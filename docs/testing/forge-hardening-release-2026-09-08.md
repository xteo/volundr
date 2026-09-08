# Forge reliability release — September 8, 2026

Status: candidate `.1` deployed and live-tested; candidate `.2` closes issues found by that campaign.
Release identity: `forge-2026.09.08.2`. Matching Lexi iOS/macOS build: 2237.

This release implements the accepted Astra endpoint findings and Claude Fable 5.1 xhigh
review. Active-provider acceptance covers Claude tmux and Codex. Legacy Claude SDK/Scody
remains in compatibility maintenance; affected shared Muse paths retain regression coverage.

## Changed contracts

- Client request IDs survive REST retries. PostgreSQL claims precede native dispatch;
  competing dispatchers cannot reuse a claim. Definite refusals may retry, while a lost native
  acknowledgment remains pending. HTTP 202 is preserved through the Forge facade.
- Question errors and acceptance carry request IDs. Invalid or stale IDs cannot resolve another
  question. Recovered native controls remain visible but require reissue when their original
  RPC/menu no longer exists. Cleanup alone does not confirm an answer.
- Codex turn/thread/request identity survives capture. Only correlated native consumption
  activates Codex input. The live conversation, disk snapshot and raw-log rebuild retain its ID.
- Native Codex WebSocket input defaults to a separate 16 MiB cap. Browser output remains
  bounded at 900 KiB, with complete tool output retained for lazy REST expansion.
- Startup versus confirmed death uses distinct close codes. Health identifies the startup
  revision, source hash and release, and returns degraded status for failed plugin startup.
- Transactional migration history records immutable checksums under a serialized startup lock.
  Existing renamed schemas are verified before adoption; ambiguous legacy data blocks startup.
  Empty/missing migration bundles fail visibly. The duplicate raw-log index is removed.
- Recovered turns retain native-import provenance. Valid resumed Claude UUIDs are available
  before idle heartbeats; a tmux name is never persisted as a native session identity.
- Starting a sibling session in the same workspace appends to the existing diagnostic log.
- Codex search completion enriches the original tool ID with its actual query/action and opaque
  native results. Live, persisted and browser folds retain one card and its original timing.
- Linux Codex children receive a parent-death signal. A per-session ownership lease permits
  reclaiming only an orphan with a verified PID/start identity, workspace, exact command and
  nonce; live owners, PID reuse and ambiguous ownership fail closed without a new thread.
- Claude TTY answers must match the pending card's declared choices and current menu before
  any key is sent. Explicit free text uses its native menu entry. Duplicate advisory permission
  hooks for the same pending bypass-mode question do not create a second card. Permission
  cards are labeled explicitly, and question fixtures never automatically answer them.

## Source validation

| Gate | Result |
|---|---|
| Final `.2` `scripts/verify_forge.py unit --coverage` | 4,801 passed; 85.35% combined line/branch coverage, unchanged 85% threshold; all 45 Skuld source hashes unchanged during the run |
| Additional main/health/build identity tests | 114 passed |
| Shared-workspace process/log/archive checks | 139 passed |
| Real PostgreSQL delivery/schema checks | 9 passed in isolated schemas; user tables untouched |
| Forge web | 834 passed across 52 files; zero stderr bytes; ESLint and TypeScript clean |
| ForgeKit | 274 tests across 46 suites; 5 opt-in real socket/corpus checks passed |
| Selected iOS app simulator suites | 323 unique tests passed; final followup run: 139 passed |

The backend gate records 24 skips, 81 deselections and one expected live-Claude xfail.
These are recorded exclusions, not executed acceptance. Source checks and focused tests
cover the subsequent append-only diagnostic-log and empty-migration-directory fixes.
The corpus has 12 fixtures, 37 turns and 1,309 frames. Actual native socket testing
reproduced the former code-1009 failure on a 2,200,171-byte frame before validating the fix.

Primary private artifacts: `.forge-results/fable-broker-release-gate`,
`.forge-results/fable-candidate-2-tty-final-gate`,
`/tmp/forge-web-act-clean-gate/warning-validation.json`, and
`/tmp/forge-hardening-20260908`. Native logs, credentials, and production backups are
excluded from committed fixtures.

## Rollout preservation

The retained set comprises `agents-brain`, `lexi-ios-agent`, `agents-astra`,
`lexi-ios-astra-recovered`, and `lexi-ios-fable-review-20260908`.
Two legacy Claude rows were corrected from a tmux-name placeholder to an already verified
native UUID while their old brokers were stopped. Session origins and definitions stayed intact.

The recovery backup contains the entire database schema and metadata, separately streamed
raw events for the five retained sessions, local conversation caches and native traces. The
first frozen raw backup contains 429,148 events. Candidate `.1` preserved all five brokers across
the main restart, then restarted each on the new source with its original native conversation.
All 55 migration checksums match source. Every original raw event was compared byte-for-byte
after rollout; all 429,148 matched. All original turn IDs, text and paired tool IDs remained.

`agents-brain` has 413,522 raw frames, predominantly terminal frames, exceeding default
full-log hydration budgets. Its validated 89-turn local cache is retained; a failed bounded
hydration must not erase it. This release does not claim unlimited raw-history hydration.

## Executed live acceptance and limits

The complete `.1` catalogs passed 9/10 Claude tmux and 10/11 Codex scenarios. Both providers
lacked a usable native planning tool in these actual sessions; those capability failures remain
recorded. Claude emitted 1,323 public frames and Codex 1,164; complete PostgreSQL-to-public-log
and replay comparisons matched. Core command/search/worker/recovery/formatting/continuity
scenarios ran against real CLIs. Claude's main assistant was Fable 5.1; its spawned workers chose
Opus 5, which is retained in the provenance rather than labeled Fable.

Semantic inspection found missing Codex search inputs/results despite successful mechanical
frame parity; `.2` repairs capture and strengthens the harness. A real Codex broker SIGKILL also
left an orphaned native writer that blocked same-thread resume; `.2` adds ownership and
parent-death handling. The failed catalog and crash artifacts remain unchanged for comparison.

Claude's hooks omit two pre-execution TaskOutput validation failures present in its native log.
All hook-emitted tool pairs were preserved; this remains a provider capture limitation. Claude's
native output clipped before the 1 MiB test target. Codex supplied a 1,048,606-byte result, itself
containing a native omission marker. Forge preserves provider output; neither proves that the
provider retained unlimited command output.

The actual iOS build opened `lexi-ios-astra-recovered` and displayed its native-import history
notice. A read-only fault proxy then forced first-load HTTP 503 and 11 failed socket connections
over 178 seconds. The app displayed Retry; after restoring the origin, tapping Retry loaded the
real transcript and established a new socket. Private screenshots and request logs are retained.
An established socket then exhausted another ten retries while loaded history and an exact
unsent draft remained visible. Foregrounding after connectivity returned opened a new socket,
cleared the interruption notice and preserved both history and draft. The fault proxy changes
displayed origin URLs for routing and does not prove byte-identical client text. Server-side
byte comparisons are separate. These simulator results do not substitute for physical iPhone QA.

Build 2236 passed iOS and macOS archive/export/Apple validation without upload. The live outage
capture then exposed a connection notice overlapping transcript text; build 2237 corrects its
readability before upload. The 2236 tag and artifacts remain intact as an unshipped candidate.

## Remaining acceptance

1. Commit/tag and launch candidate `.2`; inspect all migration checksums and every
   platform/broker revision, native ID and preserved history prefix.
2. Repeat the affected native search, crash recovery and question fault checks on `.2`,
   including native continuity, lazy output and PostgreSQL/replay comparison.
3. Retain clean build screenshots and finish the remaining live fault evidence.
4. Validate on a physical iPhone, including prolonged outage/background and memory behavior.
   Both paired phones were unavailable during simulator validation; this remains explicit.
5. Archive and validate both Apple targets, upload build 2237, and verify App Store Connect
   processing and TestFlight availability. A passed test suite is not a completed release.

The working Thor Tailscale origin has a documented temporary DNS exception in the iOS
source/changelog until `forge.xteo.mesh` and on-device resolution are provisioned together.
