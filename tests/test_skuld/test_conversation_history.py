"""Tests for conversation history tracking and persistence."""

import json
from dataclasses import asdict
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from skuld.broker import (
    CONVERSATION_HISTORY_DIR,
    Broker,
    ConversationTurn,
    app,
    broker,
)
from skuld.config import SkuldSettings
from skuld.transports import TransportCapabilities


class TestConversationTurn:
    """Tests for ConversationTurn dataclass."""

    def test_create_turn(self):
        turn = ConversationTurn(
            id="test-id",
            role="user",
            content="Hello",
        )
        assert turn.id == "test-id"
        assert turn.role == "user"
        assert turn.content == "Hello"
        assert turn.parts == []
        assert turn.metadata == {}
        assert turn.created_at  # auto-generated

    def test_turn_to_dict(self):
        turn = ConversationTurn(
            id="test-id",
            role="assistant",
            content="Hi there",
            parts=[{"type": "text", "text": "Hi there"}],
            metadata={"model": "claude-sonnet-4-20250514"},
        )
        d = asdict(turn)
        assert d["id"] == "test-id"
        assert d["role"] == "assistant"
        assert d["content"] == "Hi there"
        assert d["parts"] == [{"type": "text", "text": "Hi there"}]
        assert d["metadata"]["model"] == "claude-sonnet-4-20250514"


class TestConversationHistoryPersistence:
    """Tests for file-based conversation history persistence."""

    @pytest.fixture
    def test_broker(self, tmp_path):
        settings = SkuldSettings(
            session={"id": "test-session", "workspace_dir": str(tmp_path)},
            transport="subprocess",
        )
        return Broker(settings=settings)

    def test_history_path(self, test_broker, tmp_path):
        sid = test_broker.session_id
        expected = tmp_path / CONVERSATION_HISTORY_DIR / f"conversation_{sid}.json"
        assert test_broker._conversation_history_path() == expected

    def test_save_and_load_history(self, test_broker):
        turn1 = ConversationTurn(id="1", role="user", content="Hello")
        turn2 = ConversationTurn(id="2", role="assistant", content="Hi!")

        test_broker._conversation_turns = [turn1, turn2]
        test_broker._save_conversation_history()

        # Verify file was created
        path = test_broker._conversation_history_path()
        assert path.exists()

        # Verify JSON content
        data = json.loads(path.read_text(encoding="utf-8"))
        assert len(data["turns"]) == 2
        assert data["turns"][0]["role"] == "user"
        assert data["turns"][1]["role"] == "assistant"

        # Clear and reload
        test_broker._conversation_turns = []
        test_broker._load_conversation_history()
        assert len(test_broker._conversation_turns) == 2
        assert test_broker._conversation_turns[0].content == "Hello"
        assert test_broker._conversation_turns[1].content == "Hi!"

    def test_load_nonexistent_file(self, test_broker):
        test_broker._load_conversation_history()
        assert test_broker._conversation_turns == []

    def test_load_corrupted_file(self, test_broker):
        path = test_broker._conversation_history_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("not valid json", encoding="utf-8")

        test_broker._load_conversation_history()
        assert test_broker._conversation_turns == []

    def test_append_turn_persists(self, test_broker):
        turn = ConversationTurn(id="1", role="user", content="Test")
        test_broker._append_turn(turn)

        assert len(test_broker._conversation_turns) == 1
        assert test_broker._conversation_history_path().exists()


class TestConversationTurnCapture:
    """Tests for capturing turns from CLI events."""

    @pytest.fixture
    def test_broker(self, tmp_path):
        settings = SkuldSettings(
            session={"id": "test-session", "workspace_dir": str(tmp_path)},
            transport="subprocess",
        )
        b = Broker(settings=settings)
        b._transport = MagicMock()
        b._transport.is_alive = True
        b._transport.capabilities = TransportCapabilities()
        return b

    @pytest.mark.asyncio
    async def test_user_turn_captured_on_message(self, test_broker):
        """User messages should create a user turn."""
        test_broker._transport.send_message = AsyncMock()

        await test_broker._dispatch_browser_message({"content": "Hello world"})

        assert len(test_broker._conversation_turns) == 1
        assert test_broker._conversation_turns[0].role == "user"
        assert test_broker._conversation_turns[0].content == "Hello world"

    @pytest.mark.asyncio
    async def test_assistant_turn_captured_on_result(self, test_broker):
        """Assistant turns should be captured when result event arrives."""
        # Simulate assistant event
        await test_broker._handle_cli_event({"type": "assistant", "content": []})

        # Simulate content delta
        await test_broker._handle_cli_event(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "Hello "},
            }
        )
        await test_broker._handle_cli_event(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "there!"},
            }
        )

        # Simulate result event
        await test_broker._handle_cli_event(
            {
                "type": "result",
                "result": "",
                "modelUsage": {
                    "claude-sonnet-4-20250514": {
                        "inputTokens": 100,
                        "outputTokens": 50,
                        "costUSD": 0.001,
                    }
                },
            }
        )

        assert len(test_broker._conversation_turns) == 1
        turn = test_broker._conversation_turns[0]
        assert turn.role == "assistant"
        assert turn.content == "Hello there!"
        assert turn.metadata["cost"] == 0.001

    @pytest.mark.asyncio
    async def test_empty_result_not_captured(self, test_broker):
        """Result events with no content should not create a turn."""
        await test_broker._handle_cli_event(
            {
                "type": "result",
                "result": "",
                "modelUsage": {},
            }
        )

        assert len(test_broker._conversation_turns) == 0


class TestConversationHistoryEndpoint:
    """Tests for the /api/conversation/history endpoint."""

    @pytest.fixture(autouse=True)
    def _reset_broker(self):
        """Reset global broker's conversation state before each test."""
        broker._conversation_turns = []
        yield
        broker._conversation_turns = []

    def test_empty_history(self):
        client = TestClient(app, raise_server_exceptions=False)
        response = client.get("/api/conversation/history")
        assert response.status_code == 200
        data = response.json()
        assert data["turns"] == []
        assert "is_active" in data
        assert "last_activity" in data

    def test_history_with_turns(self):
        broker._conversation_turns = [
            ConversationTurn(
                id="1",
                role="user",
                content="Hello",
                created_at="2026-01-01T00:00:00+00:00",
            ),
            ConversationTurn(
                id="2",
                role="assistant",
                content="Hi!",
                created_at="2026-01-01T00:00:01+00:00",
                metadata={"model": "claude-sonnet-4-20250514"},
            ),
        ]

        client = TestClient(app, raise_server_exceptions=False)
        response = client.get("/api/conversation/history")
        assert response.status_code == 200
        data = response.json()
        assert len(data["turns"]) == 2
        assert data["turns"][0]["role"] == "user"
        assert data["turns"][0]["content"] == "Hello"
        assert data["turns"][1]["role"] == "assistant"
        assert data["turns"][1]["metadata"]["model"] == "claude-sonnet-4-20250514"


class TestToolCallsSerialized:
    """Tool calls + reasoning must be persisted in the saved conversation turn
    (so a reloaded session shows tool cards, not just text)."""

    @pytest.fixture
    def brk(self, tmp_path):
        settings = SkuldSettings(
            session={"id": "tool-ser", "workspace_dir": str(tmp_path)},
            transport="subprocess",
        )
        return Broker(settings=settings)

    @pytest.mark.asyncio
    async def test_assistant_tool_cycle_persists_parts(self, brk):
        # 1) assistant message that thinks + calls a tool (no final text yet)
        await brk._handle_cli_event(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "thinking", "thinking": "let me check the file"},
                        {
                            "type": "tool_use",
                            "id": "tu1",
                            "name": "Bash",
                            "input": {"command": "ls"},
                        },
                    ]
                },
            }
        )
        # 2) tool_result comes back as a user-role message (must NOT flush the turn)
        await brk._handle_cli_event(
            {
                "type": "user",
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "tu1",
                            "content": "a.txt\nb.txt",
                            "is_error": False,
                        }
                    ]
                },
            }
        )
        # 3) assistant final answer text
        await brk._handle_cli_event(
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "Two files."}]}}
        )
        # 4) a real user turn flushes the assistant turn
        await brk._handle_cli_event({"type": "user", "message": {"content": "thanks"}})

        assistant_turns = [t for t in brk._conversation_turns if t.role == "assistant"]
        assert len(assistant_turns) == 1
        turn = assistant_turns[0]
        types = [p.get("type") for p in turn.parts]
        assert "tool_use" in types
        assert "tool_result" in types
        assert "text" in types
        tu = next(p for p in turn.parts if p["type"] == "tool_use")
        assert tu["id"] == "tu1" and tu["name"] == "Bash" and tu["input"] == {"command": "ls"}
        tr = next(p for p in turn.parts if p["type"] == "tool_result")
        assert tr["tool_use_id"] == "tu1" and tr["content"] == "a.txt\nb.txt"
        assert turn.content == "Two files."

    @pytest.mark.asyncio
    async def test_tool_only_turn_persists_even_without_text(self, brk):
        await brk._handle_cli_event(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "tool_use", "id": "x", "name": "Read", "input": {"file_path": "a"}}
                    ]
                },
            }
        )
        brk._flush_pending_assistant_turn()
        turns = [t for t in brk._conversation_turns if t.role == "assistant"]
        assert len(turns) == 1
        assert any(p.get("type") == "tool_use" for p in turns[0].parts)
