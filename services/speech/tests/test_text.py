from speech_gateway.text import chunk_text, latin_to_russian, normalize_russian, split_sentences, ssml_rate


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
