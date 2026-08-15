"""Reranking port — second-stage ordering for retrieved documents.

Retrieval and ranking are different jobs. An embedding is computed once, without knowing the
question, so it must be a general-purpose summary of a document; a reranker sees the query and the
document together and can judge *this* document against *this* question. The usual shape is to
retrieve generously by embedding and then let the reranker decide the order of the few that matter.

Deliberately narrow: one method, and an implementation is expected to return an empty list rather
than raise when the service is unavailable. Ranking runs on the turn path, and a better order is
never worth an agent that cannot answer.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class RerankerPort(Protocol):
    """Score *documents* against *query*, best first."""

    async def rerank(
        self, query: str, documents: list[str], *, top_n: int | None = None
    ) -> list[tuple[int, float]]:
        """Return ``(original_index, score)`` pairs ordered best-first.

        Returns an empty list when the backend cannot answer — the caller keeps the order it
        already had. Never raises for an unavailable service.
        """
        ...
