"""The two prompts. Bump VERSION when either changes so cached notes regenerate."""
from __future__ import annotations

VERSION = "4"
MAX_CHARS = 140_000  # about 35k tokens: fits every mainstream model's context

READER = """You write study notes for one reader: a physics-trained, self-taught engineer who reads to \
understand and then to act. He wants the few principles that carry the text, the reasoning that makes \
each one true, and what to do with it. Everything else is noise: no filler, no praise, no throat-clearing, \
no tangents, no generic advice, no restating the same point twice.

Rules that are never broken:
- Ground every claim in the given text. Never invent chapters, quotes, examples or claims.
- Tag each principle with exactly one source label: [Author] (the text says it), [Clarification] \
(unpacking the author's reasoning), [Inference] (follows from it but the author does not say it).
- Prefer the author's own example. A new example must start with [My illustration].
- Keep satire, metaphor, conjecture and opinion distinct from established fact; say which it is.
- Preserve the author's terms; gloss them in plain words the first time.
- Plain, exact sentences. Short is good; skipping a reasoning step is not. Never use em dashes.
- Write Markdown with exactly the headings requested, in that order, nothing before or after."""

CHAPTER = """Book: {title}{authors}
Table of contents (this chapter is marked with >>):
{toc}

Write notes for the chapter "{chapter}" using exactly this structure:

## Central question
One sentence: the question this chapter answers.

## Core idea
One or two sentences: the author's answer.

## Principles
Three to seven, ordered so each builds on the previous. Each one in exactly this shape \
(replace everything in angle brackets; never copy these instructions into the notes):

### 1. <the principle as a short claim>
<[Author], [Clarification] or [Inference]> **Why it holds:**

1. <first step of the reasoning>
2. <next step, following from the previous>
3. <conclusion; use 2 to 4 steps>

**Example:** <the author's example in one or two sentences, or start with [My illustration]>

## Map
A fenced code block with language `map`: an indented tree (two spaces per level, each line starting \
with "- "). Root is the core idea; children are the principles; grandchildren are mechanisms, examples \
or consequences. A line may begin with a relation in brackets, e.g. "- [causes] runaway growth". \
At most 4 words per node, at most 20 nodes.

## Use it
Two to four questions to ask before a real decision, each with one line on when it applies.

## Limits
What is assumed, metaphorical, satirical, dated or unproven. Two to four bullets.

## Connections
How this chapter depends on earlier ones and prepares later ones, using only titles from the table of \
contents. Two bullets at most; say "None evident" rather than invent.

## Remember
One sentence.
{partial}
--- CHAPTER TEXT ---
{text}"""

BOOK = """Book: {title}{authors}
Below are study notes for every chapter, in order. Build the book as ONE connected theory. Integrate; \
do not repeat chapter summaries. Use exactly this structure:

## The book in one sentence

## The problem that made the book necessary

## Central thesis

## Load-bearing ideas
A table: | Idea | Meaning | Depends on | Enables |, five to nine rows, the smallest set that explains \
most of the book.

## The book as one map
A fenced `map` block (same format as the chapter maps: indented "- " tree, optional [relation] prefix, \
at most 4 words per node, at most 30 nodes) whose branches are the book's movements, each naming its chapters.

## The intellectual journey
How the argument moves from start to end, one short paragraph per movement, naming chapters.

## The principles worth keeping
A table: | # | Principle | When it helps | Failure mode if applied blindly |, seven to twelve rows.

## Operating manual
Numbered steps for applying the book to a real decision or project.

## Tensions and open questions

## Author vs. inference
Which of the big claims the author makes, and which are your inferences.

{notes}"""


def toc_lines(chapters, current: int | None = None) -> str:
    return "\n".join(("  " * c.depth) + (">> " if c.index == current else "- ") + c.title for c in chapters)


def chapter_prompt(book, ch) -> tuple[str, str]:
    text = ch.text
    partial = ""
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS]
        partial = ("\nThe chapter text below is truncated. Start the Central question section with "
                   "\"(Partial: notes cover the first part of the chapter.)\"\n")
    authors = f" by {', '.join(book.authors)}" if book.authors else ""
    return READER, CHAPTER.format(title=book.title, authors=authors, toc=toc_lines(book.chapters, ch.index),
                                  chapter=ch.title, partial=partial, text=text)


def book_prompt(book, notes: list[tuple[str, str]]) -> tuple[str, str]:
    authors = f" by {', '.join(book.authors)}" if book.authors else ""
    joined = "\n\n".join(f"=== {title} ===\n{md}" for title, md in notes)
    return READER, BOOK.format(title=book.title, authors=authors, notes=joined[:MAX_CHARS * 2])


CHAPTER_HEADINGS = ["Central question", "Core idea", "Principles", "Map", "Use it", "Limits", "Connections", "Remember"]
BOOK_HEADINGS = ["The book in one sentence", "The problem that made the book necessary", "Central thesis",
                 "Load-bearing ideas", "The book as one map", "The intellectual journey",
                 "The principles worth keeping", "Operating manual", "Tensions and open questions", "Author vs. inference"]


def shape_problems(md: str, headings: list[str]) -> list[str]:
    """What is wrong with a note's shape (empty list = fine)."""
    import re
    found = re.findall(r"^## (.+?)\s*$", md, re.M)
    probs = []
    if found != headings:
        probs.append(f"headings {found} != {headings}")
    if "```map" not in md:
        probs.append("no map block")
    for leak in ("angle brackets", "never copy these instructions", "<the principle", "<first step"):
        if leak in md:
            probs.append(f"prompt text leaked: {leak!r}")
    return probs
