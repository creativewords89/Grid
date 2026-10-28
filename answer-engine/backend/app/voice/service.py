"""Brand voice (SPEC section 6.13): real questions with the answers we liked, per platform,
teaching drafts our tone, length and wording. Facts still come only from the knowledge base.

Each platform's active examples are searched in Pinecone's `voice-{slug}` namespace by
their question. For each draft a few close, varied examples are picked; the platform's
style guide (written by the AI from all its examples, or the Owner's edit) and writing rules
apply to every draft. The caller commits.
"""

import logging
import re
import unicodedata
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import audit, settings_store
from app.ai import usage as usage_log
from app.ai.usage import Usage
from app.answering.claude_answer import Answerer
from app.answering.prompts import StyleExample, guide_message, voice_block
from app.auth.tokens import now
from app.db.models import (
    DraftState,
    MessageAuthor,
    Platform,
    ThreadMessage,
    UsageKind,
    User,
    VoiceEmojis,
    VoiceExample,
    VoiceLinks,
    VoiceSource,
    VoiceState,
)
from app.files import sniff
from app.files.extract_sheet import extract_csv, extract_xlsx
from app.jobs.queue import PermanentError, enqueue
from app.kb import outbox
from app.kb.store import Record, VectorStore

log = logging.getLogger(__name__)

PREFIX = "voice-"
GUIDE_JOB = "voice_guide"

MAX_EXAMPLES = 5000
MAX_TEXT = 4000
GUIDE_SAMPLE = 120  # examples shown to the AI when it writes the style guide

PICK = 4  # examples shown with each draft (3-5)
CANDIDATES = 12  # close matches considered
SEARCH_TOP_K = 30
MIN_MATCH = 0.2  # below this an example isn't "close"
TYPICAL = 2  # examples shown when none is close
RECENT = 8  # the most recently used examples are set aside a little (rotation)
COMMUNITY_BOOST = 0.1
QUALITY_BOOST = 0.05  # starred, or a posted reply we approved
RECENT_PENALTY = 0.7
SAME_ANSWER = 0.6  # word overlap above which two answers count as near-copies

NEEDS_COLUMNS = (
    "The file needs a header row with “question” and “answer” columns. Download the template "
    "to see the layout."
)
NO_EXAMPLES = "No examples were found: each row needs a question and an answer."
WRONG_TYPE = "Upload the examples as an Excel (.xlsx) or CSV file."

_HEADERS = {
    "question": {"question", "questions", "their question", "q", "post"},
    "answer": {"answer", "answers", "our answer", "a", "reply", "our reply", "response"},
    "community": {"group", "community", "subreddit"},
    "notes": {"notes", "note", "comment", "comments"},
}
_LINK = re.compile(r"https?://|www\.", re.IGNORECASE)
_EMOJI = re.compile("[\U0001f300-\U0001faff☀-➿]")


class VoiceError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def namespace(platform: Platform) -> str:
    return f"{PREFIX}{platform.slug}"


# --- the examples file --------------------------------------------------------------------


@dataclass
class ParsedRow:
    question: str
    answer: str
    community: str | None
    notes: str | None


@dataclass
class ParsedFile:
    rows: list[ParsedRow] = field(default_factory=list)
    skipped: int = 0  # rows without a question or an answer
    duplicates: int = 0


def _header(text: str) -> str:
    text = re.sub(r"\(optional\)", "", text, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", text).strip().lower()


def _columns(headers: list[str]) -> dict[str, int]:
    found: dict[str, int] = {}
    for index, header in enumerate(headers):
        name = _header(header)
        for role, names in _HEADERS.items():
            if name in names and role not in found:
                found[role] = index
    return found


def _cell(cells: list[str], index: int | None, limit: int) -> str:
    if index is None or index >= len(cells):
        return ""
    return cells[index].strip()[:limit]


def _key(question: str, answer: str) -> str:
    def norm(text: str) -> str:
        text = unicodedata.normalize("NFKC", text).lower()
        return re.sub(r"\W+", " ", text).strip()

    return f"{norm(question)}|{norm(answer)}"


def parse_file(path: Path, filename: str) -> ParsedFile:
    """The examples in an uploaded spreadsheet. Raises VoiceError with a readable reason."""
    try:
        file_type = sniff.detect(path, filename)
    except sniff.SniffError as exc:
        raise VoiceError(415, "unsupported", str(exc)) from None
    if file_type not in (sniff.XLSX, sniff.CSV):
        raise VoiceError(415, "unsupported", WRONG_TYPE)
    try:
        workbook = extract_xlsx(path) if file_type == sniff.XLSX else extract_csv(path)
    except PermanentError as exc:
        raise VoiceError(422, "unreadable", str(exc)) from None

    for sheet in workbook.sheets:
        columns = _columns(sheet.headers)
        if "question" in columns and "answer" in columns:
            break
    else:
        raise VoiceError(422, "no_columns", NEEDS_COLUMNS)

    parsed = ParsedFile()
    seen: set[str] = set()
    for _, cells in sheet.rows:
        question = _cell(cells, columns["question"], MAX_TEXT)
        answer = _cell(cells, columns["answer"], MAX_TEXT)
        if not question or not answer:
            parsed.skipped += 1
            continue
        key = _key(question, answer)
        if key in seen:
            parsed.duplicates += 1
            continue
        seen.add(key)
        parsed.rows.append(
            ParsedRow(
                question=question,
                answer=answer,
                community=_cell(cells, columns.get("community"), 200) or None,
                notes=_cell(cells, columns.get("notes"), 1000) or None,
            )
        )
    if not parsed.rows:
        raise VoiceError(422, "empty", NO_EXAMPLES)
    if len(parsed.rows) > MAX_EXAMPLES:
        raise VoiceError(422, "too_many", f"Upload at most {MAX_EXAMPLES:,} examples per platform.")
    return parsed


def _searchable(example: VoiceExample) -> bool:
    return example.state == VoiceState.ACTIVE and example.enabled


def replace_file(
    db: Session, platform: Platform, parsed: ParsedFile, filename: str, by: User
) -> list[VoiceExample]:
    """The examples from a new file replace the previous file's. Approved posted replies stay."""
    old = db.scalars(
        select(VoiceExample).where(
            VoiceExample.platform_id == platform.id, VoiceExample.source == VoiceSource.FILE
        )
    ).all()
    outbox.delete(db, namespace(platform), [e.record_id for e in old])
    for example in old:
        db.delete(example)
    added = [
        VoiceExample(
            platform_id=platform.id,
            source=VoiceSource.FILE,
            state=VoiceState.ACTIVE,
            question=row.question,
            answer=row.answer,
            community=row.community,
            notes=row.notes,
            created_by=by.id,
        )
        for row in parsed.rows
    ]
    db.add_all(added)
    db.flush()
    outbox.upsert(db, namespace(platform), [e.record_id for e in added])
    platform.voice_file_name = filename[:255]
    platform.voice_file_at = now()
    platform.voice_file_by = by.id
    audit.record(
        db,
        by,
        "upload",
        "brand_voice",
        platform.id,
        f"{platform.name} examples",
        [{"field": "examples", "from": len(old), "to": len(added)}],
    )
    if not platform.voice_guide_edited:
        enqueue(db, GUIDE_JOB, {"platform_id": str(platform.id), "user_id": str(by.id)})
    return added


# --- one example ----------------------------------------------------------------------------


def _resync(db: Session, example: VoiceExample, was_searchable: bool) -> None:
    space = namespace(example.platform)
    if _searchable(example):
        outbox.upsert(db, space, [example.record_id])  # also refreshes an edited question
    elif was_searchable:
        outbox.delete(db, space, [example.record_id])


def update(
    db: Session,
    example: VoiceExample,
    by: User,
    *,
    enabled: bool | None = None,
    starred: bool | None = None,
    question: str | None = None,
    answer: str | None = None,
) -> None:
    was = _searchable(example)
    changes = []
    for name, value in (
        ("enabled", enabled),
        ("starred", starred),
        ("question", question),
        ("answer", answer),
    ):
        if value is None:
            continue
        if isinstance(value, str):
            value = value.strip()
            if not value:
                raise VoiceError(422, "invalid", f"The {name} can't be empty.")
        if getattr(example, name) != value:
            changes.append({"field": name, "from": None, "to": "(changed)"})
            setattr(example, name, value)
    if changes:
        _resync(db, example, was)
        audit.record(db, by, "update", "voice_example", example.id, example.question[:120], changes)


def remove(db: Session, example: VoiceExample, by: User) -> None:
    outbox.delete(db, namespace(example.platform), [example.record_id])
    audit.record(db, by, "delete", "voice_example", example.id, example.question[:120])
    db.delete(example)


def approve(db: Session, example: VoiceExample, by: User, answer: str | None = None) -> None:
    if example.state != VoiceState.SUGGESTED:
        raise VoiceError(409, "decided", "This suggestion was already decided.")
    if answer is not None:
        if not answer.strip():
            raise VoiceError(422, "invalid", "The answer can't be empty.")
        example.answer = answer.strip()[:MAX_TEXT]
    example.state = VoiceState.ACTIVE
    example.decided_by = by.id
    _resync(db, example, False)
    audit.record(db, by, "approve", "voice_example", example.id, example.question[:120])


def dismiss(db: Session, example: VoiceExample, by: User) -> None:
    if example.state != VoiceState.SUGGESTED:
        raise VoiceError(409, "decided", "This suggestion was already decided.")
    example.state = VoiceState.DISMISSED
    example.decided_by = by.id
    audit.record(db, by, "dismiss", "voice_example", example.id, example.question[:120])


# --- suggestions from posted replies ---------------------------------------------------------


def _their_question(message: ThreadMessage) -> str | None:
    by_id = {m.id: m for m in message.thread.messages}
    parent = by_id.get(message.parent_id) if message.parent_id else None
    if parent is not None and parent.author == MessageAuthor.THEM:
        return parent.body
    first = next(
        (
            m
            for m in sorted(message.thread.messages, key=lambda m: m.created_at)
            if m.author == MessageAuthor.THEM
        ),
        None,
    )
    return first.body if first else None


def suggest_from_post(db: Session, message: ThreadMessage) -> VoiceExample | None:
    """A reply our team posted waits in To approve as a possible example (SPEC 6.13)."""
    if message.state != DraftState.POSTED or message.author != MessageAuthor.US:
        return None
    if db.scalar(select(VoiceExample.id).where(VoiceExample.thread_message_id == message.id)):
        return None
    question = _their_question(message)
    if not question:
        return None
    answer = message.answer
    suggestion = VoiceExample(
        platform_id=message.thread.platform_id,
        source=VoiceSource.POSTED,
        state=VoiceState.SUGGESTED,
        question=question[:MAX_TEXT],
        answer=message.body[:MAX_TEXT],
        community=message.thread.community,
        corrected=bool(answer and answer.current_text.strip() != answer.original_text.strip()),
        thread_message_id=message.id,
        created_by=message.posted_by,
    )
    db.add(suggestion)
    return suggestion


def correct_suggestion(db: Session, message: ThreadMessage, text: str) -> None:
    """A posted reply corrected by a reviewer: its waiting suggestion uses the correction."""
    suggestion = db.scalar(select(VoiceExample).where(VoiceExample.thread_message_id == message.id))
    if suggestion is not None and suggestion.state == VoiceState.SUGGESTED:
        suggestion.answer = text[:MAX_TEXT]
        suggestion.corrected = True


# --- Pinecone ------------------------------------------------------------------------------


def _ids_from_records(record_ids: list[str]) -> list[uuid.UUID]:
    out = []
    for record_id in record_ids:
        try:
            out.append(uuid.UUID(hex=record_id.removeprefix("vx_")))
        except ValueError:
            continue
    return out


def _live(db: Session, record_ids: list[str]) -> dict[str, VoiceExample]:
    ids = _ids_from_records(record_ids)
    if not ids:
        return {}
    rows = db.scalars(
        select(VoiceExample).where(
            VoiceExample.id.in_(ids),
            VoiceExample.state == VoiceState.ACTIVE,
            VoiceExample.enabled.is_(True),
        )
    ).all()
    return {row.record_id: row for row in rows}


def records(db: Session, space: str, record_ids: list[str]) -> list[Record]:
    """Pinecone records for the examples that are still active: searched by their question."""
    live = _live(db, record_ids)
    return [
        {"_id": record_id, "text": e.question, "example_id": str(e.id)}
        for record_id, e in sorted(live.items())
        if namespace(e.platform) == space
    ]


def all_live_records(db: Session) -> dict[str, set[str]]:
    """Every platform's namespace with the records it should hold (for Check and Rebuild)."""
    wanted: dict[str, set[str]] = {namespace(p): set() for p in db.scalars(select(Platform)).all()}
    rows = db.execute(
        select(Platform.slug, VoiceExample.id)
        .join(Platform, Platform.id == VoiceExample.platform_id)
        .where(VoiceExample.state == VoiceState.ACTIVE, VoiceExample.enabled.is_(True))
    ).all()
    for slug, example_id in rows:
        wanted.setdefault(f"{PREFIX}{slug}", set()).add(f"vx_{example_id.hex}")
    return wanted


def counts(db: Session) -> dict[uuid.UUID, int]:
    """Active, switched-on examples per platform."""
    rows = db.execute(
        select(VoiceExample.platform_id, func.count())
        .where(VoiceExample.state == VoiceState.ACTIVE, VoiceExample.enabled.is_(True))
        .group_by(VoiceExample.platform_id)
    ).all()
    return {platform_id: n for platform_id, n in rows}


# --- picking examples for a draft --------------------------------------------------------------


@dataclass
class Picked:
    examples: list[VoiceExample] = field(default_factory=list)
    matched: bool = False  # False: none was close, these are typical ones


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"\w+", text.lower()) if len(w) > 2}


def _near_copy(a: str, b: str) -> bool:
    first, second = _words(a), _words(b)
    if not first or not second:
        return False
    return len(first & second) / len(first | second) >= SAME_ANSWER


def pick(
    db: Session, store: VectorStore, platform: Platform, text: str, community: str | None
) -> Picked:
    """3-5 examples for one draft: close to the question, the same group preferred, the best
    ones preferred, varied, and the most recently used set aside a little (SPEC 6.13)."""
    model = str(settings_store.get(db, "rerank_model"))
    try:
        hits = store.search(namespace(platform), text[:2000], SEARCH_TOP_K, model, CANDIDATES)
    except Exception as exc:  # the brand voice never stops a draft
        log.warning("brand voice search failed: %s", exc)
        hits = []
    live = _live(db, [hit.id for hit in hits])
    recent = set(
        db.scalars(
            select(VoiceExample.id)
            .where(VoiceExample.platform_id == platform.id, VoiceExample.last_used_at.isnot(None))
            .order_by(VoiceExample.last_used_at.desc())
            .limit(RECENT)
        ).all()
    )
    group = (community or "").strip().lower()
    scored: list[tuple[float, VoiceExample]] = []
    for hit in hits:
        example = live.get(hit.id)
        if example is None or example.platform_id != platform.id or hit.score < MIN_MATCH:
            continue
        score = hit.score
        if group and (example.community or "").strip().lower() == group:
            score += COMMUNITY_BOOST
        if example.starred or example.source == VoiceSource.POSTED:
            score += QUALITY_BOOST
        if example.id in recent:
            score *= RECENT_PENALTY
        scored.append((score, example))
    scored.sort(key=lambda pair: (-pair[0], str(pair[1].id)))

    chosen: list[VoiceExample] = []
    for _, example in scored:
        if any(_near_copy(example.answer, other.answer) for other in chosen):
            continue
        chosen.append(example)
        if len(chosen) == PICK:
            break
    if chosen:
        return Picked(chosen, matched=True)
    typical = db.scalars(
        select(VoiceExample)
        .where(
            VoiceExample.platform_id == platform.id,
            VoiceExample.state == VoiceState.ACTIVE,
            VoiceExample.enabled.is_(True),
        )
        .order_by(
            VoiceExample.starred.desc(),
            VoiceExample.used_count.desc(),
            VoiceExample.created_at.desc(),
        )
        .limit(TYPICAL)
    ).all()
    return Picked(list(typical), matched=False)


def mark_used(examples: list[VoiceExample]) -> None:
    at = now()
    for example in examples:
        example.used_count += 1
        example.last_used_at = at


def rules(platform: Platform) -> list[str]:
    """The writing rules as instructions for the draft."""
    out = []
    if platform.voice_max_words:
        out.append(f"At most {platform.voice_max_words} words.")
    if platform.voice_emojis == VoiceEmojis.NONE:
        out.append("No emojis.")
    elif platform.voice_emojis == VoiceEmojis.ONE:
        out.append("At most one emoji.")
    if platform.voice_links == VoiceLinks.NEVER:
        out.append("No links.")
    elif platform.voice_links == VoiceLinks.WHEN_ASKED:
        out.append("No links unless the person asked for one.")
    if platform.voice_banned:
        words = ", ".join(f"“{w}”" for w in platform.voice_banned)
        out.append(f"Never use these words or phrases: {words}.")
    return out


def prompt_block(platform: Platform, picked: Picked) -> str:
    return voice_block(
        platform.voice_guide,
        rules(platform),
        [StyleExample(e.question, e.answer) for e in picked.examples],
    )


@dataclass
class Checks:
    words: int
    too_long: bool
    links: bool
    emojis: int
    banned: list[str]


def check(platform: Platform, text: str) -> Checks:
    """How a draft measures up against the writing rules (shown in Try it)."""
    words = len(text.split())
    lowered = text.lower()
    return Checks(
        words=words,
        too_long=bool(platform.voice_max_words and words > platform.voice_max_words),
        links=bool(_LINK.search(text)),
        emojis=len(_EMOJI.findall(text)),
        banned=[w for w in platform.voice_banned if w.lower() in lowered],
    )


# --- the style guide ------------------------------------------------------------------------


def _guide_sample(db: Session, platform: Platform) -> list[VoiceExample]:
    return list(
        db.scalars(
            select(VoiceExample)
            .where(
                VoiceExample.platform_id == platform.id,
                VoiceExample.state == VoiceState.ACTIVE,
                VoiceExample.enabled.is_(True),
            )
            .order_by(
                VoiceExample.starred.desc(),
                VoiceExample.source.desc(),  # posted replies first
                VoiceExample.created_at,
            )
            .limit(GUIDE_SAMPLE)
        ).all()
    )


def write_guide(db: Session, platform: Platform, answerer: Answerer, by: User | None) -> None:
    """The AI reads the examples and writes the platform's style guide. Replaces an edit."""
    sample = _guide_sample(db, platform)
    if not sample:
        raise VoiceError(409, "no_examples", "Add examples first: the guide is written from them.")
    completion = answerer.voice_guide(
        guide_message(platform.name, [StyleExample(e.question, e.answer) for e in sample])
    )
    spent = Usage()
    spent.add(completion.model, completion.input_tokens, completion.output_tokens)
    usage_log.record(db, by.id if by else None, UsageKind.DRAFT, spent)
    text = completion.text.strip()
    if completion.stop_reason == "refusal" or not text:
        raise VoiceError(502, "no_guide", "The style guide couldn't be written. Try again later.")
    platform.voice_guide = text[:4000]
    platform.voice_guide_edited = False
    platform.voice_guide_at = now()
    audit.record(db, by, "rewrite", "brand_voice", platform.id, f"{platform.name} style guide")


def edit_guide(db: Session, platform: Platform, text: str, by: User) -> None:
    platform.voice_guide = text.strip()[:4000]
    platform.voice_guide_edited = bool(platform.voice_guide)
    platform.voice_guide_at = now()
    audit.record(db, by, "update", "brand_voice", platform.id, f"{platform.name} style guide")


def summary(db: Session, platform: Platform) -> dict[str, Any]:
    """Counts for the Brand voice screen."""
    rows = db.execute(
        select(VoiceExample.source, VoiceExample.state, func.count())
        .where(VoiceExample.platform_id == platform.id)
        .group_by(VoiceExample.source, VoiceExample.state)
    ).all()
    found = {"from_file": 0, "from_posted": 0, "suggested": 0}
    for source, state, n in rows:
        if state == VoiceState.SUGGESTED:
            found["suggested"] += n
        elif state == VoiceState.ACTIVE:
            found["from_file" if source == VoiceSource.FILE else "from_posted"] += n
    return found
