"""Database tables (SPEC section 5). Each build step adds the tables it needs."""

import enum
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
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
