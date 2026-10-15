# python:3.12-slim, pinned by digest. Dependabot proposes updates (.github/dependabot.yml).
FROM python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170

ARG APP_VERSION=dev
# FORWARDED_ALLOW_IPS: uvicorn trusts X-Forwarded-For/-Proto only from these addresses.
# Behind a reverse proxy on another host or container, set it to the proxy's address in .env.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    WEB_DIR=/app/web \
    FORWARDED_ALLOW_IPS=127.0.0.1 \
    APP_VERSION=${APP_VERSION}

WORKDIR /app
# requirements.txt has a hash for every package: pip refuses anything else.
COPY server/requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

COPY server/entrypoint.sh /entrypoint.sh
COPY server/app ./app
COPY web ./web

VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
