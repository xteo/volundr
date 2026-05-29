# lexi/ux-update — Volundr UI changes for the Lexi / retail-scale environment

> **Branch:** `lexi/ux-update` (worktree `/home/thor/repos/worktrees/volundr-lexi-ux-update`, off `dev` @ `10c70135`).
> **Purpose:** capture + implement the UI/UX changes that make the Volundr (niuu web-next) Forge experience compact and usable for Lexi on a single host. **Status: spec for review — not yet implemented.**
> All "compact" behaviors live behind a small **prefs hook, defaulting to the compact view in this branch** (toggle back on if wanted), so the diff is contained and reversible.

## Shared mechanism — `useLexiUxPrefs` (localStorage, off-by-default = compact)

A tiny prefs hook (matches the repo's existing `localStorage` convention, keys `niuu.lexiUx.*`; the app already does this for `niuu.active`, `niuu.skuldChat.v2.*`, `bookmark:*`). Defaults in this branch make the view compact; each can be flipped on:

| Pref | Default (this branch) | Controls |
|---|---|---|
| `showMessageActions` | `false` | the 👍/👎 / regenerate / bookmark row (item B) |
| `copyMode` | `hover` | copy affordance: `hover` near the message vs `inline` row (item C) |
| `timestamp` | `hover` | `hover` (right-aligned, on hover) / `always` / `never` (item D) |
| `showAgentAvatar` | `false` | the Hamr/Völundr 🔨 avatar + name (item E) |
| `foldIntermediate` | `true` | Codex-style fold of intermediary + tool-call messages (item F) |
| `leftList.hideArchived` | `true` | hide archived sessions in the left list (item G) |
| `leftList.groupStopped` | `true` | collapse stopped into a "Stopped" group, collapsed by default (item G) |

## Changes

### A. Resizable / configurable two-column split
- **Where:** `packages/plugin-volundr/src/ui/SessionsPage.tsx` (left `<nav>` fixed at `width/minWidth/maxWidth: 228px`; 3px divider; right panel `flex:1`). No resizer today.
- **Do:** add a draggable divider (native `onMouseDown` drag → update width → persist `niuu.lexiUx.sessions.leftWidth`), with a sensible min/max (e.g. 200–520px) and a larger default (~300px). Replaces the fixed 228px. Keep the existing collapse toggle.

### B. Hide per-message action icons (off by default)
- **Where:** `packages/ui/src/chat/components/ChatMessages/ChatMessages.tsx` `AssistantMessage`, the `.niuu-chat-action-bar` (lines ~187–238): thumbs-up/down, regenerate, bookmark, copy (lucide-react icons).
- **Do:** gate the whole action bar on `showMessageActions` (default `false`). They're noise; off by default compacts the flow to just text.

### C. Copy → hover-revealed control
- **Where:** same component; `handleCopy` (~128–131), copy button currently in the action bar.
- **Do:** when `copyMode==='hover'`, render a single small copy control that appears on message hover, positioned near the message (right edge, or by the avatar/hammer on the left) — not a persistent row. Reuse `useCopyFeedback`.

### D. Timestamp → hover-revealed, right-aligned; text starts at top
- **Where:** `.niuu-chat-timestamp` (line ~141) inside `.niuu-chat-assistant-header`; CSS `ChatMessages.css` (~3–7, header ~120–125).
- **Do:** when `timestamp==='hover'`, move the time to the right edge of the message block, shown only on hover; remove it from the header flow so `.niuu-chat-assistant-content` starts at the very top (drop the header's reserved vertical space / `gap`).

### E. Agent avatar + name optional (hidden by default)
- **Where:** `.niuu-chat-avatar` + `Hammer` icon (lines ~135–137); room persona label in `RoomMessage.tsx` `ParticipantLabel` (~32–55).
- **Do:** gate the assistant avatar/name on `showAgentAvatar` (default `false`). The left speaker is always the agent, so it's redundant; hiding it reclaims the left gutter and compacts the row. (Room/multi-agent mode keeps persona labels — those are meaningful.)

### F. Codex-style foldable intermediary + tool-call messages
- **Two message classes:** (1) intermediary assistant chatter, (2) tool-call / activity messages (the agent working).
- **Do:** by default (`foldIntermediate`), collapse everything between the user's prompt and the final answer into one Codex-style frame: a **"Worked for `<duration>`"** header + a collapsed disclosure containing all intermediary messages, tool calls, and activity. Default view per turn = **(1) what you asked → (2) "Worked for Xs" → (3) the final answer.**
- **The "final answer" message:** you're right that it's a distinct, taggable message in the transcript. In **Claude Code** the turn's terminal `result`/last assistant message (stop_reason `end_turn`) is the answer; in **Codex** it's the final `agent_message` on `turn.completed`. We tag the turn's last assistant message as `final` and render it prominently; everything prior in the turn folds. Duration = turn start→`result`/`turn.completed` (both expose it). *Implementation note:* this is the biggest item — it changes how the message list groups events into turns; needs the message stream to expose turn boundaries + the terminal-message marker (confirm `useSkuldChat` carries `stop_reason`/result + tool_use/tool_result typing).

### G. Left session list: hide archived, collapse "Stopped", show active
- **Where:** `packages/plugin-volundr/src/ui/SessionsPage.tsx` left list.
- **Do:** default `hideArchived: true` (archived never shown). Stopped sessions collapse into a **"Stopped"** group, collapsed by default; active/running sessions show ungrouped at top.
- **Env behavior (open question — see below):** "in our current environment anything stopped moves to archived." If we auto-archive stopped, the left list effectively shows only active (the Stopped group stays empty/hidden). This can be a periodic call to the existing `POST /api/v1/forge/sessions/archive-stopped`, or a Volundr-side policy. **Tension:** earlier the 23 `stopped` sessions were called "the ones we're using" and kept; this item says stopped→archived. Confirm before auto-archiving them.

## Build / preview reality
The niuu instance on `:8080` serves a **prebuilt** web-next bundle, so edits aren't visible until we either (a) run a **vite dev server** from this worktree on a tailnet port for live review, or (b) rebuild the bundle and have niuu serve it. Either needs `pnpm install` in the worktree first (fresh worktree, no `node_modules`).

## Open questions for review
1. **Review loop:** live vite preview on a tailnet port (see changes instantly) vs build-and-serve each batch?
2. **Auto-archive stopped (item G):** also archive the current 23 stopped now (apply the policy), or keep them and only auto-archive going forward, or just collapse (no auto-archive)?
3. **Settings surface:** prefs hook only (localStorage) for now, or also expose toggles in the Settings plugin UI?
4. **Scope of F:** is the Codex-style fold v1 (it's the largest change), or do B–E + A + G land first and F follows?
