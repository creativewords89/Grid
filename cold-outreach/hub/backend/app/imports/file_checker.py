"""The file checker (SPEC step 33): Lead Check on the files handed in on Files, in the
scheduler process, so it goes on when the person who handed a file in reloads the page,
closes it or goes offline. Each file's progress is saved as it goes; a file whose checker
stopped (the scheduler restarted) is taken over after a short while."""

import logging
import time
import uuid
from datetime import timedelta

from sqlalchemy import Engine, or_, select, update
from sqlalchemy.orm import Session

from app.auth.tokens import now
from app.db.models import Submission
from app.imports import reader
from app.imports import submissions as files

log = logging.getLogger("file_checker")

STALE = timedelta(minutes=2)  # a claim not renewed for this long is taken over
SAVE_EVERY = 1.0  # seconds between two progress saves


def claim(db: Session) -> tuple[uuid.UUID, int] | None:
    """The next file waiting to be checked (its id and version), now claimed."""
    sub = db.scalar(
        select(Submission)
        .where(
            Submission.state == "checking",
            or_(Submission.claimed_at.is_(None), Submission.claimed_at < now() - STALE),
        )
        .order_by(Submission.updated_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if sub is None:
        return None
    sub.claimed_at = now()
    sub.progress = 0
    found = (sub.id, sub.version)
    db.commit()
    return found


def check_one(engine: Engine, file_id: uuid.UUID, version: int) -> None:
    """Check one claimed file and save what was found, unless a newer version was handed
    in meanwhile (that one is checked next)."""
    with Session(engine) as db:
        sub = db.get(Submission, file_id)
        if sub is None:
            return
        content, niche, number = sub.content, sub.niche, sub.number
    last = [0.0]

    def progress(percent: int) -> None:
        if time.monotonic() - last[0] < SAVE_EVERY:
            return
        last[0] = time.monotonic()
        with Session(engine) as db:
            db.execute(
                update(Submission)
                .where(Submission.id == file_id, Submission.version == version)
                .values(progress=percent, claimed_at=now())
            )
            db.commit()

    error = None
    try:
        content = files.clean(content)
        found = files.run(content, niche, progress, number)
    except reader.ReadError as failure:
        error = str(failure)[:500]
    except Exception:
        log.exception("file %s couldn't be checked", file_id)
        error = "This file couldn't be checked. Save it again as .xlsx and upload it."
    with Session(engine) as db:
        sub = db.scalar(select(Submission).where(Submission.id == file_id).with_for_update())
        if sub is None or sub.version != version or sub.state != "checking":
            return
        sub.claimed_at = None
        sub.progress = 100
        if error is not None:
            sub.state, sub.error = "failed", error
        else:
            sub.state, sub.error = "checked", None
            sub.content = content
            sub.sha256 = found.fingerprint
            sub.businesses = found.businesses
            sub.check = found.check
            sub.problems = found.problems
            sub.leads = found.leads
            # The Final check's hour starts when the file has no error (step 36).
            if found.check["errors"]:
                sub.clean_since = None
            elif sub.clean_since is None:
                sub.clean_since = now()
            files.lock_if_topped(sub)
        db.commit()
    log.info("checked file %s (version %s)", file_id, version)


def send_due(db: Session) -> int:
    """Files whose Final check hour is over go on to Top Review (step 36)."""
    due = db.scalars(
        select(Submission)
        .where(
            Submission.state == "checked",
            Submission.sent_at.is_(None),
            Submission.clean_since.is_not(None),
            Submission.clean_since <= now() - files.FINAL_CHECK,
        )
        .with_for_update(skip_locked=True)
    )
    sent = 0
    for sub in due:
        if not sub.check.get("errors"):
            files.send_on(sub)
            sent += 1
    return sent


def run_pending(engine: Engine) -> int:
    """Check every file waiting; returns how many were checked."""
    done = 0
    while True:
        with Session(engine) as db:
            claimed = claim(db)
        if claimed is None:
            return done
        try:
            check_one(engine, *claimed)
        except Exception:
            # Left claimed: taken over again once the claim is stale.
            log.exception("checking file %s failed", claimed[0])
            return done
        done += 1
