# Deploying Office3D

Office3D is a Next.js app served by a custom Node server (`server/index.js`)
that also proxies WebSocket traffic to an OpenClaw Gateway on the same origin.
There is no database. It needs Node 22+ (or the container image) and, for any
non-loopback deployment, an access token.

This describes a single-host Docker deployment behind a reverse proxy.

## Before you start

Office3D is a frontend. It renders agents from a running **OpenClaw Gateway**
(or Hermes, or the built-in demo gateway). Without one the UI loads and shows
the gateway connection form — that is expected, not a failure. Decide where the
gateway runs before deploying, because the app has to reach it.

## Required configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `STUDIO_ACCESS_TOKEN` | **Yes, for any public bind** | Gates access to the app. |
| `HOST` | Yes, in containers | `0.0.0.0`; the default `127.0.0.1` is unreachable from outside the container. |
| `PORT` | No | Defaults to `3000`. |
| `OPENCLAW_STATE_DIR` | No | Where settings, uploads and tasks are written. `/data` in the image. |
| `OFFICE3D_GATEWAY_URL` | No | Runtime gateway URL. Applied on restart, without a rebuild. |
| `OFFICE3D_GATEWAY_TOKEN` | No | Gateway token, if the gateway requires one. |
| `OFFICE3D_GATEWAY_ADAPTER_TYPE` | No | One of `openclaw`, `hermes`, `demo`, `custom`. |
| `NEXT_PUBLIC_GATEWAY_URL` | No | Baked in at **build** time; changing it requires a rebuild. Prefer `OFFICE3D_GATEWAY_URL`. |

`STUDIO_ACCESS_TOKEN` is enforced, not advisory: `server/network-policy.js`
refuses to bind a public host without it and the process exits with

```
Refusing to bind Studio to public host "0.0.0.0" without STUDIO_ACCESS_TOKEN.
```

Generate one with `openssl rand -hex 32` and keep it out of git — `.env` is
already ignored.

## Deploy

```bash
git clone https://github.com/mazhievadlan7/Office3D.git
cd Office3D
cp .env.example .env
printf 'STUDIO_ACCESS_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
docker compose up -d
docker compose ps        # STATUS should reach "healthy"
```

Compose publishes the app on `127.0.0.1:3000` only. Expose it through a reverse
proxy rather than binding it to a public interface directly.

### Running the image built by CI

The `Docker Publish` workflow pushes to `ghcr.io/mazhievadlan7/office3d`.
Because the repository is private, **the image is private too** and an
anonymous `docker pull` will fail. On the server, log in with a token that has
the `read:packages` scope:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u mazhievadlan7 --password-stdin
```

Then swap `build: .` for `image: ghcr.io/mazhievadlan7/office3d:main` in
`docker-compose.yml`.

## Reverse proxy and TLS

The gateway connection is a WebSocket on the same origin, at
`/api/gateway/ws`. A proxy that does not forward the upgrade headers will leave
the UI stuck connecting, with no obvious error. For nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Agent sessions idle between messages; the default 60s closes them.
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

Terminate TLS at the proxy (Caddy or certbot both work). Serving over plain
HTTP on a public address would send `STUDIO_ACCESS_TOKEN` in the clear.

## State and backups

Everything worth keeping lives in the `office3d-state` volume: `settings.json`,
`uploads/` and `task-manager/tasks.json`. It survives `docker compose down` but
not `down -v`.

```bash
# Back up
docker run --rm -v office3d-state:/data -v "$PWD:/backup" alpine \
  tar czf /backup/office3d-state-$(date +%F).tar.gz -C /data .

# Restore
docker run --rm -v office3d-state:/data -v "$PWD:/backup" alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/office3d-state-YYYY-MM-DD.tar.gz -C /data'
```

Back up before every upgrade. The files are small; there is no excuse to skip it.

## Health and monitoring

`GET /api/health` returns `{"ok":true,"service":"office3d"}` and is what the
image's `HEALTHCHECK` polls. Point an external check at it too — a container can
be `healthy` while the proxy in front of it is broken.

Logs go to stdout and are capped at 3 × 10 MB by compose:

```bash
docker compose logs -f office3d
```

## Upgrades and rollback

```bash
git pull
docker compose build
docker compose up -d
```

Images are tagged per branch, and releases as `vX.Y.Z` plus `latest`. To roll
back, pin a previous tag in `docker-compose.yml` and `docker compose up -d`
again. The state volume is untouched by either direction, so a rollback costs
nothing but the restart.

## Troubleshooting

**Container exits immediately, log names a public host.** `STUDIO_ACCESS_TOKEN`
is unset. This is the guard described above, working as intended.

**UI loads but shows the connection form.** No gateway is reachable. Check
`OFFICE3D_GATEWAY_URL` and that the gateway accepts connections from the
container — `localhost` inside a container is the container, not the host. Use
`host.docker.internal` or the host's LAN address.

**UI hangs on "connecting".** Almost always a reverse proxy that is not
forwarding the WebSocket upgrade. See the nginx block above.

**Build warns `Can't resolve 'openclaw'`.** Expected. The `openclaw` package is
resolved optionally at runtime and is not bundled.
