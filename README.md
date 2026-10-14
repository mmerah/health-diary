# Health Diary

A private health diary that you host yourself. You use it from your phone, tablet or computer.
Each day you log meals, drinks, medication, activities, symptoms and measurements. Apple Health data
(sleep, steps, heart rate) comes in from your iPhone. Your medical PDFs come from
[Paperless-ngx](https://docs.paperless-ngx.com/). When you need it, the app makes **one report**
for your doctor, or an **anonymized** version to paste into an AI assistant.

**[Try the demo](https://mmerah.github.io/health-diary/)**. It uses sample data and runs only in your browser.

## Features

- **Today:** meals with times, water, coffee and alcohol, medication checklist, what you did,
  symptoms (mild / moderate / severe, all day, a part of the day or a time), notes, and optional
  weight, blood pressure and temperature.
- **Apple Health:** sleep (with stages), steps, resting heart rate, HRV, workouts and weight, sent by
  an iPhone shortcut. Import your full history once from the Health app export.
- **Documents:** your medical documents from Paperless-ngx (tag `medical`), with their text.
- **Report:** profile, summary (averages, symptom patterns, medication taken), measurements,
  document text and the daily log, in one markdown file. The AI version hides names, date of birth,
  doctor names, contact details and ID numbers, and can replace dates with day numbers.
- **Several users:** each person has their own private diary. Works on phone, tablet and desktop.

## Install

You need Docker. Health Diary has no public sign-up and is made for a private network, for example
[Tailscale](https://tailscale.com/).

1. Make a folder and get the two files:

   ```sh
   mkdir health-diary && cd health-diary
   curl -O https://raw.githubusercontent.com/mmerah/health-diary/main/docker-compose.yml
   curl -o .env https://raw.githubusercontent.com/mmerah/health-diary/main/.env.example
   ```

2. Edit `.env`: your time zone, `PUID`/`PGID` (run `id` to see yours) and, if you use Paperless,
   `PAPERLESS_URL`. Use an address the container can reach, such as the LAN IP and port of Paperless.
3. Make the app reachable. `docker-compose.yml` has labels for
   [Docktail](https://github.com/marvinvr/docktail), which publishes it at
   `https://health-diary.<your-tailnet>.ts.net`. Without Docktail, publish a port
   (see the comment in the file) and put it behind HTTPS, for example with `tailscale serve`.
4. Start it and read the setup code:

   ```sh
   docker compose up -d
   docker logs health-diary
   ```

5. Open the app. Enter the setup code and create the first account. It becomes the administrator.
   The administrator adds other users in **Profile → Users**.

Update: `docker compose pull && docker compose up -d`. Your data in `./data` stays.

## First steps for each user

1. **Profile:** your details and medical history. Each line of "Regular medication" becomes a
   checkbox on the Today screen.
2. **Paperless:** in Profile, save your own Paperless API token. Add the tag `medical` to your
   reports and blood tests in Paperless.
3. **Apple Health history:** on the iPhone, Health app → your picture → **Export All Health Data**.
   Then in the diary: **Profile → Import your history**. The import only fills empty fields.
4. **Daily sync:** create a shortcut key in Profile and build the shortcut:
   [docs/shortcut.md](docs/shortcut.md).

## Security

This app holds health data. Please read this before you install it.

- **Keep it private.** Run it on a private network (Tailscale, VPN, home LAN). Do not open it to the
  internet, and do not use Tailscale Funnel for it.
- **Use HTTPS.** Tailscale (`*.ts.net`) and most reverse proxies do this for you. Behind a reverse
  proxy on another host or container, set `FORWARDED_ALLOW_IPS` to its address. Only then does the
  app read the client address and HTTPS from the proxy headers.
- **Accounts:** passwords are hashed with scrypt. Logins use secure, HttpOnly, SameSite cookies.
  After 5 wrong passwords for one username from one address in 15 minutes, the app waits before it
  accepts more tries from that address. Someone else's wrong guesses cannot lock you out.
  A new password logs out the user's other devices.
- **First account:** only a person with the setup code from the server log can create it. The code
  is long (more than 128 bits), and the number of tries is limited.
- **Administrators:** when an administrator sets a new password for a user, the user sees a notice at
  the next login. User changes are written to the server log. The last administrator cannot be
  removed.
- **Your data:** in Profile, each user can download all their data as a file, and delete their
  account with all their data.
- **Shortcut keys:** each user has a personal key. The server stores only its hash. You can replace
  or turn off a key in Profile. Profile shows when the key was last used.
- **Data isolation:** users never see each other's diaries. Deleting a user deletes their data.
  Deleted data is overwritten in the database file.
- **Checks:** the server checks every request: size, fields and values. Requests from other sites are
  refused. Uploads are limited in size, and zip bombs are refused.
- **Browser:** a strict Content Security Policy. The app loads no outside scripts, fonts or trackers.
- **At rest:** the database is a SQLite file in `./data`, readable only by the app user. Paperless
  tokens in it are encrypted with `DIARY_SECRET_KEY`. The diaries themselves are not encrypted:
  protect the host and its backups (disk encryption, file permissions).
- **Container:** it runs as `PUID:PGID` with a read-only file system, no added privileges and only
  the capabilities that the start script needs to set the owner of `./data`.
- **AI reports:** the anonymization removes the common identifiers, not all of them. Add other words
  (lab or hospital names) in the report settings, and always read a report before you share it.

Found a security problem? Please open a private
[security advisory](https://github.com/mmerah/health-diary/security/advisories/new), not a public issue.

## Backup

Copy the `data` folder. For a safe copy while the app runs:

```sh
docker exec health-diary python -c "import sqlite3; sqlite3.connect('/data/diary.db').backup(sqlite3.connect('/data/backup.db'))"
```

Keep `DIARY_SECRET_KEY` (or `data/secret.key`) too, but not in the same place as the backup.
Without the key, users must save their Paperless token again. With the key next to the backup,
anyone with the backup can read the tokens.

Each user can also download their own data as a JSON file, in Profile.

## Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `TZ` | `UTC` | Time zone. Days start at midnight in this zone. Set it: the log warns if it is missing. |
| `PUID`, `PGID` | `1000` | Owner of `./data`. The app runs as this user. |
| `DIARY_SECRET_KEY` | `data/secret.key` | Key that encrypts the Paperless tokens. Make one with `openssl rand -base64 32`. |
| `PAPERLESS_URL` | | Paperless address, as the container reaches it. |
| `PAPERLESS_PUBLIC_URL` | `PAPERLESS_URL` | Paperless address for links on your devices. |
| `PAPERLESS_TAG` | `medical` | Default tag. Each user can change it. |
| `PAPERLESS_TOKEN` | | Optional token for the first administrator (the oldest administrator account) only. Other users save their own. |
| `SETUP_CODE` | random | Fixed code for the first account. |
| `SESSION_DAYS` | `30` | Days before a login expires. It renews while you use the app. |
| `COOKIE_SECURE` | `auto` | `true` or `false` to force the Secure cookie flag. |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | Addresses of reverse proxies whose `X-Forwarded-*` headers the app trusts. Never `*`. |
| `MAX_IMPORT_MB` | `2048` | Largest Apple Health upload, in MB. |
| `MAX_IMPORT_UNPACKED_MB` | `4096` | Largest size the upload may unpack to, in MB. |

## Development

- `web/`: the front end. Plain HTML, CSS and JavaScript, no build step. Without a server it runs on
  sample data (that is the demo).
- `server/`: FastAPI and SQLite.
- Run it: `docker compose -f docker-compose.yml up --build` after you change `image:` to `build: .`.
- Tests:

  ```sh
  pip install -r server/requirements-dev.txt
  python -m pytest -q server/tests
  ```

## License

[MIT](LICENSE). Fonts: Atkinson Hyperlegible, Bricolage Grotesque and IBM Plex Mono, under the
SIL Open Font License (see `web/fonts/`).
