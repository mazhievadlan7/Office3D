from pathlib import Path

from speech_gateway.text import chunk_text, latin_to_russian, normalize_russian, split_sentences, ssml_rate

SERVICE_DIR = Path(__file__).resolve().parents[1]


def test_numbers_become_words():
    assert normalize_russian("В штабе 42 агента") == "В штабе сорок два агента"
    assert "три целых пять десятых" in normalize_russian("Загрузка 3,5")
    assert normalize_russian("Готово на 90%") == "Готово на девяносто процентов"


def test_latin_acronyms_are_spelled_and_words_read():
    assert latin_to_russian("SOC") == "эс оу си"
    callsign = normalize_russian("Оператор ONYX-0F")
    assert not any("a" <= ch.lower() <= "z" or ch.isdigit() for ch in callsign)
    assert normalize_russian("AM7 на связи") == "эй эм семь на связи"


def test_lexicon_wins_over_generic_rules():
    lexicon = {"AM7": "эй эм с+емь", "OpenClaw": "+оупен кл+оу"}
    assert normalize_russian("AM7 и OpenClaw", lexicon) == "эй эм с+емь и +оупен кл+оу"


def test_symbols_silero_cannot_say_become_pauses_or_vanish():
    text = normalize_russian("«Система» (штаба) — на связи...\n\nГотово *сейчас*")
    assert "«" not in text and "(" not in text and "*" not in text
    assert "–" in text and "…" in text
    assert "Готово сейчас" in text


def test_sentences_and_chunks():
    text = "Первое. Второе! Третье? Четвёртое…"
    assert split_sentences(text) == ["Первое.", "Второе!", "Третье?", "Четвёртое…"]
    chunks = chunk_text(" ".join(["Предложение номер один."] * 60), limit=120)
    assert all(len(chunk) <= 120 for chunk in chunks)
    assert " ".join(chunks).count("Предложение") == 60


def test_a_long_sentence_is_split_without_losing_words():
    sentence = ", ".join(["слово"] * 300) + "."
    chunks = chunk_text(sentence, limit=100)
    assert all(len(chunk) <= 100 for chunk in chunks)
    assert " ".join(chunks).count("слово") == 300


def test_speed_maps_to_ssml_rates():
    assert ssml_rate(1.0) is None and ssml_rate(0.94) is None
    assert ssml_rate(0.85) == "slow" and ssml_rate(0.7) == "x-slow"
    assert ssml_rate(1.2) == "fast" and ssml_rate(2.0) == "x-fast"


# --- Numbers read the way Russian says them --------------------------------

import json  # noqa: E402

import pytest  # noqa: E402

from speech_gateway.text import (  # noqa: E402
    TEXT_VERSION,
    gender_of,
    lexicon_version,
    load_lexicon,
    load_stress,
    ordinal_to_words,
    spoken_time,
)


@pytest.mark.parametrize(
    ("clock", "spoken"),
    [
        ("00:00", "ноль часов ровно"),
        ("01:05", "один час пять минут"),
        ("06:40", "шесть часов сорок минут"),
        ("12:21", "двенадцать часов двадцать одна минута"),
        ("02:01", "два часа одна минута"),
        ("04:22", "четыре часа двадцать две минуты"),
        ("21:02", "двадцать один час две минуты"),
        ("23:59", "двадцать три часа пятьдесят девять минут"),
        ("11:11", "одиннадцать часов одиннадцать минут"),
    ],
)
def test_a_time_is_hours_and_minutes(clock, spoken):
    assert normalize_russian(f"Время — {clock} по Москве.") == f"Время – {spoken} по Москве."
    hours, minutes = (int(part) for part in clock.split(":"))
    assert spoken_time(hours, minutes) == spoken


def test_what_only_looks_like_a_time_is_left_alone():
    assert normalize_russian("Счёт 3:2") == "Счёт три:два"
    assert "часов" not in normalize_russian("Порт 12:345")


@pytest.mark.parametrize(
    ("date", "spoken"),
    [
        ("1 октября 2026 года", "первое октября две тысячи двадцать шестого года"),
        ("2 октября 2026 года", "второе октября две тысячи двадцать шестого года"),
        ("3 октября 2026 года", "третье октября две тысячи двадцать шестого года"),
        ("21 октября 2026 года", "двадцать первое октября две тысячи двадцать шестого года"),
        ("29 сентября 2026 года", "двадцать девятое сентября две тысячи двадцать шестого года"),
        ("31 декабря 2030 года", "тридцать первое декабря две тысячи тридцатого года"),
        ("11 января 2000 года", "одиннадцатое января двухтысячного года"),
        ("12 мая", "двенадцатое мая"),
        ("4 октября 2026 г.", "четвёртое октября две тысячи двадцать шестого года"),
    ],
)
def test_a_date_is_an_ordinal_with_the_year_in_the_genitive(date, spoken):
    assert normalize_russian(f"Сегодня {date}") == f"Сегодня {spoken}"


def test_a_preposition_sets_the_case_of_the_date_and_the_year():
    assert normalize_russian("с 1 октября до 3 ноября") == "с первого октября до третьего ноября"
    assert normalize_russian("к 2 мая") == "ко второму мая"
    assert normalize_russian("в 2026 году") == "в две тысячи двадцать шестом году"
    assert normalize_russian("2026 год") == "две тысячи двадцать шестой год"
    assert ordinal_to_words(2026, case="genitive") == "две тысячи двадцать шестого"


@pytest.mark.parametrize(
    ("count", "attempts"),
    [
        (0, "ноль попыток"),
        (1, "одна попытка"),
        (2, "две попытки"),
        (5, "пять попыток"),
        (11, "одиннадцать попыток"),
        (21, "двадцать одна попытка"),
        (22, "двадцать две попытки"),
        (25, "двадцать пять попыток"),
        (101, "сто одна попытка"),
        (111, "сто одиннадцать попыток"),
        (1000, "тысяча попыток"),
    ],
)
def test_a_count_agrees_with_a_feminine_noun(count, attempts):
    noun = attempts.split()[-1]
    assert normalize_russian(f"{count} {noun}") == attempts


def test_a_count_agrees_with_masculine_and_neuter_nouns():
    assert normalize_russian("1 агент, 2 агента, 21 агент") == "один агент, два агента, двадцать один агент"
    assert normalize_russian("1 сообщение, 2 сообщения") == "одно сообщение, два сообщения"
    assert normalize_russian("2 минуты, 1 неделя, 2 ошибки") == "две минуты, одна неделя, две ошибки"
    # Words that only begin like a feminine noun stay masculine.
    assert gender_of("командир") == "m" and gender_of("атакующих") == "m"
    assert gender_of("попытк+и") == "f" and gender_of("уведомлений") == "n"


def test_yo_is_kept():
    assert normalize_russian("Всё под контролем, ещё 2 задачи.") == "Всё под контролем, ещё две задачи."


def test_local_stress_and_lexicon_files_add_to_the_shared_ones(tmp_path):
    shared = tmp_path / "stress.json"
    shared.write_text(json.dumps({"phrases": ["зам+ок на двер+и", "Ив+ан"]}, ensure_ascii=False), encoding="utf-8")
    local = tmp_path / "stress.local.json"
    local.write_text(json.dumps({"_comment": "x", "phrases": ["Иван Петр+ович", "+Иван"]}, ensure_ascii=False), encoding="utf-8")
    stress = load_stress(shared, local)
    assert stress.apply("Добро пожаловать, ИВАН ПЕТРОВИЧ. Замок на двери.") == (
        "Добро пожаловать, +Иван Петр+ович. Зам+ок на двер+и."
    )
    # The local phrase replaces the shared one for the same words.
    assert stress.apply("Иван") == "+Иван"
    assert load_stress(shared, tmp_path / "missing.json").apply("Иван") == "Ив+ан"
    assert stress.version != load_stress(shared).version

    lexicon_file = tmp_path / "lexicon.json"
    lexicon_file.write_text(json.dumps({"_comment": "x", "HQ": "штаб", "SOC": "с+ок"}), encoding="utf-8")
    local_lexicon = tmp_path / "lexicon.local.json"
    local_lexicon.write_text(json.dumps({"SOC": "эс оу си"}), encoding="utf-8")
    merged = load_lexicon(lexicon_file, local_lexicon, None)
    assert merged == {"HQ": "штаб", "SOC": "эс оу си"}
    assert lexicon_version(merged) != lexicon_version(load_lexicon(lexicon_file)) and lexicon_version({}) == ""
    assert TEXT_VERSION


def test_the_shipped_lexicons_read_the_greeting_right():
    service = SERVICE_DIR
    stress = load_stress(service / "stress.json")
    lexicon = load_lexicon(service / "lexicon.json")
    assert stress.apply("Система штаба на связи.") == "Система штаба на св+язи."
    assert normalize_russian("ID и IP агента AM7", lexicon) == "ай д+и и ай п+и агента эй эм с+емь"
