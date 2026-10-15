# Backup

All data is in the `data` folder: the database `diary.db`, the documents and the key file.

## Back up

1. Make a safe copy of the database while the app runs:

   ```sh
   docker exec health-diary python -c "import sqlite3; sqlite3.connect('/data/diary.db').backup(sqlite3.connect('/data/backup.db'))"
   ```

2. Copy the `data` folder to your backup place. Include `backup.db` and `documents/`.
3. Keep the secret key apart from the backup: `DIARY_SECRET_KEY` from `.env`, or `data/secret.key`.

> **Caution:** without the key, the uploaded documents cannot be read again.
> With the key next to the backup, anyone with the backup can read them.

## Restore

1. Stop the app: `docker compose down`.
2. Put the `data` folder back. Rename `backup.db` to `diary.db`.
3. Put the same `DIARY_SECRET_KEY` in `.env`, or put `secret.key` back in `data`.
4. Start the app: `docker compose up -d`.

## Move to a new server

1. Do a backup on the old server.
2. Install Health Diary on the new server. Do not start it.
3. Restore the backup and the key on the new server.
4. Start the app.

## Export your own data

Each user can download their data: **Profile → Settings → Account → Export my data**.
You get a ZIP file with `data.json` and your original documents. The file is not encrypted.
