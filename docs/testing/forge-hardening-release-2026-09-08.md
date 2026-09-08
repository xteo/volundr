# Forge reliability release — September 8, 2026

Status: source validation complete; rollout and live acceptance pending.
Release identity: `forge-2026.09.08.1`. Matching Lexi iOS/macOS build: 2236.

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

## Source validation

| Gate | Result |
|---|---|
| `scripts/verify_forge.py unit --coverage` | 4,714 passed; 85.13% combined line/branch coverage, unchanged 85% threshold |
| Additional main/health/build identity tests | 114 passed |
| Shared-workspace process/log/archive checks | 139 passed |
| Real PostgreSQL delivery/schema checks | 9 passed in isolated schemas; user tables untouched |
| Forge web | 831 passed across 52 files; zero stderr bytes |
| ForgeKit | 274 tests across 46 suites; 5 opt-in real socket/corpus checks passed |
| Selected iOS app simulator suites | 323 unique tests passed; final followup run: 139 passed |

The backend gate records 24 skips, 81 deselections and one expected live-Claude xfail.
These are recorded exclusions, not executed acceptance. Source checks and focused tests
cover the subsequent append-only diagnostic-log and empty-migration-directory fixes.
The corpus has 12 fixtures, 37 turns and 1,309 frames. Actual native socket testing
reproduced the former code-1009 failure on a 2,200,171-byte frame before validating the fix.

Primary private artifacts: `.forge-results/fable-broker-release-gate`,
`/tmp/forge-web-act-clean-gate/warning-validation.json`, and
`/tmp/forge-hardening-20260908`. Native logs, credentials, and production backups are
excluded from committed fixtures.

## Rollout preservation

The retained set comprises `agents-brain`, `lexi-ios-agent`, `agents-astra`,
`lexi-ios-astra-recovered`, and `lexi-ios-fable-review-20260908`.
Two legacy Claude rows require correcting a tmux-name placeholder to an already verified
native UUID while their old brokers are stopped. Session origins and definitions stay intact.

The recovery backup contains the entire database schema and metadata, separately streamed
raw events for the five retained sessions, local conversation caches and native traces. The
first frozen raw backup contains 429,148 events. The main process upgrade must preserve old
brokers long enough to drain them through the healthy new API; each retained broker then
restarts on the new source with its original native conversation.

`agents-brain` has 413,522 raw frames, predominantly terminal frames, exceeding default
full-log hydration budgets. Its validated 89-turn local cache is retained; a failed bounded
hydration must not erase it. This release does not claim unlimited raw-history hydration.

## Remaining acceptance

1. Commit/tag and launch the reviewed source; inspect all migration checksums and every
   platform/broker revision, native ID and preserved history prefix.
2. Run fresh live Claude tmux and Codex agentic canaries, delivery/restart/question faults,
   native continuity, full/lazy tool output, and PostgreSQL/replay comparison.
3. Inspect the original recovered session in the actual iOS app, and retain clean build
   screenshots plus live fault evidence.
4. Validate on a physical iPhone, including prolonged outage/background and memory behavior.
   Both paired phones were unavailable during simulator validation; this remains explicit.
5. Archive and validate both Apple targets, upload build 2236, and verify App Store Connect
   processing and TestFlight availability. A passed test suite is not a completed release.

The working Thor Tailscale origin has a documented temporary DNS exception in the iOS
source/changelog until `forge.xteo.mesh` and on-device resolution are provisioned together.
