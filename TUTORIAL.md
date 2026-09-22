# Руководство по настройке Office3D + OpenClaw + Tailscale

Это пошаговая инструкция для самой распространённой конфигурации, близкой к продакшену:

- **Машина A** запускает **шлюз OpenClaw**.
- **Машина B** запускает **Office3D**.
- **Tailscale** безопасно соединяет обе машины.

Если в точности следовать этой инструкции, можно избежать самого частого недоразумения: **Office3D не устанавливает и не запускает OpenClaw за вас.**

---

## 0) Архитектура и зоны ответственности

- **OpenClaw** — это среда выполнения и шлюз.
- **Office3D** — это интерфейс и прокси Studio.
- Office3D подключается к уже запущенному шлюзу OpenClaw.
- В этом руководстве шлюз работает на другой машине, не на той, где Office3D.

---

## 1) Предварительные требования

### Машина A (хост шлюза)

- macOS, Linux или WSL2.
- Доступ в интернет.
- Возможность установить OpenClaw и Tailscale.

### Машина B (хост Office3D)

- Для этого репозитория рекомендуется Node.js `20+`.
- Рекомендуется npm `10+`.
- Доступ в интернет.
- Возможность установить Tailscale.

### Учётные записи и права

- Учётная запись Tailscale для вашего tailnet.
- Если в вашем tailnet включено одобрение устройств, вам нужен доступ Owner/Admin/IT admin в админ-панели Tailscale.

---

## 2) Установка и запуск OpenClaw на машине A

Официальная документация OpenClaw по установке: [Install](https://docs.openclaw.ai/install/index.md) и [Getting Started](https://docs.openclaw.ai/start/getting-started.md).

### 2.1 Установка OpenClaw

На **машине A**:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

### 2.2 Первоначальная настройка и установка демона

```bash
openclaw onboard --install-daemon
```

### 2.3 Проверка состояния шлюза

```bash
openclaw gateway status
openclaw status
```

Нужен здоровый результат: например, среда выполнения запущена, а RPC-проверка проходит успешно (RPC probe ok).

### 2.4 Получение токена шлюза

Этот токен понадобится в Office3D:

```bash
openclaw config get gateway.auth.token
```

Храните его в надёжном месте.

---

## 3) Установка и авторизация Tailscale на обеих машинах

Документация Tailscale: [Serve overview](https://tailscale.com/kb/1312/serve), [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve) и [Device approval](https://tailscale.com/kb/1099/device-approval).

### 3.1 Установка Tailscale

Установите Tailscale на **машину A** и **машину B** с помощью официальных установщиков: [Tailscale downloads](https://tailscale.com/download).

### 3.2 Подключение обеих машин к одному tailnet

На каждой машине:

```bash
tailscale up
tailscale status
```

Убедитесь, что обе машины видны в одном и том же tailnet.

### 3.3 Если tailnet требует одобрения, одобрите устройства

В админ-панели Tailscale:

1. Откройте [Machines](https://login.tailscale.com/admin/machines).
2. Найдите устройства с пометкой **Needs approval**.
3. Одобрите машину A и машину B.

Без этого машины не смогут обмениваться трафиком через tailnet.

---

## 4) Публикация шлюза OpenClaw через Tailscale на машине A

Есть два рабочих способа. Выберите один.

### Вариант A (простой и явный): команда Tailscale Serve

На **машине A** оставьте шлюз привязанным к локальному адресу (`127.0.0.1:18789`) и опубликуйте его через Serve:

```bash
tailscale serve --yes --bg --https=443 http://127.0.0.1:18789
tailscale serve status
```

Примечания:

- Новые версии Tailscale CLI используют `--https=443`.
- В старой документации и командах может встретиться синтаксис вида `--https 443`. Проверьте `tailscale serve --help` для установленной у вас версии.

### Вариант B (режим Tailscale под управлением OpenClaw)

OpenClaw может сам управлять режимом Tailscale:

```bash
openclaw gateway --tailscale serve
```

Документация OpenClaw по Tailscale: [Gateway Tailscale](https://docs.openclaw.ai/gateway/tailscale.md).

### 4.1 Проверка публичного URL в tailnet

Вам нужен хост `https://<gateway-host>.<tailnet>.ts.net`.

Именно его Office3D будет использовать в виде `wss://<gateway-host>.<tailnet>.ts.net`.

---

## 5) Установка и запуск Office3D на машине B

На **машине B**:

```bash
git clone https://github.com/mazhievadlan7/Office3D.git office3d
cd office3d
npm install
cp .env.example .env
npm run dev
```

Затем откройте:

- `http://localhost:3000`

---

## 6) Подключение Office3D к OpenClaw

На экране подключения к шлюзу в Office3D:

1. В поле **Адрес шлюза** укажите:
   - `wss://<gateway-host>.<tailnet>.ts.net`
2. Вставьте в поле **Токен шлюза** токен с машины A (`openclaw config get gateway.auth.token`).
3. Нажмите **Подключиться**.

Важно:

- Для HTTPS-эндпоинтов Tailscale используйте `wss://`.
- Используйте `ws://localhost:18789` только когда шлюз работает на той же машине, что и Office3D, или при подключении через SSH-туннель.

---

## 7) Обязательный шаг: одобрение сопряжения устройства

Этот шаг чаще всего пропускают.

Когда Office3D запущен и впервые пытается подключиться, одобрите ожидающий запрос на сопряжение устройства на **машине A**:

```bash
openclaw devices list
openclaw devices approve --latest
```

Документация OpenClaw по устройствам: [openclaw devices](https://docs.openclaw.ai/cli/devices.md).

Если ожидают несколько запросов, одобряйте по id:

```bash
openclaw devices approve <requestId>
```

---

## 8) Контрольный список проверки

Пройдите этот список по порядку:

1. `openclaw gateway status` на машине A показывает здоровую среду выполнения.
2. `tailscale status` на обеих машинах показывает подключённые устройства в одном tailnet.
3. `tailscale serve status` на машине A показывает активную конфигурацию Serve для порта `443` на `127.0.0.1:18789`.
4. На экране подключения Office3D указан `wss://...ts.net` и действительный токен.
5. После первой попытки подключения выполнена команда `openclaw devices approve --latest`.
6. Интерфейс Office3D показывает, что шлюз подключён, и загружает агентов.

---

## 9) Решение проблем

### `EPROTO` или `wrong version number`

- Обычно означает несоответствие протоколов.
- Решение: если ваш эндпоинт — HTTPS/Tailscale Serve, используйте `wss://...`.
- Не используйте `wss://` для обычного эндпоинта `ws://`.

### `401` или ошибки аутентификации в Office3D

- Скопируйте токен с машины A заново:
  - `openclaw config get gateway.auth.token`.
- Убедитесь, что режим аутентификации шлюза и токен актуальны.

### Office3D не подключается, хотя токен правильный

- Одобрите ожидающее устройство:
  - `openclaw devices approve --latest`.
- Проверьте ожидающие запросы:
  - `openclaw devices list`.

### URL Tailscale нигде не открывается

- Если одобрение устройств включено, убедитесь, что оба устройства одобрены в админ-панели Tailscale.
- Выполните снова:
  - `tailscale status`.
  - `tailscale serve status`.
- При необходимости пересоздайте конфигурацию Serve:
  - `tailscale serve reset`.
  - `tailscale serve --yes --bg --https=443 http://127.0.0.1:18789`.

### Сам шлюз неисправен

- Выполните:
  - `openclaw doctor`.
  - `openclaw gateway restart`.
  - `openclaw gateway status`.

---

## 10) Замечания по безопасности

- Держите шлюз привязанным к loopback-интерфейсу, если у вас нет осознанной причины поступить иначе.
- Не коммитьте токены в git или в файлы `.env`, предназначенные для передачи другим.
- Предпочитайте Tailscale Serve публичному открытию портов шлюза напрямую.
- Относитесь к одобрению сопряжения устройств в OpenClaw как к рубежу безопасности, а не как к разовой помехе.

---

## Ссылки

- Установка OpenClaw: [docs.openclaw.ai/install/index.md](https://docs.openclaw.ai/install/index.md).
- Начало работы с OpenClaw: [docs.openclaw.ai/start/getting-started.md](https://docs.openclaw.ai/start/getting-started.md).
- Инструкция по шлюзу OpenClaw: [docs.openclaw.ai/gateway/index.md](https://docs.openclaw.ai/gateway/index.md).
- CLI устройств OpenClaw: [docs.openclaw.ai/cli/devices.md](https://docs.openclaw.ai/cli/devices.md).
- Режим шлюза OpenClaw с Tailscale: [docs.openclaw.ai/gateway/tailscale.md](https://docs.openclaw.ai/gateway/tailscale.md).
- Tailscale Serve: [tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve).
- CLI Tailscale serve: [tailscale.com/docs/reference/tailscale-cli/serve](https://tailscale.com/docs/reference/tailscale-cli/serve).
- Одобрение устройств в Tailscale: [tailscale.com/kb/1099/device-approval](https://tailscale.com/kb/1099/device-approval).
