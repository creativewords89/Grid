"""The URL parser (SPEC section 6.10): every Reddit and Facebook pattern, bare post codes,
share links and tracking parameters."""

import pytest

from app.marketing.url_parser import (
    NOT_A_THREAD,
    NOT_A_URL,
    SHARE_LINK,
    Parsed,
    PlatformRule,
    UrlError,
    clean,
    parse,
)

RULES = [
    PlatformRule("reddit", "reddit", name="Reddit"),
    PlatformRule("facebook", "facebook", name="Facebook"),
    PlatformRule("quora", "generic", ("quora.com",), name="Quora"),
]


def p(url: str, rules: list[PlatformRule] = RULES) -> Parsed:
    return parse(url, rules)


@pytest.mark.parametrize(
    ("url", "thread_id", "community", "comment"),
    [
        # Reddit
        (
            "https://www.reddit.com/r/localseo/comments/1abc2de/how_long_gbp/",
            "reddit:1abc2de",
            "r/localseo",
            None,
        ),
        (
            "https://old.reddit.com/r/LocalSEO/comments/1ABC2DE/how_long/",
            "reddit:1abc2de",
            "r/LocalSEO",
            None,
        ),
        (
            "https://reddit.com/r/localseo/comments/1abc2de/x/kx9z0p1/",
            "reddit:1abc2de",
            "r/localseo",
            "kx9z0p1",
        ),
        (
            "https://www.reddit.com/r/localseo/comments/1abc2de/x/kx9z0p1/?context=3",
            "reddit:1abc2de",
            "r/localseo",
            "kx9z0p1",
        ),
        ("https://m.reddit.com/r/SEO/comments/1abc2de", "reddit:1abc2de", "r/SEO", None),
        ("https://new.reddit.com/r/SEO/comments/1abc2de/", "reddit:1abc2de", "r/SEO", None),
        ("https://np.reddit.com/r/SEO/comments/1abc2de/t/", "reddit:1abc2de", "r/SEO", None),
        ("https://www.reddit.com/comments/1abc2de", "reddit:1abc2de", None, None),
        ("https://redd.it/1abc2de", "reddit:1abc2de", None, None),
        (
            "https://www.reddit.com/user/bob/comments/1abc2de/hello/",
            "reddit:1abc2de",
            "u/bob",
            None,
        ),
        (
            "https://www.reddit.com/r/localseo/comments/1abc2de/t/?utm_source=share&utm_medium=web2x&share_id=xyz&rdt=123",
            "reddit:1abc2de",
            "r/localseo",
            None,
        ),
        (
            "  https://www.reddit.com/r/localseo/comments/1abc2de/t/#comments  ",
            "reddit:1abc2de",
            "r/localseo",
            None,
        ),
        ("www.reddit.com/r/localseo/comments/1abc2de/t/", "reddit:1abc2de", "r/localseo", None),
        # Facebook
        (
            "https://www.facebook.com/groups/localbiz/posts/1234567890/",
            "facebook:1234567890",
            "localbiz",
            None,
        ),
        (
            "https://m.facebook.com/groups/987654/permalink/1234567890/",
            "facebook:1234567890",
            "987654",
            None,
        ),
        (
            "https://www.facebook.com/groups/localbiz/posts/1234567890/?comment_id=555&__cft__[0]=AZX&__tn__=R",
            "facebook:1234567890",
            "localbiz",
            "555",
        ),
        (
            "https://www.facebook.com/groups/localbiz/posts/1234567890/?comment_id=555&reply_comment_id=777",
            "facebook:1234567890",
            "localbiz",
            "777",
        ),
        (
            "https://www.facebook.com/permalink.php?story_fbid=1234567890&id=100064",
            "facebook:1234567890",
            None,
            None,
        ),
        (
            "https://www.facebook.com/GridRankers/posts/pfbid02AbCdEf123",
            "facebook:pfbid02AbCdEf123",
            "GridRankers",
            None,
        ),
        (
            "https://web.facebook.com/groups/localbiz/posts/1234567890/?fbclid=IwAR0",
            "facebook:1234567890",
            "localbiz",
            None,
        ),
        (
            "https://mbasic.facebook.com/groups/localbiz/posts/1234567890",
            "facebook:1234567890",
            "localbiz",
            None,
        ),
        (
            "https://fb.com/groups/localbiz/posts/1234567890",
            "facebook:1234567890",
            "localbiz",
            None,
        ),
    ],
)
def test_patterns(url: str, thread_id: str, community: str | None, comment: str | None) -> None:
    parsed = p(url)
    assert (parsed.thread_id, parsed.community, parsed.comment_id) == (
        thread_id,
        community,
        comment,
    )
    assert parsed.platform == thread_id.split(":")[0]


@pytest.mark.parametrize(
    ("url", "message"),
    [
        ("https://www.reddit.com/r/localseo/s/AbC123xyz", SHARE_LINK),
        ("https://www.facebook.com/share/p/1AbCdEf/", SHARE_LINK),
        ("https://www.facebook.com/share/1AbCdEf/", SHARE_LINK),
        ("https://fb.me/abc123", SHARE_LINK),
        ("https://www.reddit.com/r/localseo/", NOT_A_THREAD),
        ("https://www.reddit.com/r/localseo/comments/", NOT_A_THREAD),
        ("https://www.facebook.com/groups/localbiz/", NOT_A_THREAD),
        ("https://www.facebook.com/groups/localbiz/posts/not-an-id/", NOT_A_THREAD),
        ("https://redd.it/", NOT_A_THREAD),
        ("ftp://reddit.com/r/x/comments/abc", NOT_A_URL),
        ("just some text", NOT_A_URL),
        ("", NOT_A_URL),
    ],
)
def test_errors(url: str, message: str) -> None:
    with pytest.raises(UrlError) as error:
        p(url)
    assert str(error.value) == message


@pytest.mark.parametrize("code", ["1xd8w7u", "1XD8W7U", "  1abc2de  ", "kx9z"])
def test_a_reddit_post_code_on_its_own(code: str) -> None:
    parsed = p(code)
    wanted = code.strip().lower()
    assert parsed.platform == "reddit"
    assert parsed.thread_id == f"reddit:{wanted}"
    assert parsed.clean_url == f"https://www.reddit.com/comments/{wanted}/"
    # The same post as its full link.
    assert p(
        f"https://www.reddit.com/r/DunderMifflin/comments/{wanted}/kevins_wife_btw/"
    ).thread_id == (parsed.thread_id)


def test_a_bare_code_needs_reddit_switched_on() -> None:
    off = [PlatformRule("reddit", "reddit", enabled=False, name="Reddit")]
    with pytest.raises(UrlError, match="Answering on Reddit is switched off"):
        p("1xd8w7u", off)
    with pytest.raises(UrlError):
        p("1xd8w7u", [PlatformRule("quora", "generic", ("quora.com",))])


@pytest.mark.parametrize("code", ["1234567890123456", "  pfbid02AbCdEf123xYz  "])
def test_a_facebook_post_code_on_its_own(code: str) -> None:
    parsed = p(code)
    wanted = code.strip()  # a pfbid code keeps its capital letters
    assert parsed.platform == "facebook"
    assert parsed.thread_id == f"facebook:{wanted}"
    assert parsed.clean_url == f"https://www.facebook.com/{wanted}"
    # The same post as its permalink.
    assert p(f"https://www.facebook.com/groups/localbiz/posts/{wanted}/").thread_id == (
        parsed.thread_id
    )


def test_a_bare_facebook_code_needs_facebook_switched_on() -> None:
    off = [PlatformRule("facebook", "facebook", enabled=False, name="Facebook")]
    with pytest.raises(UrlError, match="Answering on Facebook is switched off"):
        p("1234567890123456", off)


def test_unknown_and_disabled_platforms() -> None:
    with pytest.raises(UrlError, match="isn't set up for answering"):
        p("https://example.com/forum/thread/1")
    off = [PlatformRule("reddit", "reddit", enabled=False, name="Reddit")]
    with pytest.raises(UrlError, match="Answering on Reddit is switched off"):
        p("https://www.reddit.com/r/x/comments/abc", off)


def test_generic_platforms_hash_the_clean_page_address() -> None:
    a = p("https://www.quora.com/How-long-does-GBP-verification-take?utm_source=x#answer")
    b = p("https://quora.com/How-long-does-GBP-verification-take")
    assert a.thread_id == b.thread_id
    assert a.thread_id.startswith("quora:") and len(a.thread_id) == len("quora:") + 40
    assert a.clean_url == "https://quora.com/How-long-does-GBP-verification-take"


def test_cleaning_keeps_only_meaningful_parameters() -> None:
    cleaned, host, path, query = clean(
        "HTTPS://WWW.Facebook.com/permalink.php?story_fbid=12&id=34&utm_campaign=x&fbclid=y#top"
    )
    assert host == "facebook.com"
    assert query == {"story_fbid": "12", "id": "34"}
    assert cleaned == "https://facebook.com/permalink.php?story_fbid=12&id=34"
    assert path == ["permalink.php"]


def test_a_facebook_reply_link_names_the_comment_it_answers() -> None:
    reply = p(
        "https://www.facebook.com/groups/localbiz/posts/1234567890/?comment_id=555&reply_comment_id=777"
    )
    assert (reply.comment_id, reply.reply_to_comment_id) == ("777", "555")
    comment = p("https://www.facebook.com/groups/localbiz/posts/1234567890/?comment_id=555")
    assert (comment.comment_id, comment.reply_to_comment_id) == ("555", None)
