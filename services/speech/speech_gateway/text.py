"""Text preparation for Russian speech: normalisation and sentence chunks.

Silero only knows Cyrillic letters and a little punctuation; anything else is
silently dropped by the model. So numbers become words, Latin acronyms are
spelled out, known names come from a small lexicon, and brackets and quotes
become pauses — before the text reaches the stress model.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterable

try:  # Optional at import time so the tests and tooling need no extra package.
    from num2words import num2words as _num2words
except ImportError:  # pragma: no cover - exercised only without num2words
    _num2words = None

LATIN_LETTER_NAMES = {
    "a": "эй", "b": "би", "c": "си", "d": "ди", "e": "и", "f": "эф", "g": "джи",
    "h": "эйч", "i": "ай", "j": "джей", "k": "кей", "l": "эл", "m": "эм", "n": "эн",
    "o": "оу", "p": "пи", "q": "кью", "r": "ар", "s": "эс", "t": "ти", "u": "ю",
    "v": "ви", "w": "дабл-ю", "x": "экс", "y": "уай", "z": "зед",
}

# Rough reading of Latin words that are not acronyms (longest patterns first).
_TRANSLIT = [
    ("sch", "ш"), ("tch", "ч"), ("sh", "ш"), ("ch", "ч"), ("th", "т"), ("ph", "ф"),
    ("kh", "х"), ("zh", "ж"), ("ts", "ц"), ("oo", "у"), ("ee", "и"), ("ck", "к"),
    ("qu", "кв"), ("ya", "я"), ("yu", "ю"), ("yo", "ё"),
    ("a", "а"), ("b", "б"), ("c", "к"), ("d", "д"), ("e", "е"), ("f", "ф"), ("g", "г"),
    ("h", "х"), ("i", "и"), ("j", "дж"), ("k", "к"), ("l", "л"), ("m", "м"), ("n", "н"),
    ("o", "о"), ("p", "п"), ("q", "к"), ("r", "р"), ("s", "с"), ("t", "т"), ("u", "у"),
    ("v", "в"), ("w", "в"), ("x", "кс"), ("y", "и"), ("z", "з"),
]

SENTENCE_END_RE = re.compile(r"(?<=[.!?…])\s+")
_NUMBER_RE = re.compile(r"(?<![\w])(\d+)(?:[.,](\d+))?(?![\w])")
_LATIN_WORD_RE = re.compile(r"[A-Za-z]+")
_ALNUM_SPLIT_RE = re.compile(r"(?<=[A-Za-zА-Яа-яЁё])(?=\d)|(?<=\d)(?=[A-Za-zА-Яа-яЁё])")


def number_to_words(value: str, fraction: str | None = None) -> str:
    if _num2words is None:
        return value if fraction is None else f"{value} {fraction}"
    try:
        if fraction is not None:
            return _num2words(float(f"{int(value)}.{fraction}"), lang="ru")
        return _num2words(int(value), lang="ru")
    except (ValueError, OverflowError, NotImplementedError):
        return value


def latin_to_russian(word: str) -> str:
    """Acronyms (AM, HQ, SOC) are spelled letter by letter; other words are read."""
    if len(word) <= 5 and (word.isupper() or len(word) == 1):
        return " ".join(LATIN_LETTER_NAMES[ch] for ch in word.lower())
    out, i, low = [], 0, word.lower()
    while i < len(low):
        for latin, cyr in _TRANSLIT:
            if low.startswith(latin, i):
                out.append(cyr)
                i += len(latin)
                break
        else:
            i += 1
    return "".join(out)


def load_lexicon(path: Path | None) -> dict[str, str]:
    if not path or not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {str(k): str(v) for k, v in data.items() if not str(k).startswith("_")}


def apply_lexicon(text: str, lexicon: dict[str, str]) -> str:
    for term in sorted(lexicon, key=len, reverse=True):
        text = re.sub(rf"(?<![\w]){re.escape(term)}(?![\w])", lexicon[term], text, flags=re.IGNORECASE)
    return text


def normalize_russian(text: str, lexicon: dict[str, str] | None = None) -> str:
    """Speakable Russian text: words and the punctuation Silero understands."""
    text = text.replace("\r", "\n")
    text = re.sub(r"\n{2,}", ". ", text)
    text = text.replace("\n", " ")
    if lexicon:
        text = apply_lexicon(text, lexicon)
    text = _ALNUM_SPLIT_RE.sub(" ", text)
    text = re.sub(r"(\d)\s*%", r"\1 процентов", text)
    text = _NUMBER_RE.sub(lambda m: number_to_words(m.group(1), m.group(2)), text)
    text = _LATIN_WORD_RE.sub(lambda m: latin_to_russian(m.group(0)), text)
    text = text.replace("—", "–").replace("―", "–")
    text = re.sub(r"[«»\"“”„'`’‘*_#<>&=|\\/^{}\[\]]", " ", text)
    text = re.sub(r"[()]", ", ", text)
    text = re.sub(r"\.{3,}", "…", text)
    text = re.sub(r"\s+([,.!?:;…])", r"\1", text)
    text = re.sub(r"([,.!?:;])(?:\s*[,])+", r"\1", text)
    text = re.sub(r"^[\s,.;:]+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def split_sentences(text: str) -> list[str]:
    return [part.strip() for part in SENTENCE_END_RE.split(text) if part.strip()]


def _split_long(sentence: str, limit: int) -> Iterable[str]:
    """A sentence longer than the limit breaks at commas, then at spaces."""
    if len(sentence) <= limit:
        yield sentence
        return
    pieces = re.split(r"(?<=[,;:–])\s+", sentence)
    if len(pieces) == 1:
        pieces = sentence.split(" ")
    current = ""
    for piece in pieces:
        while len(piece) > limit:  # a single enormous "word"
            if current:
                yield current
                current = ""
            yield piece[:limit]
            piece = piece[limit:]
        candidate = f"{current} {piece}".strip()
        if len(candidate) > limit and current:
            yield current
            current = piece
        else:
            current = candidate
    if current:
        yield current


def chunk_text(text: str, limit: int = 600) -> list[str]:
    """Whole sentences packed into chunks of at most `limit` characters."""
    chunks: list[str] = []
    current = ""
    for sentence in split_sentences(text):
        for part in _split_long(sentence, limit):
            candidate = f"{current} {part}".strip()
            if len(candidate) > limit and current:
                chunks.append(current)
                current = part
            else:
                current = candidate
    if current:
        chunks.append(current)
    return chunks


def ssml_rate(speed: float) -> str | None:
    """Silero changes tempo only through SSML's five named rates."""
    if speed <= 0.8:
        return "x-slow"
    if speed <= 0.9:
        return "slow"
    if speed < 1.1:
        return None
    if speed < 1.3:
        return "fast"
    return "x-fast"
