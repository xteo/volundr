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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ServicesProvider services={{ volundr }}>
        <QuickLaunch open onOpenChange={onOpenChange} />
      </ServicesProvider>
    </QueryClientProvider>,
  );
}

function mockVolundr(): IVolundrService {
  const volundr = createMockVolundrService();
  // Force the FALLBACK definition set so the Claude->opus-4-8 / Codex->gpt-5.5
  // mapping is deterministic; QuickLaunch then filters to Claude + Codex only.
  (volundr as IVolundrService).getSessionDefinitions = async () => [];
  return volundr;
}

describe('QuickLaunch', () => {
  beforeEach(() => {
    navigate.mockClear();
  });

  it('offers a folder + name + Claude/Codex engines only (no repo/branch, no other engines)', async () => {
    renderQuickLaunch(mockVolundr());
    expect(await screen.findByTestId('quick-launch')).toBeInTheDocument();
    expect(screen.getByTestId('quick-launch-folder')).toBeInTheDocument();
    expect(screen.getByTestId('quick-launch-name')).toBeInTheDocument();
    expect(screen.getByTestId('quick-launch-engine-claude')).toBeInTheDocument();
    expect(screen.getByTestId('quick-launch-engine-codex')).toBeInTheDocument();
    // Only the two supported engines — no Gemini/Aider, and no git repo/branch.
    expect(screen.queryByTestId('quick-launch-engine-gemini')).toBeNull();
    expect(screen.queryByTestId('quick-launch-engine-aider')).toBeNull();
    expect(screen.queryByTestId('quick-launch-repo')).toBeNull();
    expect(screen.queryByTestId('quick-launch-branch')).toBeNull();
  });

  it('Go is disabled until a folder is provided', async () => {
    renderQuickLaunch(mockVolundr());
    await screen.findByTestId('quick-launch');
    expect(screen.getByTestId('quick-launch-go')).toBeDisabled();
    fireEvent.change(screen.getByTestId('quick-launch-folder'), {
      target: { value: '/home/thor/repos/lexi-frontend' },
    });
    expect(screen.getByTestId('quick-launch-go')).toBeEnabled();
  });

  it('creates a local_mount session from a folder + Codex engine and navigates to it', async () => {
    const volundr = mockVolundr();
    const startSession = vi.fn().mockResolvedValue({ id: 'new-1' });
    (volundr as IVolundrService).startSession = startSession;
    const onOpenChange = vi.fn();

    renderQuickLaunch(volundr, onOpenChange);
    await screen.findByTestId('quick-launch');

    fireEvent.change(screen.getByTestId('quick-launch-folder'), {
      target: { value: '/home/thor/repos/acme-api' },
    });
    fireEvent.change(screen.getByTestId('quick-launch-name'), { target: { value: 'fix-auth' } });
    fireEvent.click(screen.getByTestId('quick-launch-engine-codex'));
    fireEvent.click(screen.getByTestId('quick-launch-go'));

    await waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'fix-auth',
        source: {
          type: 'local_mount',
          local_path: '/home/thor/repos/acme-api',
          paths: [
            { host_path: '/home/thor/repos/acme-api', mount_path: '/workspace', read_only: false },
          ],
        },
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

  it('derives the session name from the folder when name is left blank', async () => {
    const volundr = mockVolundr();
    const startSession = vi.fn().mockResolvedValue({ id: 'new-2' });
    (volundr as IVolundrService).startSession = startSession;

    renderQuickLaunch(volundr);
    await screen.findByTestId('quick-launch');

    fireEvent.change(screen.getByTestId('quick-launch-folder'), {
      target: { value: '/home/thor/repos/Billing-Service/' },
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

    fireEvent.change(screen.getByTestId('quick-launch-folder'), {
      target: { value: '/home/thor/repos/x' },
    });
    fireEvent.click(screen.getByTestId('quick-launch-go'));

    const err = await screen.findByTestId('quick-launch-error');
    expect(err).toHaveTextContent('boom');
    expect(navigate).not.toHaveBeenCalled();
  });
});
