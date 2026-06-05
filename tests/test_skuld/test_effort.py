"""Tests for reasoning-effort: helpers, config default, command parsing, transport."""

import pytest

from skuld.broker import _parse_effort_command
from skuld.config import SkuldSessionConfig, SkuldSettings
from skuld.effort import (
    DEFAULT_EFFORT,
    EFFORT_LEVELS,
    codex_reasoning_effort,
    normalize_effort,
)
from skuld.transports.sdk import SDKTransport


@pytest.fixture(autouse=True)
def _no_yaml_config(monkeypatch):
    monkeypatch.setitem(SkuldSettings.model_config, "yaml_file", [])


class TestEffortHelpers:
    def test_levels_and_default(self):
        assert EFFORT_LEVELS == ("low", "medium", "high", "max")
        assert DEFAULT_EFFORT == "max"

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("MAX ", "max"),
            (" High", "high"),
            ("low", "low"),
            ("medium", "medium"),
            ("bogus", "max"),
            ("", "max"),
            (None, "max"),
            (123, "max"),
        ],
    )
    def test_normalize(self, raw, expected):
        assert normalize_effort(raw) == expected

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("max", "high"),
            ("high", "high"),
            ("medium", "medium"),
            ("low", "low"),
            ("bogus", "high"),
        ],
    )
    def test_codex_mapping(self, raw, expected):
        # Codex has no `max` tier -> collapses to high.
        assert codex_reasoning_effort(raw) == expected


class TestSessionConfigEffort:
    def test_defaults_to_max(self):
        assert SkuldSessionConfig().effort == "max"

    def test_normalizes_invalid(self):
        assert SkuldSessionConfig(effort="LOW").effort == "low"
        assert SkuldSessionConfig(effort="nonsense").effort == "max"


class TestParseEffortCommand:
    @pytest.mark.parametrize(
        "msg,expected",
        [
            ("/effort high", "high"),
            ("/EFFORT Max", "max"),
            ("  /effort low  ", "low"),
            ("/effort", ""),  # bare -> report/usage
            ("/effort bogus", ""),  # unknown arg -> report/usage
            ("not a command", None),
            ("/effortish high", None),
            ("run /effort high", None),  # only a leading slash command counts
        ],
    )
    def test_parse(self, msg, expected):
        assert _parse_effort_command(msg) == expected


class TestSdkTransportEffort:
    def test_effort_param_and_capability(self):
        t = SDKTransport(workspace_dir="/tmp", model="claude-sonnet-4-6", effort="high")
        assert t._effort == "high"
        assert t.capabilities.set_effort is True

    def test_effort_normalized_and_optional(self):
        assert SDKTransport(workspace_dir="/tmp", effort="MAX")._effort == "max"
        # Absent -> empty (transport omits the option, SDK uses its own default).
        assert SDKTransport(workspace_dir="/tmp")._effort == ""

    def test_ignores_extra_kwargs(self):
        # The broker passes a superset (incl. reasoning_effort) — must not crash.
        t = SDKTransport(workspace_dir="/tmp", effort="low", reasoning_effort="high", sdk_port=1)
        assert t._effort == "low"
