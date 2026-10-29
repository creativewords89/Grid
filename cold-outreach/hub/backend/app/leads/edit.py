"""Changing a lead's fields (SPEC steps 27 and 28): the Hub's lead window and a fix file use
the same rules. An empty value clears a field; a business keeps a name and a city. Lead
Check runs again on the new values. Top is never changed here: it is chosen in a city."""

from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app import audit
from app.db.models import Lead
from app.imports import reader
from app.imports.service import recheck, sync_cities, sync_do_not_contact

# Fields kept in `lead.data`, by name (the others are columns of the lead).
DATA_KEYS = (
    "address",
    "phone",
    "whatsapp",
    "website",
    "facebook",
    "instagram",
    "reviews",
    "rating",
)
# Every field that can be changed, in the lead file's order.
FIELDS = (
    "business_name",
    "gbp_link",
    "address",
    "city",
    "website",
    "phone",
    "whatsapp",
    "email",
    "facebook",
    "instagram",
    "reviews",
    "rating",
    "notes",
)
LIMITS = {"business_name": 255, "city": 120, "email": 2000, "notes": 4000}


@dataclass
class EditError(Exception):
    field: str
    message: str


def view(lead: Lead) -> dict[str, Any]:
    """The lead's values as History shows them, old and new."""
    data = lead.data or {}
    return {
        "business_name": lead.business_name,
        "gbp_link": lead.gbp_link,
        "city": lead.city,
        "email": ", ".join(lead.emails),
        **{key: data.get(key, "") for key in DATA_KEYS},
        "level": lead.level,
        "notes": data.get("notes", ""),
    }


def apply(db: Session, lead: Lead, patch: dict[str, str]) -> list[dict[str, Any]]:
    """Change the fields in `patch` (field -> new value) and check the lead again. Returns
    the changes (as History records them); raises EditError, changing nothing, when a
    value isn't allowed. The caller records History and commits."""
    patch = {k: v.strip() for k, v in patch.items() if k in FIELDS}
    for key, value in patch.items():
        if len(value) > LIMITS.get(key, 500):
            raise EditError(key, f"Too long: at most {LIMITS.get(key, 500)} characters.")
    if "business_name" in patch and not patch["business_name"]:
        raise EditError("business_name", "A business needs a name.")
    if "city" in patch and not patch["city"]:
        raise EditError("city", "A business needs a city.")
    emails: list[str] | None = None
    if "email" in patch:
        valid, invalid = reader.split_emails(patch["email"])
        if invalid:
            raise EditError("email", f"This doesn't look like an email: {invalid[0]}")
        emails = list(dict.fromkeys(valid))
    before = view(lead)
    if "business_name" in patch:
        lead.business_name = patch["business_name"]
    if "city" in patch:
        lead.city = patch["city"]
    if "gbp_link" in patch:
        lead.gbp_link = reader.clean_gbp(patch["gbp_link"])[:500]
    if emails is not None:
        lead.emails = emails
    data = dict(lead.data or {})
    for key in (*DATA_KEYS, "notes"):
        if key in patch:
            value = patch[key]
            data[key] = reader.clean_website(value) if key == "website" and value else value
    lead.data = {key: value for key, value in data.items() if value}
    lead.phone_digits = reader.phone_digits(lead.data.get("phone", ""))
    lead.website_domain = reader.website_domain(lead.data.get("website", ""))[:255]
    place = {"business_name": lead.business_name, "city": lead.city} | lead.data
    lead.name_address = reader.name_place(place)[:600]
    recheck(lead)
    changes = audit.diff(before, view(lead))
    if changes:
        sync_do_not_contact(db, lead)
        if before["city"] != lead.city and lead.batch_id is not None:
            db.flush()
            sync_cities(db, lead.batch_id)
    return changes
