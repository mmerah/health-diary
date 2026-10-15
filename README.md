# Health Diary

A private health diary on your own server. Use it on your phone, tablet or computer.

- Log meals, drinks, medication, symptoms and measurements.
- Get sleep, steps, heart rate and blood oxygen from Apple Health.
- Keep your medical documents: upload them, or connect [Paperless-ngx](https://docs.paperless-ngx.com/).
- Make a report for your doctor, or an anonymized summary for an AI assistant.

**[Try the demo](https://mmerah.github.io/health-diary/)**. It uses sample data. It runs only in your browser.

## What you need

- A server with Docker, for example a NAS.
- A private network to reach it, for example [Tailscale](https://tailscale.com/).
  Do not open Health Diary to the internet. Read [Security](docs/security.md).

## Install

1. Make a folder and download the two files:

   ```sh
   mkdir health-diary && cd health-diary
   curl -O https://raw.githubusercontent.com/mmerah/health-diary/main/docker-compose.yml
   curl -o .env https://raw.githubusercontent.com/mmerah/health-diary/main/.env.example
   ```

2. Edit `.env`. Set `TZ`, `PUID` and `PGID`. See [Settings](docs/configuration.md).
3. Make the app reachable with HTTPS. The compose file has labels for
   [Docktail](https://github.com/marvinvr/docktail). Without Docktail, see
   [Settings](docs/configuration.md#reach-the-app).
4. Start the app and get the setup code:

   ```sh
   docker compose up -d
   docker logs health-diary
   ```

5. Open the app. Enter the setup code. Create the first account. This account is the administrator.

To add users: **Profile → Settings → Users**.

## First steps

1. **Profile → My health:** enter your details, medical history and medication.
2. **Profile → Settings → My lists:** set your symptoms, measurements and counters (optional).
3. **Records:** add your medical documents, or connect Paperless in **Profile → Settings**.
   See [Documents](docs/documents.md).
4. **Apple Health:** import your history once, then set up the daily sync.
   See [iPhone shortcut](docs/shortcut.md).

## Update

```sh
docker compose pull && docker compose up -d
```

Your data in `./data` stays. Make a [backup](docs/backup.md) first.

## Guides

| Guide | Contents |
|---|---|
| [Settings](docs/configuration.md) | The `.env` settings, HTTPS, reverse proxies |
| [Security](docs/security.md) | How the app protects your data, and what you must do |
| [Backup](docs/backup.md) | Back up, restore, move to a new server |
| [Documents](docs/documents.md) | Upload documents, OCR, types, Paperless |
| [iPhone shortcut](docs/shortcut.md) | Send Apple Health data every day |
| [Development](docs/development.md) | Code structure, tests, run from source |

## Report a problem

- A bug or an idea: [open an issue](https://github.com/mmerah/health-diary/issues/new/choose).
  Give the version from **Profile → Settings → About**. Never put real health data in an issue.
- A security problem: report it privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Fonts: Atkinson Hyperlegible and Bricolage Grotesque, under the SIL Open Font
License (see `web/fonts/`).
