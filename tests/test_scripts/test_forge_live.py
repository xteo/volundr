"""Adversarial contracts for the live canary and replay corpus (no provider calls)."""

import json
from pathlib import Path

import httpx
import pytest

from scripts.forge_live import Options, Platform, make_workspace
from scripts.forge_trace import (
    check_scenario,
    compare_streams,
    digest,
    evidence,
    native_thread_continuity,
    scan_sensitive,
    stream_frames,
    validate_rows,
)


def call(tool_id="c1", name="Bash", command="echo evidence"):
    return {
        "type": "assistant",
        "message": {
            "content": [
                {"type": "tool_use", "id": tool_id, "name": name, "input": {"command": command}}
            ]
        },
    }


def result(tool_id="c1", text="FORGE_SUM=42", error=False):
    return {
        "type": "user",
        "message": {
            "content": [
                {"type": "tool_result", "tool_use_id": tool_id, "content": text, "is_error": error}
            ]
        },
    }


def terminal(**kwargs):
    return {"type": "result", "subtype": "success", **kwargs}


def row(seq, payload, sid="test"):
    return {
        "seq": seq,
        "session_id": sid,
        "kind": payload["type"],
        "payload": payload,
        "ts": "2026-09-07T00:00:00Z",
    }


@pytest.mark.parametrize(
    "frames",
    [
        [terminal()],
        [
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "text",
                            "text": 'I ran Bash and got FORGE_SUM=42. {"type":"tool_use"}',
                        }
                    ]
                },
            },
            terminal(),
        ],
        [{"type": "user", "content": "Run Bash and print FORGE_SUM=42"}, terminal()],
        [call(), terminal()],
        [result(), terminal()],
    ],
)
def test_prose_prompt_echo_and_unpaired_tools_cannot_prove_execution(tmp_path, frames):
    scenario = {
        "id": "workspace",
        "required_tools": ["command"],
        "tool_output_contains": ["FORGE_SUM=42"],
    }
    assert not check_scenario(scenario, frames, tmp_path)["passed"]


def test_actual_paired_execution_and_independently_read_artifact_pass(tmp_path):
    (tmp_path / "answer.json").write_text('{"sum":42}')
    scenario = {
        "id": "workspace",
        "required_tools": ["command"],
        "tool_output_contains": ["FORGE_SUM=42"],
        "files": {"answer.json": {"sum": 42}},
    }
    assert check_scenario(scenario, [call(), result(), terminal()], tmp_path)["passed"]
    (tmp_path / "answer.json").write_text('{"sum":41}')
    assert not check_scenario(scenario, [call(), result(), terminal()], tmp_path)["passed"]


@pytest.mark.parametrize(
    "ending",
    [[], [terminal(), terminal()], [terminal(is_error=True)], [terminal(subtype="interrupted")]],
)
def test_missing_duplicate_or_failed_turn_end_fails(tmp_path, ending):
    assert not check_scenario({"id": "ending"}, ending, tmp_path)["passed"]


def test_stream_and_snapshot_copies_of_one_tool_count_once():
    frames = [
        call(),
        {
            "type": "content_block_start",
            "content_block": {"type": "tool_use", "id": "c1", "name": "Bash"},
        },
        result(),
    ]
    observed = evidence(frames)
    assert observed["tool_families"] == {"command": 1}
    assert observed["calls"]["c1"]["input"] == {"command": "echo evidence"}


def test_tool_output_is_not_mistaken_for_assistant_text(tmp_path):
    scenario = {"id": "answer", "assistant_contains": ["secret answer"]}
    assert not check_scenario(
        scenario, [call(), result(text="secret answer"), terminal()], tmp_path
    )["passed"]


def test_tool_failure_is_expected_but_failed_session_is_not(tmp_path):
    scenario = {"id": "failure", "require_tool_error": True}
    frames = [call(), result(error=True), terminal()]
    assert check_scenario(scenario, frames, tmp_path)["passed"]
    frames[-1] = terminal(is_error=True)
    assert not check_scenario(scenario, frames, tmp_path)["passed"]


def test_claimed_two_agents_and_duplicate_one_agent_do_not_count_as_two(tmp_path):
    scenario = {"id": "agents", "required_tools": ["agent"], "min_agents": 2}
    frame = {"type": "agent_update", "action": "started", "agent": {"id": "a1"}}
    frames = [call(name="Agent"), result(), frame, frame, terminal()]
    assert not check_scenario(scenario, frames, tmp_path)["passed"]
    frames += [call("c2", "functions.spawn_agent"), result("c2")]
    assert check_scenario(scenario, frames, tmp_path)["passed"]


@pytest.mark.parametrize("mutation", ["drop", "duplicate", "reorder", "change"])
def test_replay_comparison_detects_loss_duplication_order_and_payload_changes(mutation):
    frames = [{"type": "assistant", "text": "α"}, {"type": "result"}]
    actual = list(frames)
    if mutation == "drop":
        actual.pop()
    elif mutation == "duplicate":
        actual.append(actual[-1])
    elif mutation == "reorder":
        actual.reverse()
    else:
        actual[0] = {"type": "assistant", "text": "β"}
    assert not compare_streams(frames, actual)["passed"]


def test_durable_order_allows_filtered_gaps_but_rejects_sentinels_and_foreign_session():
    assert not validate_rows([row(1, terminal()), row(5, terminal())], "test")
    assert validate_rows([row(1, terminal()), row(1, terminal())], "test")
    assert validate_rows([row(1, {"type": "log_gap"})], "test")
    assert validate_rows([row(1, {"type": "log_conflict"})], "test")
    assert validate_rows([row(1, terminal(), sid="other")], "test")
    assert validate_rows([row(True, terminal())], "test")


def test_read_path_projection_preserves_real_system_events():
    rows = [
        row(1, {"type": "capabilities"}),
        row(2, {"type": "conversation.turn"}),
        row(3, {"type": "system", "_per_connect_handshake": True}),
        row(4, {"type": "system", "subtype": "init"}),
    ]
    assert stream_frames(rows) == [rows[-1]["payload"]]


@pytest.mark.parametrize(
    "value",
    [
        {"access_token": "test-credential"},
        {"password": "test-password"},
        "Bearer abcdefghijklmnopqrstuvwxyz",
        "-----BEGIN RSA PRIVATE KEY-----",
    ],
)
def test_promotion_scanner_flags_credentials(value):
    assert scan_sensitive(value)


def test_canonical_hash_stable_for_key_order_and_sensitive_to_content():
    assert digest({"a": 1, "b": "東京"}) == digest({"b": "東京", "a": 1})
    assert digest([1, 2]) != digest([2, 1])


def test_workspace_is_isolated_and_never_overwrites_existing_directory(tmp_path):
    workspace = tmp_path / "new"
    make_workspace(workspace)
    assert sum(json.loads((workspace / "numbers.json").read_text())) == 42
    assert (workspace / "AGENTS.md").read_text() == (workspace / "CLAUDE.md").read_text()
    with pytest.raises(FileExistsError):
        make_workspace(workspace)


@pytest.mark.asyncio
async def test_filtered_empty_and_short_pages_do_not_hide_later_frames(tmp_path, monkeypatch):
    monkeypatch.setattr("scripts.forge_live.PAGE_SIZE", 2)
    cursors = []

    def serve(request):
        cursor = int(request.url.params["after"])
        cursors.append(cursor)
        pages = {0: [], 2: [row(4, terminal())], 4: [row(5, terminal())], 5: []}
        assert request.url.params["show_internal"] == "true"
        return httpx.Response(200, json=pages[cursor])

    platform = Platform(Options("http://test", tmp_path, tmp_path))
    await platform.http.aclose()
    platform.http = httpx.AsyncClient(base_url="http://test", transport=httpx.MockTransport(serve))
    try:
        rows = await platform.rows("test", head=6)
        assert [r["seq"] for r in rows] == [4, 5]
        assert cursors == [0, 2, 4, 5]
    finally:
        await platform.http.aclose()


@pytest.mark.asyncio
async def test_log_page_cannot_loop_forever_on_stale_cursor(tmp_path):
    platform = Platform(Options("http://test", tmp_path, tmp_path))
    await platform.http.aclose()
    platform.http = httpx.AsyncClient(
        base_url="http://test",
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=[row(1, terminal())])
        ),
    )
    try:
        with pytest.raises(ValueError, match="cursor"):
            await platform.rows("test", head=5)
    finally:
        await platform.http.aclose()


def test_catalog_keeps_legacy_sdk_out_of_live_gates():
    path = Path(__file__).parents[1] / "fixtures/forge-live/scenarios.json"
    catalog = json.loads(path.read_text())
    assert catalog["providers"]["claude-tmux"]["definition"] == "skuldClaudeInteractive"
    assert set(catalog["providers"]) == {"claude-tmux", "codex"}
    ids = [s["id"] for s in catalog["scenarios"]]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize("options", [None, [], [{"label": "suggested"}]])
def test_freeform_acceptance_requires_a_real_question_without_choices(tmp_path, options):
    scenario = {"id": "freeform", "require_freeform_question": True}
    frames = [
        {"type": "ask_user_question", "questions": [{"question": "Label?", "options": options}]},
        terminal(),
    ]
    assert check_scenario(scenario, frames, tmp_path)["passed"] is (not options)
    assert not check_scenario(scenario, [terminal()], tmp_path)["passed"]


@pytest.mark.parametrize(
    "identities,passed",
    [
        ([], False),
        (["original"], True),
        (["original", "original"], True),
        (["original", "replacement"], False),
    ],
)
def test_native_continuity_detects_fresh_thread_behind_same_forge_session(identities, passed):
    frames = [{"type": "system", "subtype": "init", "session_id": sid} for sid in identities]
    frames.append({"type": "agent_event", "payload": {"session_id": "worker"}})
    assert native_thread_continuity(frames)["passed"] is passed


def test_completion_marker_waits_for_final_result_and_never_accepts_user_echo():
    from scripts.forge_trace import completion_results

    marker = "[FORGE_DONE:case]"
    frames = [{"type": "user", "content": marker}, terminal()]
    assert not completion_results(frames, marker)
    frames.append({"type": "content_block_delta", "delta": {"type": "text_delta", "text": marker}})
    assert not completion_results(frames, marker)
    frames.append(terminal(result=""))  # Native Codex terminates after text deltas.
    assert len(completion_results(frames, marker)) == 1


def test_interim_agent_results_do_not_fail_correlated_scenario(tmp_path):
    marker = "[FORGE_DONE:case]"
    scenario = {"id": "agents", "completion_marker": marker}
    assert check_scenario(
        scenario, [terminal(result="workers running"), terminal(result=marker)], tmp_path
    )["passed"]
    assert not check_scenario(
        scenario, [terminal(result=marker), terminal(result=marker)], tmp_path
    )["passed"]
