# ux-update — Compact Forge UI + frontier-model defaults

> **Branch:** `lexi/ux-update` (off `dev`).
> **Purpose:** make the niuu web-next Forge experience compact and usable on a
> single host, and default the platform to frontier models (Opus 4.8 / Codex)
> across volundr/forge. Sonnet/Haiku stay in the catalog for other users.

All "compact" behaviors live behind small prefs hooks that read `localStorage`
(no rebuild to flip), so the diff is contained and reversible.

## Frontier-model defaults

Default everywhere is **`claude-opus-4-8`** (Codex sessions use `gpt-5.5`). The
older models are kept in the catalog so other users can still pick them.

| File | Change |
|---|---|
| `src/bifrost/config.py` | Add `claude-opus-4-8` `ManagedModelConfig` at the top of `_default_models`. Opus 4.7 / Sonnet 4.6 / Haiku 4.5 / Opus 4.6 retained. |
| `src/skuld/config.py` | `SkuldSessionConfig.model` default → `claude-opus-4-8`; the coupled MODEL-env sentinel updated in lockstep so the override still fires. |
| `src/skuld/transports/codex_ws.py` | `__init__` now accepts `reasoning_effort` and `fast_mode` (were swallowed by `**_kwargs`); emits `thread_params["modelReasoningEffort"]` (extra-high/xhigh/max → `"high"`). |
| `src/volundr/config.py` | `skuldClaude.default_model` and `ChronicleConfig.summary_model` → `claude-opus-4-8`. |
| `src/volundr/adapters/outbound/local_process.py` | `DEFAULT_MAX_CONCURRENT` 4 → 8; drop the hardcoded sonnet fallback. |
| `web-next/.../LaunchWizard.tsx` | Form default model, `pickDefaultModel`, fallback definitions and placeholder all → `claude-opus-4-8`. |

## Compact chat UX — `getCompactUxChatPrefs` (`packages/ui/src/chat/compactUxPrefs.ts`)

`localStorage` keys live under the `niuu.compactUx.*` namespace. Defaults make the
chat view compact; each flips back on at runtime.

| Pref | Default | Controls |
|---|---|---|
| `showMessageActions` | `false` | 👍/👎 / regenerate / bookmark / copy row under each message |
| `showAgentAvatar` | `false` | the Hamr/Völundr avatar + name beside assistant messages |
| `timestamp` | `hover` | `hover` (right-aligned, on hover) / `always` / `never` |
| `copyMode` | `hover` | hover control near the message vs the inline action row |
| `conversationView` | `compact` | Codex-style fold: question → "Worked" disclosure → final answer |

The conversation fold (`SessionChat.tsx`) collapses everything between the
prompt and the terminal assistant message into one "Worked for `<duration>`"
disclosure; a per-turn toggle expands it. `expanded` turns (or `showInternal`)
render the full event stream.

## Operator vs debug metadata — `getShowDebugMeta` (`packages/plugin-volundr/src/ui/uxPrefs.ts`)

Platform plumbing (forge/cluster IDs, pod GUIDs, owner ids, the Forge badge and
metric) is noise for the operator. Hidden by default; reveal with
`niuu.compactUx.showDebugMeta = "1"`. Gated in `LiveSessionDetailPage.tsx`,
`SessionsPage.tsx`, and `ForgePage.tsx`.

## Session list — `SessionsPage.tsx`

- Active/running sessions show at the top; **STOPPED** and **ARCHIVED** groups
  fold by default (`DEFAULT_FOLDED_GROUPS`).
- Multi-select delete for stopped sessions: a selection toggle reveals
  per-row checkboxes. Entering selection mode force-unfolds the STOPPED group so
  its rows are selectable.
- Row affordances (stop / archive) appear on hover; active-work rows pulse; zebra
  striping by index.

## Same-origin session transport

- `apps/niuu/vite.config.ts` proxies `/s/` (and the rest of the API surface) to
  the backend with `ws: true`, so session history + WebSocket are same-origin in
  dev (fixes CORS). `host: true` / `allowedHosts: true` for tailnet access.
- `apps/niuu/src/services.ts` points the aggregate adapter base at
  `${sharedApiBase}/forge`. The `/niuu/volundr` create path returns 503 in this
  environment; `/forge` returns 201 (verified against the live backend).

## Naming

The prefs module was renamed `lexiUxPrefs.ts` → `compactUxPrefs.ts` and its
exports/keys de-branded (`niuu.lexiUx.*` → `niuu.compactUx.*`). No "Lexi" naming
remains in niuu source.
