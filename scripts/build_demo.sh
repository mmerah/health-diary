#!/bin/sh
# Builds the sample-data demo for GitHub Pages into ./_site.
# The web app is static. Its config.js has no server address, so it runs on sample data in the browser.
set -e
rm -rf _site
mkdir -p _site
cp -R web/. _site/
rm -rf _site/tests _site/package.json
echo "Demo built in _site/"
