#!/bin/sh
# Builds the sample-data demo for GitHub Pages into ./_site.
# The web app is static. Its config.js has no server address, so it runs on sample data in the browser.
set -e
rm -rf _site
mkdir -p _site
cp -R web/. _site/
rm -rf _site/tests _site/package.json
# The version shown in Profile → Settings → About.
VERSION=$(git describe --tags --always 2>/dev/null | sed 's/^v//' || echo dev)
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo '')
BUILT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '// Demo build: no server, so the app runs on sample data in the browser.\nwindow.DIARY_CONFIG = { version: "%s", commit: "%s", built: "%s" };\n' "$VERSION" "$COMMIT" "$BUILT" > _site/config.js
echo "Demo built in _site/"
