# Settings

Health Diary reads its settings from the `.env` file next to `docker-compose.yml`.
After a change, restart the app: `docker compose up -d`.

## The settings

| Setting | Needed | Default | What it does |
|---|---|---|---|
| `TZ` | Yes | `UTC` | Your time zone, for example `Europe/Zurich`. A day starts at midnight in this zone. |
| `PUID` | Yes | `1000` | The user that owns `./data`. Run `id -u` on the server to find it. |
| `PGID` | Yes | `1000` | The group that owns `./data`. Run `id -g` on the server to find it. |
| `DIARY_SECRET_KEY` | Recommended | a file in `./data` | The key that encrypts documents and Paperless tokens. See [Secret key](#secret-key). |
| `PAPERLESS_URL` | Only for Paperless | | The Paperless address, as the container reaches it. |
| `PAPERLESS_PUBLIC_URL` | No | `PAPERLESS_URL` | The Paperless address for links on your devices. |
| `FORWARDED_ALLOW_IPS` | Only behind a proxy | `127.0.0.1` | The proxy address. See [Reverse proxy](#reverse-proxy). |

Each user sets their own Paperless token and tags in the app: **Profile → Settings → Paperless**.

## Secret key

The app encrypts uploaded documents and Paperless tokens with this key.

1. Make a key:

   ```sh
   openssl rand -base64 32
   ```

2. Put it in `.env`: `DIARY_SECRET_KEY=<the key>`.
3. Keep a copy of the key in a safe place, apart from your backups.

If you do not set a key, the app makes one in `./data/secret.key`.

> **Caution:** if you lose the key, the uploaded documents cannot be read again.

## Paperless

1. Set `PAPERLESS_URL`. Use an address that the container can reach, for example
   `http://192.168.1.10:8000`. A `*.ts.net` address can fail inside a container.
2. Set `PAPERLESS_PUBLIC_URL` to the address you use on your devices, for example
   `https://paperless.<your-tailnet>.ts.net`. The "Open in Paperless" links use it.
3. Each user saves a Paperless API token in **Profile → Settings → Paperless**.
   Use a Paperless user that can read only your medical documents.

## Reach the app

The app listens on port 8000 in the container. It needs HTTPS.

- **Docktail:** keep the `docktail.*` labels in `docker-compose.yml`. The app is at
  `https://health-diary.<your-tailnet>.ts.net`.
- **Tailscale without Docktail:** publish the port to the server only, then use `tailscale serve`:

  ```yaml
  ports: ["127.0.0.1:8000:8000"]
  ```

  ```sh
  tailscale serve --bg --https=443 http://127.0.0.1:8000
  ```

- **Other reverse proxy:** forward HTTPS to port 8000. Then set `FORWARDED_ALLOW_IPS`.

## Reverse proxy

A proxy (Docktail, `tailscale serve`, nginx, Caddy, Traefik) connects to the app for your devices.
The app then sees the proxy address, not the device address. The app uses the device address to
slow down password guessing.

1. Open the app once in a browser.
2. Run `docker logs health-diary`. Each request line starts with the address that connected,
   for example `172.18.0.5:41234`.
3. Put this address in `.env`: `FORWARDED_ALLOW_IPS=172.18.0.5`.

> **Warning:** never set `FORWARDED_ALLOW_IPS=*`. Then anyone can give a false address.

If you do not set it, the app still works. All users then share the proxy address: wrong passwords
of one person can slow down the login of the same username for all.
