"""Make Ravn look like an OpenClaw gateway to the LexiChat iOS app.

Rather than teaching LexiChat about Ravn, this teaches Ravn to speak the
protocol LexiChat already implements. The payoff is that Ravn conversations
arrive in the same channel list, the same ``ChatScreen``, the same transcript
and the same composer as OpenClaw ones — with no Swift on the chat data path.

Why in-process rather than a separate bridge
--------------------------------------------
This channel holds the same :class:`RavnGateway` instance that the Telegram and
HTTP channels hold, and calls ``handle_message_stream`` directly. An
out-of-process bridge could only reach Ravn through ``POST /chat``, and that
path has a defect that makes it unusable as a foundation: a client disconnect
cancels ``run_turn`` mid-tool and skips ``drain()``, leaving a stale sentinel
that makes the *next* turn on that session return an empty stream while
executing in full. Going in-process avoids that entirely — and gives us the
per-session lock, the real event objects, and a turn whose life is not tied to
any socket.

Shape notes that are easy to get wrong
--------------------------------------
* The WebSocket is at the **root path**. ``GatewayConfig.webSocketURL`` builds
  ``ws://host:port`` with no path component.
* ``GET /health`` must return both ``ok`` and ``status`` — both are
  non-optional in Swift's ``HealthResponse``, so omitting either makes the probe
  fail to decode and the gateway reads as down.
* The challenge is pushed **unprompted and first**. The client has no timeout
  waiting for it.
* Ticks continue **during** a turn. Only ``hello-ok`` and ``tick`` reset the
  client's watchdog; chat events do not.
* The client speaks ``ws://`` and ``http://`` only — both schemes are hardcoded
  in ``Gateway``. There is no TLS option, so bind to the tailnet, never public.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import uuid
from typing import TYPE_CHECKING, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from ravn.adapters.channels.openclaw_protocol import (
    SCOPES,
    TICK_EMIT_SECONDS,
    DeviceAuthError,
    ErrorCodes,
    challenge_frame,
    error_frame,
    event_frame,
    hello_ok_payload,
    mint_device_token,
    new_nonce,
    response_frame,
    verify_device_challenge,
)
from ravn.adapters.channels.openclaw_store import OpenClawStore, now_ms
from ravn.adapters.channels.openclaw_translate import TurnTranslator

if TYPE_CHECKING:
    from ravn.adapters.channels.gateway import RavnGateway

logger = logging.getLogger(__name__)

SERVER_VERSION = "ravn-openclaw-shim/0.1.0"

#: RPCs we advertise in hello-ok. Deliberately small and honest: advertising a
#: method we answer with an error is worse than not advertising it, because the
#: app lights up an affordance that cannot work.
SUPPORTED_METHODS = [
    "connect",
    "health",
    "agents.list",
    "sessions.list",
    "sessions.subscribe",
    "sessions.messages.subscribe",
    "chat.history",
    "chat.send",
]


class OpenClawGateway:
    """A WebSocket server that speaks OpenClaw and executes on Ravn."""

    def __init__(
        self,
        config: Any,
        gateway: RavnGateway,
        *,
        store: OpenClawStore | None = None,
        agent_id: str | None = None,
    ) -> None:
        self._config = config
        self._gateway = gateway
        self._agent_id = agent_id or getattr(config, "agent_id", None) or "travis"
        self._store = store or OpenClawStore(
            getattr(config, "store_path", "~/.ravn/openclaw/state.db")
        )
        self._token = self._resolve_token()
        self._prefix = getattr(config, "session_prefix", None) or f"agent:{self._agent_id}:"
        self._max_sessions = int(getattr(config, "max_live_sessions", 32))
        self._conns: set[_Connection] = set()
        self._app = self._build_app()
        self._seed_main_session()

    # -- config ------------------------------------------------------------

    def _resolve_token(self) -> str:
        env = getattr(self._config, "token_env", "RAVN_OPENCLAW_TOKEN")
        token = os.environ.get(env, "")
        if not token:
            logger.warning(
                "%s is unset — the OpenClaw shim will refuse every connect. "
                "Set it to the same value as OPENCLAW_API_TOKEN_RAVN in "
                "lexi-agent-service/.env.",
                env,
            )
        return token

    @property
    def main_session_key(self) -> str:
        return f"{self._prefix}main"

    def _seed_main_session(self) -> None:
        """Ensure one channel exists, so the app has something to show.

        A ``sessions.list`` row needs only a ``key`` to render a channel.
        """
        if self._store.get_session(self.main_session_key) is None:
            self._store.upsert_session(
                self.main_session_key,
                agent_id=self._agent_id,
                display_name=self._agent_id.capitalize(),
            )

    # -- lifecycle ---------------------------------------------------------

    async def run(self) -> None:
        import uvicorn

        host = getattr(self._config, "host", "127.0.0.1")
        port = int(getattr(self._config, "port", 18790))
        server = uvicorn.Server(
            uvicorn.Config(
                self._app,
                host=host,
                port=port,
                log_level="info",
                access_log=False,
                ws_ping_interval=None,  # we own the heartbeat
            )
        )
        logger.info("OpenClaw shim listening on %s:%s (agent=%s)", host, port, self._agent_id)
        await server.serve()

    # -- app ---------------------------------------------------------------

    def _build_app(self) -> FastAPI:
        app = FastAPI(title="Ravn OpenClaw shim", docs_url=None, redoc_url=None)

        @app.get("/health")
        async def health() -> dict[str, Any]:
            # Both fields are non-optional in Swift's HealthResponse.
            return {"ok": True, "status": "live"}

        @app.websocket("/")
        async def ws_root(websocket: WebSocket) -> None:
            await self._serve(websocket)

        return app

    async def _serve(self, websocket: WebSocket) -> None:
        conn = _Connection(self, websocket)
        self._conns.add(conn)
        try:
            await conn.run()
        except WebSocketDisconnect:
            pass
        except Exception:
            logger.exception("OpenClaw shim connection failed")
        finally:
            self._conns.discard(conn)
            await conn.aclose()

    # -- fan-out -----------------------------------------------------------

    async def broadcast(self, session_key: str, event: str, payload: dict[str, Any]) -> None:
        """Send an event to every connection subscribed to *session_key*."""
        for conn in list(self._conns):
            if conn.is_subscribed(session_key):
                await conn.send_event(event, payload)

    # -- accessors used by _Connection ------------------------------------

    @property
    def store(self) -> OpenClawStore:
        return self._store

    @property
    def token(self) -> str:
        return self._token

    @property
    def agent_id(self) -> str:
        return self._agent_id

    def owns_session_key(self, key: str) -> bool:
        """Only keys this shim minted are addressable.

        Ravn's ``get_or_create_session`` has no ownership check, and Telegram
        shares the same :class:`RavnGateway`. Without this allowlist a phone
        could pass ``telegram:8572736034`` and inject a turn into Damien's real
        thread, appending to its history.
        """
        return isinstance(key, str) and key.startswith(self._prefix)

    async def run_turn(self, session_key: str, message: str) -> str:
        """Start a Ravn turn and stream it to subscribers. Returns the run id."""
        run_id = f"run-{uuid.uuid4().hex[:16]}"
        self._store.append_message(
            session_key,
            message_id=f"{run_id}-user",
            role="user",
            blocks=[{"type": "text", "text": message}],
            run_id=run_id,
        )
        self._store.upsert_session(session_key, agent_id=self._agent_id, status="busy")
        # Detached on purpose: the turn's life is not tied to any socket, so
        # backgrounding the phone cannot cancel it mid-tool.
        asyncio.create_task(self._drive(session_key, message, run_id))
        return run_id

    _TERMINAL_STATES = frozenset({"final", "error", "aborted"})

    async def _emit(
        self, session_key: str, chats: list[dict[str, Any]], translator: TurnTranslator, run_id: str
    ) -> None:
        """Broadcast chat events, persisting the turn BEFORE any terminal one.

        Ordering matters more than it looks. ``ChatScreenModel`` reconciles
        against ``chat.history`` the moment a turn ends (the terminal-reconcile
        rail), so if the assistant row is written *after* the ``final`` event is
        broadcast, that refetch can race and find only the user message — and
        drop the answer the user just watched stream in.

        So: durable first, then tell anyone the turn is over.
        """
        for chat in chats:
            if chat.get("state") in self._TERMINAL_STATES:
                self._persist_turn(session_key, translator, run_id)
            await self.broadcast(session_key, "chat", chat)

    def _persist_turn(self, session_key: str, translator: TurnTranslator, run_id: str) -> None:
        blocks = translator.final_blocks()
        if not blocks:
            return
        # append_message is idempotent on message_id, so a re-entry (terminal
        # in the loop, then finish() in the finally) updates rather than dupes.
        self._store.append_message(
            session_key,
            message_id=run_id,
            role="assistant",
            blocks=blocks,
            run_id=run_id,
        )

    async def _drive(self, session_key: str, message: str, run_id: str) -> None:
        translator = TurnTranslator(session_key=session_key, run_id=run_id)
        reason = "stream closed"
        try:
            async for event in self._gateway.handle_message_stream(session_key, message):
                frame = {"type": str(event.type), "payload": event.payload}
                await self._emit(session_key, translator.ingest(frame), translator, run_id)
        except asyncio.CancelledError:
            reason = "cancelled"
            raise
        except Exception as exc:
            # RavnAgent emits no error events and _run_and_signal has no except,
            # so without this the turn would end in silence.
            logger.exception("Ravn turn failed for %s", session_key)
            reason = f"{type(exc).__name__}: {exc}"
        finally:
            # No-op when the turn already terminated cleanly; synthesizes an
            # error terminal when Ravn's stream just ended.
            await self._emit(session_key, translator.finish(reason=reason), translator, run_id)
            self._persist_turn(session_key, translator, run_id)
            self._store.upsert_session(session_key, agent_id=self._agent_id, status="idle")
            await self.broadcast(session_key, "sessions.changed", {"sessionKey": session_key})


class _Connection:
    """One WebSocket client: handshake, seq, heartbeat, RPC dispatch."""

    def __init__(self, gateway: OpenClawGateway, websocket: WebSocket) -> None:
        self._gw = gateway
        self._ws = websocket
        self._conn_id = str(uuid.uuid4())
        self._nonce = new_nonce()
        self._seq = 0
        self._authed = False
        self._device_id: str | None = None
        self._subscriptions: set[str] = set()
        self._subscribe_all = False
        self._tick_task: asyncio.Task | None = None
        self._send_lock = asyncio.Lock()

    # -- plumbing ----------------------------------------------------------

    async def _send(self, frame: dict[str, Any]) -> None:
        async with self._send_lock:
            await self._ws.send_text(json.dumps(frame))

    async def send_event(self, event: str, payload: dict[str, Any]) -> None:
        self._seq += 1
        await self._send(event_frame(event, payload, seq=self._seq))

    def is_subscribed(self, session_key: str) -> bool:
        return self._authed and (self._subscribe_all or session_key in self._subscriptions)

    async def aclose(self) -> None:
        if self._tick_task:
            self._tick_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._tick_task

    # -- run ---------------------------------------------------------------

    async def run(self) -> None:
        await self._ws.accept()
        # Unprompted and first: without this the client wedges in
        # .waitingForChallenge forever, with no reconnect and no error.
        await self._send(challenge_frame(self._nonce))

        while True:
            try:
                raw = await self._ws.receive_text()
            except WebSocketDisconnect:
                return
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if frame.get("type") != "req":
                continue
            await self._dispatch(frame)

    async def _heartbeat(self) -> None:
        """Tick forever, including mid-turn.

        The client kills the transport at 2.5x the advertised interval and only
        hello-ok and tick reset that watchdog — a long Ravn turn emitting chat
        events would otherwise look like silence.
        """
        try:
            while True:
                await asyncio.sleep(TICK_EMIT_SECONDS)
                await self.send_event("tick", {"ts": now_ms()})
        except asyncio.CancelledError:
            return
        except Exception:
            logger.debug("heartbeat ended", exc_info=True)

    # -- dispatch ----------------------------------------------------------

    async def _dispatch(self, frame: dict[str, Any]) -> None:
        req_id = str(frame.get("id") or "")
        method = str(frame.get("method") or "")
        params = frame.get("params") or {}

        if method == "connect":
            await self._on_connect(req_id, params)
            return

        if not self._authed:
            await self._send(error_frame(req_id, ErrorCodes.UNAUTHORIZED, "not connected"))
            return

        handlers = {
            "health": self._on_health,
            "agents.list": self._on_agents_list,
            "sessions.list": self._on_sessions_list,
            "sessions.subscribe": self._on_subscribe,
            "sessions.messages.subscribe": self._on_subscribe,
            "chat.history": self._on_chat_history,
            "chat.send": self._on_chat_send,
        }
        handler = handlers.get(method)
        if handler is None:
            # Must stay decodable and must NOT tear down the socket — verified
            # against the real gateway, and it is what lets a partial shim ship.
            await self._send(
                error_frame(
                    req_id,
                    ErrorCodes.UNSUPPORTED,
                    f"{method} is not implemented by the Ravn shim",
                    details={"method": method},
                )
            )
            return
        try:
            await handler(req_id, params)
        except Exception as exc:
            logger.exception("RPC %s failed", method)
            await self._send(
                error_frame(req_id, ErrorCodes.INTERNAL, f"{type(exc).__name__}: {exc}")
            )

    # -- handshake ---------------------------------------------------------

    async def _on_connect(self, req_id: str, params: dict[str, Any]) -> None:
        token = ((params.get("auth") or {}).get("token")) or ""
        if not self._gw.token or token != self._gw.token:
            # The client latches on UNAUTHORIZED and stops reconnecting, which
            # is correct: a wrong token will not fix itself.
            await self._send(error_frame(req_id, ErrorCodes.UNAUTHORIZED, "invalid gateway token"))
            await self._ws.close(code=1008)
            return

        device = params.get("device") or {}
        client = params.get("client") or {}
        scopes = list(params.get("scopes") or SCOPES)
        try:
            device_id = verify_device_challenge(
                device=device,
                client=client,
                scopes=scopes,
                token=token,
                expected_nonce=self._nonce,
            )
        except DeviceAuthError as exc:
            await self._send(
                error_frame(
                    req_id,
                    ErrorCodes.INVALID_REQUEST,
                    exc.message,
                    details={"reason": exc.reason},
                )
            )
            await self._ws.close(code=1008)
            return

        public_key = str(device.get("publicKey"))
        known = self._gw.store.known_public_key(device_id)
        if known is not None and known != public_key:
            # Cannot happen while the id is a hash of the key, but if the
            # derivation ever changes this is the check that stops impersonation.
            await self._send(error_frame(req_id, ErrorCodes.UNAUTHORIZED, "device key mismatch"))
            await self._ws.close(code=1008)
            return
        self._gw.store.remember_device(device_id, public_key, label=str(client.get("id") or ""))

        self._authed = True
        self._device_id = device_id
        logger.info("openclaw shim: device %s (%s) connected", device_id[:12], client.get("id"))
        await self._send(
            response_frame(
                req_id,
                hello_ok_payload(
                    server_version=SERVER_VERSION,
                    conn_id=self._conn_id,
                    device_token=mint_device_token(device_id, self._gw.token),
                    agent_id=self._gw.agent_id,
                    main_session_key=self._gw.main_session_key,
                    methods=SUPPORTED_METHODS,
                ),
            )
        )
        self._tick_task = asyncio.create_task(self._heartbeat())

    # -- read-only RPCs ----------------------------------------------------

    async def _on_health(self, req_id: str, _params: dict[str, Any]) -> None:
        await self._send(response_frame(req_id, {"ok": True, "ts": now_ms()}))

    async def _on_agents_list(self, req_id: str, _params: dict[str, Any]) -> None:
        agent_id = self._gw.agent_id
        await self._send(
            response_frame(
                req_id,
                {
                    "defaultId": agent_id,
                    "mainKey": self._gw.main_session_key,
                    "scope": "per-sender",
                    "agents": [{"id": agent_id, "name": agent_id.capitalize()}],
                },
            )
        )

    async def _on_sessions_list(self, req_id: str, params: dict[str, Any]) -> None:
        limit = int(params.get("limit") or 50)
        sessions = self._gw.store.list_sessions(limit=limit)
        await self._send(
            response_frame(
                req_id,
                {
                    "sessions": sessions,
                    "count": len(sessions),
                    "totalCount": len(sessions),
                    "hasMore": False,
                    "ts": now_ms(),
                },
            )
        )

    async def _on_subscribe(self, req_id: str, params: dict[str, Any]) -> None:
        key = params.get("sessionKey")
        if isinstance(key, str) and key:
            self._subscriptions.add(key)
        else:
            self._subscribe_all = True
        await self._send(response_frame(req_id, {"ok": True}))

    async def _on_chat_history(self, req_id: str, params: dict[str, Any]) -> None:
        key = params.get("sessionKey")
        if not self._gw.owns_session_key(key):
            await self._send(error_frame(req_id, ErrorCodes.NOT_FOUND, "unknown session"))
            return
        limit = int(params.get("limit") or 30)
        await self._send(
            response_frame(req_id, {"messages": self._gw.store.history(key, limit=limit)})
        )

    # -- chat.send ---------------------------------------------------------

    async def _on_chat_send(self, req_id: str, params: dict[str, Any]) -> None:
        key = params.get("sessionKey")
        message = params.get("message")
        if not self._gw.owns_session_key(key):
            await self._send(
                error_frame(
                    req_id,
                    ErrorCodes.NOT_FOUND,
                    "unknown session",
                    details={"sessionKey": str(key)},
                )
            )
            return
        if not isinstance(message, str) or not message.strip():
            await self._send(error_frame(req_id, ErrorCodes.INVALID_REQUEST, "message is required"))
            return

        idem = params.get("idempotencyKey")
        if isinstance(idem, str) and idem:
            existing = self._gw.store.seen_idempotency_key(idem)
            if existing:
                # A retried send must not start a second turn.
                await self._send(response_frame(req_id, {"runId": existing}))
                return

        row = self._gw.store.get_session(key)
        if row is not None and row["status"] == "busy":
            # Ravn's per-session lock would silently queue this behind the
            # running turn with no feedback. Refusing is the honest answer.
            await self._send(
                error_frame(
                    req_id,
                    ErrorCodes.RATE_LIMITED,
                    "this conversation is still finishing its previous turn",
                    details={"sessionKey": key},
                )
            )
            return

        run_id = await self._gw.run_turn(key, message)
        if isinstance(idem, str) and idem:
            self._gw.store.record_idempotency(idem, key, run_id)
        await self._send(response_frame(req_id, {"runId": run_id, "ok": True}))
