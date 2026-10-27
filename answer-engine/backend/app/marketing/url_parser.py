"""Turn a pasted Reddit or Facebook link (or a post's bare code) into a thread ID
(SPEC section 6.10). Pure functions.

The same post can be linked in many ways (old.reddit, m.facebook, tracking parameters, a
comment's permalink), so the URL is cleaned first and the post's own ID is taken from it.
The thread ID is `{platform}:{post id}`, which is how a later reply in the same thread is
found again.
"""

import hashlib
import re
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SHARE_LINK = "This is a share link. Open it and copy the full address from the browser bar."
NOT_A_THREAD = "This doesn't look like a link to a post. Open the post and copy its address."
NOT_A_URL = "Paste the full address, starting with https://, or the post's code."
_BARE_CODE = re.compile(r"^[a-z0-9]{4,12}$")
# A Facebook post ID: a long number, or a `pfbid…` token (case matters).
_FB_ID = re.compile(r"^(?:\d+|pfbid[0-9A-Za-z]+)$")
_BARE_FB_CODE = re.compile(r"^(?:\d{13,}|pfbid[0-9A-Za-z]{10,})$")

_PREFIXES = ("www.", "m.", "old.", "new.", "np.", "mbasic.", "web.")
_TRACKING = {
    "fbclid",
    "rdt",
    "share_id",
    "ref",
    "ref_source",
    "ref_campaign",
    "__cft__",
    "__tn__",
    "mibextid",
    "rdid",
    "sh",
    "context",
    "s",
    "si",
    "igshid",
    "notif_id",
    "notif_t",
    "acontext",
    "_rdc",
    "_rdr",
}
_BASE36 = re.compile(r"^[a-z0-9]+$")


@dataclass(frozen=True)
class PlatformRule:
    """How a platform's links are read: `reddit`, `facebook`, or `generic` with its hosts."""

    slug: str
    parser: str
    hosts: tuple[str, ...] = ()
    enabled: bool = True
    name: str = ""


@dataclass(frozen=True)
class Parsed:
    platform: str
    thread_id: str
    community: str | None = None
    comment_id: str | None = None
    clean_url: str = ""
    # A Facebook reply's link also names the comment it answers.
    reply_to_comment_id: str | None = None


class UrlError(ValueError):
    pass


REDDIT_HOSTS = ("reddit.com", "redd.it")
FACEBOOK_HOSTS = ("facebook.com", "fb.com", "fb.me")


def _host(raw: str) -> str:
    host = raw.lower().strip(".")
    changed = True
    while changed:
        changed = False
        for prefix in _PREFIXES:
            if host.startswith(prefix) and host.count(".") > 1:
                host = host[len(prefix) :]
                changed = True
    return host


def _matches(host: str, hosts: tuple[str, ...]) -> bool:
    return any(host == h or host.endswith("." + h) for h in hosts)


def clean(url: str) -> tuple[str, str, list[str], dict[str, str]]:
    """(cleaned URL, host, path parts, query) with tracking parameters dropped."""
    text = url.strip()
    if not re.match(r"^https?://", text, re.IGNORECASE):
        if re.match(r"^[\w.-]+\.[a-z]{2,}/", text, re.IGNORECASE):
            text = "https://" + text
        else:
            raise UrlError(NOT_A_URL)
    parts = urlsplit(text)
    host = _host(parts.hostname or "")
    if not host or "." not in host:
        raise UrlError(NOT_A_URL)
    query = {
        key: value
        for key, value in parse_qsl(parts.query, keep_blank_values=False)
        if not key.lower().startswith("utm_") and key.lower() not in _TRACKING
    }
    path = [p for p in parts.path.split("/") if p]
    cleaned = urlunsplit(("https", host, "/" + "/".join(path), urlencode(query), ""))
    return cleaned, host, path, query


def _reddit(host: str, path: list[str], cleaned: str) -> Parsed:
    lower = [p.lower() for p in path]
    if host == "redd.it":
        if len(lower) == 1 and _BASE36.match(lower[0]):
            return Parsed("reddit", f"reddit:{lower[0]}", clean_url=cleaned)
        raise UrlError(NOT_A_THREAD)
    if len(lower) >= 3 and lower[0] in ("r", "u", "user") and lower[2] == "s":
        raise UrlError(SHARE_LINK)
    community: str | None = None
    rest = lower
    if len(lower) >= 2 and lower[0] == "r":
        community = f"r/{path[1]}"
        rest = lower[2:]
    elif len(lower) >= 2 and lower[0] in ("u", "user"):
        community = f"u/{path[1]}"
        rest = lower[2:]
    if len(rest) >= 2 and rest[0] == "comments" and _BASE36.match(rest[1]):
        post = rest[1]
        comment = rest[3] if len(rest) >= 4 and _BASE36.match(rest[3]) else None
        return Parsed("reddit", f"reddit:{post}", community, comment, cleaned)
    raise UrlError(NOT_A_THREAD)


def _facebook(host: str, path: list[str], query: dict[str, str], cleaned: str) -> Parsed:
    if host == "fb.me" or (path and path[0].lower() == "share"):
        raise UrlError(SHARE_LINK)
    reply = query.get("reply_comment_id")
    comment = reply or query.get("comment_id")
    reply_to = query.get("comment_id") if reply else None
    lower = [p.lower() for p in path]
    post: str | None = None
    community: str | None = None
    if len(path) >= 4 and lower[0] == "groups" and lower[2] in ("posts", "permalink"):
        community, post = path[1], path[3]
    elif lower[:1] == ["permalink.php"] or lower[:1] == ["story.php"]:
        post = query.get("story_fbid")
    elif len(path) >= 3 and lower[1] == "posts":
        community, post = path[0], path[2]
    if post is None or not _FB_ID.match(post):
        raise UrlError(NOT_A_THREAD)
    return Parsed("facebook", f"facebook:{post}", community, comment, cleaned, reply_to)


def _generic(slug: str, host: str, path: list[str]) -> Parsed:
    # No query, no fragment: the same page's address with tracking removed.
    page = urlunsplit(("https", host, "/" + "/".join(path), "", ""))
    digest = hashlib.sha1(page.encode(), usedforsecurity=False).hexdigest()
    return Parsed(slug, f"{slug}:{digest}", clean_url=page)


def _bare_code(code: str, parser: str, rules: list[PlatformRule]) -> Parsed:
    """A post's code typed or pasted on its own: `1xd8w7u` (Reddit), or a long number or
    `pfbid…` (Facebook)."""
    rule = next((r for r in rules if r.parser == parser), None)
    if rule is None:
        raise UrlError(NOT_A_URL)
    if not rule.enabled:
        raise UrlError(f"Answering on {rule.name or rule.slug} is switched off in Settings.")
    if parser == "facebook":
        link = f"https://www.facebook.com/{code}"
    else:
        link = f"https://www.reddit.com/comments/{code}/"
    return Parsed(rule.slug, f"{rule.slug}:{code}", clean_url=link)


def parse(url: str, rules: list[PlatformRule]) -> Parsed:
    """The thread a URL (or a Reddit post's bare code) points to, or UrlError with a message
    people can act on."""
    code = url.strip()
    if _BARE_FB_CODE.match(code):
        return _bare_code(code, "facebook", rules)
    if _BARE_CODE.match(code.lower()):
        return _bare_code(code.lower(), "reddit", rules)
    cleaned, host, path, query = clean(url)
    for rule in rules:
        hosts = rule.hosts or (
            REDDIT_HOSTS
            if rule.parser == "reddit"
            else FACEBOOK_HOSTS
            if rule.parser == "facebook"
            else ()
        )
        if not _matches(host, hosts):
            continue
        if not rule.enabled:
            raise UrlError(f"Answering on {rule.name or rule.slug} is switched off in Settings.")
        if rule.parser == "reddit":
            parsed = _reddit(host, path, cleaned)
        elif rule.parser == "facebook":
            parsed = _facebook(host, path, query, cleaned)
        else:
            parsed = _generic(rule.slug, host, path)
        if parsed.platform != rule.slug:
            parsed = Parsed(
                rule.slug,
                rule.slug + parsed.thread_id[parsed.thread_id.index(":") :],
                parsed.community,
                parsed.comment_id,
                parsed.clean_url,
                parsed.reply_to_comment_id,
            )
        return parsed
    raise UrlError(
        "This website isn't set up for answering. The Owner can add it in Settings → Platforms."
    )
