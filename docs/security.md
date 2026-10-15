# Security

Health Diary keeps health data. Read this page before you install it.

## What you must do

1. **Keep the app on a private network.** Use Tailscale, a VPN or your home network.
   Do not open the app to the internet. Do not use Tailscale Funnel for it.
2. **Use HTTPS.** Tailscale (`*.ts.net`) and most reverse proxies do this for you.
3. **Set `DIARY_SECRET_KEY`** and keep a copy apart from your backups. See [Settings](configuration.md#secret-key).
4. **Behind a proxy, set `FORWARDED_ALLOW_IPS`.** See [Settings](configuration.md#reverse-proxy).
5. **Protect the server and the backups.** Use disk encryption. Anyone with the `data` folder can
   read the diaries.
6. **Read every AI report before you share it.** See [AI reports](#ai-reports).

## Accounts

- Only a person with the setup code from the server log can create the first account.
  The code is random and long. Each wrong code makes the next try wait longer.
- There is no public sign-up. An administrator adds users.
- Passwords are stored as scrypt hashes.
- After each wrong password, the next try for that username from that address waits longer:
  1 s, 2 s, 4 s, up to 1 minute. The app never locks an account.
- Logins use secure, HttpOnly, SameSite cookies. A login lasts 30 days and renews while you use it.
- A new password logs out your other devices.
- When an administrator sets a new password for you, you see a notice at your next login.
- The last administrator cannot be removed.

## Your data

- Users never see the diary of another user.
- Each user can download all their data (**Profile → Settings → Account**): a ZIP file with the data
  and the original documents. This file is not encrypted. Keep it in a safe place.
- Each user can delete their account. This deletes all their data and files. Deleted data is
  overwritten in the database file. Old backups still contain it.
- Edits that are not saved yet (for example offline) stay in the browser of that device, for that
  user only. They are deleted at logout.

## The server

- The server checks every request: size, fields and values.
- It refuses requests from other websites.
- The app loads no outside scripts, fonts or trackers. A strict Content Security Policy blocks them.
- The container runs as `PUID:PGID` with a read-only file system, no added privileges and few
  capabilities.
- The database and the documents are readable only by the app user.

## Documents

- Uploaded files and their text are encrypted with `DIARY_SECRET_KEY`. The title, date and type are
  not encrypted: the list needs them.
- The app accepts only PDF, JPEG, PNG and WebP files. It checks the file content, not the name.
- It refuses PDFs with a password.
- External tools (poppler, tesseract) read the text. They run with a time limit and a memory limit,
  in a private folder that is deleted after.
- The browser gets a file with a policy that blocks scripts in it.

## Paperless

- The app only reads from Paperless. It never changes Paperless.
- Paperless tokens are encrypted with `DIARY_SECRET_KEY`. The app never shows a saved token.
- Your corrections to Paperless documents (type, date, title) stay in the diary.

## iPhone shortcut

- Each user has a personal shortcut key. The server keeps only a hash of it.
- Replace or turn off the key in **Profile → Settings → Apple Health sync**. The page shows when the
  key was last used.

## AI reports

The AI report removes common personal details: names, date of birth, addresses, phone numbers,
email addresses, ID numbers and hospital names. Dates become day numbers (D-12).

It cannot find every detail. For example, a name with no title and no context can stay.

1. Add words to hide in the report settings, for example a clinic name.
2. Read the full report before you share it.

## Report a problem

Report security problems privately. See [SECURITY.md](../SECURITY.md).
