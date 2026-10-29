"""`/api/niches` (step 33): the niches files, batches and benchmarks are for. Anyone who
hands in files adds one (a spelling close to a known niche is asked about first); Owners
and Admins rename them (everything of that niche follows) and delete the unused ones."""

import difflib
import uuid
from typing import Annotated

from fastapi import APIRouter
from pydantic import BaseModel, StringConstraints
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app import audit
from app.api.schemas import Strict
from app.auth.deps import CurrentUser, Db
from app.db.models import Batch, Benchmark, Import, Lead, LeadList, Niche, Submission
from app.errors import ApiError
from app.permissions import Action, ensure

router = APIRouter(tags=["niches"])

NicheName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=80)]
# Everything that is for a niche: renamed with it, and keeps it from being deleted.
USES = (Batch, Benchmark, Submission, Import, Lead, LeadList)
SIMILAR = 0.8  # how alike two spellings are before "Did you mean …?"


def niche_names(db: Session) -> dict[str, str]:
    """Every niche (lower case) -> its spelling: the list, and those already in use."""
    spellings: dict[str, str] = {}
    known = select(Niche.name).union_all(select(Benchmark.niche), select(Batch.niche))
    for name in db.scalars(known):
        if name.strip():
            spellings.setdefault(name.strip().lower(), name.strip())
    return spellings


def _uses(db: Session, name: str) -> int:
    key = name.strip().lower()
    return sum(
        db.scalar(
            select(func.count()).select_from(model).where(func.lower(func.trim(model.niche)) == key)
        )
        or 0
        for model in USES
    )


class NicheOut(BaseModel):
    id: uuid.UUID
    name: str
    uses: int  # files, batches, benchmarks and leads of it


class AddIn(Strict):
    name: NicheName
    confirm: bool = False  # add it although a known niche is spelt nearly the same


class AddOut(BaseModel):
    name: str
    created: bool


@router.get("/niches/all", response_model=list[NicheOut])
def all_niches(me: CurrentUser, db: Db) -> list[NicheOut]:
    """The niches to rename or delete (those in use but not on the list are added)."""
    ensure(me, Action.MANAGE_NICHES)
    listed = {n.name.strip().lower() for n in db.scalars(select(Niche))}
    for key, name in niche_names(db).items():
        if key not in listed:
            db.add(Niche(name=name))
    db.commit()
    found = db.scalars(select(Niche).order_by(func.lower(Niche.name)))
    return [NicheOut(id=n.id, name=n.name, uses=_uses(db, n.name)) for n in found]


@router.post("/niches", response_model=AddOut)
def add_niche(body: AddIn, me: CurrentUser, db: Db) -> AddOut:
    """Add a niche. The same name in other letters is the known one."""
    ensure(me, Action.ADD_NICHES)
    known = niche_names(db)
    key = body.name.lower()
    if key in known:
        return AddOut(name=known[key], created=False)
    close = difflib.get_close_matches(key, list(known), n=1, cutoff=SIMILAR)
    if close and not body.confirm:
        raise ApiError(
            409,
            "similar",
            f"Did you mean {known[close[0]]}?",
            details={"similar": known[close[0]]},
        )
    niche = Niche(name=body.name, created_by=me.id)
    db.add(niche)
    db.flush()
    audit.record(db, me, "add", "niche", niche.id, niche.name, [])
    db.commit()
    return AddOut(name=niche.name, created=True)


def _get(db: Session, niche_id: uuid.UUID) -> Niche:
    niche = db.get(Niche, niche_id)
    if niche is None:
        raise ApiError(404, "not_found", "That niche doesn't exist.")
    return niche


class RenameIn(Strict):
    name: NicheName


@router.patch("/niches/{niche_id}", response_model=NicheOut)
def rename_niche(niche_id: uuid.UUID, body: RenameIn, me: CurrentUser, db: Db) -> NicheOut:
    """Rename a niche: its files, batches, benchmarks and leads follow."""
    ensure(me, Action.MANAGE_NICHES)
    niche = _get(db, niche_id)
    old = niche.name
    taken = niche_names(db).get(body.name.lower())
    if taken is not None and body.name.lower() != old.strip().lower():
        raise ApiError(409, "taken", f"{taken} is already a niche.", {"name": "Already a niche."})
    for model in USES:
        db.execute(
            update(model)
            .where(func.lower(func.trim(model.niche)) == old.strip().lower())
            .values(niche=body.name)
        )
    niche.name = body.name
    # Files' batch names follow ("Cleaning 01" → "House Cleaning 01").
    for sub in db.scalars(
        select(Submission).where(func.lower(func.trim(Submission.niche)) == body.name.lower())
    ):
        if sub.batch_name.lower().startswith(old.strip().lower() + " "):
            sub.batch_name = body.name + sub.batch_name[len(old.strip()) :]
    audit.record(
        db,
        me,
        "rename",
        "niche",
        niche.id,
        body.name,
        [{"field": "name", "from": old, "to": body.name}],
    )
    db.commit()
    return NicheOut(id=niche.id, name=niche.name, uses=_uses(db, niche.name))


@router.delete("/niches/{niche_id}", status_code=204)
def delete_niche(niche_id: uuid.UUID, me: CurrentUser, db: Db) -> None:
    """Delete a niche nothing is for."""
    ensure(me, Action.MANAGE_NICHES)
    niche = _get(db, niche_id)
    if _uses(db, niche.name):
        raise ApiError(409, "in_use", f"{niche.name} is in use: it can't be deleted.")
    audit.record(db, me, "delete", "niche", niche.id, niche.name, [])
    db.delete(niche)
    db.commit()
