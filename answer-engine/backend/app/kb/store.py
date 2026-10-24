"""The search copy in Pinecone (SPEC section 6.3). Only the sync worker writes to it."""

from collections.abc import Iterator
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol

from pinecone import Pinecone

from app.config import get_settings

DOCS = "docs"  # one record per chunk
VERIFIED = "verified"  # one record per verified answer (build step 11)

UPSERT_BATCH = 96  # Pinecone's limit for records embedded by the index itself
DELETE_BATCH = 1000

Record = dict[str, Any]


@dataclass(frozen=True)
class Hit:
    id: str
    score: float  # the reranker's relevance, 0-1


class VectorStore(Protocol):
    def upsert(self, namespace: str, records: list[Record]) -> None: ...
    def delete(self, namespace: str, ids: list[str]) -> None: ...
    def list_ids(self, namespace: str) -> Iterator[str]: ...
    def search(
        self, namespace: str, text: str, top_k: int, rerank_model: str, top_n: int
    ) -> list[Hit]: ...


class PineconeStore:
    def __init__(self, api_key: str, index_name: str, host: str = "") -> None:
        self.client = Pinecone(api_key=api_key)
        self.index_name = index_name
        self.host = host
        self._index: Any = None

    @property
    def index(self) -> Any:
        if self._index is None:
            if self.host:
                self._index = self.client.Index(host=self.host)
            else:
                self._index = self.client.Index(name=self.index_name)
        return self._index

    def upsert(self, namespace: str, records: list[Record]) -> None:
        self.index.upsert_records(namespace=namespace, records=records)

    def delete(self, namespace: str, ids: list[str]) -> None:
        self.index.delete(ids=ids, namespace=namespace)

    def list_ids(self, namespace: str) -> Iterator[str]:
        for page in self.index.list(namespace=namespace, limit=100):
            for vector in page.vectors:
                yield vector.id

    def search(
        self, namespace: str, text: str, top_k: int, rerank_model: str, top_n: int
    ) -> list[Hit]:
        """Embed the text in Pinecone, take the top_k nearest, rerank them to top_n."""
        response = self.index.search(
            namespace=namespace,
            top_k=top_k,
            inputs={"text": text},
            fields=["file_id"],
            rerank={"model": rerank_model, "rank_fields": ["text"], "top_n": top_n},
        )
        return [Hit(hit.id, float(hit.score)) for hit in response.result.hits]

    def ensure_index(self, cloud: str, region: str, embed_model: str) -> str:
        """Create the index with integrated embedding if it doesn't exist. Returns a summary."""
        if not self.client.has_index(self.index_name):
            self.client.create_index_for_model(
                name=self.index_name,
                cloud=cloud,
                region=region,
                embed={"model": embed_model, "field_map": {"text": "text"}},
                timeout=300,
            )
            created = "created"
        else:
            created = "already exists"
        description = self.client.describe_index(self.index_name)
        return f"Index {self.index_name} {created} (host {description.host})."


@lru_cache
def _store(api_key: str, index_name: str, host: str) -> PineconeStore:
    return PineconeStore(api_key, index_name, host)


def get_store() -> VectorStore | None:
    """Pinecone, or None while no API key is set (changes then wait in the outbox)."""
    settings = get_settings()
    if not settings.pinecone_api_key:
        return None
    return _store(settings.pinecone_api_key, settings.pinecone_index, settings.pinecone_host)
