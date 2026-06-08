import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useService } from '@niuulabs/plugin-sdk';
import { Dialog, DialogContent, Field, Input, Textarea } from '@niuulabs/ui';
import type { IVolundrService } from '../ports/IVolundrService';
import type { LocalMountSource } from '../models/volundr.model';
import {
  FALLBACK_SESSION_DEFINITIONS,
  definitionToTaskType,
  deriveCliTool,
  getDefinitionRune,
  slugifySessionName,
  validateSessionName,
} from './LaunchWizard';

export interface QuickLaunchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Mini mode runs in place against a local checkout — only these two engines.
const ALLOWED_ENGINES = new Set(['skuldClaude', 'skuldCodex']);

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
 * Mini-mode session create surface: pick a local folder + an engine, then Go.
 *
 * In mini mode the session runs IN PLACE against a checkout already on disk —
 * there is no clone — so the source is a local_mount (folder path), not a
 * git repo/branch. Only Claude Code and Codex are offered. Deliberately omits
 * the cluster/k8s machinery of the full LaunchWizard (resources, cluster, the
 * fake boot animation, MCP/credentials/presets). Maps straight onto the working
 * POST /forge/sessions contract and, on success, lands in the session view.
 */
export function QuickLaunch({ open, onOpenChange }: QuickLaunchProps) {
  const volundr = useService<IVolundrService>('volundr');
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const definitionsQuery = useQuery({
    queryKey: ['volundr', 'session-definitions'],
    queryFn: () => volundr.getSessionDefinitions(),
    enabled: open,
  });

  // Claude + Codex only, in that order.
  const definitions = useMemo(() => {
    const all = definitionsQuery.data?.length
      ? definitionsQuery.data
      : FALLBACK_SESSION_DEFINITIONS;
    const allowed = all.filter((d) => ALLOWED_ENGINES.has(d.key));
    return allowed.length
      ? allowed
      : FALLBACK_SESSION_DEFINITIONS.filter((d) => ALLOWED_ENGINES.has(d.key));
  }, [definitionsQuery.data]);

  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [definitionKey, setDefinitionKey] = useState('skuldClaude');
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedDef = useMemo(
    () => definitions.find((d) => d.key === definitionKey) ?? definitions[0],
    [definitions, definitionKey],
  );

  // Auto-derive the session name from the folder's last path segment when blank.
  const effectiveName = useMemo(() => {
    const explicit = slugifySessionName(name);
    if (explicit) return explicit;
    const lastSegment = (folder || '').split('/').filter(Boolean).at(-1) ?? '';
    const fromFolder = slugifySessionName(lastSegment.replace(/^~/, 'home'));
    return fromFolder || 'forge-session';
  }, [name, folder]);

  // Only validate what the user typed; the auto-derived fallback is always valid.
  const nameError = name ? validateSessionName(slugifySessionName(name)) : null;
  const canCreate = Boolean(folder.trim()) && !nameError && !creating;

  async function handleCreate() {
    if (!canCreate) return;
    setError(null);
    setCreating(true);
    try {
      const def = selectedDef;
      const path = folder.trim();
      const source: LocalMountSource = {
        type: 'local_mount',
        local_path: path,
        paths: [{ host_path: path, mount_path: '/workspace', read_only: false }],
      };
      const session = await volundr.startSession({
        name: effectiveName,
        source,
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
            label="Folder"
            hint="Absolute path to a local checkout — the session runs in place, no clone"
          >
            <Input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="/home/thor/repos/lexi-frontend"
              data-testid="quick-launch-folder"
            />
          </Field>

          <Field
            label="Name"
            hint="Optional — derived from the folder if left blank"
            error={nameError ?? undefined}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={effectiveName}
              data-testid="quick-launch-name"
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
              disabled={!canCreate}
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
