"""A lead's GBP link to the profile's Google ID (`agents/gbp-audit/SPEC.md` section 2).

The links in the lead files are Google Maps links, often short ones (`share.google/…`,
`maps.app.goo.gl/…`). A short link is followed to the address it stands for; the profile's
CID (`cid=`, `ludocid=`, or the second half of a `0x…:0x…` feature id) or Place ID is read
from it. DataForSEO is asked by that ID, so the right profile is audited.
"""

import re
from dataclasses import dataclass
from urllib.parse import unquote, urlsplit

import httpx2

CID = re.compile(r"[?&#](?:cid|ludocid)=(\d{5,25})")
FEATURE = re.compile(r"0x[0-9a-f]{6,16}:0x([0-9a-f]{6,16})", re.IGNORECASE)
PLACE = re.compile(r"(?:place_id[=:]|query_place_id=|!19s)(ChIJ[\w-]{10,})")
SHORT_HOSTS = ("share.google", "maps.app.goo.gl", "goo.gl", "g.page", "g.co")
MAX_HOPS = 6

transport: httpx2.BaseTransport | None = None  # tests swap it for an httpx2.MockTransport


@dataclass(frozen=True)
class Place:
    cid: str = ""
    place_id: str = ""

    @property
    def keyword(self) -> str:
        """How DataForSEO is asked for this profile."""
        return f"cid:{self.cid}" if self.cid else f"place_id:{self.place_id}"


def read(url: str) -> Place | None:
    """The ID in a full Google Maps or Search address, if it has one."""
    text = unquote(unquote(url))
    if found := CID.search(text):
        return Place(cid=found.group(1))
    if found := FEATURE.search(text):
        return Place(cid=str(int(found.group(1), 16)))
    if found := PLACE.search(text):
        return Place(place_id=found.group(1))
    return None


def _short(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in SHORT_HOSTS)


def resolve(link: str) -> Place | None:
    """The profile a lead's GBP link points to, following a short link when needed; None when
    the link names no profile (the agent then looks it up by name and address)."""
    link = link.strip()
    if not link:
        return None
    if not link.startswith(("http://", "https://")):
        link = "https://" + link
    if found := read(link):
        return found
    if not _short(link):
        return None
    url = link
    try:
        with httpx2.Client(timeout=15.0, transport=transport, follow_redirects=False) as client:
            for _ in range(MAX_HOPS):
                response = client.get(url, headers={"User-Agent": "Mozilla/5.0"})
                target = response.headers.get("location")
                if not target or response.status_code not in (301, 302, 303, 307, 308):
                    return read(str(response.url))
                url = str(response.url.join(target))
                if found := read(url):
                    return found
    except httpx2.HTTPError:
        return None
    return None
