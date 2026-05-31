import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useService } from '@niuulabs/plugin-sdk';
import {
  Dialog,
  DialogContent,
  Field,
  Input,
  RepoSelect,
  Textarea,
  type RepoRecord,
} from '@niuulabs/ui';
import type { IVolundrService } from '../ports/IVolundrService';
import {
  FALLBACK_SESSION_DEFINITIONS,
  definitionToTaskType,
  deriveCliTool,
  getDefinitionRune,
  slugifySessionName,
  validateSessionName,
} from './LaunchWizard';

type RepoCatalogService = { getRepos(): Promise<RepoRecord[]> };

export interface QuickLaunchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PRIMARY_BTN =
  'niuu-rounded-md niuu-border niuu-border-brand niuu-bg-brand niuu-px-4 niuu-py-2 niuu-text-xs niuu-font-mono niuu-text-bg-primary niuu-cursor-pointer disabled:niuu-opacity-50 disabled:niuu-cursor-not-allowed';
const CANCEL_BTN =
  'niuu-rounded-md niuu-border niuu-border-border-subtle niuu-bg-bg-primary niuu-px-4 niuu-py-2 niuu-text-xs niuu-font-mono niuu-text-text-primary hover:niuu-bg-bg-tertiary';
const ENGINE_BTN =
  'niuu-flex niuu-items-center niuu-gap-1.5 niuu-rounded-md niuu-border niuu-px-3 niuu-py-2 niuu-text-xs niuu-font-mono niuu-cursor-pointer';
const ENGINE_BTN_ACTIVE = 'niuu-border-brand niuu-bg-bg-tertiary niuu-text-text-primary';
const ENGINE_BTN_IDLE =
  'niuu-border-border-subtle niuu-bg-bg-primary niuu-text-text-muted hover:niuu-border-brand';

/**
 * Mini-mode session create surface: name + repository + engine, then Go.
 *
 * Deliberately omits the cluster/k8s machinery of the full LaunchWizard
 * (CPU/GPU/memory, cluster targeting, the fake boot animation, MCP/credentials/
 * presets) — none of it applies to a local single-host (LocalProcessPodManager)
 * session. It maps straight onto the working POST /forge/sessions contract and,
 * on success, lands the user in the session view (no "open pod" step).
 */
export function QuickLaunch({ open, onOpenChange }: QuickLaunchProps) {
  const volundr = useService<IVolundrService>('volundr');
  const repoCatalog = useService<RepoCatalogService>('niuu.repos');
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const reposQuery = useQuery({
    queryKey: ['volundr', 'repos'],
    queryFn: () => repoCatalog.getRepos(),
    enabled: open,
  });
  const definitionsQuery = useQuery({
    queryKey: ['volundr', 'session-definitions'],
    queryFn: () => volundr.getSessionDefinitions(),
    enabled: open,
  });

  const repos = reposQuery.data ?? [];
  const definitions = definitionsQuery.data?.length
    ? definitionsQuery.data
    : FALLBACK_SESSION_DEFINITIONS;

  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [definitionKey, setDefinitionKey] = useState('skuldClaude');
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedDef = useMemo(
    () => definitions.find((d) => d.key === definitionKey) ?? definitions[0],
    [definitions, definitionKey],
  );

  // Auto-derive a session name from the repo/branch when the user leaves it blank.
  const effectiveName = useMemo(() => {
    const explicit = slugifySessionName(name);
    if (explicit) return explicit;
    const fromRepo = slugifySessionName(
      (repo || '')
        .split('/')
        .at(-1)
        ?.replace(/\.git$/, '') ?? '',
    );
    if (fromRepo) return fromRepo;
    const fromBranch = slugifySessionName((branch || '').split('/').at(-1) ?? '');
    return fromBranch || 'forge-session';
  }, [name, repo, branch]);

  // Only validate what the user typed; the auto-derived fallback is always valid.
  const nameError = name ? validateSessionName(slugifySessionName(name)) : null;

  async function handleCreate() {
    if (creating) return;
    setError(null);
    setCreating(true);
    try {
      const def = selectedDef;
      const session = await volundr.startSession({
        name: effectiveName,
        source: { type: 'git', repo: repo.trim(), branch: (branch || 'main').trim() },
        model: def?.defaultModel ?? '',
        definition: def?.key,
        taskType: def ? definitionToTaskType(def.key) : undefined,
        initialPrompt: prompt.trim() || undefined,
        terminalRestricted: false,
        workloadConfig: {},
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['volundr', 'sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['volundr', 'stats'] }),
        queryClient.invalidateQueries({ queryKey: ['volundr', 'domain-sessions'] }),
      ]);
      onOpenChange(false);
      void navigate({
        to: '/volundr/sessions/$sessionId',
        params: { sessionId: session.id },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create session');
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New session">
        <div className="niuu-flex niuu-flex-col niuu-gap-4" data-testid="quick-launch">
          <Field
            label="Name"
            hint="Optional — derived from the repository if left blank"
            error={nameError ?? undefined}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={effectiveName}
              data-testid="quick-launch-name"
            />
          </Field>

          <Field label="Repository">
            {repos.length > 0 ? (
              <RepoSelect
                repos={repos}
                value={repo}
                onChange={(value) => {
                  const r = repos.find((item) => item.cloneUrl === value);
                  setRepo(value);
                  if (r?.defaultBranch) setBranch(r.defaultBranch);
                }}
                placeholder="Select repository"
                testId="quick-launch-repo"
              />
            ) : (
              <Input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="github.com/owner/repo"
                data-testid="quick-launch-repo"
              />
            )}
          </Field>

          <Field label="Branch">
            <Input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              data-testid="quick-launch-branch"
            />
          </Field>

          <Field label="Engine">
            <div
              className="niuu-flex niuu-flex-wrap niuu-gap-2"
              role="radiogroup"
              aria-label="Coding engine"
            >
              {definitions.map((def) => {
                const active = def.key === definitionKey;
                return (
                  <button
                    key={def.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setDefinitionKey(def.key)}
                    data-testid={`quick-launch-engine-${deriveCliTool(def.key)}`}
                    className={`${ENGINE_BTN} ${active ? ENGINE_BTN_ACTIVE : ENGINE_BTN_IDLE}`}
                  >
                    <span aria-hidden>{getDefinitionRune(def.key)}</span>
                    {def.displayName}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="First instruction" hint="Optional — what should the agent start on?">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="e.g. Fix the failing auth tests"
              data-testid="quick-launch-prompt"
            />
          </Field>

          {error ? (
            <p className="niuu-text-xs niuu-text-danger" data-testid="quick-launch-error">
              {error}
            </p>
          ) : null}

          <div className="niuu-flex niuu-justify-end niuu-gap-2">
            <button type="button" onClick={() => onOpenChange(false)} className={CANCEL_BTN}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating || Boolean(nameError)}
              data-testid="quick-launch-go"
              className={PRIMARY_BTN}
            >
              {creating ? 'Creating…' : 'Go →'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
