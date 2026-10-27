"""Database tables (SPEC section 5). Each build step adds the tables it needs."""

import enum
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.ids import uuid7


class Role(enum.StrEnum):
    OWNER = "owner"
    ADMIN = "admin"
    VIEWER = "viewer"


class RunTrigger(enum.StrEnum):
    SCHEDULE = "schedule"
    MANUAL = "manual"


class RunStatus(enum.StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    STOPPED = "stopped"
    TIMED_OUT = "timed_out"


ACTIVE_RUN = (RunStatus.QUEUED, RunStatus.RUNNING)


class TokenKind(enum.StrEnum):
    INVITE = "invite"
    RESET = "reset"


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
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Alerts by email (SPEC section 6.6); each person can switch them off.
    alert_email: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

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


class AuditEntry(Base):
    """History (SPEC section 5): who did what. Never holds secret values."""

    __tablename__ = "audit_log"

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
        Index("ix_audit_log_at", "at"),
        Index("ix_audit_log_entity", "entity", "entity_id"),
    )


class Setting(Base):
    """Values the Owner sets in the website (SPEC section 5). Missing keys use the defaults
    in `app/settings_store.py`."""

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Agent(TimestampMixin, Base):
    """An agent the Hub runs (SPEC section 6.2). It describes itself with a manifest."""

    __tablename__ = "agents"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    key: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(120))
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    # Sent by the agent when it starts; None until it has connected once.
    manifest: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    # The values set in the Hub for the manifest's settings.
    config: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    daily_limit: Mapped[int] = mapped_column(Integer, default=100, server_default="100")
    run_time: Mapped[str] = mapped_column(String(5), default="02:00", server_default="02:00")
    time_zone: Mapped[str] = mapped_column(
        String(64), default="Asia/Dhaka", server_default="Asia/Dhaka"
    )
    daily_budget_usd: Mapped[Decimal] = mapped_column(
        Numeric(10, 2), default=Decimal("5"), server_default="5"
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    runs: Mapped[list["Run"]] = relationship(back_populates="agent", passive_deletes=True)


class Run(Base):
    """One run of an agent: queued by the schedule or Run now, then reported by the agent."""

    __tablename__ = "runs"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    agent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))
    trigger: Mapped[RunTrigger] = mapped_column(_enum(RunTrigger, "run_trigger"))
    status: Mapped[RunStatus] = mapped_column(_enum(RunStatus, "run_status"))
    requested_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    done: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    failed: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    skipped: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    cost_usd: Mapped[Decimal] = mapped_column(
        Numeric(12, 4), default=Decimal("0"), server_default="0"
    )
    stop_reason: Mapped[str | None] = mapped_column(String(255))
    summary: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    # Stop pressed in the Hub: the agent is told at its next progress report.
    stop_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    stop_requested_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    agent: Mapped[Agent] = relationship(back_populates="runs")
    requester: Mapped[User | None] = relationship(foreign_keys=[requested_by])
    stopper: Mapped[User | None] = relationship(foreign_keys=[stop_requested_by])

    __table_args__ = (
        Index("ix_runs_agent_id_queued_at", "agent_id", "queued_at"),
        # One queued or running run per agent at a time, even if two requests race.
        Index(
            "uq_runs_one_active_per_agent",
            "agent_id",
            unique=True,
            postgresql_where=text("status IN ('queued', 'running')"),
        ),
    )


class ImportStatus(enum.StrEnum):
    PREVIEW = "preview"
    CONFIRMED = "confirmed"
    FAILED = "failed"
    DISCARDED = "discarded"


class Import(TimestampMixin, Base):
    """An uploaded lead file (SPEC section 6.4). The file itself isn't kept: `rows` holds
    the cleaned leads until the import is confirmed or discarded."""

    __tablename__ = "imports"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    file_name: Mapped[str] = mapped_column(String(255))
    niche: Mapped[str] = mapped_column(String(80))
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    status: Mapped[ImportStatus] = mapped_column(_enum(ImportStatus, "import_status"))
    counts: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    preview: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    rows: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, server_default="[]")
    error: Mapped[str | None] = mapped_column(String(500))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    uploader: Mapped[User | None] = relationship()


class Lead(TimestampMixin, Base):
    """The Lead ID registry (SPEC section 5): enough to match a business on the next import.
    The full row lives in the Master Sheet."""

    __tablename__ = "leads"

    lead_id: Mapped[str] = mapped_column(String(12), primary_key=True)
    niche: Mapped[str] = mapped_column(String(80))
    city: Mapped[str] = mapped_column(String(120))
    business_name: Mapped[str] = mapped_column(String(255))
    level: Mapped[str] = mapped_column(String(20), default="", server_default="")
    gbp_link: Mapped[str] = mapped_column(String(500), default="", server_default="")
    phone_digits: Mapped[str] = mapped_column(String(20), default="", server_default="")
    name_address: Mapped[str] = mapped_column(String(600), default="", server_default="")
    website_domain: Mapped[str] = mapped_column(String(255), default="", server_default="")
    emails: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")
    first_import_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("imports.id", ondelete="SET NULL")
    )
    last_import_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("imports.id", ondelete="SET NULL")
    )

    __table_args__ = (
        Index("ix_leads_gbp_link", "gbp_link"),
        Index("ix_leads_phone_digits", "phone_digits"),
        Index("ix_leads_name_address", "name_address"),
        Index("ix_leads_niche_city", "niche", "city"),
    )


class LeadList(TimestampMixin, Base):
    """One City + Niche (SPEC section 5): switched off, its leads are left alone."""

    __tablename__ = "lists"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    city: Mapped[str] = mapped_column(String(120))
    niche: Mapped[str] = mapped_column(String(80))
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    daily_limit: Mapped[int | None] = mapped_column(Integer)

    __table_args__ = (Index("uq_lists_city_niche", "city", "niche", unique=True),)


class DoNotContact(Base):
    """Never outreached (PLAN.md section 3.4): Top leads now, opt-outs later."""

    __tablename__ = "do_not_contact"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    kind: Mapped[str] = mapped_column(String(10))  # email, phone, gbp, domain
    value: Mapped[str] = mapped_column(String(500))
    reason: Mapped[str] = mapped_column(String(20))  # top, opt_out, manual
    lead_id: Mapped[str | None] = mapped_column(String(12))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("uq_do_not_contact_kind_value_reason", "kind", "value", "reason", unique=True),
        Index("ix_do_not_contact_lead_id", "lead_id"),
    )


class GbpBenchmark(TimestampMixin, Base):
    """What the top businesses of a City + Niche look like (PLAN.md section 3.5). Every
    value is optional: empty means "don't compare this"."""

    __tablename__ = "gbp_benchmarks"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    city: Mapped[str] = mapped_column(String(120))
    niche: Mapped[str] = mapped_column(String(80))
    additional_categories: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    services: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    photos: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    posts_90_days: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    description_length: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    reviews: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    rating: Mapped[Decimal | None] = mapped_column(Numeric(4, 2))
    review_reply_pct: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    reference_businesses: Mapped[str] = mapped_column(String(1000), default="", server_default="")
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    __table_args__ = (Index("uq_gbp_benchmarks_city_niche", "city", "niche", unique=True),)


class WebsiteStandard(Base):
    """A niche's Website Standard (SPEC section 6.5): drafts are edited, locked versions are
    what the Website agent uses."""

    __tablename__ = "website_standards"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    niche: Mapped[str] = mapped_column(String(80))
    version: Mapped[int | None] = mapped_column(Integer)  # None while a draft
    standard: Mapped[dict[str, Any]] = mapped_column(JSONB)
    edited_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    edited_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    locked_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    editor: Mapped[User | None] = relationship(foreign_keys=[edited_by])
    locker: Mapped[User | None] = relationship(foreign_keys=[locked_by])

    __table_args__ = (
        Index("uq_website_standards_niche_version", "niche", "version", unique=True),
        # One draft per niche.
        Index(
            "uq_website_standards_one_draft",
            "niche",
            unique=True,
            postgresql_where=text("version IS NULL"),
        ),
    )


class Alert(Base):
    """Something a person should know about (SPEC section 6.6). Saved first, then sent by
    the scheduler, so a slow email server never holds up an agent."""

    __tablename__ = "alerts"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    kind: Mapped[str] = mapped_column(String(40))
    # The same key isn't alerted twice within REPEAT_AFTER.
    dedupe_key: Mapped[str] = mapped_column(String(200))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(String(4000))
    audience: Mapped[str] = mapped_column(String(10))  # "owners" or "staff"
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    emailed_to: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")
    telegram_sent: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    error: Mapped[str | None] = mapped_column(String(500))

    __table_args__ = (
        Index("ix_alerts_dedupe_key_created_at", "dedupe_key", "created_at"),
        Index("ix_alerts_sent_at", "sent_at"),
    )
