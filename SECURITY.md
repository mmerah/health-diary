# Security policy

Health Diary stores personal health data. Thank you for helping to keep it safe.

## Report a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately: [open a security advisory](https://github.com/mmerah/health-diary/security/advisories/new).
Tell us what you found, how to reproduce it, and which version you use (`/api/health` shows it).

You get an answer within 7 days. When the fix is released, the advisory is published and you are
credited, unless you ask us not to.

## Supported versions

Only the latest release and the `latest` image get security fixes. Update with:

```sh
docker compose pull && docker compose up -d
```

## Scope

In scope: the server, the web app, the Docker image and the anonymization of AI reports.
Out of scope: problems that need an attacker with access to the host or to the `data` folder,
and setups that expose the app to the internet against the advice in the README.
