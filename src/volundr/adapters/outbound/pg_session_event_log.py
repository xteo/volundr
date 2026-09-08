"""PostgreSQL adapter for the durable, append-only session event log.

Implements :class:`SessionEventLogRepository`. Writes are idempotent on
(session_id, seq) via ON CONFLICT DO NOTHING, so the producer (skuld) can retry
at-least-once without creating duplicates. Reads are cursor-based (seq) so any
client can resume a full transcript replay.
"""

import hashlib
import json
import logging
from dataclasses import replace
from datetime import UTC, datetime
from uuid import UUID

import asyncpg

from volundr.adapters.outbound._jsonb import dumps_jsonb, force_scrub_json, scrub_text
from volundr.domain.history_import import (
    HistoryImportConflictError,
    HistoryImportSessionNotFoundError,
    HistoryImportValidationError,
)
from volundr.domain.models import SessionLogEntry
from volundr.domain.ports import SessionEventLogRepository, _log_entries_conflict

logger = logging.getLogger(__name__)

_INSERT_SQL = """WITH locked_session AS MATERIALIZED (
           SELECT id FROM sessions WHERE id = $1 FOR UPDATE
       )
       INSERT INTO session_event_log
       (session_id, seq, kind, role, request_id, payload, ts)
       SELECT $1, $2, $3, $4, $5, $6, $7
       FROM (SELECT COUNT(*) FROM locked_session) AS lock_guard
       ON CONFLICT (session_id, seq) DO NOTHING"""

_IMPORT_INSERT_SQL = """INSERT INTO session_event_log
       (session_id, seq, kind, role, request_id, payload, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7)"""

_HISTORY_IMPORT_IDLE_STATUSES = frozenset({"created", "stopped", "failed"})
_HISTORY_IMPORT_CHROME_KINDS = ("init", "capabilities", "available_commands")


class PostgresSessionEventLog(SessionEventLogRepository):
    """PostgreSQL adapter for the full-fidelity session event log."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def append(self, entries: list[SessionLogEntry]) -> int:
        if not entries:
            return 0
        # executemany is atomic: each insert takes the same session-row lock as
        # import_history, held until the batch finishes. Stable session ordering
        # avoids deadlocks between multi-session batches, without a global lock.
        # The COUNT guard preserves orphan-log writes (there is deliberately no FK).
        args = [self._entry_to_args(e) for e in sorted(entries, key=lambda e: str(e.session_id))]
        try:
            await self._pool.executemany(_INSERT_SQL, args)
        except asyncpg.exceptions.UntranslatableCharacterError:
            # Defensive: a frame still carried a character Postgres can't store
            # past the primary scrub. Force-scrub the serialized payloads and retry
            # once so one bad frame never drops the whole batch (ON CONFLICT keeps
            # this idempotent if some rows already landed).
            logger.warning("session_event_log insert hit untranslatable char; retrying scrubbed")
            scrubbed = [self._force_scrub_args(a) for a in args]
            await self._pool.executemany(_INSERT_SQL, scrubbed)
        return len(entries)

    async def import_history(
        self, session_id: UUID, source_id: str, entries: list[SessionLogEntry]
    ) -> int:
        """Atomically append one native history to an idle, transcript-empty session.

        Existing connect/init rows retain their seqs. Imported frames receive new
        seqs in caller order, retaining their original timestamps. The final marker
        is committed in the same transaction, making retries idempotent without
        accepting a partial import or merging independent conversations.
        """
        self._validate_history_import(session_id, source_id, entries)
        snapshot = self._history_snapshot(entries)
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT status FROM sessions WHERE id = $1 FOR UPDATE", session_id
                )
                if row is None:
                    raise HistoryImportSessionNotFoundError(f"Session {session_id} does not exist")
                markers = await conn.fetch(
                    """SELECT payload FROM session_event_log
                       WHERE session_id = $1 AND kind = 'history_import'""",
                    session_id,
                )
                if markers:
                    self._check_history_source(markers, source_id, snapshot)
                    return 0
                if row["status"] not in _HISTORY_IMPORT_IDLE_STATUSES:
                    raise HistoryImportConflictError(
                        f"Session {session_id} must be created, stopped, or failed before import"
                    )
                captured = await conn.fetchrow(
                    """SELECT seq, kind FROM session_event_log
                       WHERE session_id = $1 AND NOT (
                           kind = ANY($2::text[]) OR (
                               kind = 'system' AND (
                                   COALESCE(payload->>'subtype', '') = 'init'
                                   OR payload @> '{"_per_connect_handshake": true}'::jsonb
                               )
                           )
                       ) ORDER BY seq LIMIT 1""",
                    session_id,
                    list(_HISTORY_IMPORT_CHROME_KINDS),
                )
                if captured is not None:
                    raise HistoryImportConflictError(
                        f"Session {session_id} already contains captured history "
                        f"at seq {captured['seq']} ({captured['kind']})"
                    )
                head = await conn.fetchval(
                    "SELECT MAX(seq) FROM session_event_log WHERE session_id = $1", session_id
                )
                head = int(head or 0)
                args = [
                    self._entry_to_args(replace(entry, seq=head + offset))
                    for offset, entry in enumerate(entries, start=1)
                ]
                marker = SessionLogEntry(
                    session_id=session_id,
                    seq=head + len(entries) + 1,
                    kind="history_import",
                    payload={
                        "type": "history_import",
                        "source_id": source_id,
                        **snapshot,
                    },
                    ts=datetime.now(UTC),
                )
                args.append(self._entry_to_args(marker))
                await self._insert_history_batch(conn, args)
        return len(entries)

    @staticmethod
    def _validate_history_import(
        session_id: UUID, source_id: str, entries: list[SessionLogEntry]
    ) -> None:
        if not isinstance(source_id, str) or not source_id.strip():
            raise HistoryImportValidationError("History source_id must be nonempty")
        if scrub_text(source_id) != source_id:
            raise HistoryImportValidationError("History source_id contains unsupported characters")
        if not entries:
            raise HistoryImportValidationError("Native history contains no frames to import")
        for entry in entries:
            if entry.session_id != session_id:
                raise HistoryImportValidationError("Every imported frame must belong to the target")
            if entry.kind == "history_import":
                raise HistoryImportValidationError(
                    "Imported frames cannot contain an import marker"
                )

    @staticmethod
    def _history_snapshot(entries: list[SessionLogEntry]) -> dict:
        """Fingerprint source order and content, independent of destination cursors."""
        digest = hashlib.sha256()
        partial = False
        for entry in entries:
            payload = dict(entry.payload)
            # Some adapters include the destination session in the wire frame;
            # that provisional UUID is not part of native transcript identity.
            if payload.get("session_id") == str(entry.session_id):
                payload.pop("session_id")
            provenance = payload.get("metadata", {}).get("native_import", {})
            partial = partial or bool(provenance.get("partial"))
            record = {
                "kind": entry.kind,
                "role": entry.role,
                "request_id": entry.request_id,
                "payload": payload,
                "ts": entry.ts.astimezone(UTC).isoformat(),
            }
            try:
                encoded = json.dumps(
                    record,
                    sort_keys=True,
                    separators=(",", ":"),
                    ensure_ascii=True,
                    allow_nan=False,
                ).encode("utf-8")
            except (TypeError, ValueError) as exc:
                raise HistoryImportValidationError("Native history contains invalid JSON") from exc
            digest.update(encoded)
            digest.update(b"\n")
        return {"snapshot_sha256": digest.hexdigest(), "count": len(entries), "partial": partial}

    @staticmethod
    def _check_history_source(markers: list, source_id: str, snapshot: dict) -> None:
        for marker in markers:
            payload = marker["payload"]
            if isinstance(payload, str):
                payload = json.loads(payload)
            if not isinstance(payload, dict) or payload.get("source_id") != source_id:
                raise HistoryImportConflictError(
                    "Session already imported a different history source"
                )
            if any(payload.get(key) != value for key, value in snapshot.items()):
                raise HistoryImportConflictError(
                    "Native history snapshot changed since import; stored history was not modified"
                )

    async def _insert_history_batch(self, conn: asyncpg.Connection, args: list[tuple]) -> None:
        try:
            # Savepoint rollback keeps the surrounding import transaction usable
            # for the defensive scrub retry, without releasing its session lock.
            async with conn.transaction():
                await conn.executemany(_IMPORT_INSERT_SQL, args)
        except asyncpg.exceptions.UntranslatableCharacterError:
            logger.warning("history import hit untranslatable char; retrying scrubbed")
            await conn.executemany(_IMPORT_INSERT_SQL, [self._force_scrub_args(a) for a in args])

    async def read_after(
        self,
        session_id: UUID,
        after_seq: int = 0,
        limit: int = 1000,
    ) -> list[SessionLogEntry]:
        rows = await self._pool.fetch(
            """SELECT session_id, seq, kind, role, request_id, payload, ts
               FROM session_event_log
               WHERE session_id = $1 AND seq > $2
               ORDER BY seq ASC
               LIMIT $3""",
            session_id,
            after_seq,
            limit,
        )
        return [self._row_to_entry(r) for r in rows]

    async def latest_seq(self, session_id: UUID) -> int:
        value = await self._pool.fetchval(
            "SELECT MAX(seq) FROM session_event_log WHERE session_id = $1",
            session_id,
        )
        if value is None:
            return 0
        return int(value)

    async def detect_conflicts(self, entries: list[SessionLogEntry]) -> list[int]:
        """Surface seqs whose STORED row differs from the candidate (INV-3c).

        Cold path only — never called from ``append``/``_flush``. One bounded,
        parameterized SELECT per session over exactly the candidate seqs (no N+1,
        no scan). ``append`` (ON CONFLICT DO NOTHING) is untouched, so the
        at-least-once retry stays an idempotent same-payload no-op.
        """
        if not entries:
            return []

        by_session: dict[UUID, dict[int, SessionLogEntry]] = {}
        for entry in entries:
            by_session.setdefault(entry.session_id, {})[entry.seq] = entry

        conflicts: list[int] = []
        for session_id, candidates in by_session.items():
            rows = await self._pool.fetch(
                """SELECT session_id, seq, kind, role, request_id, payload, ts
                   FROM session_event_log
                   WHERE session_id = $1 AND seq = ANY($2::bigint[])""",
                session_id,
                list(candidates),
            )
            for row in rows:
                stored = self._row_to_entry(row)
                candidate = candidates.get(stored.seq)
                if candidate is None:
                    continue
                if _log_entries_conflict(candidate, stored):
                    conflicts.append(stored.seq)
        conflicts.sort()
        return conflicts

    # -- Internal helpers -----------------------------------------------------

    @staticmethod
    def _entry_to_args(entry: SessionLogEntry) -> tuple:
        # Scrub the text columns too — kind/role/request_id are plain text and a
        # NUL there 500s the insert just like the JSONB payload does.
        return (
            entry.session_id,
            entry.seq,
            scrub_text(entry.kind),
            scrub_text(entry.role),
            scrub_text(entry.request_id),
            dumps_jsonb(entry.payload),
            entry.ts,
        )

    @staticmethod
    def _force_scrub_args(args: tuple) -> tuple:
        """Belt-and-suspenders rebuild of one row's args for the retry path: the
        payload ($6) is an already-serialized JSON string, force-scrubbed of any
        residual escaped NUL/surrogate; the text columns re-scrubbed."""
        session_id, seq, kind, role, request_id, payload, ts = args
        return (
            session_id,
            seq,
            scrub_text(kind),
            scrub_text(role),
            scrub_text(request_id),
            force_scrub_json(payload),
            ts,
        )

    @staticmethod
    def _row_to_entry(row: asyncpg.Record) -> SessionLogEntry:
        payload = row["payload"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        return SessionLogEntry(
            session_id=row["session_id"],
            seq=row["seq"],
            kind=row["kind"],
            payload=payload,
            ts=row["ts"],
            role=row["role"],
            request_id=row["request_id"],
        )
