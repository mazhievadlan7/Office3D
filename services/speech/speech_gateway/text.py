"""Text preparation for Russian speech: normalisation and sentence chunks.

Silero only knows Cyrillic letters and a little punctuation; anything else is
silently dropped by the model. So numbers become words, Latin acronyms are
spelled out, known names come from a small lexicon, and brackets and quotes
become pauses — before the text reaches the stress model.

Numbers are read the way Russian says them, not digit by digit: a time is
«шесть часов сорок минут», a date «третье октября две тысячи двадцать шестого
года», and a count agrees with the noun after it («одна попытка», «две
минуты», «одно сообщение»).
"""

from __future__ import annotations

import hashlib
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

#: Bumped whenever normalisation reads the same input differently, so audio
#: cached under the old reading is not served again (part of the cache key).
TEXT_VERSION = "2"

_MONTHS_GENITIVE = (
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
)
_YEAR_CASES = {"год": "nominative", "года": "genitive", "году": "prepositional", "годом": "instrumental"}
# 06:40, 0:05, 23:59 — not 12:345 or 1:2:3.
_TIME_RE = re.compile(r"(?<![\w:])([01]?\d|2[0-3]):([0-5]\d)(?![\w:])")
# The case a preposition puts the day in: «с первого октября», «к третьему».
_DATE_PREPOSITIONS = {"с": "genitive", "со": "genitive", "до": "genitive", "от": "genitive",
                      "после": "genitive", "около": "genitive", "к": "dative", "ко": "dative"}
# 3 октября, с 3 октября, 3 октября 2026 года, 3 октября 2026 г.
_DATE_RE = re.compile(
    r"(?<![\w])(?:(" + "|".join(_DATE_PREPOSITIONS) + r")\s+)?(\d{1,2})\s+(" + "|".join(_MONTHS_GENITIVE) + r")"
    r"(?:\s+(\d{3,4})\s*(года|году|год|г\.))?(?![\w])",
    re.IGNORECASE,
)
# 2026 года, в 2026 году.
_YEAR_RE = re.compile(r"(?<![\w])(\d{3,4})\s+(годом|года|году|год)(?![\w])", re.IGNORECASE)

# Nouns a count agrees with when they are not masculine, as whole word forms
# (the singular, the paucal and the genitive plural). A plain list, no
# morphology package: it covers the words the office's lines count.
_FEMININE_RE = re.compile(
    r"попытк[аиу]|попыток|минут[аы]?|секунд[аы]?|недел[ьяи]|недель|задач[аи]?|ошибк[аи]|ошибок"
    r"|атак[аи]?|угроз[аы]?|уязвимост[ьи]|уязвимостей|сесси[яи]|сессий|операци[яи]|операций"
    r"|проверк[аи]|проверок|заявк[аи]|заявок|строк[аи]?|тысяч[аи]?|систем[аы]?|команд[аы]?"
    r"|единиц[аы]?|запис[ьи]|записей|машин[аы]?|точк[аи]|точек|сет[ьи]|сетей"
)
_NEUTER_RE = re.compile(
    r"(?:сообщени|событи|подключени|соединени|предупреждени|уведомлени|обновлени|задани)[еяй]"
    r"|устройств[оа]?|правил[оа]?|окн[оа]|окон"
)
_NEXT_WORD_RE = re.compile(r"\s*([А-Яа-яЁё+]+)")

SENTENCE_END_RE = re.compile(r"(?<=[.!?…])\s+")
_NUMBER_RE = re.compile(r"(?<![\w])(\d+)(?:[.,](\d+))?(?![\w])")
_LATIN_WORD_RE = re.compile(r"[A-Za-z]+")
_ALNUM_SPLIT_RE = re.compile(r"(?<=[A-Za-zА-Яа-яЁё])(?=\d)|(?<=\d)(?=[A-Za-zА-Яа-яЁё])")


def _plural(count: int, one: str, few: str, many: str) -> str:
    n = abs(count) % 100
    if 10 < n < 20:
        return many
    if 1 < n % 10 < 5:
        return few
    return one if n % 10 == 1 else many


def _tidy(words: str) -> str:
    """«тысяча», not num2words' «одна тысяча»."""
    return re.sub(r"^одна тысяч", "тысяч", words)


def number_to_words(value: str, fraction: str | None = None, gender: str = "m") -> str:
    """A cardinal in words; a whole number agrees with `gender` (m, f or n)."""
    if _num2words is None:
        return value if fraction is None else f"{value} {fraction}"
    try:
        if fraction is not None:
            return _num2words(float(f"{int(value)}.{fraction}"), lang="ru")
        return _tidy(_num2words(int(value), lang="ru", gender=gender))
    except (ValueError, OverflowError, NotImplementedError, TypeError):
        return value


def ordinal_to_words(value: int, *, case: str = "nominative", gender: str = "m") -> str:
    """An ordinal in words: «третье» (gender n), «двадцать шестого» (genitive)."""
    if _num2words is None:
        return str(value)
    try:
        return _tidy(_num2words(value, lang="ru", to="ordinal", case=case, gender=gender))
    except (ValueError, OverflowError, NotImplementedError, TypeError):
        return str(value)


def gender_of(word: str) -> str:
    """The gender a count takes before `word`: m (the default), f or n."""
    low = word.lower().replace("+", "").replace("ё", "е")
    if _FEMININE_RE.fullmatch(low):
        return "f"
    if _NEUTER_RE.fullmatch(low):
        return "n"
    return "m"


def spoken_time(hours: int, minutes: int) -> str:
    """«шесть часов сорок минут», «один час пять минут», «ноль часов ровно»."""
    h = f"{number_to_words(str(hours))} {_plural(hours, 'час', 'часа', 'часов')}"
    if minutes == 0:
        return f"{h} ровно"
    return f"{h} {number_to_words(str(minutes), gender='f')} {_plural(minutes, 'минута', 'минуты', 'минут')}"


def _date(match: re.Match[str]) -> str:
    preposition, day, month, year, word = match.groups()
    case = _DATE_PREPOSITIONS.get(preposition.lower(), "nominative") if preposition else "nominative"
    ordinal = ordinal_to_words(int(day), case=case, gender="n")
    if preposition and preposition.lower() == "к" and ordinal.startswith("втор"):
        preposition += "о"  # ко второму
    spoken = f"{preposition} " if preposition else ""
    spoken += f"{ordinal} {month}"
    if year:
        unit = "года" if word.lower() == "г." else word
        spoken += f" {ordinal_to_words(int(year), case=_YEAR_CASES.get(unit.lower(), 'genitive'))} {unit}"
    return spoken


def _year(match: re.Match[str]) -> str:
    year, word = match.groups()
    return f"{ordinal_to_words(int(year), case=_YEAR_CASES[word.lower()])} {word}"


def _count(match: re.Match[str]) -> str:
    value, fraction = match.group(1), match.group(2)
    if fraction is not None:
        return number_to_words(value, fraction)
    following = _NEXT_WORD_RE.match(match.string, match.end())
    return number_to_words(value, gender=gender_of(following.group(1)) if following else "m")


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


def load_lexicon(path: Path | None, *extra: Path | None) -> dict[str, str]:
    """lexicon.json, then each extra file over it: a local file's entries win."""
    merged: dict[str, str] = {}
    for file in (path, *extra):
        if not file or not file.is_file():
            continue
        data = json.loads(file.read_text(encoding="utf-8"))
        merged.update({str(k): str(v) for k, v in data.items() if not str(k).startswith("_")})
    return merged


def lexicon_version(lexicon: dict[str, str]) -> str:
    """A short fingerprint of a lexicon (part of the speech cache key)."""
    if not lexicon:
        return ""
    joined = "\n".join(f"{key}={lexicon[key]}" for key in sorted(lexicon))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:12]


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
    text = _TIME_RE.sub(lambda m: spoken_time(int(m.group(1)), int(m.group(2))), text)
    text = _DATE_RE.sub(_date, text)
    text = _YEAR_RE.sub(_year, text)
    text = _NUMBER_RE.sub(_count, text)
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


class StressLexicon:
    """Phrases the engines stress wrongly (homographs in the office's own
    lines: замо́к / за́мок, всё / все, мука́ / му́ка), marked by hand with `+`.

    Matching ignores case and ё/е. For Silero the phrase goes in with its
    marks (the stress model keeps marks it is given); for engines that take
    plain text (VoxCPM2) the marks are dropped and only the ё is kept.
    """

    def __init__(self, phrases: Iterable[str]) -> None:
        entries: list[tuple[re.Pattern[str], str]] = []
        seen: list[str] = []
        for raw in phrases:
            marked = " ".join(str(raw).split())
            plain = marked.replace("+", "")
            if not plain:
                continue
            seen.append(marked)
            pattern = "".join(
                "[её]" if ch in "её" else r"\s+" if ch == " " else re.escape(ch) for ch in plain.lower()
            )
            entries.append((re.compile(rf"(?<![\w+]){pattern}(?![\w+])", re.IGNORECASE), marked))
        entries.sort(key=lambda entry: len(entry[1]), reverse=True)
        self._entries = entries
        self.version = hashlib.sha256("\n".join(sorted(seen)).encode("utf-8")).hexdigest()[:12] if seen else ""

    def __len__(self) -> int:
        return len(self._entries)

    @staticmethod
    def _cased(found: str, replacement: str) -> str:
        if not found[:1].isupper():
            return replacement
        for index, ch in enumerate(replacement):
            if ch.isalpha():
                return replacement[:index] + ch.upper() + replacement[index + 1 :]
        return replacement

    def apply(self, text: str, *, marks: bool = True) -> str:
        for regex, marked in self._entries:
            replacement = marked if marks else marked.replace("+", "")
            text = regex.sub(lambda m, r=replacement: self._cased(m.group(0), r), text)
        return text


def _stress_phrases(path: Path | None) -> list[str]:
    if not path or not path.is_file():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return [str(p) for p in (data.get("phrases", []) if isinstance(data, dict) else data)]


def load_stress(path: Path | None, *extra: Path | None) -> StressLexicon:
    """stress.json plus the phrases of each extra file — a local file kept out
    of the repository, for the owner's name for instance. A local phrase that
    repeats a shared one (same words, other marks) replaces it."""
    shared = _stress_phrases(path)
    local = [p for file in extra for p in _stress_phrases(file)]
    plain = {" ".join(p.replace("+", "").lower().replace("ё", "е").split()) for p in local}
    kept = [p for p in shared if " ".join(p.replace("+", "").lower().replace("ё", "е").split()) not in plain]
    return StressLexicon([*kept, *local])
