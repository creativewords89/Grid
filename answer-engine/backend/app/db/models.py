"""Database tables (SPEC section 5). Each build step adds the tables it needs."""

import enum
import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.ids import uuid7


class Role(enum.StrEnum):
    OWNER = "owner"
    REVIEWER = "reviewer"
    USER = "user"


class NotifyChannel(enum.StrEnum):
    IN_APP = "in_app"
    EMAIL = "email"
    TELEGRAM = "telegram"


class TokenKind(enum.StrEnum):
    INVITE = "invite"
    RESET = "reset"
    TELEGRAM_LINK = "telegram_link"


def _enum(cls: type[enum.StrEnum], name: str) -> Enum:
    return Enum(cls, name=name, values_callable=lambda members: [m.value for m in members])


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class User(TimestampMixin, Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[Role] = mapped_column(_enum(Role, "user_role"))
    # NULL until the person accepts their invite and sets a password.
    password_hash: Mapped[str | None] = mapped_column(String(255))
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    telegram_user_id: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    notify_channel: Mapped[NotifyChannel] = mapped_column(
        _enum(NotifyChannel, "notify_channel"),
        default=NotifyChannel.EMAIL,
        server_default=NotifyChannel.EMAIL.value,
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    sessions: Mapped[list["AuthSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", passive_deletes=True
    )

    @property
    def invited(self) -> bool:
        """Invited but has not set a password yet."""
        return self.password_hash is None


class AuthSession(TimestampMixin, Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ip: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(String(512))

    user: Mapped[User] = relationship(back_populates="sessions")

    __table_args__ = (Index("ix_sessions_user_id", "user_id"),)


class AuthToken(TimestampMixin, Base):
    __tablename__ = "auth_tokens"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[TokenKind] = mapped_column(_enum(TokenKind, "auth_token_kind"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship()

    __table_args__ = (Index("ix_auth_tokens_user_id_kind", "user_id", "kind"),)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    email: Mapped[str] = mapped_column(String(254))
    ip: Mapped[str] = mapped_column(String(45))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ok: Mapped[bool] = mapped_column(Boolean)

    __table_args__ = (Index("ix_login_attempts_email_ip_at", "email", "ip", "at"),)


class FileStatus(enum.StrEnum):
    QUEUED = "queued"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


class StoredFile(TimestampMixin, Base):
    """An uploaded document (SPEC sections 5 and 6.1). Named StoredFile to avoid `file`."""

    __tablename__ = "files"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_path: Mapped[str] = mapped_column(String(255))
    status: Mapped[FileStatus] = mapped_column(
        _enum(FileStatus, "file_status"), default=FileStatus.QUEUED
    )
    error: Mapped[str | None] = mapped_column(Text)
    # Ready, but something was skipped (e.g. "3 pages look scanned …").
    warning: Mapped[str | None] = mapped_column(Text)
    page_count: Mapped[int | None] = mapped_column(Integer)
    sheet_count: Mapped[int | None] = mapped_column(Integer)  # Excel workbooks only
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    ocr_pages: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Shown as "Processing 3/10" while scanned pages are being read.
    progress_done: Mapped[int | None] = mapped_column(Integer)
    progress_total: Mapped[int | None] = mapped_column(Integer)
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    previous_file_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("files.id", ondelete="SET NULL")
    )
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    uploader: Mapped[User | None] = relationship(foreign_keys=[uploaded_by])

    __table_args__ = (
        # One live copy of any file; a deleted copy may be uploaded again.
        Index(
            "uq_files_sha256_live",
            "sha256",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_files_created_at", "created_at"),
    )

    @property
    def owner_ids(self) -> frozenset[uuid.UUID]:
        return frozenset({self.uploaded_by}) if self.uploaded_by else frozenset()


class Chunk(Base):
    """A piece of a document as it is searched (SPEC sections 5 and 6.3)."""

    __tablename__ = "chunks"

    id: Mapped[str] = mapped_column(String(100), primary_key=True)  # doc_{file_id}_{n}
    file_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("files.id", ondelete="CASCADE"))
    position: Mapped[int] = mapped_column(Integer)
    page_from: Mapped[int | None] = mapped_column(Integer)
    page_to: Mapped[int | None] = mapped_column(Integer)
    sheet: Mapped[str | None] = mapped_column(String(255))
    heading: Mapped[str | None] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text)
    token_count: Mapped[int] = mapped_column(Integer)
    from_ocr: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    __table_args__ = (Index("ix_chunks_file_id_position", "file_id", "position"),)

    @staticmethod
    def make_id(file_id: uuid.UUID, position: int) -> str:
        return f"doc_{file_id}_{position}"


class JobState(enum.StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class Job(TimestampMixin, Base):
    """Background work run by the worker (SPEC section 6.12)."""

    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    kind: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    state: Mapped[JobState] = mapped_column(_enum(JobState, "job_state"), default=JobState.QUEUED)
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    run_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    locked_by: Mapped[str | None] = mapped_column(String(100))
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    # Scheduled jobs use e.g. "trash_purge:2026-10-08" so each runs once per slot.
    dedupe_key: Mapped[str | None] = mapped_column(String(100), unique=True)

    __table_args__ = (
        Index(
            "ix_jobs_ready",
            "run_after",
            postgresql_where=text("state = 'queued'"),
        ),
    )


class TrashKind(enum.StrEnum):
    FILE = "file"
    VERIFIED_ANSWER = "verified_answer"
    THREAD = "thread"
    CONVERSATION = "conversation"


class TrashItem(Base):
    __tablename__ = "trash"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    kind: Mapped[TrashKind] = mapped_column(_enum(TrashKind, "trash_kind"))
    ref_id: Mapped[uuid.UUID]
    title: Mapped[str] = mapped_column(String(255))
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    deleted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    deleter: Mapped[User | None] = relationship()

    __table_args__ = (Index("uq_trash_kind_ref_id", "kind", "ref_id", unique=True),)


class AuditEntry(Base):
    __tablename__ = "audit"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(String(50))
    entity: Mapped[str] = mapped_column(String(50))
    entity_id: Mapped[str | None] = mapped_column(String(100))
    title: Mapped[str | None] = mapped_column(String(255))
    changes: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, server_default="[]")
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    actor: Mapped[User | None] = relationship()

    __table_args__ = (
        Index("ix_audit_at", "at"),
        Index("ix_audit_entity", "entity", "entity_id"),
    )


class Setting(Base):
    """Owner-editable settings (SPEC section 10). Missing keys use the defaults in code."""

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class UsageKind(enum.StrEnum):
    ANSWER = "answer"
    CHECK = "check"
    OCR = "ocr"
    DRAFT = "draft"


class UsageDaily(Base):
    """Claude usage per day, person and kind (SPEC sections 5 and 9.5)."""

    __tablename__ = "usage_daily"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    date: Mapped[date] = mapped_column(Date)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    kind: Mapped[UsageKind] = mapped_column(_enum(UsageKind, "usage_kind"))
    requests: Mapped[int] = mapped_column(Integer, default=0)
    tokens_in: Mapped[int] = mapped_column(BigInteger, default=0)
    tokens_out: Mapped[int] = mapped_column(BigInteger, default=0)
    cost_usd: Mapped[float] = mapped_column(Numeric(12, 6, asdecimal=False), default=0)

    __table_args__ = (
        UniqueConstraint(
            "date", "user_id", "kind", name="uq_usage_daily_day", postgresql_nulls_not_distinct=True
        ),
    )


class KbOpKind(enum.StrEnum):
    UPSERT = "upsert"
    DELETE = "delete"


class KbOpState(enum.StrEnum):
    PENDING = "pending"
    DONE = "done"


class KbOp(TimestampMixin, Base):
    """The Pinecone outbox (SPEC section 6.4): written in the same transaction as the change
    it reflects, sent to Pinecone in order by the worker."""

    __tablename__ = "kb_ops"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    # Sending order. A sequence, not the id: UUID v7 isn't ordered within a millisecond.
    seq: Mapped[int] = mapped_column(BigInteger, Identity(), unique=True)
    op: Mapped[KbOpKind] = mapped_column(_enum(KbOpKind, "kb_op_kind"))
    namespace: Mapped[str] = mapped_column(String(50))
    record_ids: Mapped[list[str]] = mapped_column(ARRAY(String(100)))
    # The file the records belong to, so Documents can show "Sync pending".
    file_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"))
    state: Mapped[KbOpState] = mapped_column(
        _enum(KbOpState, "kb_op_state"), default=KbOpState.PENDING
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_error: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        Index("ix_kb_ops_pending", "seq", postgresql_where=text("state = 'pending'")),
        Index("ix_kb_ops_file_id", "file_id"),
    )


class Conversation(TimestampMixin, Base):
    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(200))
    last_message_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation",
        order_by="Message.position",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    __table_args__ = (Index("ix_conversations_user_last", "user_id", "last_message_at"),)

    @property
    def owner_ids(self) -> frozenset[uuid.UUID]:
        return frozenset({self.user_id})


class MessageRole(enum.StrEnum):
    USER = "user"
    ASSISTANT = "assistant"


class AnswerKind(enum.StrEnum):
    CHAT = "chat"
    MARKETING = "marketing"


class AnswerOutcome(enum.StrEnum):
    NO_ANSWER = "no_answer"
    LOW = "low"
    HIGH = "high"


class AnswerStatus(enum.StrEnum):
    AUTO = "auto"
    IN_REVIEW = "in_review"
    NEEDS_INFO = "needs_info"
    VERIFIED = "verified"
    CORRECTED = "corrected"
    WRONG_NO_ANSWER = "wrong_no_answer"


class Answer(TimestampMixin, Base):
    """Every answer the engine gives, kept for the Answer Log (SPEC sections 5 and 7.5)."""

    __tablename__ = "answers"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    kind: Mapped[AnswerKind] = mapped_column(_enum(AnswerKind, "answer_kind"))
    asked_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL")
    )
    question: Mapped[str] = mapped_column(Text)
    retrieval_query: Mapped[str] = mapped_column(Text)
    original_text: Mapped[str] = mapped_column(Text)
    current_text: Mapped[str] = mapped_column(Text)
    sources: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, server_default="[]")
    confidence: Mapped[int | None] = mapped_column(Integer)
    confidence_parts: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    outcome: Mapped[AnswerOutcome | None] = mapped_column(_enum(AnswerOutcome, "answer_outcome"))
    status: Mapped[AnswerStatus] = mapped_column(
        _enum(AnswerStatus, "answer_status"), default=AnswerStatus.AUTO
    )
    flagged: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    flag_note: Mapped[str | None] = mapped_column(Text)
    # 👍 / 👎 from the person who asked: "up", "down" or NULL.
    feedback: Mapped[str | None] = mapped_column(String(4))
    # When a review changed what the asker sees, and when they last saw it (the chat's dot).
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    model: Mapped[str | None] = mapped_column(String(100))
    usage: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    stop_reason: Mapped[str | None] = mapped_column(String(50))

    __table_args__ = (
        Index("ix_answers_created_at", "created_at"),
        Index("ix_answers_outcome", "outcome"),
    )

    @property
    def owner_ids(self) -> frozenset[uuid.UUID]:
        return frozenset({self.asked_by}) if self.asked_by else frozenset()


class Message(TimestampMixin, Base):
    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE")
    )
    role: Mapped[MessageRole] = mapped_column(_enum(MessageRole, "message_role"))
    # The user's text; for an assistant message a copy of answers.current_text.
    body: Mapped[str] = mapped_column(Text)
    answer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("answers.id", ondelete="SET NULL")
    )
    position: Mapped[int] = mapped_column(Integer)

    conversation: Mapped[Conversation] = relationship(back_populates="messages")
    answer: Mapped[Answer | None] = relationship()

    __table_args__ = (
        UniqueConstraint("conversation_id", "position", name="uq_messages_conversation_position"),
    )


class ReviewReason(enum.StrEnum):
    LOW_CONFIDENCE = "low_confidence"
    NO_ANSWER = "no_answer"
    ADMIN = "admin"
    FLAG = "flag"


class ReviewState(enum.StrEnum):
    OPEN = "open"
    CLAIMED = "claimed"
    NEEDS_INFO = "needs_info"
    APPROVED = "approved"
    EDITED = "edited"
    REJECTED = "rejected"
    CANCELLED = "cancelled"


UNDECIDED = (ReviewState.OPEN, ReviewState.CLAIMED, ReviewState.NEEDS_INFO)


class Review(TimestampMixin, Base):
    """A person checking an answer (SPEC section 6.7). `number` is the #R-142 shown to people."""

    __tablename__ = "reviews"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    number: Mapped[int] = mapped_column(BigInteger, Identity(), unique=True)
    answer_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("answers.id", ondelete="CASCADE"))
    reason: Mapped[ReviewReason] = mapped_column(_enum(ReviewReason, "review_reason"))
    state: Mapped[ReviewState] = mapped_column(
        _enum(ReviewState, "review_state"), default=ReviewState.OPEN
    )
    claimed_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    final_text: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    # The group message, and the bot's "reply to this message with…" prompt and what it is for.
    telegram_message_id: Mapped[int | None] = mapped_column(BigInteger)
    prompt_message_id: Mapped[int | None] = mapped_column(BigInteger)
    prompt_action: Mapped[str | None] = mapped_column(String(20))
    reminded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    answer: Mapped[Answer] = relationship()
    messages: Mapped[list["ReviewMessage"]] = relationship(
        back_populates="review", order_by="ReviewMessage.created_at", passive_deletes=True
    )

    __table_args__ = (
        Index("ix_reviews_state_created", "state", "created_at"),
        Index("ix_reviews_answer_id", "answer_id"),
        # At most one undecided review per answer.
        Index(
            "uq_reviews_answer_undecided",
            "answer_id",
            unique=True,
            postgresql_where=text("state IN ('open', 'claimed', 'needs_info')"),
        ),
    )

    @property
    def undecided(self) -> bool:
        return self.state in UNDECIDED


class ReviewMessageKind(enum.StrEnum):
    QUESTION_TO_ASKER = "question_to_asker"
    ASKER_REPLY = "asker_reply"
    REVIEWER_NOTE = "reviewer_note"


class ReviewMessage(TimestampMixin, Base):
    __tablename__ = "review_messages"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    review_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("reviews.id", ondelete="CASCADE"))
    author_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    kind: Mapped[ReviewMessageKind] = mapped_column(_enum(ReviewMessageKind, "review_message_kind"))
    body: Mapped[str] = mapped_column(Text)

    review: Mapped[Review] = relationship(back_populates="messages")

    __table_args__ = (Index("ix_review_messages_review_id", "review_id"),)


class VerifiedStatus(enum.StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"
    EXPIRED = "expired"


class VerifiedOrigin(enum.StrEnum):
    REVIEW = "review"
    ADMIN = "admin"
    MARKETING = "marketing"


class VerifiedAnswer(TimestampMixin, Base):
    """A question and answer the team has confirmed (SPEC section 6.9). Searchable in the
    `verified` namespace while active."""

    __tablename__ = "verified_answers"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    question: Mapped[str] = mapped_column(Text)
    answer: Mapped[str] = mapped_column(Text)
    status: Mapped[VerifiedStatus] = mapped_column(
        _enum(VerifiedStatus, "verified_status"), default=VerifiedStatus.ACTIVE
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    origin: Mapped[VerifiedOrigin] = mapped_column(_enum(VerifiedOrigin, "verified_origin"))
    origin_answer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("answers.id", ondelete="SET NULL")
    )
    source_file_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), default=list, server_default="{}"
    )
    needs_check: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    needs_check_reason: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("ix_verified_answers_origin_answer", "origin_answer_id"),
        Index("ix_verified_answers_sources", "source_file_ids", postgresql_using="gin"),
    )

    @property
    def record_id(self) -> str:
        return f"va_{self.id}"


class VerifiedAnswerVersion(Base):
    __tablename__ = "verified_answer_versions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    verified_answer_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("verified_answers.id", ondelete="CASCADE")
    )
    version: Mapped[int] = mapped_column(Integer)
    question: Mapped[str] = mapped_column(Text)
    answer: Mapped[str] = mapped_column(Text)
    changed_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("verified_answer_id", "version", name="uq_verified_versions"),
    )
