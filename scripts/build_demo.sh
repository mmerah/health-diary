#!/bin/sh
# Builds the sample-data demo for GitHub Pages into ./_site.
# Same web app, but without config.js: it runs on sample data in the browser and talks to no server.
set -e
rm -rf _site
mkdir -p _site
cp -R web/. _site/
{
  cat <<'HEAD'
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Demo of Health Diary, a self-hosted personal health diary. Sample data only.">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon.png">
<link rel="stylesheet" href="base.css">
HEAD
  sed 's/<header/<\/head><body>\n<header/' web/index.html
  echo '</body></html>'
} > _site/index.html
echo "Demo built in _site/"
