# Reviewed live Forge corpus

Captured on 2026-09-07 and 2026-09-08 from real Claude/tmux and Codex sessions.
These fixtures contain synthetic task data and reviewed literal path redactions.
Each expectations file pins the exported hash, source provenance, assertions,
expected turns, checkpoint cursors, and reviewer notes.

Serve with `make forge-trace-lab`. Discover cases at
`GET /api/v1/forge/replay/catalog`. Connect to
`ws://127.0.0.1:8767/api/v1/forge/replay/fixtures/<case>` for playback.

The September 7 source runs retain a deployment-level failure: the running platform had not
yet loaded the public replay-facade fix. A valid scenario fixture does not hide
that failure or certify iOS rendering. The September 8 free-text question case
comes from a passing run after the Lexi Astra capture/recovery fix.

| Case | Frames | Expected turns |
|---|---:|---:|
| [claude-tmux / agents](claude-tmux-agents-c8656d2372.frames.json) | 388 | 6 |
| [claude-tmux / background](claude-tmux-background-0dc1b5bccf.frames.json) | 69 | 3 |
| [claude-tmux / presentation](claude-tmux-presentation-5661c0f978.frames.json) | 31 | 4 |
| [claude-tmux / question](claude-tmux-question-ba5eae7a7f.frames.json) | 74 | 3 |
| [claude-tmux / recovery](claude-tmux-recovery-708373ae98.frames.json) | 70 | 5 |
| [claude-tmux / workspace](claude-tmux-workspace-2544ad8b84.frames.json) | 91 | 4 |
| [codex / agents](codex-agents-da06fa93af.frames.json) | 248 | 2 |
| [codex / background](codex-background-b27deac17e.frames.json) | 56 | 2 |
| [codex / long-output](codex-long-output-27c14b62bb.frames.json) | 70 | 2 |
| [codex / question](codex-question-3c651f5bc0.frames.json) | 63 | 2 |
| [codex / question-freeform](codex-question-freeform-784c2d0311.frames.json) | 77 | 2 |
| [codex / workspace](codex-workspace-f7572f15f7.frames.json) | 72 | 2 |

See the [acceptance plan](../../../docs/testing/forge-live-agentic-acceptance.md)
for the iOS replay matrix, review process, and live commands.
