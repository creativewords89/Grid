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
    LargeBinary,
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
    # The external team that collects leads (step 31): only the Files screen, own files.
    COLLECTOR = "collector"


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
    # A built-in kind (app/builtin, e.g. "demo"): the Hub's agents service runs it (step 25).
    # None for an agent with a token and a container of its own.
    kind: Mapped[str | None] = mapped_column(String(40))
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
    # The task its manifest names (SPEC section 6.7); None until it has connected once.
    task_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"))

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
    batch_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("batches.id", ondelete="RESTRICT")
    )
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    status: Mapped[ImportStatus] = mapped_column(_enum(ImportStatus, "import_status"))
    counts: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    preview: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    rows: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, server_default="[]")
    # Every row of the file by tab (SPEC section 6.4): while waiting, its cleaned values,
    # original text and what happens to it; once confirmed, its tab, row and Lead ID.
    sheet: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    error: Mapped[str | None] = mapped_column(String(500))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    uploader: Mapped[User | None] = relationship()
    batch: Mapped["Batch | None"] = relationship()


class Submission(TimestampMixin, Base):
    """A lead file handed in on the Files screen (SPEC step 31), before it is in a batch:
    checked by Lead Check, revised by its sender until it is ready, then added to a batch
    by an Owner or Admin (which makes an import of it). A file is used once."""

    __tablename__ = "submissions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    file_name: Mapped[str] = mapped_column(String(255))
    niche: Mapped[str] = mapped_column(String(80))
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    content: Mapped[bytes] = mapped_column(LargeBinary)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    businesses: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Lead Check: errors and warnings by tab, and every problem (tab, row, column, value).
    check: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    problems: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list, server_default="[]")
    # The import that added it to a batch; it is used once that import is saved.
    import_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("imports.id", ondelete="SET NULL")
    )

    uploader: Mapped[User | None] = relationship()
    imp: Mapped["Import | None"] = relationship()


class Lead(TimestampMixin, Base):
    """A business (SPEC section 5): the keys that match it on the next import, its row from
    the lead files (`data`) and what each agent found (`results`, by agent key)."""

    __tablename__ = "leads"

    lead_id: Mapped[str] = mapped_column(String(12), primary_key=True)
    # A business is in one batch only: the one it was first imported into.
    batch_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("batches.id", ondelete="RESTRICT")
    )
    niche: Mapped[str] = mapped_column(String(80))
    city: Mapped[str] = mapped_column(String(120))
    business_name: Mapped[str] = mapped_column(String(255))
    level: Mapped[str] = mapped_column(String(20), default="", server_default="")
    gbp_link: Mapped[str] = mapped_column(String(500), default="", server_default="")
    phone_digits: Mapped[str] = mapped_column(String(20), default="", server_default="")
    name_address: Mapped[str] = mapped_column(String(600), default="", server_default="")
    website_domain: Mapped[str] = mapped_column(String(255), default="", server_default="")
    emails: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")
    # address, website, phone, whatsapp, facebook, instagram, reviews, rating, notes
    data: Mapped[dict[str, str]] = mapped_column(JSONB, default=dict, server_default="{}")
    # The file's other columns, by their header (e.g. "Operation Hour").
    extra: Mapped[dict[str, str]] = mapped_column(JSONB, default=dict, server_default="{}")
    # agent key -> {status, score, summary, details, benchmark_id, benchmark_version, at}
    results: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    # Lead Check (step 26): what is wrong in its fields; None until checked.
    check: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB)
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
        Index("ix_leads_batch_id", "batch_id"),
    )


class LeadFile(Base):
    """A file an agent saved for a lead, such as its audit report (SPEC section 6.4). The
    bytes are on disk under REPORTS_DIR; the database knows its name and where it is."""

    __tablename__ = "lead_files"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    lead_id: Mapped[str] = mapped_column(ForeignKey("leads.lead_id", ondelete="CASCADE"))
    agent_key: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(120))
    content_type: Mapped[str] = mapped_column(String(80))
    size: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("uq_lead_files_lead_agent_name", "lead_id", "agent_key", "name", unique=True),
    )


class LeadList(TimestampMixin, Base):
    """A city of a batch (SPEC section 6.4): switched off, its leads in that batch are
    left alone."""

    __tablename__ = "lists"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    batch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("batches.id", ondelete="CASCADE"))
    city: Mapped[str] = mapped_column(String(120))
    niche: Mapped[str] = mapped_column(String(80))
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    # A person switched it on or off: the small-city rule leaves it alone.
    set_by_hand: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    daily_limit: Mapped[int | None] = mapped_column(Integer)

    __table_args__ = (Index("uq_lists_batch_city", "batch_id", func.lower(city), unique=True),)


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


class Benchmark(TimestampMixin, Base):
    """What a good business of a niche looks like (SPEC section 6.5): GBP numbers and the
    Website Standard, in one named set such as "Cleaning Benchmark 1". It doesn't depend on
    city or competition. Every change of the numbers or the standard raises `version`, so
    agents know to check their leads again."""

    __tablename__ = "benchmarks"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String(120))
    niche: Mapped[str] = mapped_column(String(80))
    gbp: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    website: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    editor: Mapped[User | None] = relationship()

    __table_args__ = (Index("uq_benchmarks_name", func.lower(name), unique=True),)


class BatchStatus(enum.StrEnum):
    NOT_STARTED = "not_started"
    RUNNING = "running"
    PAUSED = "paused"


class Batch(TimestampMixin, Base):
    """A named group of leads of one niche, checked against one Benchmark (SPEC section
    6.4). Files are added to a batch; its tasks and bots are chosen in it (section 6.7)."""

    __tablename__ = "batches"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str] = mapped_column(String(120))
    niche: Mapped[str] = mapped_column(String(80))
    # Required when a batch is made; None only for leads moved in from before batches.
    benchmark_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("benchmarks.id", ondelete="RESTRICT")
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    status: Mapped[str] = mapped_column(
        String(20), default=BatchStatus.NOT_STARTED, server_default=BatchStatus.NOT_STARTED
    )
    # The running order: when two running batches use the same bot, the lower comes first.
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    benchmark: Mapped[Benchmark | None] = relationship()

    __table_args__ = (Index("uq_batches_name", func.lower(name), unique=True),)


class Task(TimestampMixin, Base):
    """A job agents do, such as GBP Audit (SPEC section 6.7), made from their manifests.
    A batch's tasks name a job each; what a task needs first belongs to the batch."""

    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    key: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(80))


class ShareMode(enum.StrEnum):
    ALL = "all"  # every bot checks every business
    SPLIT = "split"  # each business goes to one bot


class BatchTask(Base):
    """A task in a batch's pipeline, and how its bots share the work."""

    __tablename__ = "batch_tasks"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid7)
    batch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("batches.id", ondelete="CASCADE"))
    task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tasks.id", ondelete="RESTRICT"))
    name: Mapped[str] = mapped_column(String(80), default="", server_default="")
    # The jobs (task keys) of this batch's tasks it waits for.
    needs: Mapped[list[str]] = mapped_column(JSONB, default=list, server_default="[]")
    share: Mapped[str] = mapped_column(String(10), default=ShareMode.ALL, server_default="all")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    task: Mapped[Task] = relationship()
    bots: Mapped[list["BatchTaskBot"]] = relationship(
        order_by="BatchTaskBot.position", cascade="all, delete-orphan", passive_deletes=True
    )

    __table_args__ = (Index("uq_batch_tasks", "batch_id", "task_id", unique=True),)


class BatchTaskBot(Base):
    """A bot doing a task in a batch."""

    __tablename__ = "batch_task_bots"

    batch_task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("batch_tasks.id", ondelete="CASCADE"), primary_key=True
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    agent: Mapped[Agent] = relationship()


class LeadBotShare(Base):
    """For a task whose bots split the businesses: which bot a lead went to."""

    __tablename__ = "lead_bot_shares"

    batch_task_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("batch_tasks.id", ondelete="CASCADE"), primary_key=True
    )
    lead_id: Mapped[str] = mapped_column(
        ForeignKey("leads.lead_id", ondelete="CASCADE"), primary_key=True
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))


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
