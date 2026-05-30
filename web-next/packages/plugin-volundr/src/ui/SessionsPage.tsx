import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useService } from '@niuulabs/plugin-sdk';
import { LoadingState, ErrorState, EmptyState, StateDot, relTime, cn } from '@niuulabs/ui';
import type { DotState } from '@niuulabs/ui';
import { Archive, ChevronRight, Search, Square, SquareTerminal, Ticket } from 'lucide-react';
import { LaunchWizard } from './LaunchWizard';
import { useSessionList } from './hooks/useSessionStore';
import { groupByState } from './sessions/groupByState';
import { LiveSessionDetailPage } from './LiveSessionDetailPage';
import { getShowDebugMeta } from './uxPrefs';
import type { Session, SessionState } from '../domain/session';
import type { IVolundrService } from '../ports/IVolundrService';
import './scrollbar-themed.css';
import './session-card.css';

// ---------------------------------------------------------------------------
// Pod group definitions — maps display labels to session states
// ---------------------------------------------------------------------------

interface PodGroupDef {
  label: string;
  states: SessionState[];
}

type SidebarMode = 'state' | 'repo' | 'forge';

interface SessionSection {
  label: string;
  sessions: Session[];
}

const POD_GROUPS: PodGroupDef[] = [
  { label: 'ACTIVE', states: ['running'] },
  { label: 'IDLE', states: ['idle'] },
  { label: 'BOOTING', states: ['provisioning', 'requested'] },
  { label: 'ERROR', states: ['failed'] },
  { label: 'STOPPED', states: ['terminated'] },
  { label: 'ARCHIVED', states: ['archived'] },
];

// ---------------------------------------------------------------------------
// Session state → dot state mapping
// ---------------------------------------------------------------------------

const SESSION_DOT: Record<SessionState, DotState> = {
  running: 'running',
  idle: 'idle',
  provisioning: 'processing',
  requested: 'queued',
  ready: 'healthy',
  terminating: 'degraded',
  terminated: 'archived',
  archived: 'archived',
  failed: 'failed',
};

function looksLikeRepoLabel(value: string): boolean {
  return (
    value.includes('#') ||
    value.startsWith('~/') ||
    value.startsWith('/') ||
    value.startsWith('http')
  );
}

function compactSourceParts(value: string): { label: string; branch?: string } {
  if (value.includes('#')) {
    const [repo, branch] = value.split('#');
    return { label: shortenRepoLabel(repo ?? value), branch: branch || undefined };
  }
  return { label: shortenRepoLabel(value) };
}

/** Collapse a leading "/home/<user>/" (incl. literal "/home/thor/") to "~/". */
function homeToTilde(value: string): string {
  return value.replace(/^\/home\/[^/]+\//, '~/');
}

function shortenRepoLabel(value: string): string {
  if (value.startsWith('~/') || value.startsWith('/')) return homeToTilde(value);
  const trimmed = value.replace(/\/+$/, '');
  const slug = trimmed.split('/').pop() ?? trimmed;
  return slug.replace(/\.git$/, '') || value;
}

function toGroupTestId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sessionActivityTs(session: Session): number {
  return new Date(session.lastActivityAt ?? session.startedAt).getTime();
}

function compareSessionsByActivity(a: Session, b: Session): number {
  return sessionActivityTs(b) - sessionActivityTs(a);
}

function repoGroupLabel(session: Session): string {
  if (session.preview && looksLikeRepoLabel(session.preview)) {
    return compactSourceParts(session.preview).label;
  }
  if (session.personaName.startsWith('~/') || session.personaName.startsWith('/')) {
    return homeToTilde(session.personaName);
  }
  return 'other';
}

function groupByRepo(sessions: Session[]): SessionSection[] {
  const grouped = new Map<string, Session[]>();

  for (const session of sessions) {
    const label = repoGroupLabel(session);
    const bucket = grouped.get(label);
    if (bucket) {
      bucket.push(session);
    } else {
      grouped.set(label, [session]);
    }
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([label, groupedSessions]) => ({
      label,
      sessions: [...groupedSessions].sort(compareSessionsByActivity),
    }));
}

function forgeGroupLabel(session: Session): string {
  return session.clusterName ?? session.clusterId ?? 'unknown forge';
}

function groupByForge(sessions: Session[]): SessionSection[] {
  const grouped = new Map<string, Session[]>();

  for (const session of sessions) {
    const label = forgeGroupLabel(session);
    const bucket = grouped.get(label);
    if (bucket) {
      bucket.push(session);
    } else {
      grouped.set(label, [session]);
    }
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([label, groupedSessions]) => ({
      label,
      sessions: [...groupedSessions].sort(compareSessionsByActivity),
    }));
}

// ---------------------------------------------------------------------------
// PodEntry — a single session row in the sidebar
// ---------------------------------------------------------------------------

/** States from which a session can still be stopped. */
const STOPPABLE_STATES: SessionState[] = [
  'running',
  'idle',
  'provisioning',
  'requested',
  'ready',
  'terminating',
];

function PodEntry({
  session,
  selected,
  onSelect,
  onStop,
  onArchive,
  busy = false,
  collapsed = false,
  index = 0,
}: {
  session: Session;
  selected: boolean;
  onSelect: () => void;
  /** Stop the session in place (hover action). */
  onStop?: (id: string) => void;
  /** Stop (if running) then archive the session (hover action). */
  onArchive?: (id: string) => void;
  /** True while this row has an action in flight — disables its buttons. */
  busy?: boolean;
  collapsed?: boolean;
  /** Row position within its group — drives the zebra striping. */
  index?: number;
}) {
  const canStop = STOPPABLE_STATES.includes(session.state);
  const canArchive = session.state !== 'archived';
  const lastActiveMs = new Date(session.lastActivityAt ?? session.startedAt).getTime();
  const ageLabel = relTime(lastActiveMs);
  // Pulse only when the session is genuinely working right now. The backend keeps
  // status 'running' even after the agent finished its turn (it does not set
  // activity_state on the list payload), so a stale "running" pod would otherwise
  // pulse forever. Treat a running session with no activity in the last 45s as
  // idle: solid dot, no pulse.
  const isActivelyWorking = session.state === 'running' && Date.now() - lastActiveMs < 45_000;
  const primaryLabel = session.name || session.personaName || '(unnamed)';
  // saga/run/ravn id and forge/cluster id are platform plumbing. ravnId in
  // particular falls back to the owner id ("dev-user") when there is no real
  // tracker, so it renders as a meaningless "ticket". Hide both unless the
  // operator opts into debug metadata. See uxPrefs.getShowDebugMeta.
  const showDebugMeta = getShowDebugMeta();
  const trackerLabel = showDebugMeta
    ? (session.sagaId ?? session.runId ?? session.ravnId)
    : undefined;
  const previewLabel = session.preview;
  const sourceParts =
    previewLabel && looksLikeRepoLabel(previewLabel) ? compactSourceParts(previewLabel) : null;
  const showPreviewFallback = previewLabel && !sourceParts;
  const forgeLabel = showDebugMeta ? (session.clusterName ?? session.clusterId) : undefined;
  // Zebra striping: subtle alternating background on even rows. Inline so it
  // works without the prebuilt niuu-* utilities being recompiled in dev.
  const zebraBg = selected ? undefined : index % 2 === 1 ? 'rgba(255,255,255,0.025)' : undefined;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      data-testid={`pod-entry-${session.id}`}
      aria-pressed={selected}
      style={selected ? undefined : zebraBg ? { backgroundColor: zebraBg } : undefined}
      className={cn(
        'lx-pod-entry niuu-flex niuu-w-full niuu-items-start niuu-gap-2 niuu-border-b niuu-border-l-2 niuu-px-3 niuu-py-1.5 niuu-text-left niuu-transition-colors',
        selected
          ? 'lx-pod-entry--selected niuu-border-brand niuu-border-b-white/10'
          : 'niuu-border-transparent niuu-border-b-white/6',
      )}
    >
      <StateDot state={SESSION_DOT[session.state]} pulse={isActivelyWorking} />
      {collapsed ? null : (
        <>
          <div className="niuu-flex-1 niuu-min-w-0 niuu-flex niuu-flex-col niuu-gap-0.5">
            <div className="niuu-flex niuu-min-w-0 niuu-items-baseline niuu-gap-2">
              <span className="niuu-flex-1 niuu-min-w-0 niuu-font-mono niuu-text-[13px] niuu-font-medium niuu-text-text-primary niuu-truncate">
                {primaryLabel}
              </span>
              <span className="lx-pod-age niuu-flex-shrink-0 niuu-font-mono niuu-text-[10px] niuu-text-text-secondary">
                {ageLabel}
              </span>
            </div>
            <div className="niuu-flex niuu-min-w-0 niuu-flex-wrap niuu-items-center niuu-gap-x-2 niuu-gap-y-0.5 niuu-font-mono niuu-text-[10px] niuu-text-text-muted">
              {trackerLabel ? (
                <span
                  className="niuu-flex niuu-min-w-0 niuu-items-center niuu-gap-1.5"
                  title={trackerLabel}
                >
                  <Ticket className="niuu-h-3 niuu-w-3 niuu-flex-shrink-0 niuu-text-text-faint" />
                  <span className="niuu-truncate niuu-text-brand">{trackerLabel}</span>
                </span>
              ) : null}
              {forgeLabel ? (
                <span
                  className="niuu-inline-flex niuu-min-w-0 niuu-items-center niuu-rounded-full niuu-border niuu-border-brand/20 niuu-bg-brand/10 niuu-px-2 niuu-py-0.5"
                  title={forgeLabel}
                >
                  <span className="niuu-truncate niuu-text-brand">{forgeLabel}</span>
                </span>
              ) : null}
              {sourceParts ? (
                <span
                  className="niuu-flex niuu-min-w-0 niuu-items-center niuu-gap-1.5 niuu-text-text-secondary"
                  title={previewLabel}
                >
                  <span className="niuu-truncate">{sourceParts.label}</span>
                  {sourceParts.branch ? (
                    <span className="niuu-flex-shrink-0 niuu-text-brand">
                      @{sourceParts.branch}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {showPreviewFallback ? (
                <span
                  className="niuu-flex niuu-min-w-0 niuu-items-center niuu-gap-1.5"
                  title={previewLabel}
                >
                  <SquareTerminal className="niuu-h-3 niuu-w-3 niuu-flex-shrink-0 niuu-text-text-faint" />
                  <span className="niuu-truncate">{previewLabel}</span>
                </span>
              ) : null}
            </div>
          </div>
          {(canStop && onStop) || (canArchive && onArchive) ? (
            <div className="lx-pod-actions" onClick={(e) => e.stopPropagation()}>
              {canStop && onStop ? (
                <button
                  type="button"
                  className="lx-pod-action-btn lx-pod-action-btn--stop"
                  title="Stop session"
                  aria-label={`Stop session ${primaryLabel}`}
                  data-testid={`pod-entry-${session.id}-stop`}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStop(session.id);
                  }}
                >
                  <Square size={11} fill="currentColor" />
                </button>
              ) : null}
              {canArchive && onArchive ? (
                <button
                  type="button"
                  className="lx-pod-action-btn lx-pod-action-btn--archive"
                  title="Stop & archive session"
                  aria-label={`Stop and archive session ${primaryLabel}`}
                  data-testid={`pod-entry-${session.id}-archive`}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onArchive(session.id);
                  }}
                >
                  <Archive size={11} />
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PodGroup — a state section with label + session entries
// ---------------------------------------------------------------------------

function PodGroup({
  label,
  sessions,
  selectedId,
  onSelect,
  onStop,
  onArchive,
  busyId,
  collapsed = false,
  folded = false,
  onToggleFold,
}: {
  label: string;
  sessions: Session[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStop?: (id: string) => void;
  onArchive?: (id: string) => void;
  /** Id of the session whose row action is currently in flight. */
  busyId?: string | null;
  collapsed?: boolean;
  /** Whether the group's session rows are folded away (header still shown). */
  folded?: boolean;
  /** Toggles the folded state. When absent, the header is not interactive. */
  onToggleFold?: () => void;
}) {
  if (sessions.length === 0) return null;

  return (
    <div data-testid={`pod-group-${toGroupTestId(label)}`}>
      {!collapsed && (
        <button
          type="button"
          onClick={onToggleFold}
          disabled={!onToggleFold}
          aria-expanded={!folded}
          data-testid={`pod-group-${toGroupTestId(label)}-header`}
          className={cn(
            'niuu-flex niuu-w-full niuu-items-center niuu-gap-1.5 niuu-border-b niuu-border-white/6 niuu-px-2.5 niuu-py-2 niuu-text-left niuu-text-[10px] niuu-font-semibold niuu-uppercase niuu-tracking-[0.18em] niuu-text-text-muted niuu-transition-colors',
            onToggleFold && 'hover:niuu-text-text-primary',
          )}
        >
          <ChevronRight
            className="niuu-h-3 niuu-w-3 niuu-flex-shrink-0 niuu-text-text-faint niuu-transition-transform"
            style={{ transform: folded ? 'rotate(0deg)' : 'rotate(90deg)' }}
            aria-hidden="true"
          />
          <span className="niuu-flex-1 niuu-truncate">{label}</span>
          <span
            className="niuu-font-mono niuu-text-text-faint"
            data-testid={`pod-group-${toGroupTestId(label)}-count`}
          >
            {sessions.length}
          </span>
        </button>
      )}
      {!folded &&
        sessions.map((s, i) => (
          <PodEntry
            key={s.id}
            session={s}
            selected={s.id === selectedId}
            onSelect={() => onSelect(s.id)}
            onStop={onStop}
            onArchive={onArchive}
            busy={busyId === s.id}
            collapsed={collapsed}
            index={i}
          />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionsPage — master-detail layout
// ---------------------------------------------------------------------------

// niuu-ux: configurable (drag-resizable) left session column, persisted.
const LEFT_WIDTH_KEY = 'niuu.compactUx.sessions.leftWidth';
const LEFT_MIN_PX = 200;
const LEFT_MAX_PX = 560;
const LEFT_DEFAULT_PX = 300;
function readLeftWidth(): number {
  if (typeof window === 'undefined') return LEFT_DEFAULT_PX;
  const v = Number(window.localStorage.getItem(LEFT_WIDTH_KEY));
  return Number.isFinite(v) && v >= LEFT_MIN_PX && v <= LEFT_MAX_PX ? v : LEFT_DEFAULT_PX;
}

// niuu-ux: foldable groups + hide-archived, persisted in localStorage.
const FOLDED_GROUPS_KEY = 'niuu.compactUx.sessions.foldedGroups';
const HIDE_ARCHIVED_KEY = 'niuu.compactUx.sessions.hideArchived';
/** Groups folded away by default on first load. */
const DEFAULT_FOLDED_GROUPS = ['ARCHIVED', 'STOPPED'];

function readFoldedGroups(): Record<string, boolean> {
  const seed = Object.fromEntries(DEFAULT_FOLDED_GROUPS.map((g) => [g, true]));
  if (typeof window === 'undefined') return seed;
  try {
    const raw = window.localStorage.getItem(FOLDED_GROUPS_KEY);
    if (!raw) return seed;
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return parsed && typeof parsed === 'object' ? parsed : seed;
  } catch {
    return seed;
  }
}

function readHideArchived(): boolean {
  if (typeof window === 'undefined') return true;
  const raw = window.localStorage.getItem(HIDE_ARCHIVED_KEY);
  // Default = hide archived. Only an explicit "0" reveals them.
  return raw === null ? true : raw !== '0';
}

export function SessionsPage() {
  const navigate = useNavigate();
  const { sessionId: routeSessionId } = useParams({ strict: false });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('state');
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(readLeftWidth);
  const [resizing, setResizing] = useState(false);
  const [foldedGroups, setFoldedGroups] = useState<Record<string, boolean>>(readFoldedGroups);
  const [hideArchived, setHideArchived] = useState<boolean>(readHideArchived);
  useEffect(() => {
    try {
      window.localStorage.setItem(LEFT_WIDTH_KEY, String(sidebarWidth));
    } catch {
      /* localStorage unavailable — non-fatal */
    }
  }, [sidebarWidth]);
  useEffect(() => {
    try {
      window.localStorage.setItem(FOLDED_GROUPS_KEY, JSON.stringify(foldedGroups));
    } catch {
      /* localStorage unavailable — non-fatal */
    }
  }, [foldedGroups]);
  useEffect(() => {
    try {
      window.localStorage.setItem(HIDE_ARCHIVED_KEY, hideArchived ? '1' : '0');
    } catch {
      /* localStorage unavailable — non-fatal */
    }
  }, [hideArchived]);
  const toggleGroupFold = (label: string) => {
    setFoldedGroups((prev) => ({ ...prev, [label]: !prev[label] }));
  };
  const startSidebarResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    setResizing(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(LEFT_MAX_PX, Math.max(LEFT_MIN_PX, startWidth + (ev.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  const volundr = useService<IVolundrService>('volundr');
  const queryClient = useQueryClient();

  const sessionsQuery = useSessionList();
  const allSessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const stoppedSessionCount = useMemo(
    () => allSessions.filter((session) => session.state === 'terminated').length,
    [allSessions],
  );

  // Filter by search query
  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allSessions;
    return allSessions.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        s.name?.toLowerCase().includes(q) ||
        s.personaName.toLowerCase().includes(q) ||
        s.preview?.toLowerCase().includes(q) ||
        s.clusterName?.toLowerCase().includes(q) ||
        s.clusterId?.toLowerCase().includes(q),
    );
  }, [allSessions, searchQuery]);

  // Group by state
  const grouped = useMemo(() => groupByState(filteredSessions), [filteredSessions]);

  // Build sidebar groups — flatten matching states per display group.
  // When hideArchived is on (and we're grouping by state) the ARCHIVED group
  // is dropped entirely.
  const sidebarGroups = useMemo<SessionSection[]>(() => {
    if (sidebarMode === 'repo') {
      return groupByRepo(filteredSessions);
    }
    if (sidebarMode === 'forge') {
      return groupByForge(filteredSessions);
    }
    return POD_GROUPS.filter((g) => !(hideArchived && g.label === 'ARCHIVED')).map((g) => ({
      label: g.label,
      sessions: g.states.flatMap((st) => grouped[st]),
    }));
  }, [filteredSessions, grouped, sidebarMode, hideArchived]);

  // True when there are any archived sessions to reveal/hide.
  const archivedCount = useMemo(
    () => allSessions.filter((s) => s.state === 'archived').length,
    [allSessions],
  );

  // Auto-select first running session on load
  useEffect(() => {
    if (!sessionsQuery.data) return;

    const requestedSessionId = typeof routeSessionId === 'string' ? routeSessionId : null;
    if (requestedSessionId) {
      const matchingSession = sessionsQuery.data.find(
        (session) => session.id === requestedSessionId,
      );
      if (matchingSession) {
        if (selectedSessionId !== matchingSession.id) {
          setSelectedSessionId(matchingSession.id);
        }
        return;
      }
    }

    if (selectedSessionId) return;

    const running = sessionsQuery.data.filter((s) => s.state === 'running');
    if (running.length > 0) {
      setSelectedSessionId(running[0]!.id);
    } else if (sessionsQuery.data.length > 0) {
      setSelectedSessionId(sessionsQuery.data[0]!.id);
    }
  }, [routeSessionId, selectedSessionId, sessionsQuery.data]);

  function handleSelectSession(id: string) {
    setSelectedSessionId(id);
    void navigate({
      to: '/volundr/sessions/$sessionId',
      params: { sessionId: id },
    });
  }

  async function handleArchiveAllStopped() {
    if (archiveBusy || stoppedSessionCount === 0) return;
    setArchiveBusy(true);
    try {
      await volundr.archiveStoppedSessions();
      await refreshSessions();
    } finally {
      setArchiveBusy(false);
    }
  }

  async function refreshSessions() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['volundr', 'domain-sessions'] }),
      queryClient.invalidateQueries({ queryKey: ['volundr', 'history'] }),
    ]);
    await sessionsQuery.refetch();
  }

  // Hover action: stop a session in place.
  async function handleStopSession(id: string) {
    if (rowBusy) return;
    setRowBusy(id);
    try {
      await volundr.stopSession(id);
      await refreshSessions();
    } finally {
      setRowBusy(null);
    }
  }

  // Hover action: "archive" == stop (if still active) then archive.
  async function handleArchiveSession(id: string) {
    if (rowBusy) return;
    setRowBusy(id);
    try {
      const target = allSessions.find((s) => s.id === id);
      if (target && STOPPABLE_STATES.includes(target.state)) {
        // Stop first; ignore a stop error so a flaky stop still lets us archive.
        await volundr.stopSession(id).catch(() => undefined);
      }
      await volundr.archiveSession(id);
      await refreshSessions();
    } finally {
      setRowBusy(null);
    }
  }

  return (
    <>
      <div className="niuu-relative niuu-flex niuu-h-full" data-testid="sessions-page">
        {/* ── Left sidebar: pod list ─────────────────────────────── */}
        <nav
          className={cn(
            'niuu-relative niuu-shrink-0 niuu-overflow-hidden niuu-bg-[#0b0c10]',
            !resizing && 'niuu-transition-[width] niuu-duration-200',
          )}
          style={
            sidebarCollapsed
              ? {
                  width: '48px',
                  minWidth: '48px',
                  maxWidth: '48px',
                  flexBasis: '48px',
                }
              : {
                  width: `${sidebarWidth}px`,
                  minWidth: `${sidebarWidth}px`,
                  maxWidth: `${sidebarWidth}px`,
                  flexBasis: `${sidebarWidth}px`,
                }
          }
          aria-label="Session list"
          data-testid="pod-list-sidebar"
        >
          {sidebarCollapsed ? (
            <div className="niuu-flex niuu-h-full niuu-flex-col niuu-overflow-hidden">
              <div className="niuu-flex niuu-items-center niuu-justify-center niuu-border-b niuu-border-border-subtle niuu-py-2.5">
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(false)}
                  className="niuu-font-mono niuu-text-sm niuu-text-text-muted"
                  data-testid="pod-sidebar-toggle"
                  aria-label="Expand pods sidebar"
                >
                  ›
                </button>
              </div>
              <div className="niuu-flex-1 niuu-min-h-0 niuu-overflow-y-auto niuu-py-2 niuu-scroll-themed">
                {sidebarGroups.map((g) => (
                  <PodGroup
                    key={g.label}
                    label={g.label}
                    sessions={g.sessions}
                    selectedId={selectedSessionId}
                    onSelect={handleSelectSession}
                    collapsed
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="niuu-flex niuu-h-full niuu-flex-col niuu-overflow-hidden">
              <div className="niuu-flex niuu-items-center niuu-justify-between niuu-border-b niuu-border-white/8 niuu-px-3 niuu-py-2">
                <div className="niuu-flex niuu-items-center niuu-gap-1.5">
                  <h2 className="niuu-text-sm niuu-font-semibold niuu-text-text-primary">
                    Sessions
                  </h2>
                  <span
                    className="niuu-rounded-full niuu-bg-bg-elevated niuu-px-1.5 niuu-py-0.5 niuu-font-mono niuu-text-[10px] niuu-text-text-muted"
                    data-testid="pod-count"
                  >
                    {allSessions.length}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(true)}
                  className="niuu-font-mono niuu-text-lg niuu-text-text-muted"
                  data-testid="pod-sidebar-toggle"
                  aria-label="Collapse pods sidebar"
                >
                  ‹
                </button>
              </div>

              <div className="niuu-flex niuu-items-center niuu-gap-2 niuu-px-3 niuu-py-1">
                <span className="niuu-text-[10px] niuu-font-mono niuu-text-text-secondary">
                  group by
                </span>
                <div
                  className="niuu-inline-flex niuu-gap-1 niuu-rounded-lg niuu-border niuu-border-border-subtle niuu-bg-bg-tertiary niuu-p-1"
                  data-testid="pod-group-mode"
                >
                  {(['state', 'repo', 'forge'] as const).map((mode) => {
                    const active = sidebarMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setSidebarMode(mode)}
                        className={cn(
                          'niuu-rounded-md niuu-px-3 niuu-py-1 niuu-font-mono niuu-text-[10px] niuu-transition-colors',
                          active
                            ? 'niuu-bg-brand/15 niuu-text-brand'
                            : 'niuu-text-text-muted hover:niuu-text-text-primary',
                        )}
                        data-testid={`pod-group-mode-${mode}`}
                        aria-pressed={active}
                      >
                        {mode}
                      </button>
                    );
                  })}
                </div>
                {archivedCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setHideArchived((v) => !v)}
                    className={cn(
                      'niuu-ml-auto niuu-rounded-md niuu-border niuu-border-border-subtle niuu-px-2 niuu-py-1 niuu-font-mono niuu-text-[10px] niuu-transition-colors',
                      hideArchived
                        ? 'niuu-text-text-muted hover:niuu-text-text-primary'
                        : 'niuu-bg-brand/15 niuu-text-brand',
                    )}
                    data-testid="pod-toggle-archived"
                    aria-pressed={!hideArchived}
                    title={hideArchived ? 'Show archived sessions' : 'Hide archived sessions'}
                  >
                    {hideArchived ? `show archived (${archivedCount})` : 'hide archived'}
                  </button>
                ) : null}
              </div>

              <div className="niuu-px-3 niuu-pb-1">
                <div className="niuu-flex niuu-items-center niuu-gap-2">
                  <button
                    type="button"
                    onClick={() => setLaunchOpen(true)}
                    className="niuu-flex niuu-h-7 niuu-w-7 niuu-flex-shrink-0 niuu-items-center niuu-justify-center niuu-rounded-lg niuu-border niuu-border-border-subtle niuu-bg-bg-elevated niuu-text-sm niuu-font-semibold niuu-text-text-muted niuu-transition-colors hover:niuu-border-brand/40 hover:niuu-text-brand"
                    data-testid="pod-launch-button"
                    aria-label="Launch a new session"
                    title="Launch a new session"
                  >
                    +
                  </button>
                  <div className="niuu-flex niuu-min-w-0 niuu-flex-1 niuu-items-center niuu-gap-2 niuu-rounded-xl niuu-border niuu-border-border-subtle niuu-bg-bg-tertiary niuu-px-2 niuu-py-1 niuu-shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] focus-within:niuu-border-brand/50 focus-within:niuu-ring-1 focus-within:niuu-ring-brand/20">
                    <Search
                      className="niuu-h-4 niuu-w-4 niuu-flex-shrink-0 niuu-text-text-muted"
                      aria-hidden="true"
                    />
                    <input
                      type="search"
                      placeholder="filter by name / repo / branch / forge"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="niuu-min-w-0 niuu-flex-1 niuu-bg-transparent niuu-py-0.5 niuu-pr-1 niuu-text-[11px] niuu-text-text-primary placeholder:niuu-text-text-muted focus:niuu-outline-none"
                      data-testid="pod-search"
                      aria-label="Filter sessions"
                    />
                  </div>
                </div>
              </div>

              {stoppedSessionCount > 0 && (
                <div className="niuu-px-2.5 niuu-pb-2">
                  <button
                    type="button"
                    onClick={() => void handleArchiveAllStopped()}
                    disabled={archiveBusy}
                    className="niuu-flex niuu-w-full niuu-items-center niuu-justify-between niuu-rounded-lg niuu-border niuu-border-border-subtle niuu-bg-bg-tertiary niuu-px-3 niuu-py-2 niuu-font-mono niuu-text-[10px] niuu-text-text-muted hover:niuu-bg-bg-elevated disabled:niuu-cursor-not-allowed disabled:niuu-opacity-50"
                    data-testid="archive-stopped-button"
                  >
                    <span>
                      {archiveBusy ? 'archiving stopped sessions…' : 'archive all stopped'}
                    </span>
                    <span className="niuu-text-text-faint">{stoppedSessionCount}</span>
                  </button>
                </div>
              )}

              <div className="niuu-flex-1 niuu-min-h-0 niuu-overflow-y-auto niuu-pb-1.5 niuu-scroll-themed">
                {sidebarGroups.map((g) => (
                  <PodGroup
                    key={g.label}
                    label={g.label}
                    sessions={g.sessions}
                    selectedId={selectedSessionId}
                    onSelect={handleSelectSession}
                    onStop={handleStopSession}
                    onArchive={handleArchiveSession}
                    busyId={rowBusy}
                    folded={Boolean(foldedGroups[g.label])}
                    onToggleFold={() => toggleGroupFold(g.label)}
                  />
                ))}
              </div>
            </div>
          )}
        </nav>

        {/* ── Resizable divider: drag to set the left column width ── */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize session list"
          onMouseDown={sidebarCollapsed ? undefined : startSidebarResize}
          className="niuu-h-full niuu-flex-shrink-0"
          style={{
            width: sidebarCollapsed ? '3px' : '6px',
            cursor: sidebarCollapsed ? 'default' : 'col-resize',
            userSelect: 'none',
            background:
              'linear-gradient(to right, rgba(255,255,255,0.12), rgba(255,255,255,0.30), rgba(255,255,255,0.12))',
          }}
        />

        <div className="niuu-flex niuu-min-w-0 niuu-flex-1 niuu-flex-col niuu-overflow-hidden">
          {sessionsQuery.isLoading && <LoadingState label="Loading sessions…" />}
          {sessionsQuery.isError && (
            <ErrorState
              title="Failed to load sessions"
              message={
                sessionsQuery.error instanceof Error ? sessionsQuery.error.message : 'Unknown error'
              }
            />
          )}
          {sessionsQuery.data && !selectedSessionId && (
            <EmptyState
              title="No session selected"
              description="Select a session from the sidebar."
            />
          )}
          {sessionsQuery.data && selectedSessionId && (
            <LiveSessionDetailPage key={selectedSessionId} sessionId={selectedSessionId} />
          )}
        </div>
      </div>
      <LaunchWizard open={launchOpen} onOpenChange={setLaunchOpen} />
    </>
  );
}
