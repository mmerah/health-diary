# Development

## Structure

| Folder | Contents |
|---|---|
| `web/` | The front end: HTML, CSS and JavaScript modules. No build step. |
| `web/js/main.js` | The app shell: login, tabs, addresses, theme. |
| `web/js/core/` | The data model (`schema.js`), dates, text helpers, autosave, UI parts. |
| `web/js/api/` | The server client (`http.js`) and the demo back end (`mock.js`, `sample.js`). |
| `web/js/screens/` | One module for each screen. |
| `web/js/report/` | The report: model, statistics, lab values, anonymization, Markdown and HTML. |
| `server/app/` | FastAPI and SQLite. `models.py` checks every request body. |
| `server/tests/`, `web/tests/` | Tests. |
| `docs/` | Guides. |

A new measurement type, drink or document type goes in `web/js/core/schema.js`.
Users add their own items in the app (**My lists**), not in the code.

## Run the demo

The demo runs on sample data in the browser:

```sh
python3 -m http.server -d web
```

Open `http://localhost:8000`.

## Run the full app

1. In `docker-compose.yml`, replace `image:` with `build: .`.
2. Run `docker compose up --build`.

## Tests

```sh
pip install -r server/requirements-dev.txt && python -m pytest -q server/tests
cd web && node --test "tests/*.test.js"
```

The OCR tests need poppler and tesseract. Without them, they are skipped. CI runs them.

## Style

- Text in the app and in the guides: simple technical English (ASD-STE100). Use short sentences
  and active verbs. Use the same word for the same thing.
- Escape every value that goes into HTML (`esc()` in `core/format.js`).
- No inline scripts or styles: the Content Security Policy blocks them.
