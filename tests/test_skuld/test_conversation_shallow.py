"""Tests for shallow conversation serialization + the lazy tool-result endpoint.

Shallow mode elides heavy ``tool_result`` content to placeholders so a client
can render the conversation structure cheaply and lazy-load an individual result
on demand. Covers the pure helper (``skuld.conversation_shallow``) and the two
broker endpoints (``GET /api/conversation/history?detail=shallow`` and
``GET /api/conversation/tool-result/{tool_use_id}``).
"""

import json

import pytest
from fastapi.testclient import TestClient

from skuld.broker import ConversationTurn, app, broker
from skuld.conversation_shallow import (
    INLINE_BYTE_LIMIT,
    _content_image_info,
    elide_tool_result_block,
    elide_turns,
    is_elided_block,
)

BIG = "X" * (INLINE_BYTE_LIMIT + 1000)  # safely over the inline threshold
SMALL = "ok"

# A Skuld image Read returns `content` as a JSON STRING of this envelope (verified against the
# live REST API). The base64 is padded so the serialized content clears INLINE_BYTE_LIMIT and
# is therefore always elided — exactly the case the image hint exists to describe.
IMG_ENVELOPE = json.dumps(
    {
        "type": "image",
        "file": {
            "base64": "iVBORw0KGgo" + "A" * 2000,
            "type": "image/png",
            "dimensions": {
                "displayWidth": 920,
                "displayHeight": 2000,
                "originalWidth": 1206,
                "originalHeight": 2622,
            },
            "originalSize": 900660,
        },
    }
)
# A Read of a TEXT file uses the same envelope with `{"file":{"content":…}}` and is NOT an image.
TEXT_ENVELOPE = json.dumps({"type": "text", "file": {"content": "import SwiftUI\n" * 200}})


def _tool_use(uid: str) -> dict:
    return {"type": "tool_use", "id": uid, "name": "Bash", "input": {"command": "ls"}}


def _tool_result(uid: str, content, is_error: bool = False) -> dict:
    return {
        "type": "tool_result",
        "tool_use_id": uid,
        "content": content,
        "is_error": is_error,
    }


class TestElideHelper:
    """Pure-function behaviour of the elide helper."""

    def test_big_tool_result_becomes_placeholder(self):
        block = _tool_result("t1", BIG)
        out = elide_tool_result_block(block)
        assert out["type"] == "tool_result"
        assert out["tool_use_id"] == "t1"
        assert out["truncated"] is True
        assert out["byte_size"] == len(BIG.encode("utf-8"))
        assert out["preview"] == BIG[:200]
        assert "content" not in out
        assert is_elided_block(out)

    def test_small_tool_result_kept_inline(self):
        block = _tool_result("t2", SMALL)
        out = elide_tool_result_block(block)
        assert out == block  # unchanged — not worth a round-trip
        assert not is_elided_block(out)

    def test_non_tool_result_untouched(self):
        for block in (_tool_use("t3"), {"type": "text", "text": "hi"}):
            assert elide_tool_result_block(block) == block

    def test_list_content_preview_and_size(self):
        content = [{"type": "text", "text": "A" * 6000}]
        out = elide_tool_result_block(_tool_result("t4", content))
        assert out["truncated"] is True
        assert out["preview"].startswith("AAAA")
        assert len(out["preview"]) == 200
        assert out["byte_size"] > INLINE_BYTE_LIMIT

    def test_error_flag_preserved(self):
        out = elide_tool_result_block(_tool_result("t5", BIG, is_error=True))
        assert out["is_error"] is True

    def test_elide_turns_does_not_mutate_input(self):
        turns = [{"role": "assistant", "parts": [_tool_use("t1"), _tool_result("t1", BIG)]}]
        out = elide_turns(turns)
        # input still has the full content (no mutation)
        assert turns[0]["parts"][1]["content"] == BIG
        # output is elided
        assert is_elided_block(out[0]["parts"][1])
        # the tool_use call is preserved verbatim
        assert out[0]["parts"][0] == _tool_use("t1")


class TestImageHint:
    """The image hint stamped onto an elided image tool_result placeholder."""

    def test_image_read_placeholder_carries_hint(self):
        out = elide_tool_result_block(_tool_result("img", IMG_ENVELOPE))
        assert out["truncated"] is True
        assert "content" not in out
        assert out["is_image"] is True
        assert out["mime_type"] == "image/png"
        assert out["img_w"] == 920
        assert out["img_h"] == 2000

    def test_text_read_placeholder_has_no_hint(self):
        out = elide_tool_result_block(_tool_result("txt", TEXT_ENVELOPE))
        assert out["truncated"] is True
        assert "is_image" not in out
        assert "mime_type" not in out

    def test_non_json_big_string_has_no_hint(self):
        out = elide_tool_result_block(_tool_result("plain", BIG))
        assert out["truncated"] is True
        assert "is_image" not in out

    def test_anthropic_content_array_form_detected(self):
        content = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": "/9j/4AAQ" + "A" * 2000,
                },
            },
        ]
        out = elide_tool_result_block(_tool_result("aimg", content))
        assert out["is_image"] is True
        assert out["mime_type"] == "image/jpeg"
        assert "img_w" not in out  # array form carries no display dimensions

    def test_content_image_info_pure_helper(self):
        assert _content_image_info(IMG_ENVELOPE) == (True, "image/png", 920, 2000)
        assert _content_image_info(TEXT_ENVELOPE) == (False, None, None, None)
        assert _content_image_info("not json {") == (False, None, None, None)
        assert _content_image_info(SMALL) == (False, None, None, None)

    def test_hint_survives_shallow_endpoint(self):
        broker._conversation_turns = [
            ConversationTurn(
                id="a1",
                role="assistant",
                content="rendered a chart",
                parts=[_tool_use("chart"), _tool_result("chart", IMG_ENVELOPE)],
            ),
        ]
        try:
            client = TestClient(app, raise_server_exceptions=False)
            data = client.get("/api/conversation/history", params={"detail": "shallow"}).json()
            part = next(p for p in data["turns"][0]["parts"] if p.get("tool_use_id") == "chart")
            assert part["is_image"] is True
            assert part["mime_type"] == "image/png"
            assert part["img_w"] == 920 and part["img_h"] == 2000
        finally:
            broker._conversation_turns = []


class TestShallowEndpoints:
    """The broker conversation + tool-result HTTP surface."""

    @pytest.fixture(autouse=True)
    def _reset_broker(self):
        broker._conversation_turns = []
        yield
        broker._conversation_turns = []

    def _seed(self):
        broker._conversation_turns = [
            ConversationTurn(id="u1", role="user", content="do it"),
            ConversationTurn(
                id="a1",
                role="assistant",
                content="working",
                parts=[
                    _tool_use("big"),
                    _tool_result("big", BIG),
                    _tool_use("small"),
                    _tool_result("small", SMALL),
                    {"type": "text", "text": "done"},
                ],
            ),
        ]

    def test_full_mode_keeps_content(self):
        self._seed()
        client = TestClient(app, raise_server_exceptions=False)
        data = client.get("/api/conversation/history").json()
        parts = data["turns"][1]["parts"]
        big = next(p for p in parts if p.get("tool_use_id") == "big")
        assert big["content"] == BIG
        assert "truncated" not in big

    def test_shallow_mode_elides_big_keeps_small(self):
        self._seed()
        client = TestClient(app, raise_server_exceptions=False)
        data = client.get("/api/conversation/history", params={"detail": "shallow"}).json()
        parts = data["turns"][1]["parts"]
        big = next(p for p in parts if p.get("tool_use_id") == "big")
        small = next(p for p in parts if p.get("tool_use_id") == "small")
        text = next(p for p in parts if p.get("type") == "text")
        # big elided
        assert big["truncated"] is True
        assert "content" not in big
        assert big["byte_size"] == len(BIG.encode("utf-8"))
        # small inline, text + tool_use untouched
        assert small["content"] == SMALL
        assert text["text"] == "done"
        assert any(p.get("type") == "tool_use" and p.get("id") == "big" for p in parts)

    def test_shallow_payload_is_much_smaller(self):
        self._seed()
        client = TestClient(app, raise_server_exceptions=False)
        full = client.get("/api/conversation/history").content
        shallow = client.get("/api/conversation/history", params={"detail": "shallow"}).content
        assert len(shallow) < len(full) / 2

    def test_tool_result_fetch_returns_full_content(self):
        self._seed()
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/conversation/tool-result/big")
        assert resp.status_code == 200
        body = resp.json()
        assert body["tool_use_id"] == "big"
        assert body["content"] == BIG
        assert body["is_error"] is False

    def test_tool_result_fetch_unknown_id_404(self):
        self._seed()
        client = TestClient(app, raise_server_exceptions=False)
        assert client.get("/api/conversation/tool-result/nope").status_code == 404
