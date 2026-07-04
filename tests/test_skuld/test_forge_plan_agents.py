"""Plan + running-agents surfacing for Claude tmux sessions.

Integration tests drive a REAL ``TmuxInteractiveTransport`` + ``fakeagent`` (which
POSTs the real Claude hook shapes — ``TodoWrite`` PreToolUse for the plan, ``Task``
Pre/PostToolUse for subagents) through a real ``Broker`` over a fake browser
client, and assert the structured ``plan`` / ``agent_update`` frames surface, are
tracked, and replay on reconnect. Default-tier tests cover the broker helpers and
the ``/api/plan`` / ``/api/agents`` read endpoints without tmux.

See docs/forge-plan-and-agents-surfacing.md for the contract + decision log.
"""

from __future__ import annotations

import asyncio
import shutil

import pytest

from tests.support.forge import BrokerHarness


def _require_tmux() -> None:
    if shutil.which("tmux") is None:
        pytest.skip("tmux is not installed")


async def _wait_until(predicate, timeout: float = 5.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.05)
    raise AssertionError("condition not met before timeout")


# ──────────────────────────── plan (TodoWrite) ────────────────────────────


@pytest.mark.integration
@pytest.mark.asyncio
async def test_plan_surfaces_to_client_and_is_tracked() -> None:
    """A TodoWrite call surfaces a structured `plan` frame + is tracked live."""
    _require_tmux()
    async with BrokerHarness(hooks=True, idle_timeout_s=0.3) as h:
        client = await h.connect()
        client.send(
            {
                "type": "message",
                "content": "todo:design API=completed;build it=in_progress;write tests=pending",
            }
        )
        plan = await client.wait_for_type("plan", timeout=8.0)

        assert plan.get("event_type") == "claude.plan"
        by_content = {t["content"]: t["status"] for t in plan["tasks"]}
        assert by_content == {
            "design API": "completed",
            "build it": "in_progress",
            "write tests": "pending",
        }
        assert plan["counts"] == {
            "total": 3,
            "pending": 1,
            "in_progress": 1,
            "completed": 1,
        }
        # Tracked live so a reconnect/REST can answer.
        await _wait_until(lambda: h.broker._current_plan is not None, timeout=5.0)  # noqa: SLF001
        assert h.broker._current_plan["tasks"][1]["content"] == "build it"  # noqa: SLF001


@pytest.mark.integration
@pytest.mark.asyncio
async def test_plan_replays_on_reconnect() -> None:
    """A client joining after the plan was set immediately receives it."""
    _require_tmux()
    async with BrokerHarness(
        hooks=True,
        idle_timeout_s=0.3,
        start_transport=True,
        boot="todo:scope=completed;ship=in_progress",
    ) as h:
        await _wait_until(lambda: h.broker._current_plan is not None, timeout=8.0)  # noqa: SLF001
        # A fresh client gets the current plan on connect (no new TodoWrite needed).
        client = await h.connect()
        plan = await client.wait_for_type("plan", timeout=5.0)
        assert {t["content"] for t in plan["tasks"]} == {"scope", "ship"}


# ──────────────────────────── running agents (Task) ────────────────────────────


@pytest.mark.integration
@pytest.mark.asyncio
async def test_agent_lifecycle_surfaces_and_tracks() -> None:
    """A Task subagent surfaces started -> stopped agent_update frames + is tracked."""
    _require_tmux()
    async with BrokerHarness(hooks=True, idle_timeout_s=0.3) as h:
        client = await h.connect()

        client.send({"type": "message", "content": "agent:code-reviewer|review the diff"})
        started = await client.wait_for_type("agent_update", timeout=8.0)
        assert started["action"] == "started"
        agent = started["agent"]
        assert agent["kind"] == "subagent"
        assert agent["name"] == "code-reviewer"
        assert agent["status"] == "running"
        agent_id = agent["id"]
        await _wait_until(lambda: agent_id in h.broker._running_agents, timeout=5.0)  # noqa: SLF001

        client.send({"type": "message", "content": "agent_done:code-reviewer"})
        await _wait_until(
            lambda: any(f["action"] == "stopped" for f in client.frames_of_type("agent_update")),
            timeout=8.0,
        )
        stopped = [f for f in client.frames_of_type("agent_update") if f["action"] == "stopped"][-1]
        assert stopped["agent"]["status"] == "done"
        # Removed from the live set once stopped.
        await _wait_until(lambda: agent_id not in h.broker._running_agents, timeout=5.0)  # noqa: SLF001


@pytest.mark.integration
@pytest.mark.asyncio
async def test_running_agents_replay_on_reconnect() -> None:
    """A still-running agent is replayed to a freshly-connecting client."""
    _require_tmux()
    async with BrokerHarness(
        hooks=True,
        idle_timeout_s=0.3,
        start_transport=True,
        boot="agent:researcher|dig into the logs",
    ) as h:
        await _wait_until(lambda: len(h.broker._running_agents) == 1, timeout=8.0)  # noqa: SLF001
        client = await h.connect()
        replayed = await client.wait_for_type("agent_update", timeout=5.0)
        assert replayed["action"] == "started"
        assert replayed["agent"]["name"] == "researcher"
        assert replayed["metadata"]["source"] == "reconnect_replay"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_subagent_start_stop_surfaces_and_tracks() -> None:
    """The SubagentStart/SubagentStop hooks surface + track like the Task path."""
    _require_tmux()
    async with BrokerHarness(hooks=True, idle_timeout_s=0.3) as h:
        client = await h.connect()

        client.send({"type": "message", "content": "subagent:test-runner|run the suite"})
        started = await client.wait_for_type("agent_update", timeout=8.0)
        assert started["action"] == "started"
        assert started["agent"]["kind"] == "subagent"
        assert started["agent"]["name"] == "test-runner"
        agent_id = started["agent"]["id"]
        await _wait_until(lambda: agent_id in h.broker._running_agents, timeout=5.0)  # noqa: SLF001

        client.send({"type": "message", "content": "subagent_done:test-runner"})
        await _wait_until(lambda: agent_id not in h.broker._running_agents, timeout=8.0)  # noqa: SLF001
        stopped = [f for f in client.frames_of_type("agent_update") if f["action"] == "stopped"][-1]
        assert stopped["agent"]["status"] == "done"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_task_and_subagent_signals_dedup_by_id() -> None:
    """A SubagentStart carrying the Task's tool_use_id merges, not duplicates.

    The Task tool fires PreToolUse with tool_use_id `fakeagent-task-builder`; a
    SubagentStart pinned to that same id (`id=fakeagent-task-builder`) must enrich
    the existing agent rather than create a second one.
    """
    _require_tmux()
    async with BrokerHarness(hooks=True, idle_timeout_s=0.3) as h:
        client = await h.connect()

        client.send({"type": "message", "content": "agent:builder|build the thing"})
        await _wait_until(lambda: len(h.broker._running_agents) == 1, timeout=8.0)  # noqa: SLF001

        client.send(
            {
                "type": "message",
                "content": "subagent:builder|build the thing|id=fakeagent-task-builder",
            }
        )
        # Still exactly one agent (deduped by the shared id), now enriched.
        await asyncio.sleep(1.0)
        assert len(h.broker._running_agents) == 1, (
            f"Task + SubagentStart for the same id must NOT duplicate; "
            f"got {h.broker._running_agents}"  # noqa: SLF001
        )
        assert "fakeagent-task-builder" in h.broker._running_agents  # noqa: SLF001


# ──────────────────────────── broker helpers + endpoints (no tmux) ────────────────────────────


@pytest.mark.asyncio
async def test_track_pane_agent_excludes_primary_and_tracks_teammates() -> None:
    """Pane index 0 is the main REPL (not an agent); others are teammate agents."""
    from skuld.broker import Broker

    broker = Broker()
    broker._track_pane_agent(  # noqa: SLF001
        {"type": "terminal_pane_opened", "pane_id": "%0", "pane_index": "0"}, opened=True
    )
    assert broker._running_agents == {}  # noqa: SLF001 - primary pane excluded

    # A teammate is a split of the single "main" window running claude — window_name is a useless
    # identity (every teammate shares it), so the row uses the indexed fallback, never "main".
    # (See test_teammate_pane_name_never_uses_window_name for the full title/command/index chain.)
    broker._track_pane_agent(  # noqa: SLF001
        {
            "type": "terminal_pane_opened",
            "pane_id": "%1",
            "pane_index": "1",
            "window_name": "main",
            "current_command": "claude",
        },
        opened=True,
    )
    assert broker._running_agents["%1"]["kind"] == "teammate"  # noqa: SLF001
    assert broker._running_agents["%1"]["name"] == "Teammate 1"  # noqa: SLF001

    broker._track_pane_agent(  # noqa: SLF001
        {"type": "terminal_pane_closed", "pane_id": "%1", "pane_index": "1"}, opened=False
    )
    assert "%1" not in broker._running_agents  # noqa: SLF001


@pytest.mark.asyncio
async def test_teammate_pane_name_never_uses_window_name() -> None:
    """Every teammate is a split of the single "main" window, so the name must come from a real
    signal, never window_name. Fallback chain: pane_title → concrete current_command → Teammate <n>.
    """
    from skuld.broker import Broker

    broker = Broker()

    # 1) A meaningful pane_title wins outright — and is NOT the window name.
    broker._track_pane_agent(  # noqa: SLF001
        {
            "pane_id": "%1",
            "pane_index": "1",
            "window_name": "main",
            "pane_title": "reviewer",
            "current_command": "node",
        },
        opened=True,
    )
    assert broker._running_agents["%1"]["name"] == "reviewer"  # noqa: SLF001

    # 2) No useful title, but a concrete command → the command names the row.
    broker._track_pane_agent(  # noqa: SLF001
        {
            "pane_id": "%2",
            "pane_index": "2",
            "window_name": "main",
            "pane_title": "main",
            "current_command": "vim",
        },
        opened=True,
    )
    assert broker._running_agents["%2"]["name"] == "vim"  # noqa: SLF001

    # 3) Generic title + generic runtime command → indexed fallback, NEVER "main".
    broker._track_pane_agent(  # noqa: SLF001
        {
            "pane_id": "%3",
            "pane_index": "3",
            "window_name": "main",
            "pane_title": "main",
            "current_command": "claude",
        },
        opened=True,
    )
    assert broker._running_agents["%3"]["name"] == "Teammate 3"  # noqa: SLF001
    assert all(a["name"] != "main" for a in broker._running_agents.values())  # noqa: SLF001


@pytest.mark.asyncio
async def test_primary_pane_keyed_by_id_survives_reindexing() -> None:
    """The primary REPL is keyed by the pane_id of the first index-0 pane; a later event that puts
    the SAME pane at a different index still excludes it, and a teammate that lands at index 0 is
    still tracked."""
    from skuld.broker import Broker

    broker = Broker()
    # Primary opens at index 0 → captured by id "%0".
    broker._track_pane_agent(  # noqa: SLF001
        {"pane_id": "%0", "pane_index": "0"}, opened=True
    )
    assert broker._running_agents == {}  # noqa: SLF001

    # tmux renumbers: the primary "%0" is now reported at index 1 — still excluded (matched by id).
    broker._track_pane_agent(  # noqa: SLF001
        {"pane_id": "%0", "pane_index": "1", "current_command": "claude"}, opened=True
    )
    assert broker._running_agents == {}  # noqa: SLF001

    # A teammate now reported at index 0 must still be tracked (id ≠ the captured primary id).
    broker._track_pane_agent(  # noqa: SLF001
        {"pane_id": "%5", "pane_index": "0", "current_command": "vim"}, opened=True
    )
    assert broker._running_agents["%5"]["kind"] == "teammate"  # noqa: SLF001


@pytest.mark.asyncio
async def test_reap_dead_teammates_drops_pane_that_no_longer_exists() -> None:
    """Belt-and-suspenders: a teammate row whose pane is gone from the transport's live set is
    reaped at serve time; subagent rows (not keyed by a live pane) are never touched."""
    from skuld.broker import Broker

    broker = Broker()
    broker._running_agents = {  # noqa: SLF001
        "%1": {"id": "%1", "kind": "teammate", "name": "Teammate 1", "status": "running"},
        "%2": {"id": "%2", "kind": "teammate", "name": "Teammate 2", "status": "running"},
        "sub-a": {"id": "sub-a", "kind": "subagent", "name": "Mercury", "status": "running"},
    }

    class _FakeTransport:
        live_pane_ids = {"%1"}  # %2 has vanished; subagents are not panes

    broker._transport = _FakeTransport()  # noqa: SLF001
    broker._reap_dead_teammates()  # noqa: SLF001

    assert set(broker._running_agents) == {"%1", "sub-a"}  # noqa: SLF001


@pytest.mark.asyncio
async def test_reap_dead_teammates_noop_without_live_pane_transport() -> None:
    """A transport that cannot report live panes (e.g. a non-tmux one) must leave the registry
    untouched — reaping is a tmux-only safety net, not a correctness dependency."""
    from skuld.broker import Broker

    broker = Broker()
    broker._running_agents = {  # noqa: SLF001
        "%1": {"id": "%1", "kind": "teammate", "name": "Teammate 1", "status": "running"},
    }
    broker._transport = object()  # no live_pane_ids attribute  # noqa: SLF001
    broker._reap_dead_teammates()  # noqa: SLF001
    assert set(broker._running_agents) == {"%1"}  # noqa: SLF001


@pytest.mark.asyncio
async def test_get_plan_and_get_agents_endpoints(monkeypatch) -> None:
    """The /api/plan and /api/agents endpoints answer from live broker state."""
    import skuld.broker as broker_mod

    fresh = broker_mod.Broker()
    monkeypatch.setattr(broker_mod, "broker", fresh)

    # Empty by default.
    assert await broker_mod.get_plan() == {"tasks": [], "counts": {"total": 0}}
    assert await broker_mod.get_agents() == {"agents": []}

    fresh._current_plan = {  # noqa: SLF001
        "tasks": [{"content": "x", "status": "in_progress"}],
        "counts": {"total": 1, "in_progress": 1},
    }
    fresh._running_agents = {  # noqa: SLF001
        "t1": {"id": "t1", "kind": "subagent", "name": "rev", "status": "running"}
    }
    plan = await broker_mod.get_plan()
    assert plan["tasks"][0]["content"] == "x"
    assert plan["counts"]["in_progress"] == 1
    agents = await broker_mod.get_agents()
    assert agents["agents"][0]["name"] == "rev"
