# Развёртывание Office3D

Office3D — это Next.js-приложение, которое обслуживает собственный Node-сервер
(`server/index.js`); он же проксирует WebSocket-трафик к шлюзу OpenClaw на том же
origin. Базы данных нет. Нужен Node 22+ (или образ контейнера), а для любого
развёртывания не на loopback-интерфейсе — токен доступа.

Здесь описано развёртывание в Docker на одном хосте за обратным прокси.

## Прежде чем начать

Office3D — это фронтенд. Он показывает агентов из работающего **шлюза OpenClaw**
(или Hermes, или встроенного демо-шлюза). Без шлюза интерфейс загружается и
показывает форму подключения к шлюзу — это ожидаемо, а не сбой. Решите, где будет
работать шлюз, до развёртывания: приложение должно до него дотягиваться.

## Обязательная настройка

| Переменная | Обязательна | Назначение |
| --- | --- | --- |
| `STUDIO_ACCESS_TOKEN` | **Да, при любой публичной привязке** | Закрывает доступ к приложению. |
| `HOST` | Да, в контейнерах | `0.0.0.0`; значение по умолчанию `127.0.0.1` недоступно снаружи контейнера. |
| `PORT` | Нет | По умолчанию `3000`. |
| `OPENCLAW_STATE_DIR` | Нет | Куда записываются настройки, загрузки и задачи. В образе — `/data`. |
| `OFFICE3D_GATEWAY_URL` | Нет | URL шлюза во время работы. Применяется при перезапуске, без пересборки. |
| `OFFICE3D_GATEWAY_TOKEN` | Нет | Токен шлюза, если шлюз его требует. |
| `OFFICE3D_GATEWAY_ADAPTER_TYPE` | Нет | Одно из `openclaw`, `hermes`, `demo`, `custom`. |
| `NEXT_PUBLIC_GATEWAY_URL` | Нет | Зашивается во время **сборки**; для изменения нужна пересборка. Лучше используйте `OFFICE3D_GATEWAY_URL`. |

`STUDIO_ACCESS_TOKEN` обязателен на деле, а не на словах: `server/network-policy.js`
отказывается привязываться к публичному хосту без него, и процесс завершается с
сообщением

```
Refusing to bind Studio to public host "0.0.0.0" without STUDIO_ACCESS_TOKEN.
```

Сгенерируйте токен командой `openssl rand -hex 32` и не храните его в git — `.env`
уже в игнор-списке.

## Развёртывание

```bash
git clone https://github.com/mazhievadlan7/Office3D.git
cd Office3D
cp .env.example .env
printf 'STUDIO_ACCESS_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
docker compose up -d
docker compose ps        # STATUS должен дойти до "healthy"
```

Compose публикует приложение только на `127.0.0.1:3000`. Открывайте доступ через
обратный прокси, а не привязывайте приложение напрямую к публичному интерфейсу.

### Запуск образа, собранного в CI

Рабочий процесс `Docker Publish` отправляет образ в `ghcr.io/mazhievadlan7/office3d`.
Поскольку репозиторий приватный, **образ тоже приватный**, и анонимный
`docker pull` не сработает. На сервере войдите с токеном, у которого есть право
`read:packages`:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u mazhievadlan7 --password-stdin
```

Затем замените `build: .` на `image: ghcr.io/mazhievadlan7/office3d:main` в
`docker-compose.yml`.

## Обратный прокси и TLS

Подключение к шлюзу — это WebSocket на том же origin, по адресу
`/api/gateway/ws`. Если прокси не передаёт заголовки upgrade, интерфейс зависнет
на подключении без явной ошибки. Для nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Сессии агентов простаивают между сообщениями; таймаут по умолчанию 60s их закрывает.
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

Завершайте TLS на прокси (подойдут и Caddy, и certbot). При работе по обычному
HTTP на публичном адресе `STUDIO_ACCESS_TOKEN` будет передаваться открытым текстом.

## Состояние и резервные копии

Всё, что стоит сохранять, лежит в томе `office3d-state`: `settings.json`,
`uploads/` и `task-manager/tasks.json`. Том переживает `docker compose down`, но
не `down -v`.

```bash
# Резервная копия
docker run --rm -v office3d-state:/data -v "$PWD:/backup" alpine \
  tar czf /backup/office3d-state-$(date +%F).tar.gz -C /data .

# Восстановление
docker run --rm -v office3d-state:/data -v "$PWD:/backup" alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/office3d-state-YYYY-MM-DD.tar.gz -C /data'
```

Делайте резервную копию перед каждым обновлением. Файлы маленькие — пропускать этот
шаг нет оправданий.

## Состояние и мониторинг

`GET /api/health` возвращает `{"ok":true,"service":"office3d"}` — именно его
опрашивает `HEALTHCHECK` образа. Направьте на него и внешнюю проверку: контейнер
может быть `healthy`, даже когда прокси перед ним сломан.

Логи идут в stdout, и compose ограничивает их размером 3 × 10 МБ:

```bash
docker compose logs -f office3d
```

## Обновление и откат

```bash
git pull
docker compose build
docker compose up -d
```

Образы получают тег по ветке, а релизы — `vX.Y.Z` и `latest`. Чтобы откатиться,
закрепите предыдущий тег в `docker-compose.yml` и снова выполните
`docker compose up -d`. Ни обновление, ни откат не трогают том состояния, так что
откат стоит только перезапуска.

## Устранение неполадок

**Контейнер сразу завершается, в логе упоминается публичный хост.**
`STUDIO_ACCESS_TOKEN` не задан. Это описанная выше защита, и она работает как
задумано.

**Интерфейс загружается, но показывает форму подключения.** Ни один шлюз не
доступен. Проверьте `OFFICE3D_GATEWAY_URL` и то, что шлюз принимает подключения из
контейнера: `localhost` внутри контейнера — это сам контейнер, а не хост.
Используйте `host.docker.internal` или адрес хоста в локальной сети.

**Интерфейс висит на «Подключение…».** Почти всегда дело в обратном прокси, который
не передаёт WebSocket upgrade. См. блок nginx выше.

**Сборка предупреждает `Can't resolve 'openclaw'`.** Это ожидаемо. Пакет
`openclaw` подключается опционально во время работы и не входит в сборку.
