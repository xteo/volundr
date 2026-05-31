import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ServicesProvider } from '@niuulabs/plugin-sdk';
import { QuickLaunch } from './QuickLaunch';
import { createMockVolundrService } from '../adapters/mock';
import type { IVolundrService } from '../ports/IVolundrService';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}));

function renderQuickLaunch(volundr: IVolundrService, onOpenChange = () => {}) {
  // Empty repo catalog -> the free-text repo input renders (testid stable either way).
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ServicesProvider
        services={{
          volundr,
          'niuu.repos': { getRepos: async () => [] },
        }}
      >
        <QuickLaunch open onOpenChange={onOpenChange} />
      </ServicesProvider>
    </QueryClientProvider>,
  );
}

function mockVolundr(): IVolundrService {
  const volundr = createMockVolundrService();
  // Force the FALLBACK definition set (skuldClaude -> opus-4-8, skuldCodex -> gpt-5.5)
  // so engine->model mapping is deterministic.
  (volundr as IVolundrService).getSessionDefinitions = async () => [];
  return volundr;
}

describe('QuickLaunch', () => {
  beforeEach(() => {
    navigate.mockClear();
  });

  it('renders a minimal name/repo/engine surface with no k8s cruft', async () => {
    renderQuickLaunch(mockVolundr());
    expect(await screen.findByTestId('quick-launch')).toBeInTheDocument();
    expect(screen.getByTestId('quick-launch-name')).toBeInTheDocument();
    expect(screen.getByTestId('quick-launch-repo')).toBeInTheDocument();
    expect(screen.getByTestId('quick-launch-engine-claude')).toBeInTheDocument();
    expect(screen.getByTestId('quick-launch-engine-codex')).toBeInTheDocument();
    expect(screen.getByTestId('quick-launch-go')).toBeInTheDocument();
    // The whole point: none of the cluster/pod-resource machinery.
    expect(screen.queryByText(/CPU|GPU|Memory|cluster|attach PVCs|pull image/i)).toBeNull();
  });

  it('creates a session from name + repo + Codex engine and navigates to it', async () => {
    const volundr = mockVolundr();
    const startSession = vi.fn().mockResolvedValue({ id: 'new-1' });
    (volundr as IVolundrService).startSession = startSession;
    const onOpenChange = vi.fn();

    renderQuickLaunch(volundr, onOpenChange);
    await screen.findByTestId('quick-launch');

    fireEvent.change(screen.getByTestId('quick-launch-name'), { target: { value: 'fix-auth' } });
    fireEvent.change(screen.getByTestId('quick-launch-repo'), {
      target: { value: 'github.com/acme/app' },
    });
    fireEvent.click(screen.getByTestId('quick-launch-engine-codex'));
    fireEvent.click(screen.getByTestId('quick-launch-go'));

    await waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'fix-auth',
        source: { type: 'git', repo: 'github.com/acme/app', branch: 'main' },
        definition: 'skuldCodex',
        model: 'gpt-5.5',
      }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/volundr/sessions/$sessionId',
        params: { sessionId: 'new-1' },
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('derives the session name from the repo when name is left blank', async () => {
    const volundr = mockVolundr();
    const startSession = vi.fn().mockResolvedValue({ id: 'new-2' });
    (volundr as IVolundrService).startSession = startSession;

    renderQuickLaunch(volundr);
    await screen.findByTestId('quick-launch');

    fireEvent.change(screen.getByTestId('quick-launch-repo'), {
      target: { value: 'github.com/acme/Billing-Service.git' },
    });
    fireEvent.click(screen.getByTestId('quick-launch-go'));

    await waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ name: 'billing-service' }));
  });

  it('surfaces an error and stays open when create fails', async () => {
    const volundr = mockVolundr();
    (volundr as IVolundrService).startSession = vi.fn().mockRejectedValue(new Error('boom'));

    renderQuickLaunch(volundr);
    await screen.findByTestId('quick-launch');

    fireEvent.change(screen.getByTestId('quick-launch-repo'), {
      target: { value: 'github.com/a/b' },
    });
    fireEvent.click(screen.getByTestId('quick-launch-go'));

    const err = await screen.findByTestId('quick-launch-error');
    expect(err).toHaveTextContent('boom');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('uses the repo dropdown and adopts the repo default branch', async () => {
    const volundr = mockVolundr();
    const startSession = vi.fn().mockResolvedValue({ id: 'new-3' });
    (volundr as IVolundrService).startSession = startSession;
    const repos = [
      {
        provider: 'github',
        org: 'acme',
        name: 'api',
        cloneUrl: 'https://github.com/acme/api',
        url: 'https://github.com/acme/api',
        defaultBranch: 'develop',
        branches: ['develop', 'main'],
      },
    ];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ServicesProvider services={{ volundr, 'niuu.repos': { getRepos: async () => repos } }}>
          <QuickLaunch open onOpenChange={() => {}} />
        </ServicesProvider>
      </QueryClientProvider>,
    );

    // Wait until the repo catalog loads and the dropdown (a <select>) replaces the
    // free-text input.
    await waitFor(() => expect(screen.getByTestId('quick-launch-repo').tagName).toBe('SELECT'));
    fireEvent.change(screen.getByTestId('quick-launch-repo'), {
      target: { value: 'https://github.com/acme/api' },
    });
    fireEvent.click(screen.getByTestId('quick-launch-go'));

    await waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'api',
        source: { type: 'git', repo: 'https://github.com/acme/api', branch: 'develop' },
      }),
    );
  });
});
