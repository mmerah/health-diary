# Health Diary

A private health diary that you host yourself. You use it from your phone, tablet or computer.
Each day you log meals, drinks, medication, activities, symptoms and measurements. Apple Health data
(sleep, steps, heart rate) comes in from your iPhone. Your medical PDFs come from
[Paperless-ngx](https://docs.paperless-ngx.com/). When you need it, the app makes **one report**
for your doctor, or an **anonymized** version to paste into an AI assistant.

**[Try the demo](https://mmerah.github.io/health-diary/)**. It uses sample data and runs only in your browser.

## Features

- **Today:** a compact day you scan in one look. Meals with times, snacks, water, coffee and alcohol,
  your medication checklist (with the time you took it), what you did, symptoms (mild / moderate /
  severe; all day, a part of the day or a time), notes, and optional weight, blood pressure and
  temperature. The **+** button logs the common things in one or two taps.
- **Apple Health:** sleep (stages and naps), steps, resting heart rate, HRV, workouts and weight, sent
  by an iPhone shortcut. Import your full history once from the Health app export.
- **Trends:** weight, blood pressure (with the 140/90 line), temperature, weekly sleep, steps and heart
  rate, and a symptom calendar. Every chart also works as a table.
- **Records:** your medical documents from Paperless-ngx (tag `medical`), with their text.
- **Report:** flags first (high blood pressure, fever, weight change, new symptoms, missed medication,
  lab values out of range), then medication taken, symptom patterns, links such as "palpitations on
  days with 3 or more coffees", trends, measurements, a lab table and a short daily log.
  - **For your doctor:** a formatted report to print, save as PDF or share.
  - **For an AI assistant:** anonymized markdown. Names, date of birth, addresses, contact details and
    ID numbers are removed, and dates become day numbers (D-12).
- **Several users:** each person has their own private diary. Light, dark or automatic theme. Works on
  phone, tablet and desktop, and can be added to the iPhone home screen.

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

1. **Profile → My health:** your details, medical history and medication. Scheduled medication
   appears as a checklist on Today; "as needed" medication appears as quick buttons.
2. **Profile → Settings → Paperless:** save your own Paperless API token. Use a Paperless user that
   can read only your medical documents. Add the tag `medical` to your reports and blood tests.
3. **Apple Health history:** on the iPhone, Health app → your picture → **Export All Health Data**.
   Then in the diary: **Profile → Settings → Import your history**. The import only fills empty days.
4. **Daily sync:** create a shortcut key in **Profile → Settings** and build the shortcut:
   [docs/shortcut.md](docs/shortcut.md).

## Documents without Paperless

You do not need Paperless to keep your medical documents. In **Records**, upload a PDF or a photo
(JPEG, PNG or WebP, up to 25 MB and 50 pages). The server reads the text in the background: the
text of the PDF, or OCR (tesseract, in English, French and German) for scans and photos. It then
suggests a type, a date and a title. Nothing changes until you confirm. The text goes into your
reports like the text of Paperless documents.

If you use Paperless too, both lists show together. You can set a type, a date or a title for a
Paperless document in the diary. The diary keeps it for you and never changes Paperless.

## Security

This app holds health data. Please read this before you install it.

- **Keep it private.** Run it on a private network (Tailscale, VPN, home LAN). Do not open it to the
  internet, and do not use Tailscale Funnel for it.
- **Use HTTPS.** Tailscale (`*.ts.net`) and most reverse proxies do this for you.
- **Proxy address (`FORWARDED_ALLOW_IPS`).** Docktail, `tailscale serve` and reverse proxies connect
  to the app for your devices, so the app sees the proxy's address, not the device's. The app
  reads the real address from the `X-Forwarded-For` header only when the request comes from an
  address in `FORWARDED_ALLOW_IPS`. To find the proxy's address, open the app once and run
  `docker logs health-diary`: each request line starts with the address that connected (for example
  `172.18.0.5:41234`). Put that address in `.env` (`FORWARDED_ALLOW_IPS=172.18.0.5`). Never use `*`:
  then anyone can fake their address. If you do not set it, all users share the proxy's address.
  This is safe, but one person's wrong passwords then slow down logins of the same username for all.
- **Accounts:** passwords are hashed with scrypt. Logins use secure, HttpOnly, SameSite cookies.
  After each wrong password for one username from one address, the next try must wait longer:
  1 second, then 2, 4, 8 and so on, up to 1 minute. The app never locks an account. After 30 wrong
  passwords from one address in 15 minutes, that address must wait.
  A new password logs out the user's other devices.
- **First account:** only a person with the setup code from the server log can create it. The code
  is long (more than 128 bits), and each wrong code from an address makes the next try wait longer.
  A fixed `SETUP_CODE` must have at least 16 letters or digits, or the app does not start.
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
- **Documents:** uploaded files are stored encrypted with `DIARY_SECRET_KEY` in `./data/documents`,
  and so is their text in the database. The title, date and type of each document are not
  encrypted: the list needs them. Only PDF, JPEG, PNG and WebP files are accepted, checked by their
  content, not their name. PDFs with a password are refused. The text is read by external tools
  (poppler, tesseract) with a time limit and a memory limit, in a private folder that is deleted
  after. A file is sent back to the browser with a policy that blocks scripts in it.
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
**Without the key, the uploaded documents cannot be read again**, and users must save their
Paperless token again. With the key next to the backup, anyone with the backup can read them.

Each user can also download their own data, in Profile: a zip file with `data.json` and their
uploaded documents (not encrypted).

## Settings (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `TZ` | `UTC` | Time zone. Days start at midnight in this zone. Set it: the log warns if it is missing. |
| `PUID`, `PGID` | `1000` | Owner of `./data`. The app runs as this user. |
| `DIARY_SECRET_KEY` | `data/secret.key` | Key that encrypts the Paperless tokens and the uploaded documents. Make one with `openssl rand -base64 32`. Back it up apart from the data. |
| `PAPERLESS_URL` | | Paperless address, as the container reaches it. |
| `PAPERLESS_PUBLIC_URL` | `PAPERLESS_URL` | Paperless address for links on your devices. |
| `PAPERLESS_TAG` | `medical` | Default tag. Each user can change it. |
| `PAPERLESS_TOKEN` | | Optional Paperless token for one account. Other users save their own in Profile. |
| `PAPERLESS_TOKEN_USER` | | The username that may use `PAPERLESS_TOKEN`. Without it, nobody uses the token. |
| `SETUP_CODE` | random | Fixed code for the first account. At least 16 letters or digits. |
| `SESSION_DAYS` | `30` | Days before a login expires. It renews while you use the app. |
| `COOKIE_SECURE` | `auto` | `true` or `false` to force the Secure cookie flag. |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | Addresses of proxies (Docktail, `tailscale serve`, reverse proxy) whose `X-Forwarded-*` headers the app trusts. See Security. Never `*`. |
| `MAX_IMPORT_MB` | `2048` | Largest Apple Health upload, in MB. |
| `MAX_IMPORT_UNPACKED_MB` | `4096` | Largest size the upload may unpack to, in MB. |
| `MAX_DOC_MB` | `25` | Largest document upload, in MB. |
| `OCR_WORKERS` | `1` | Documents read at the same time. More is faster, and uses more CPU and memory. |
| `OCR_LANGS` | `eng+fra+deu` | Languages for OCR. The image has English, French and German. |
| `OCR_MEMORY_MB` | `1024` | Memory limit for each OCR or PDF tool run. |

## Development

- `web/`: the front end. HTML, CSS and JavaScript modules, no build step.
  - `js/main.js` is the app shell. `js/core/` holds the shared data model (`schema.js`), dates, text
    helpers, autosave and UI parts. `js/api/` has the server client and the demo back end.
    `js/screens/` has one module per screen. `js/report/` builds and anonymizes the report.
  - Without a server it runs on sample data in the browser: that is the demo. Try it with
    `python3 -m http.server -d web`.
- `server/`: FastAPI and SQLite. Request bodies are checked by the models in `app/models.py`.
- Run the full app: in `docker-compose.yml`, replace `image:` with `build: .`, then `docker compose up --build`.
- Tests:

  ```sh
  pip install -r server/requirements-dev.txt && python -m pytest -q server/tests
  cd web && node --test "tests/*.test.js"
  ```

## License

[MIT](LICENSE). Fonts: Atkinson Hyperlegible and Bricolage Grotesque, under the SIL Open Font
License (see `web/fonts/`).
