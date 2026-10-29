"""Lead Check (SPEC step 26): is each lead file in the Hub's standard, and is each field
holding what its column says? Pure functions, so every rule is easy to test.

An **error** (🔴) is wrong data in a field, such as a phone number in the address or a
Facebook link as the website: until every error of a file is fixed, agents leave all of that
file's leads alone. A **warning** (🟠) is missing or doubtful data: shown, never blocking.
"""

import re
from dataclasses import asdict, dataclass
from typing import Any, Literal
from urllib.parse import urlsplit

Severity = Literal["error", "warning"]

# The standard columns of a lead file, in its order (as the Leads table names them).
STANDARD: dict[str, str] = {
    "business_name": "Business name",
    "gbp_link": "GBP link",
    "address": "Address",
    "city": "City",
    "website": "Website",
    "phone": "Phone",
    "whatsapp": "WhatsApp",
    "email": "Email",
    "facebook": "Facebook",
    "instagram": "Instagram",
    "reviews": "Reviews",
    "rating": "Rating",
}

# code -> (severity, what is wrong). The field is the column it is about.
CODES: dict[str, tuple[Severity, str]] = {
    "NAME_IS_LINK": ("error", "Business name is a link"),
    "NAME_IS_PHONE": ("error", "Business name is a phone number"),
    "NAME_TOO_LONG": ("warning", "Business name is unusually long"),
    "NO_NAME": ("warning", "No business name"),
    "GBP_NOT_MAPS": ("error", "GBP link isn't a Google Maps link"),
    "NO_GBP_LINK": ("warning", "No GBP link"),
    "ADDRESS_HAS_PHONE": ("error", "Address holds a phone number"),
    "ADDRESS_HAS_EMAIL": ("error", "Address holds an email"),
    "ADDRESS_HAS_LINK": ("error", "Address holds a link"),
    "NO_ADDRESS": ("warning", "No address"),
    "ADDRESS_OTHER_CITY": ("warning", "Address doesn't mention the city"),
    "CITY_HAS_NUMBERS": ("error", "City holds numbers (an address?)"),
    "WEBSITE_IS_FACEBOOK": ("error", "Website is a Facebook link"),
    "WEBSITE_IS_INSTAGRAM": ("error", "Website is an Instagram link"),
    "WEBSITE_IS_GOOGLE": ("error", "Website is a Google Maps link"),
    "WEBSITE_NOT_LINK": ("error", "Website isn't a link"),
    "PHONE_HAS_LETTERS": ("error", "Phone holds letters"),
    "PHONE_WRONG_LENGTH": ("error", "Phone isn't a 10-digit US number"),
    "NO_PHONE": ("warning", "No phone"),
    "WHATSAPP_NOT_PHONE": ("error", "WhatsApp isn't a phone number"),
    "EMAIL_PLACEHOLDER": ("warning", "Email looks made up (test@, example.com)"),
    "FACEBOOK_IS_INSTAGRAM": ("error", "Facebook is an Instagram link"),
    "FACEBOOK_NOT_FACEBOOK": ("error", "Facebook isn't a Facebook link"),
    "INSTAGRAM_IS_FACEBOOK": ("error", "Instagram is a Facebook link"),
    "INSTAGRAM_NOT_INSTAGRAM": ("error", "Instagram isn't an Instagram link"),
    "REVIEWS_NOT_NUMBER": ("error", "Reviews isn't a whole number"),
    "RATING_NOT_NUMBER": ("error", "Rating isn't a number"),
    "RATING_OUT_OF_RANGE": ("error", "Rating isn't between 0 and 5"),
    "REVIEWS_RATING_SWAPPED": ("error", "Reviews and Rating look swapped"),
    # A tab (city) of the file: never blocking.
    "MISSING_COLUMN": ("warning", "Column missing"),
    "DUPLICATE_COLUMN": ("warning", "Column twice: the first one is used"),
    "CITY_NOT_TAB": ("warning", "City differs from the tab's name"),
}

PHONE_IN_TEXT = re.compile(r"(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}")
EMAIL_IN_TEXT = re.compile(r"[^@\s]+@[^@\s]+\.[a-z]{2,}", re.IGNORECASE)
LINK_IN_TEXT = re.compile(r"(https?://|www\.)\S+", re.IGNORECASE)
LINK = re.compile(r"^(https?://)?[^\s/@]+\.[a-z]{2,}(/\S*)?$", re.IGNORECASE)
MAPS = re.compile(
    r"^(https?://)?([a-z]+\.)?(google\.[a-z.]+/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl"
    r"|goo\.gl/maps|g\.page|share\.google)",
    re.IGNORECASE,
)
PLACEHOLDER_EMAIL = re.compile(r"^(test|example|none|noemail|no-reply|noreply)@|@example\.")
NUMBER = re.compile(r"^\d+(\.\d+)?$")


@dataclass(frozen=True)
class Issue:
    code: str
    field: str  # the column it is about (a key of STANDARD)
    severity: Severity
    message: str

    def as_dict(self) -> dict[str, str]:
        return asdict(self)


def issue(code: str, field: str) -> Issue:
    severity, message = CODES[code]
    return Issue(code, field, severity, message)


def _host(url: str) -> str:
    text = url if "://" in url else f"https://{url}"
    try:
        return (urlsplit(text).hostname or "").lower().removeprefix("www.")
    except ValueError:
        return ""


def _is(url: str, *hosts: str) -> bool:
    host = _host(url)
    return any(host == h or host.endswith("." + h) for h in hosts)


def _phone_problem(value: str, field: str, letters: str, length: str) -> Issue | None:
    text = re.sub(r"(?i)\b(ext|x)\.?\s*\d+$", "", value).strip()  # an extension is fine
    if re.search(r"[a-z]", text, re.IGNORECASE):
        return issue(letters, field)
    digits = re.sub(r"\D", "", text)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return None if len(digits) == 10 else issue(length, field)


def check_lead(values: dict[str, str]) -> list[Issue]:
    """Every problem of one lead's fields (its current values, keyed like STANDARD)."""
    found: list[Issue] = []
    add = found.append
    v = {k: (values.get(k) or "").strip() for k in STANDARD}

    name = v["business_name"]
    if not name:
        add(issue("NO_NAME", "business_name"))
    elif LINK_IN_TEXT.search(name) or LINK.match(name):
        add(issue("NAME_IS_LINK", "business_name"))
    elif PHONE_IN_TEXT.fullmatch(name):
        add(issue("NAME_IS_PHONE", "business_name"))
    elif len(name) > 80:
        add(issue("NAME_TOO_LONG", "business_name"))

    gbp = v["gbp_link"]
    if not gbp:
        add(issue("NO_GBP_LINK", "gbp_link"))
    elif not MAPS.match(gbp):
        add(issue("GBP_NOT_MAPS", "gbp_link"))

    address, city = v["address"], v["city"]
    if not address:
        add(issue("NO_ADDRESS", "address"))
    elif PHONE_IN_TEXT.search(address) and not re.search(r"\b\d{5}(-\d{4})?\s*$", address):
        add(issue("ADDRESS_HAS_PHONE", "address"))
    elif EMAIL_IN_TEXT.search(address):
        add(issue("ADDRESS_HAS_EMAIL", "address"))
    elif LINK_IN_TEXT.search(address):
        add(issue("ADDRESS_HAS_LINK", "address"))
    elif city and city.lower() not in address.lower():
        add(issue("ADDRESS_OTHER_CITY", "address"))
    if re.search(r"\d", city):
        add(issue("CITY_HAS_NUMBERS", "city"))

    website = v["website"]
    if website:
        if _is(website, "facebook.com", "fb.com"):
            add(issue("WEBSITE_IS_FACEBOOK", "website"))
        elif _is(website, "instagram.com"):
            add(issue("WEBSITE_IS_INSTAGRAM", "website"))
        elif MAPS.match(website):
            add(issue("WEBSITE_IS_GOOGLE", "website"))
        elif "@" in website or not LINK.match(website):
            add(issue("WEBSITE_NOT_LINK", "website"))

    phone = v["phone"]
    if not phone:
        add(issue("NO_PHONE", "phone"))
    elif problem := _phone_problem(phone, "phone", "PHONE_HAS_LETTERS", "PHONE_WRONG_LENGTH"):
        add(problem)
    whatsapp = v["whatsapp"]
    if whatsapp and _phone_problem(
        whatsapp, "whatsapp", "WHATSAPP_NOT_PHONE", "WHATSAPP_NOT_PHONE"
    ):
        add(issue("WHATSAPP_NOT_PHONE", "whatsapp"))

    if any(PLACEHOLDER_EMAIL.search(e.strip().lower()) for e in v["email"].split(",") if e):
        add(issue("EMAIL_PLACEHOLDER", "email"))

    facebook, instagram = v["facebook"], v["instagram"]
    if facebook and not _is(facebook, "facebook.com", "fb.com", "fb.me"):
        code = "FACEBOOK_IS_INSTAGRAM" if _is(facebook, "instagram.com") else None
        add(issue(code or "FACEBOOK_NOT_FACEBOOK", "facebook"))
    if instagram and not _is(instagram, "instagram.com", "instagr.am"):
        code = "INSTAGRAM_IS_FACEBOOK" if _is(instagram, "facebook.com", "fb.com") else None
        add(issue(code or "INSTAGRAM_NOT_INSTAGRAM", "instagram"))

    reviews, rating = v["reviews"].replace(",", ""), v["rating"]
    reviews_ok = not reviews or reviews.isdigit()
    rating_ok = not rating or bool(NUMBER.match(rating))
    swapped = (
        reviews and rating and NUMBER.match(reviews) and rating_ok and float(rating) > 5
    ) and float(reviews) <= 5
    if swapped:
        add(issue("REVIEWS_RATING_SWAPPED", "reviews"))
        return found
    if not reviews_ok:
        add(issue("REVIEWS_NOT_NUMBER", "reviews"))
    if not rating_ok:
        add(issue("RATING_NOT_NUMBER", "rating"))
    elif rating and not 0 <= float(rating) <= 5:
        add(issue("RATING_OUT_OF_RANGE", "rating"))
    return found


def check_tab(fields: list[str], duplicates: list[str], city_not_tab: int) -> list[Issue]:
    """The problems of one tab (city) of a file: missing or doubled standard columns, rows
    whose City isn't the tab's name. Warnings only."""
    found = [issue("MISSING_COLUMN", f) for f in STANDARD if f not in fields and f != "city"]
    found += [issue("DUPLICATE_COLUMN", f) for f in duplicates if f in STANDARD]
    if city_not_tab:
        found.append(issue("CITY_NOT_TAB", "city"))
    return found


def lead_values(lead: Any) -> dict[str, str]:
    """A saved lead's current values, keyed like STANDARD."""
    data = lead.data or {}
    values = {k: str(data.get(k, "")) for k in STANDARD}
    values |= {
        "business_name": lead.business_name,
        "gbp_link": lead.gbp_link,
        "city": lead.city,
        "email": ", ".join(lead.emails or []),
    }
    return values


def errors(issues: list[dict[str, Any]] | None) -> int:
    return sum(1 for i in issues or [] if i.get("severity") == "error")


def _without(text: str, match: re.Match[str]) -> str:
    """The text with the match taken out, and the separators left around it tidied."""
    rest = text[: match.start()] + " " + text[match.end() :]
    return re.sub(r"\s*([,;|·-])\s*([,;|·-]\s*)+", r"\1 ", re.sub(r"\s+", " ", rest)).strip(
        " ,;|·-"
    )


def _move(values: dict[str, str], source: str, target: str) -> dict[str, Any]:
    name = STANDARD[target]
    if values.get(target):
        return {"label": f"Clear {STANDARD[source]} ({name} is filled)", "changes": {source: ""}}
    changes = {source: "", target: values[source]}
    return {"label": f"Move it to {name}", "changes": changes}


def fix_for(code: str, values: dict[str, str]) -> dict[str, Any] | None:
    """A one-click fix for a problem (step 27): a label and the field changes, or None when
    a person has to decide. Nothing is changed until the fix is applied."""
    if code == "WEBSITE_IS_FACEBOOK":
        return _move(values, "website", "facebook")
    if code == "WEBSITE_IS_INSTAGRAM":
        return _move(values, "website", "instagram")
    if code == "WEBSITE_IS_GOOGLE":
        return _move(values, "website", "gbp_link")
    if code == "FACEBOOK_IS_INSTAGRAM":
        return _move(values, "facebook", "instagram")
    if code == "INSTAGRAM_IS_FACEBOOK":
        return _move(values, "instagram", "facebook")
    if code == "REVIEWS_RATING_SWAPPED":
        changes = {"reviews": values["rating"], "rating": values["reviews"]}
        return {"label": "Swap Reviews and Rating", "changes": changes}
    address = values.get("address", "")
    if code == "ADDRESS_HAS_PHONE" and (found := PHONE_IN_TEXT.search(address)):
        changes = {"address": _without(address, found)}
        if values.get("phone"):
            return {"label": "Take the phone number out of Address", "changes": changes}
        return {"label": "Move the phone number to Phone", "changes": changes | {"phone": found[0]}}
    if code == "ADDRESS_HAS_EMAIL" and (found := EMAIL_IN_TEXT.search(address)):
        emails = [e for e in values.get("email", "").split(", ") if e]
        changes = {"address": _without(address, found), "email": ", ".join([*emails, found[0]])}
        return {"label": "Move the email to Email", "changes": changes}
    if code == "ADDRESS_HAS_LINK" and (found := LINK_IN_TEXT.search(address)):
        changes = {"address": _without(address, found)}
        if not values.get("website"):
            changes["website"] = found[0]
            return {"label": "Move the link to Website", "changes": changes}
        return {"label": "Take the link out of Address", "changes": changes}
    return None
