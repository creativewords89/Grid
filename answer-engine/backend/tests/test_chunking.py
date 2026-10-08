"""Chunking rules of SPEC section 6.3."""

import itertools

from app.chunking import (
    MAX,
    OVERLAP,
    TARGET,
    chunk_blocks,
    context_line,
    count_tokens,
    split_sentences,
)
from app.files.blocks import Block


def sentence(n: int, words: int = 12) -> str:
    """A distinct sentence of about `words` words, so text can be traced through chunks."""
    return "Sentence " + str(n) + " " + " ".join(f"word{n}x{i}" for i in range(words - 2)) + "."


def paragraph(start: int, count: int, page: int | None = 1) -> Block:
    return Block("text", " ".join(sentence(n) for n in range(start, start + count)), page=page)


def heading(text: str, level: int = 1, page: int | None = 1) -> Block:
    return Block("heading", text, page=page, level=level)


def table(rows: int, cols: int = 3) -> str:
    head = "| " + " | ".join(f"Col {c}" for c in range(cols)) + " |"
    sep = "|" + "---|" * cols
    body = ["| " + " | ".join(f"r{r}c{c} value" for c in range(cols)) + " |" for r in range(rows)]
    return "\n".join([head, sep, *body])


def test_nothing_in_nothing_out() -> None:
    assert chunk_blocks([]) == []
    assert chunk_blocks([Block("text", "   ")]) == []


def test_a_short_document_is_one_chunk() -> None:
    [chunk] = chunk_blocks([heading("Pricing"), paragraph(0, 3)])

    assert chunk.text.startswith("# Pricing\n\nSentence 0 ")
    assert chunk.heading == "Pricing"
    assert (chunk.page_from, chunk.page_to) == (1, 1)
    assert chunk.token_count == count_tokens(chunk.text)


def test_long_text_is_split_near_the_target_and_never_over_the_max() -> None:
    blocks = [paragraph(n * 5, 5) for n in range(40)]  # ~200 sentences in 40 paragraphs

    chunks = chunk_blocks(blocks)

    assert len(chunks) > 5
    assert all(c.token_count <= MAX for c in chunks)
    assert all(c.token_count >= TARGET * 0.75 for c in chunks[:-1])


def test_every_sentence_survives_and_none_is_cut() -> None:
    blocks = [paragraph(n * 7, 7) for n in range(30)]
    every = [sentence(n) for n in range(210)]

    chunks = chunk_blocks(blocks)

    found = [s for c in chunks for s in split_sentences(c.text.replace("\n\n", "\n"))]
    assert set(found) == set(every)  # whole sentences only (some twice, from the overlap)


def test_neighbouring_chunks_overlap_by_whole_sentences() -> None:
    chunks = chunk_blocks([paragraph(n * 5, 5) for n in range(40)])

    for before, after in itertools.pairwise(chunks):
        before_sentences = split_sentences(before.text.replace("\n\n", "\n"))
        after_sentences = split_sentences(after.text.replace("\n\n", "\n"))
        shared = [s for s in after_sentences[:5] if s in before_sentences]
        assert shared, "consecutive chunks should share sentences"
        assert shared == before_sentences[-len(shared) :]  # the tail of the previous chunk
        assert count_tokens(" ".join(shared)) <= OVERLAP


def test_a_heading_starts_a_new_chunk_without_overlap() -> None:
    blocks = [heading("Plans"), paragraph(0, 15), heading("Billing"), paragraph(100, 15)]

    chunks = chunk_blocks(blocks)

    assert [c.heading for c in chunks] == ["Plans", "Billing"]
    assert chunks[1].text.startswith("# Billing\n\nSentence 100 ")
    assert "Sentence 14 " not in chunks[1].text


def test_short_sections_are_kept_together() -> None:
    blocks = [heading("A"), paragraph(0, 1), heading("B"), paragraph(1, 1), heading("C")]

    [chunk] = chunk_blocks(blocks)

    assert chunk.heading is None  # A and B share no heading
    assert "# B" in chunk.text
    assert "# C" not in chunk.text  # a heading with nothing under it is dropped


def test_a_chunk_spanning_subsections_is_labelled_with_their_parent() -> None:
    blocks = [
        heading("Pricing", 1),
        heading("Basic", 2),
        paragraph(0, 2),
        heading("Pro", 2),
        paragraph(10, 2),
    ]

    [chunk] = chunk_blocks(blocks)

    assert chunk.heading == "Pricing"


def test_a_short_section_end_joins_the_chunk_before_it() -> None:
    blocks = [
        heading("Onboarding", 1),
        paragraph(0, 15),
        heading("Checklist", 2),
        Block("text", "- Verify the profile", page=2),
        heading("Pricing", 1),
        paragraph(100, 15),
    ]

    chunks = chunk_blocks(blocks)

    assert [c.heading for c in chunks] == ["Onboarding", "Pricing"]
    assert chunks[0].text.endswith("## Checklist\n\n- Verify the profile")
    assert chunks[1].text.startswith("# Pricing")


def test_heading_path_follows_levels() -> None:
    blocks = [
        heading("Services", 1),
        heading("Local SEO", 2),
        paragraph(0, 15),
        heading("Pricing", 3),
        paragraph(20, 15),
        heading("Support", 1),
        paragraph(40, 15),
    ]

    assert [c.heading for c in chunk_blocks(blocks)] == [
        "Services › Local SEO",
        "Services › Local SEO › Pricing",
        "Support",
    ]


def test_a_table_is_never_split_when_it_fits() -> None:
    small_table = table(rows=30)
    assert count_tokens(small_table) <= MAX
    blocks = [paragraph(0, 25), Block("table", small_table), paragraph(100, 3)]

    chunks = chunk_blocks(blocks)

    holding = [c for c in chunks if "| Col 0 |" in c.text]
    assert len(holding) == 1
    assert small_table in holding[0].text


def test_a_table_too_big_for_one_chunk_is_split_by_rows_with_the_header() -> None:
    big = table(rows=200)
    assert count_tokens(big) > MAX

    chunks = chunk_blocks([Block("table", big)])

    assert len(chunks) > 1
    header = "\n".join(big.splitlines()[:2])
    rows: list[str] = []
    for chunk in chunks:
        assert chunk.text.startswith(header)
        assert chunk.token_count <= MAX
        rows += chunk.text.splitlines()[2:]
    assert rows == big.splitlines()[2:]  # every row once, in order, none cut


def test_a_huge_paragraph_is_split_at_sentences() -> None:
    [block] = [paragraph(0, 200)]
    assert count_tokens(block.text) > MAX

    chunks = chunk_blocks([block])

    assert all(c.token_count <= MAX for c in chunks)
    for chunk in chunks:
        assert chunk.text.startswith("Sentence ")
        assert chunk.text.endswith(".")


def test_a_sentence_longer_than_a_chunk_is_split_at_words() -> None:
    endless = " ".join(f"item{n}" for n in range(1500))  # a list with no full stops

    chunks = chunk_blocks([Block("text", endless)])

    assert all(c.token_count <= MAX for c in chunks)
    assert " ".join(c.text for c in chunks).split() == endless.split()


def test_page_numbers_cover_the_pages_a_chunk_came_from() -> None:
    blocks = [paragraph(0, 4, page=1), paragraph(10, 4, page=2), paragraph(20, 4, page=3)]

    [chunk] = chunk_blocks(blocks)

    assert (chunk.page_from, chunk.page_to) == (1, 3)


def test_formats_without_pages_have_none() -> None:
    [chunk] = chunk_blocks([paragraph(0, 2, page=None)])

    assert (chunk.page_from, chunk.page_to) == (None, None)


def test_ocr_text_is_marked() -> None:
    chunks = chunk_blocks([Block("text", "Scanned words.", page=4, from_ocr=True)])

    assert chunks[0].from_ocr is True


def test_a_document_of_only_headings_has_no_chunks() -> None:
    assert chunk_blocks([heading("Title"), heading("Contents", 2)]) == []


def test_a_title_sits_above_top_level_headings() -> None:
    blocks = [heading("Handbook", 0), paragraph(0, 1), heading("Leave", 1), paragraph(10, 30)]

    chunks = chunk_blocks(blocks)

    assert chunks[0].text.startswith("# Handbook")
    assert chunks[-1].heading == "Handbook › Leave"


def test_context_line() -> None:
    assert context_line("Pricing.pdf", "Plans › Local SEO") == "Pricing.pdf › Plans › Local SEO"
    assert context_line("Pricing.pdf", None) == "Pricing.pdf"


def test_sentences_keep_quotes_and_skip_abbreviations() -> None:
    text = "It costs $500. Is that ok? “Yes.” See p. 4 and e.g. Dr. Smith. Version 2.5 works.\nNew"

    assert split_sentences(text) == [
        "It costs $500.",
        "Is that ok?",
        "“Yes.”",
        "See p. 4 and e.g. Dr. Smith.",
        "Version 2.5 works.",
        "New",
    ]
