"""Stage 2 of the GBP audit agent (hub step 51, `agents/gbp-audit/SPEC.md` section 5): what
was collected, compared with the batch's benchmark (GBP part), into findings and a score.

- A benchmark number: the lead's value ÷ the benchmark's; under 25% red, 25-60% orange,
  60% or more ok. An empty box in the benchmark is not compared.
- Something missing from the profile (not claimed, no phone …) is a red finding, without
  a benchmark.
- What DataForSEO didn't give is never a finding: that check is left out of the score.
- Reviews and ratings are shown in the report, never compared: an agency can't change them
  (step 53).

The score is 100 points over the parts that could be checked: Basics 20, Primary category
20, Description 10, Photos 20, Posts 30.
"""

from dataclasses import dataclass
from typing import Any

RED, ORANGE, OK = "red", "orange", "ok"
SERVICES_WANTED = 3  # standard services the description should name (all, when fewer)


@dataclass
class Check:
    part: str
    code: str
    message: str
    points: float  # what it is worth in the score
    got: float | None  # the share earned, 0 to 1; None: unable to verify (left out)
    severity: str = OK
    value: Any = None
    benchmark: Any = None
    scored: bool = True

    def finding(self) -> dict[str, Any]:
        return {
            "part": self.part,
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
            "value": self.value,
            "benchmark": self.benchmark,
            "scored": self.scored,
        }


def colour(share: float) -> str:
    return RED if share < 0.25 else ORANGE if share < 0.6 else OK


def _ratio(
    part: str, code: str, what: str, points: float, value: Any, target: Any, scored: bool = True
) -> Check | None:
    """The lead's number against the benchmark's; None when the benchmark box is empty."""
    if target is None:
        return None
    if value is None:
        return Check(part, code, f"{what}: unable to verify", points, None, scored=scored)
    target = float(target)
    share = 1.0 if target <= 0 else min(1.0, float(value) / target)
    severity = colour(share)
    message = f"{what}: {_num(value)} vs {_num(target)} in the benchmark"
    return Check(part, code, message, points, share, severity, value, target, scored)


def _num(value: Any) -> str:
    number = float(value)
    return str(int(number)) if number.is_integer() else f"{number:g}"


def _present(part: str, code: str, what: str, points: float, value: Any) -> Check:
    """Something the profile should have; unknown when DataForSEO didn't say."""
    if value is None:
        return Check(part, code, f"{what}: unable to verify", points, None)
    if value is False or value == "" or value == [] or value == {} or value == 0:
        return Check(part, code, f"No {what.lower()}", points, 0.0, RED, value)
    return Check(part, code, what, points, 1.0, OK, True)


def checks(data: dict[str, Any], gbp: dict[str, Any]) -> list[Check]:
    b = data.get("basics") or {}
    c = data.get("categories") or {}
    d = data.get("description") or {}
    p = data.get("photos") or {}
    posts = data.get("posts")
    out: list[Check | None] = []

    # Basics: 20, 4 each.
    claimed = b.get("claimed")
    out.append(
        Check("basics", "GBP_NOT_CLAIMED", "Not claimed", 4, 0.0, RED, False)
        if claimed is False
        else _present("basics", "GBP_NOT_CLAIMED", "Claimed", 4, claimed)
    )
    out.append(_present("basics", "GBP_NO_PHONE", "Phone", 4, b.get("phone") or ""))
    out.append(_present("basics", "GBP_NO_WEBSITE", "Website", 4, b.get("website") or ""))
    out.append(_present("basics", "GBP_NO_ADDRESS", "Address", 4, b.get("address") or ""))
    out.append(_present("basics", "GBP_NO_HOURS", "Hours", 4, b.get("hours") or ""))

    # Primary category: 20.
    right = [x.strip().lower() for x in gbp.get("primary_categories") or [] if x.strip()]
    primary = c.get("primary")
    if right:
        if primary is None:
            out.append(
                Check(
                    "categories",
                    "GBP_WRONG_PRIMARY",
                    "Primary category: unable to verify",
                    20,
                    None,
                )
            )
        elif primary.strip().lower() in right:
            out.append(
                Check("categories", "GBP_WRONG_PRIMARY", f"Primary category {primary}", 20, 1.0)
            )
        else:
            out.append(
                Check(
                    "categories",
                    "GBP_WRONG_PRIMARY",
                    f"Primary category {primary} isn't one for the niche",
                    20,
                    0.0,
                    RED,
                    primary,
                    gbp.get("primary_categories"),
                )
            )

    # Description: 10 (there 2; Claude's check: business name 3, category 3, standard
    # services 2; the city is shown, not scored).
    text = d.get("text")
    out.append(_present("description", "GBP_NO_DESCRIPTION", "Description", 2, text or ""))
    if text:
        out.extend(_described(d.get("checks")))

    # Photos: 20 (count 16, logo 2, cover 2).
    out.append(_ratio("photos", "GBP_FEW_PHOTOS", "Photos", 16, p.get("total"), gbp.get("photos")))
    out.append(_present("photos", "GBP_NO_LOGO", "Logo", 2, p.get("logo") or ""))
    out.append(_present("photos", "GBP_NO_COVER", "Cover photo", 2, p.get("cover") or ""))

    # Posts: 30 (ever posted 10, in 90 days 20).
    if posts is None:
        out.append(Check("posts", "GBP_NO_POSTS", "Posts: unable to verify", 30, None))
    else:
        out.append(
            Check("posts", "GBP_NO_POSTS", "Has posted", 10, 1.0)
            if posts.get("count")
            else Check("posts", "GBP_NO_POSTS", "Never posted", 10, 0.0, RED, 0)
        )
        out.append(
            _ratio(
                "posts",
                "GBP_FEW_RECENT_POSTS",
                "Posts in 90 days",
                20,
                posts.get("last_90_days"),
                gbp.get("posts_90_days"),
            )
        )
    # Reviews are shown in the report, never compared: not something an agency can change.
    return [x for x in out if x is not None]


def _mention(code: str, what: str, points: float, answer: Any, scored: bool = True) -> Check:
    if not isinstance(answer, dict):
        return Check("description", code, f"{what}: unable to verify", points, None, scored=scored)
    if answer.get("mentioned"):
        return Check(
            "description",
            code,
            f"{what} in the description",
            points,
            1.0,
            OK,
            answer.get("quote"),
            scored=scored,
        )
    severity = RED if scored else ORANGE
    return Check(
        "description",
        code,
        f"{what} not in the description",
        points,
        0.0,
        severity,
        scored=scored,
    )


def _described(checks: Any) -> list[Check]:
    """Claude's check of the description (describe.py): unable to verify without one."""
    checks = checks if isinstance(checks, dict) else {}
    out = [
        _mention("GBP_DESCRIPTION_NO_BRAND", "Business name", 3, checks.get("brand")),
        _mention("GBP_DESCRIPTION_NO_CATEGORY", "Primary category", 3, checks.get("category")),
        _mention("GBP_DESCRIPTION_NO_CITY", "City", 0, checks.get("city"), scored=False),
    ]
    services = checks.get("services")
    if not checks:
        out.append(
            Check(
                "description",
                "GBP_DESCRIPTION_FEW_SERVICES",
                "Main services: unable to verify",
                2,
                None,
            )
        )
    elif services:
        named = [s["name"] for s in services if s.get("mentioned")]
        missing = [s["name"] for s in services if not s.get("mentioned")]
        needed = min(SERVICES_WANTED, len(services))
        share = min(1.0, len(named) / needed)
        severity = OK if len(named) >= needed else ORANGE if named else RED
        message = f"{len(named)} of the standard services in the description" + (
            f" ({needed} wanted); not named: {', '.join(missing)}" if severity != OK else ""
        )
        out.append(
            Check(
                "description",
                "GBP_DESCRIPTION_FEW_SERVICES",
                message,
                2,
                share,
                severity,
                named,
                needed,
            )
        )
    return out


def score(found: list[Check]) -> float | None:
    """100 points over the checks that could be made; None when none could."""
    counted = [c for c in found if c.scored and c.points and c.got is not None]
    total = sum(c.points for c in counted)
    if not total:
        return None
    return round(100 * sum(c.points * (c.got or 0) for c in counted) / total)


def summary(found: list[Check], points: float | None) -> str:
    reds = [c for c in found if c.severity == RED]
    oranges = [c for c in found if c.severity == ORANGE]
    head = f"Score {_num(points)}" if points is not None else "No score"
    return " · ".join([head, f"{len(reds)} red", f"{len(oranges)} orange"])


def compare(data: dict[str, Any], gbp: dict[str, Any] | None) -> dict[str, Any]:
    """Findings (not ok first), score and summary; without a benchmark only what the profile
    misses is found."""
    found = checks(data, gbp or {})
    order = {RED: 0, ORANGE: 1, OK: 2}
    found.sort(key=lambda c: order[c.severity])
    points = score(found)
    return {
        "findings": [c.finding() for c in found if c.got is not None or c.severity != OK],
        "score": points,
        "summary": summary(found, points),
        "unverified": [c.code for c in found if c.got is None],
    }
