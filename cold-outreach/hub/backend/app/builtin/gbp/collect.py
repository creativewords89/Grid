"""What the GBP audit agent collects from DataForSEO's answers (`agents/gbp-audit/SPEC.md`
section 4): Basics, Categories & Services, Description, Photos, Posts and Reviews. Nothing is
compared or scored here. What DataForSEO doesn't give is None and listed in `unknown`: never
a problem, "unable to verify" (PLAN.md section 3.7)."""

from datetime import UTC, datetime, timedelta
from typing import Any

DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
BOOKING = ("reservation", "booking", "appointment", "book")
LATEST_REVIEWS = 50


def when(text: Any) -> datetime | None:
    """DataForSEO's "2026-10-01 08:00:00 +00:00"."""
    if not isinstance(text, str) or not text:
        return None
    for pattern in ("%Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S"):
        try:
            found = datetime.strptime(text.strip(), pattern)
        except ValueError:
            continue
        return found if found.tzinfo else found.replace(tzinfo=UTC)
    return None


def _day(found: datetime | None) -> str | None:
    return found.date().isoformat() if found else None


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _clock(point: Any) -> str:
    if not isinstance(point, dict):
        return "?"
    return f"{int(point.get('hour') or 0):02d}:{int(point.get('minute') or 0):02d}"


def hours(work_time: Any) -> dict[str, str] | None:
    """Each day's opening hours, e.g. {"monday": "08:00-18:00"}; "closed" on a day off."""
    table = ((work_time or {}).get("work_hours") or {}).get("timetable")
    if not isinstance(table, dict) or not table:
        return None
    out: dict[str, str] = {}
    for day in DAYS:
        spans = table.get(day)
        if not spans:
            out[day] = "closed"
            continue
        out[day] = ", ".join(
            f"{_clock(s.get('open'))}–{_clock(s.get('close'))}"
            for s in spans
            if isinstance(s, dict)
        )
    return out


def _attributes(info: dict[str, Any]) -> dict[str, list[str]] | None:
    found = (info.get("attributes") or {}).get("available_attributes")
    if not isinstance(found, dict):
        return None
    return {str(group): [str(x) for x in values or []] for group, values in found.items()}


def basics(info: dict[str, Any]) -> dict[str, Any]:
    attributes = _attributes(info)
    links = [x for x in info.get("local_business_links") or [] if isinstance(x, dict)]
    booking = next(
        (x.get("url") for x in links if any(w in str(x.get("type", "")).lower() for w in BOOKING)),
        None,
    )
    status = ((info.get("work_time") or {}).get("work_hours") or {}).get("current_status")
    return {
        "name": _text(info.get("title")),
        "claimed": info.get("is_claimed") if isinstance(info.get("is_claimed"), bool) else None,
        "phone": _text(info.get("phone")),
        "website": _text(info.get("url")),
        "address": _text(info.get("address")),
        "latitude": info.get("latitude"),
        "longitude": info.get("longitude"),
        "hours": hours(info.get("work_time")),
        "status": _text(status),
        "booking_link": booking,
        "attributes": attributes,
        "payments": (attributes or {}).get("payments"),
        "last_updated": _day(when(info.get("last_updated_time"))),
        "people_also_search": [
            str(x.get("title")) for x in info.get("people_also_search") or [] if x.get("title")
        ]
        or None,
        "cid": _text(str(info.get("cid") or "")),
        "place_id": _text(info.get("place_id")),
        "gbp_url": _text(info.get("check_url")),
    }


def categories(info: dict[str, Any]) -> dict[str, Any]:
    services = info.get("services")  # DataForSEO may not give them: None is "unable to verify"
    listed = None
    if isinstance(services, list):
        listed = [
            {
                "name": str(s.get("name") or s.get("title") or s)
                if isinstance(s, dict)
                else str(s),
                "description": _text(s.get("description")) if isinstance(s, dict) else None,
            }
            for s in services
        ]
    return {
        "primary": _text(info.get("category")),
        "additional": [str(x) for x in info.get("additional_categories") or []],
        "services": listed,
    }


def description(info: dict[str, Any]) -> dict[str, Any]:
    text = _text(info.get("description"))
    return {"text": text, "length": len(text) if text else 0}


def photos(info: dict[str, Any]) -> dict[str, Any]:
    total = info.get("total_photos")
    return {
        "total": int(total) if isinstance(total, int | float) else None,
        "logo": _text(info.get("logo")),
        "cover": _text(info.get("main_image")),
    }


def posts(result: list[dict[str, Any]] | None, today: datetime) -> dict[str, Any] | None:
    """Every post DataForSEO gives, newest first, and how many in the last 30 and 90 days."""
    if result is None:
        return None
    items = [
        x
        for r in result
        for x in r.get("items") or []
        if isinstance(x, dict) and "post" in str(x.get("type", ""))
    ]
    dated_posts: list[tuple[datetime | None, dict[str, Any]]] = []
    for item in items:
        posted = when(item.get("timestamp") or item.get("post_date"))
        buttons = [x for x in item.get("links") or [] if isinstance(x, dict)]
        dated_posts.append(
            (
                posted,
                {
                    "date": _day(posted),
                    "text": _text(item.get("post_text")),
                    "url": _text(item.get("url")),
                    "image": bool(item.get("images_url")),
                    "button": _text(buttons[0].get("title")) if buttons else None,
                },
            )
        )
    dated_posts.sort(key=lambda p: p[0] or datetime.min.replace(tzinfo=UTC), reverse=True)
    listed = [post for _, post in dated_posts]
    dated = [at for at, _ in dated_posts if at]
    return {
        "count": len(listed),
        "last": _day(dated[0]) if dated else None,
        "last_30_days": sum(1 for d in dated if d >= today - timedelta(days=30)),
        "last_90_days": sum(1 for d in dated if d >= today - timedelta(days=90)),
        "items": listed,
    }


def reviews(info: dict[str, Any], result: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """Count, rating and stars from the profile; the latest reviews and replies, if fetched."""
    rating = info.get("rating") or {}
    stars = info.get("rating_distribution")
    out: dict[str, Any] = {
        "count": rating.get("votes_count"),
        "rating": rating.get("value"),
        "stars": {str(k): v for k, v in stars.items()} if isinstance(stars, dict) else None,
        "last": None,
        "reply_pct": None,
        "unanswered_low": None,
        "latest": None,
    }
    if result is None:
        return out
    items = [x for r in result for x in r.get("items") or [] if isinstance(x, dict)][
        :LATEST_REVIEWS
    ]
    latest: list[dict[str, Any]] = []
    for item in items:
        latest.append(
            {
                "date": _day(when(item.get("timestamp"))),
                "rating": (item.get("rating") or {}).get("value"),
                "text": _text(item.get("review_text")),
                "reply": _text(item.get("owner_answer")),
            }
        )
    dates = sorted((r["date"] for r in latest if r["date"]), reverse=True)
    out["last"] = dates[0] if dates else None
    out["latest"] = latest
    if latest:
        out["reply_pct"] = round(100 * sum(1 for r in latest if r["reply"]) / len(latest))
        out["unanswered_low"] = sum(1 for r in latest if not r["reply"] and (r["rating"] or 5) <= 2)
    return out


def unknown(data: dict[str, Any]) -> list[str]:
    """What DataForSEO didn't give: "unable to verify", never a problem."""
    return sorted(
        f"{part}.{key}"
        for part, values in data.items()
        if isinstance(values, dict)
        for key, value in values.items()
        if value is None
    )


def collect(
    info: dict[str, Any],
    post_result: list[dict[str, Any]] | None,
    review_result: list[dict[str, Any]] | None,
    today: datetime,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "basics": basics(info),
        "categories": categories(info),
        "description": description(info),
        "photos": photos(info),
        "posts": posts(post_result, today),
        "reviews": reviews(info, review_result),
    }
    data["unknown"] = unknown(data)
    return data


def summary(data: dict[str, Any]) -> str:
    """One line for the Leads table: what was collected."""
    b, c, p, r = data["basics"], data["categories"], data["photos"], data["reviews"] or {}
    parts = [
        {True: "claimed", False: "not claimed"}.get(b["claimed"], "claimed: unknown"),
        f"category {c['primary']}" if c["primary"] else "no category",
        f"{p['total']} photos" if p["total"] is not None else "photos: unknown",
    ]
    posted = data["posts"]
    if posted is not None:
        parts.append(
            f"last post {posted['last']} ({posted['last_90_days']} in 90 days)"
            if posted["last"]
            else "no posts"
        )
    if r.get("count") is not None:
        parts.append(f"{r['count']} reviews, {r['rating']}★")
    missing = [
        label
        for label, value in (
            ("phone", b["phone"]),
            ("website", b["website"]),
            ("address", b["address"]),
            ("hours", b["hours"]),
            ("description", data["description"]["text"]),
        )
        if not value
    ]
    if missing:
        parts.append("none on the profile: " + ", ".join(missing))
    return "Collected: " + " · ".join(parts) + "."
