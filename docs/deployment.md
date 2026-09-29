# Развёртывание Office3D с Hermes

Пошаговая установка на один сервер с Docker, своим доменом и HTTPS, а также
эксплуатация: копии, наблюдение, обновления, восстановление. Устройство
системы описано в [`hermes-platform.md`](hermes-platform.md), возможности
офиса — в [`hermes-gateway.md`](hermes-gateway.md).

## Что запускается

Все сервисы описаны в `docker-compose.yml`:

| Сервис | Что делает | Снаружи |
| --- | --- | --- |
| `caddy` | HTTPS для вашего домена, сертификат Let's Encrypt | порты 80 и 443 |
| `office3d` | офис: интерфейс, адаптер Hermes, MCP-сервер для агентов, наблюдение | только `127.0.0.1:3000` |
| `hermes` | Hermes Agent: агенты (профили), память, задачи, инструменты | нет |
| `hermes-gate` | пропускает к панели Hermes только запросы с токеном | нет |
| `updater` | обновления Hermes с откатом, ежедневные копии, восстановление | нет |
| `speech` | шлюз речи: голос системы (Silero), единый API речи для офиса (профиль `speech`) | нет |
| `voicestudio` | VoiceStudio: голоса AM7 и операторов, распознавание речи (профиль `speech`) | нет |

Тома, в которых лежат данные:

- `hermes-data` — всё, что хранит Hermes;
- `office3d-state` — настройки офиса, задачи, организация;
- `hermes-backups` — резервные копии;
- `caddy-data` — сертификаты;
- `speech-data`, `voicestudio-data` — модели речи и кэш (их можно не копировать:
  они скачиваются заново).

`docker compose down` их не трогает, а `down -v` удаляет.

## Сервер

- **ОС:** Linux с Docker Engine 24+ и плагином compose; проверено на Ubuntu 24.04.
- **Память:** от 8 ГБ. Лимиты в compose: Hermes 4 ГБ (в его контейнере работают
  браузер, терминал и код агентов), офис 1 ГБ, остальное немного.
- **Процессор:** от 4 vCPU.
- **Диск:** от 60 ГБ SSD. Образ Hermes занимает около 4 ГБ, образы офиса около
  1 ГБ; остальное уходит на данные агентов и копии.
- **Модели** работают у провайдера (OpenRouter, свои ключи) или на отдельной
  машине с видеокартой (см. «Своя модель по адресу» ниже). Самому серверу офиса
  видеокарта не нужна.

## Подготовка

1. **Домен.** Добавьте A-запись (и AAAA, если есть IPv6), например
   `office.example.com`, указывающую на IP сервера. Дождитесь, пока
   `dig +short office.example.com` начнёт отвечать этим адресом.
2. **Файрвол.** Откройте снаружи только 22 (SSH), 80 и 443:

   ```bash
   ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443 && ufw enable
   ```

   Docker публикует только порты caddy и `127.0.0.1:3000`, остальные сервисы
   видны лишь во внутренней сети compose.
3. **Docker:** <https://docs.docker.com/engine/install/>.

## Установка

```bash
git clone https://github.com/mazhievadlan7/Office3D.git
cd Office3D
cp .env.example .env
```

Заполните в `.env` секреты. Каждый — случайная строка, например из
`openssl rand -hex 32`:

```bash
for key in STUDIO_ACCESS_TOKEN HERMES_API_KEY HERMES_DASHBOARD_TOKEN \
           OFFICE3D_HERMES_KEY_SECRET OFFICE3D_UPDATER_TOKEN; do
  printf '%s=%s\n' "$key" "$(openssl rand -hex 32)" >> .env
done
chmod 600 .env
```

Затем задайте в `.env` остальное:

```ini
COMPOSE_PROFILES=https
OFFICE3D_DOMAIN=office.example.com
OFFICE3D_TIMEZONE=Europe/Moscow
# Оповещения: хотя бы один канал (см. «Наблюдение» ниже)
ALERT_NTFY_URL=https://ntfy.sh/<длинное-случайное-имя>
ALERT_HEARTBEAT_URL=https://hc-ping.com/<uuid>
```

Запуск:

```bash
docker compose build          # образы офиса и сервиса обновлений
docker compose up -d
docker compose ps             # все сервисы должны дойти до healthy (1–2 минуты)
```

Откройте `https://office.example.com`: офис перенаправит на страницу входа.
Введите `STUDIO_ACCESS_TOKEN` из `.env` как пароль (и `STUDIO_LOGIN` как логин,
если он задан). Вход держится 30 дней на этом браузере. Если сменить токен,
все входы сбрасываются. После входа система штаба приветствует по имени из
`STUDIO_OWNER_NAME` (или по логину), называет дату, время, непрочитанное,
состояние операций и безопасности.

`STUDIO_ACCESS_TOKEN` — ключ ко всему офису, а через него и к агентам. Храните
его в менеджере паролей.

## Первые шаги в офисе

1. **Модели.** «Настройки офиса» → «Модели и провайдеры»: ключ OpenRouter
   или своего провайдера. Для модели на своей машине откройте агента →
   «Возможности Hermes» → «Своя модель по адресу».
2. **Миссия** на доске задач; автономия и дневной бюджет.
3. **Оповещения:** «Настройки офиса» → «Состояние системы» → «Отправить
   тестовое оповещение».

### Своя модель по адресу

Подходит любой сервер с OpenAI-совместимым API: Ollama, vLLM, LM Studio,
llama.cpp.

- **На этом же сервере:** адрес `http://host.docker.internal:<порт>/v1` (у
  Ollama порт 11434). Сервер модели должен слушать не только `127.0.0.1`.
  У Ollama для этого нужен `OLLAMA_HOST=0.0.0.0`, при этом порт нельзя
  открывать в файрволе.
- **На другой машине:** её адрес. Доступ лучше защитить ключом или закрытой
  сетью, например Tailscale или WireGuard.

Hermes сам проверяет адрес со своей стороны сети и хранит ключ в `.env`
профиля.

## Голос

Штаб говорит и слушает только через открытые движки, которые работают на
вашем сервере или машине, без платных API и ключей:

| Что | Движок | Лицензия |
| --- | --- | --- |
| Голос «Системы штаба» (приветствие) и любой текст, где важно точное ударение | [Silero TTS v5](https://github.com/snakers4/silero-models) + [silero-stress](https://github.com/snakers4/silero-stress) | MIT |
| Голоса AM7 и операторов (синтезированные по описанию, VoxCPM2) | [VoiceStudio](https://github.com/debpalash/VoiceStudio) | AGPL-3.0 |
| Распознавание голосовых команд (GigaAM v3 `e2e_rnnt`, с пунктуацией) + Silero VAD | [GigaAM](https://github.com/salute-developers/GigaAM) через [onnx-asr](https://github.com/istupakov/onnx-asr) | MIT |
| Запасное распознавание (Whisper large-v3) | VoiceStudio | AGPL-3.0 |

Офис обращается к одному **шлюзу речи** (`services/speech`, наш код, MIT) по
`SPEECH_GATEWAY_URL` — OpenAI-совместимый API:

```
office3d ──► шлюз речи :8765 ──► Silero, GigaAM + Silero VAD (в самом шлюзе, CPU)
                  │
                  └────────────► VoiceStudio :3900 (голоса voicestudio:*; запасное распознавание)
```

- `GET /v1/voices` — голоса `silero:<диктор>` и `voicestudio:<имя>` с ролями
  (`system`, `lead`, `crew`); список и роли задаёт
  `services/speech/voices.json`, произношение имён — `services/speech/lexicon.json`.
- `POST /v1/audio/speech` — речь (`mp3`, `wav`, `opus`, `flac`, `pcm`). Silero
  ставит ударения моделью silero-stress, текст режется по предложениям,
  48 кГц, одинаковые фразы берутся из кэша.
- `POST /v1/audio/transcriptions` — распознавание в самом шлюзе: GigaAM v3
  (русский, с пунктуацией) на CPU. Запись любого формата браузера (WebM/Opus,
  Ogg, MP4/AAC, WAV) декодируется через PyAV, Silero VAD отрезает тишину по
  краям (запись без речи даёт пустой текст, а не выдуманную фразу) и режет
  длинную речь по паузам на куски до 20 с. Модель загружается один раз при
  старте и остаётся в памяти. Форматы ответа — `json`, `text`, `verbose_json`,
  `srt`, `vtt`. `model=voicestudio` или язык не `ru` — запрос уходит в Whisper
  VoiceStudio; туда же, если GigaAM не установлен или не смог загрузиться
  (`SPEECH_STT_FALLBACK=0` это отключает). Какой движок ответил — в заголовке
  `X-Speech-STT-Engine`.
- `GET /health` — готовность движков (`silero`, `stt`, `voicestudio` с
  состоянием прогрева).

При старте шлюз прогревает всё: GigaAM (секунды), Silero и — одной фразой
голосом AM7 — VoxCPM2 в VoiceStudio, чтобы первая реплика AM7 не ждала
загрузки модели (около полутора минут). `npm run speech` запускает VoiceStudio с
`OMNIVOICE_SIDECAR_IDLE_TIMEOUT_S=0`: VoxCPM2 остаётся в видеопамяти, а не
выгружается через 5 минут тишины. Браузер запрашивает речь по предложениям
(`src/lib/voice/speechChunks.ts`): первое предложение звучит, пока рендерятся
следующие.

Если VoiceStudio недоступен или не успел ответить, у каждого голоса AM7 и
операторов есть запасной голос Silero (`fallback` в `voices.json`) — штаб не
замолкает. Системного голоса браузера или ОС нет и не будет.

Шлюз слушает только `127.0.0.1` (в контейнере — только внутреннюю сеть
compose, порт не публикуется). VoiceStudio запускается без изменений, отдельным
процессом, и общается со шлюзом по HTTP: его код не встраивается в офис.

### Локально (разработка)

Один раз установите движки — они ставятся **вне репозитория**, по умолчанию в
`%LOCALAPPDATA%\office3d-speech` (Windows) или `~/.local/share/office3d-speech`
(Linux, macOS); другое место — `OFFICE3D_SPEECH_HOME` в `.env`. Нужны Python
3.11+, git и [uv](https://docs.astral.sh/uv/); видеокарта NVIDIA необязательна
(колёса CUDA 12.8 подходят и для RTX 50xx).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\speech-setup.ps1
```

```bash
bash scripts/speech-setup.sh
```

Скрипт создаёт venv шлюза и скачивает Silero и GigaAM v3 с Silero VAD (около
0,9 ГБ, в `<OFFICE3D_SPEECH_HOME>/hf`), клонирует VoiceStudio
(`VOICESTUDIO_REF`, по умолчанию `v0.5.6`) без настольного приложения, ставит
его backend через `uv sync`, устанавливает движок VoxCPM2 в его собственный
venv, скачивает веса VoxCPM2 и запасного Whisper large-v3 (всего около 20 ГБ).
Повторный запуск обновляет установку. Ключи `-SkipVoxcpm2`/`SKIP_VOXCPM2=1`,
`-SkipAsr`/`SKIP_ASR=1` (без Whisper: распознаёт GigaAM, запасного пути нет),
`-AsrModel`/`ASR_MODEL` и `-SkipVoiceStudio`/`SKIP_VOICESTUDIO=1` сокращают
установку. Уже установленному шлюзу модель распознавания докачивает
`python -m speech_gateway.tools prefetch-stt` (из `services/speech`, python из
`gateway-venv`, после `uv pip install -r requirements-<cpu|cu128>.txt`).

Запуск рядом с `npm run dev` (оба сервиса останавливаются вместе по Ctrl+C):

```bash
npm run speech
npm run speech:check   # Silero, VoxCPM2 и распознавание, с временем ответа
```

Замеры на RTX 5060 8 ГБ + Ryzen 5 5600 (6 ядер), всё прогрето:

| Что | Время |
| --- | --- |
| Распознавание команды 3 с (GigaAM, CPU, 4 потока, через HTTP) | ≈ 0,2 с; WebM/Opus 16 кбит/с с шумом — ≈ 0,25 с |
| Распознавание 8–11 с | ≈ 0,5–0,6 с |
| Загрузка GigaAM | ≈ 1,6 с отдельно, ≈ 8 с при старте рядом с Silero и VoiceStudio |
| Прежний путь: Whisper large-v3 в VoiceStudio рядом с VoxCPM2 | 6–20 с, холодный — до минуты |
| Загрузка VoxCPM2 (теперь — при старте шлюза) | ≈ 100 с |
| Ответ AM7 из двух предложений (70 символов) | первый звук через ≈ 4 с вместо ≈ 7 с |
| Брифинг AM7 (126 символов) | первый звук через ≈ 9 с вместо ≈ 20 с |

Если веса VoxCPM2 ещё не скачаны (установка с `-SkipVoxcpm2`, а движок
поставлен позже), первая фраза AM7 скачивает их: пока они качаются, он говорит
запасным голосом Silero. На Windows не запускайте установку из
упакованного (MSIX) приложения: его запись в `%LOCALAPPDATA%` видна только ему —
в таком случае задайте `OFFICE3D_SPEECH_HOME` вне `AppData`.

### На сервере: docker compose

Оба сервиса описаны в `docker-compose.yml` под профилем `speech`:

```bash
# в .env: COMPOSE_PROFILES=https,speech
docker compose build speech
docker compose up -d
# один раз: движок VoxCPM2 (изнутри контейнера — это loopback VoiceStudio)
docker compose exec voicestudio curl -fsS -X POST http://127.0.0.1:3900/engines/sidecar/voxcpm2/install
# необязательно: веса запасного Whisper (распознаёт GigaAM в шлюзе, он скачается сам в том speech-data)
docker compose exec voicestudio curl -fsS -X POST http://127.0.0.1:3900/models/install \
  -H 'Content-Type: application/json' -d '{"repo_id":"Systran/faster-whisper-large-v3","target":"local"}'
# веса VoxCPM2 скачаются при прогреве шлюза (до тех пор говорит запасной голос Silero)
```

Чтобы VoxCPM2 не выгружался из видеопамяти через 5 минут тишины, добавьте
сервису `voicestudio` переменную `OMNIVOICE_SIDECAR_IDLE_TIMEOUT_S: "0"`
(например, в `docker-compose.override.yml`). В контейнере шлюза GigaAM в полной
точности занимает около 1 ГБ памяти сверх Silero; при лимите памяти в 3 ГБ и
тесном сервере задайте `SPEECH_STT_QUANTIZATION=int8` (около 0,35 ГБ).

`office3d` находит шлюз по `SPEECH_GATEWAY_URL=http://speech:8765` (значение по
умолчанию в compose). С видеокартой NVIDIA и NVIDIA Container Toolkit добавьте
`docker-compose.speech-gpu.yml`:

```bash
docker compose -f docker-compose.yml -f docker-compose.speech-gpu.yml up -d
```

`VOICESTUDIO_API_KEY` (необязательно) закрывает VoiceStudio ключом: шлюз
передаёт его как `Bearer`. Без него VoiceStudio открыт только внутренней сети
`speech`.

### На сервере без Docker: systemd

После `bash scripts/speech-setup.sh` от имени пользователя `office3d`
(`OFFICE3D_SPEECH_HOME=/opt/office3d-speech`, репозиторий в `/opt/Office3D`):

```ini
# /etc/systemd/system/office3d-voicestudio.service
[Unit]
Description=Office3D speech: VoiceStudio backend
After=network-online.target

[Service]
User=office3d
WorkingDirectory=/opt/office3d-speech/voicestudio
Environment=OMNIVOICE_DATA_DIR=/opt/office3d-speech/voicestudio-data
Environment=HF_HOME=/opt/office3d-speech/hf
Environment=OMNIVOICE_BIND_HOST=127.0.0.1
Environment=OMNIVOICE_PORT=3900
# VoxCPM2 остаётся в видеопамяти (иначе выгружается через 5 минут тишины)
Environment=OMNIVOICE_SIDECAR_IDLE_TIMEOUT_S=0
ExecStart=/opt/office3d-speech/voicestudio/.venv/bin/python backend/main.py
Restart=on-failure
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/office3d-speech.service
[Unit]
Description=Office3D speech gateway (Silero, GigaAM + VoiceStudio)
After=network-online.target office3d-voicestudio.service
Wants=office3d-voicestudio.service

[Service]
User=office3d
WorkingDirectory=/opt/Office3D/services/speech
Environment=OFFICE3D_SPEECH_HOME=/opt/office3d-speech
Environment=HF_HOME=/opt/office3d-speech/hf
Environment=SPEECH_HOST=127.0.0.1
Environment=SPEECH_PORT=8765
Environment=VOICESTUDIO_URL=http://127.0.0.1:3900
ExecStart=/opt/office3d-speech/gateway-venv/bin/python -m speech_gateway
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now office3d-voicestudio office3d-speech
curl -s http://127.0.0.1:8765/health
```

Если сам офис работает в Docker, а шлюз — на хосте, укажите
`SPEECH_GATEWAY_URL=http://host.docker.internal:8765` и запустите шлюз с
`SPEECH_HOST` на адресе docker-моста и `SPEECH_ALLOW_NON_LOOPBACK=1`, закрыв
порт файрволом.

### Сервер без видеокарты

Silero работает быстрее реального времени на 2–4 ядрах (`SILERO_THREADS`), так
что голос системы и запасные голоса есть всегда. VoxCPM2 на CPU медленный: на
таком сервере ставьте `SKIP_VOXCPM2=1` — AM7 и операторы будут говорить своими
запасными голосами Silero, либо назначьте им голоса `silero:*` в
`voices.json`. Распознавание (GigaAM) и так работает на CPU (`SPEECH_STT_THREADS`),
видеокарта ему не нужна.

### Видеокарта на 8 ГБ

VoxCPM2 держит в видеопамяти около 6 ГБ. Раньше распознавание шло через
Whisper large-v3 в VoiceStudio: рядом с VoxCPM2 он не помещался, уходил на CPU
и загружался заново на каждый запрос (около 20 с на команду), а после работы на
GPU процесс VoiceStudio удерживал ещё ~4 ГБ видеопамяти, из-за чего VoxCPM2
замедлялся. Теперь распознаёт GigaAM в шлюзе на CPU, видеокарта целиком
отдана голосам. Модель Whisper поменьше (`ASR_MODEL_WHISPERX=medium` или
`turbo`) этого не исправляет: VoiceStudio загружает её заново на каждый запрос,
и одна загрузка large-v3 по его журналу занимает 7–8 с.

### Голоса и обработка

Кто каким голосом говорит, задаёт `services/speech/voices.json`:

- «Система штаба» — `silero:system` (Silero `eugene`, самый низкий голос Silero,
  точные ударения, мгновенно на CPU);
- AM7 и восемь операторов (шесть мужских, два женских) — голоса, созданные
  дизайном голоса VoxCPM2 по английскому описанию с фиксированным seed. Каждый
  один раз записан в короткий эталон (`services/speech/voice-refs/*.flac`,
  синтетический голос, не запись человека); шлюз заводит по нему профиль в
  VoiceStudio и клонирует его на каждой реплике, поэтому тембр не «плывёт» от
  фразы к фразе. У каждого свой запасной голос Silero (`fallback`), все
  разные;
- `fx` — обработка «гуманоидного ИИ», которую шлюз накладывает после синтеза и
  до кэша (numpy, одинаково на любом CPU): `humanoid` (на 2 полутона ниже,
  лёгкий фленджер, короткое эхо) у системы и AM7, `humanoid-light` (на
  полутон ниже, едва заметный фленджер) у команды, `none` — без обработки.
  Браузер играет звук как есть.

Свой эталон для сервера можно положить в `<OFFICE3D_SPEECH_HOME>/voice-refs/`
с тем же именем файла: он важнее файла из репозитория. Без эталона голос
создаётся по описанию (тембр между репликами менее стабилен).

### Реплики команды в штабе

Когда камера подходит к тем, кто разговаривает (в лаунже, соседи за столами),
слышны настоящие короткие реплики каждого своим голосом: вопросы и ответы о
скоупе, находках, отчётах, учениях на полигоне
(`src/features/hq/render/audio/crewScript.ts`). Их нужно один раз озвучить
при запущенном `npm run speech`:

```bash
npm run voice:bank            # все голоса команды и AM7; можно прервать и продолжить
npm run voice:bank -- --check # сколько готово
```

Файлы лежат вне репозитория (`OFFICE3D_VOICE_BANK_DIR`), офис отдаёт их по
`/api/office/voice/bank`. Пока банка нет, в штабе слышен синтезированный гул
голосов. Субтитров над говорящими по умолчанию нет (голос, а не текст); их
можно включить в браузере: `localStorage["office3d.hq.captions"] = "on"`.

### Настройки

| Переменная | Где | Значение по умолчанию |
| --- | --- | --- |
| `SPEECH_GATEWAY_URL` | офис | `http://127.0.0.1:8765` |
| `OFFICE3D_SYSTEM_VOICE` | офис | `silero:system` — голос «Системы штаба» (Silero Евгений с обработкой humanoid) |
| `OFFICE3D_TTS_VOICE` | офис | `voicestudio:am7` — голос AM7, если в настройках не выбран другой |
| `OFFICE3D_STT_LANGUAGE` | офис | `ru` |
| `OFFICE3D_VOICE_BANK_DIR` | офис, `npm run voice:bank` | `<OFFICE3D_SPEECH_HOME>/voice-bank` — заранее озвученные реплики команды |
| `OFFICE3D_SPEECH_HOME` | установка, `npm run speech`, шлюз | см. выше |
| `SPEECH_PORT`, `SPEECH_DEFAULT_VOICE` | шлюз | `8765`, `silero:aidar` |
| `VOICESTUDIO_URL`, `VOICESTUDIO_MODEL`, `VOICESTUDIO_TIMEOUT_S`, `VOICESTUDIO_BACKOFF_S` | шлюз | `http://127.0.0.1:3900`, `voxcpm2`, `90`, `60` (после сбоя VoiceStudio столько секунд говорят запасные голоса) |
| `SILERO_MODEL`, `SILERO_CIS_MODEL`, `SILERO_DEVICE`, `SILERO_THREADS` | шлюз | `v5_5_ru`, `v5_cis_base` (голоса `ru_*` для запасных голосов команды, MIT; скачивается при первом использовании), `cpu`, `4` |
| `SPEECH_STRESS_FILE` | шлюз | `services/speech/stress.json` — фразы с ударениями (`+`) для омографов в репликах офиса |
| `SPEECH_STT_ENGINE` | шлюз | `gigaam` (или `voicestudio` — всё распознаёт Whisper VoiceStudio) |
| `SPEECH_STT_MODEL`, `SPEECH_STT_QUANTIZATION`, `SPEECH_STT_THREADS` | шлюз | `gigaam-v3-e2e-rnnt` (или `gigaam-v3-e2e-ctc`), пусто (полная точность; `int8` — в 4 раза меньше памяти), `4` |
| `SPEECH_STT_VAD`, `SPEECH_STT_FALLBACK`, `SPEECH_STT_MODEL_DIR` | шлюз | `1`, `1` (без GigaAM — в VoiceStudio), пусто (веса из `HF_HOME`; каталог — для установки без сети) |
| `SPEECH_WARMUP`, `SPEECH_VOICESTUDIO_WARMUP`, `SPEECH_VOICESTUDIO_WARMUP_TIMEOUT_S` | шлюз | `1`, `1`, `600` — прогрев моделей при старте |
| `OMNIVOICE_SIDECAR_IDLE_TIMEOUT_S` | `npm run speech` → VoiceStudio | `0` — VoxCPM2 не выгружается |
| `SPEECH_CACHE`, `SPEECH_CACHE_MAX_MB` | шлюз | `1`, `512` |

Тесты шлюза не требуют моделей:

```bash
cd services/speech
python -m pip install -r requirements-dev.txt
python -m pytest
```

## Резервные копии

Каждый день в `BACKUP_TIME` (по умолчанию 03:30 по `BACKUP_TIMEZONE`, иначе по
`OFFICE3D_TIMEZONE`) сервис `updater` делает копию. Хранятся последние
`BACKUP_KEEP` штук (по умолчанию 7). Копия состоит из трёх файлов:

- `hermes.zip` — собственный архив Hermes (`hermes backup`): профили, память,
  сессии, навыки, задачи, `.env`. Базы SQLite Hermes копирует на ходу,
  останавливать его не нужно;
- `office3d-state.tar.gz` — состояние офиса;
- `manifest.json` — версия Hermes, размеры и контрольные суммы.

Если сервер был выключен в назначенное время, пропущенная копия делается
вскоре после запуска. Копия и обновление Hermes никогда не идут одновременно.

```bash
scripts/office3d-backup.sh list            # копии и расписание
scripts/office3d-backup.sh now             # сделать сейчас
scripts/office3d-backup.sh restore <id>    # вернуться к копии (спросит подтверждение)
```

При восстановлении офис:

1. сверяет контрольные суммы;
2. делает копию текущего состояния (метка `pre-restore`);
3. останавливает офис и Hermes;
4. заменяет их данные данными из копии;
5. запускает всё снова.

Если на каком-то шаге ошибка, прежние данные возвращаются на место до
запуска.

**Копии содержат ключи API.** Поэтому файлы доступны только владельцу. На том
же диске копия спасает от ошибок и неудачных обновлений, но не от потери
сервера. Регулярно уносите копии с сервера в зашифрованном виде, например
restic в любое S3-хранилище:

```bash
# один раз
export RESTIC_REPOSITORY=s3:https://<endpoint>/<bucket>/office3d RESTIC_PASSWORD=<надёжный пароль>
restic init
# ежедневно (cron на хосте, после BACKUP_TIME)
restic backup "$(docker volume inspect -f '{{ .Mountpoint }}' office3d_hermes-backups)/daily"
restic forget --keep-daily 14 --keep-weekly 8 --prune
```

Имя тома начинается с имени проекта compose (по умолчанию это имя каталога).

## Наблюдение и оповещения

Офис каждую минуту проверяет:

- Hermes и его панель;
- сервис обновлений;
- свежесть копий: тревога, если последняя копия не удалась или удачной нет
  больше 26 часов;
- свободное место на диске: тревога, если осталось меньше 2 ГБ или 5%.

Отдельно, по одному разу на каждое событие, приходят:

- откат или сбой обновления Hermes;
- исчерпанный дневной бюджет.

Как работают тревоги:

- проблема засчитывается, если проверка не прошла два раза подряд;
- напоминание приходит раз в 12 часов, пока проблема не устранена;
- когда всё восстановилось, приходит отдельное сообщение.

Каналы оповещений задаются в `.env`:

- **`ALERT_NTFY_URL`** — пуш на телефон через приложение ntfy. Имя темы на
  ntfy.sh — единственный секрет, поэтому делайте его длинным и случайным.
- **`ALERT_SMTP_URL`, `ALERT_EMAIL_TO`** — почта. Для Gmail нужен пароль
  приложения, а `@` в имени пользователя записывается как `%40`.
- **`ALERT_HEARTBEAT_URL`** — внешний сторож, например healthchecks.io. Офис
  отмечается у него каждые 5 минут. Если сервер упал целиком, отметки
  прекращаются, и сторож сам сообщает об этом: изнутри упавшего сервера
  сообщить уже некому.

Картина видна в «Настройки офиса» → «Состояние системы». Логи смотрите
командой `docker compose logs -f office3d` (и так же для `hermes`, `updater`,
`caddy`). Их размер ограничен в compose.

## Обновления

- **Hermes.** Офис сам предлагает новую версию: кнопки «Обновить» и
  «Позже». Сервис `updater` сохраняет данные, переключает версию, проверяет её
  и при неудаче откатывается. Подробности — в
  [`hermes-gateway.md`](hermes-gateway.md).
- **Офис:**

  ```bash
  scripts/office3d-backup.sh now
  git pull
  docker compose build && docker compose up -d
  ```

- **Откат офиса:** `git checkout <прежний коммит>`, затем снова `build` и
  `up -d`. Состояние офиса при этом не меняется. Если новая версия успела
  изменить данные, восстановите копию, сделанную до обновления.
- **Готовые образы из CI:** CI публикует `ghcr.io/mazhievadlan7/office3d` и
  `office3d-updater` с тегом `main` и с неизменяемым тегом коммита
  `sha-<12 символов>`. Чтобы брать их вместо локальной сборки:
  1. войдите: `docker login ghcr.io` с токеном `read:packages` (репозиторий
     приватный);
  2. замените `build` на `image: ghcr.io/…:sha-…` в `office3d`, `hermes-gate`
     и `updater`.

## Безопасность

- **Что видно снаружи.** Снаружи открыты только caddy (80/443) и SSH. Панель
  Hermes, его API, MCP-сервер офиса и сервис обновлений доступны лишь во
  внутренних сетях.
- **Три внутренние сети.**
  - `backend`: офис и Hermes, где работают инструменты агентов;
  - `edge`: caddy и офис;
  - `control`: офис и сервис обновлений.

  Из контейнера Hermes сервис обновлений не виден. Здоровье Hermes сервис
  обновлений проверяет по состоянию контейнеров в Docker.
- **Токен входа** должен быть не короче 32 символов, иначе офис не
  запустится на публичном адресе.
- **Подбор токена.** Неверные попытки считаются по адресу клиента (10 в
  минуту) и по всем адресам сразу (100 в минуту). Заголовку
  `X-Forwarded-For` офис верит только от caddy (`TRUSTED_PROXY_HOSTS`), а не
  от любого контейнера сети.
- **WebSocket** принимается только со страниц самого офиса (Origin равен
  Host). Другой разрешённый адрес можно добавить в `OFFICE3D_ALLOWED_ORIGINS`.
- **Без токена** (локальный запуск) офис слушает только loopback и отвечает
  только на адреса `localhost`/`127.0.0.1`. Это защищает от подмены DNS
  (DNS rebinding).
- **Сервис обновлений** — единственный контейнер с доступом к Docker (это
  права root на хосте). Он не опубликован, принимает только токен офиса, а
  восстановление — только изнутри своего контейнера.
- **Серверы-программы MCP** из офиса запускаются внутри контейнера Hermes с его
  правами. Добавляйте только программы, которым доверяете.
- **Остаточные риски, о которых стоит знать:**
  - вход действует 30 дней, а выход из всех браузеров сразу возможен только
    сменой токена;
  - политика CSP страниц офиса разрешает встроенные скрипты (так требует
    Next.js);
  - образы закреплены тегами, а не хешами;
  - сотрудник с набором «терминал» может читать `.env` и `config.yaml`
    своего профиля Hermes (так Hermes изолирует профили). Там лежат токены
    MCP-серверов и секреты своих OAuth-клиентов, если вы их задали.
- **Смена токена входа.** Замените `STUDIO_ACCESS_TOKEN` в `.env` и выполните
  `docker compose up -d office3d`: все входы сбросятся. Остальные секреты
  меняются так же, после чего перезапустите все сервисы.

## Устранение неполадок

**`docker compose ps` показывает `unhealthy` у office3d.** Посмотрите
`docker compose logs office3d`. Офис ждёт Hermes, пока тот запускается, и
сообщает, если конфигурация неверна.

**caddy перезапускается с сообщением «Set OFFICE3D_DOMAIN».** В `.env` не
задан домен. Если в логе caddy ошибки ACME, значит домен ещё не указывает на
сервер или закрыты порты 80 и 443.

**Офис висит на «Подключение…».** Проверьте `docker compose ps` и «Состояние
системы». Если перед caddy стоит ещё один прокси, он должен пропускать
WebSocket.

**Вход в MCP-сервер через OAuth: сервис ругается на адрес возврата.** Офис
передаёт сервису адрес `<адрес офиса>/oauth/mcp/<сервер>`, где адрес офиса —
тот, на котором он открыт. Если офис открывают по нескольким именам, задайте
в `.env` `OFFICE3D_PUBLIC_URL=https://<домен>` и перезапустите office3d. Для
своего OAuth-клиента этот же адрес должен быть указан у сервиса.

**Нет оповещений.** «Состояние системы» показывает, какие каналы настроены и
в чём ошибки настройки. Там же есть кнопка тестового оповещения.

**Сборка предупреждает `Can't resolve 'openclaw'`.** Это ожидаемо: пакет
`openclaw` подключается при работе и в сборку не входит.

**Вернуться на OpenClaw.** См. раздел «Откат на OpenClaw» в
[`hermes-gateway.md`](hermes-gateway.md).
