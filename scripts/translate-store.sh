#!/bin/bash
# Translate the whole store into every published language, directly against the
# Shopify Admin API (no dev server / tunnel needed). Run from your own Terminal,
# which has full network access to your store.
#
#   cd /Users/ghoshdarnit/storetranslatorapp
#   bash scripts/translate-store.sh
#
# Optional: limit to specific resource types, e.g.
#   ONLY_TYPES="ONLINE_STORE_THEME,ONLINE_STORE_THEME_JSON_TEMPLATE" bash scripts/translate-store.sh

set -e
cd "$(dirname "$0")/.."

export SHOP="storetranslatorapp.myshopify.com"
export TOKEN=$(python3 -c "import sqlite3; print(sqlite3.connect('prisma/dev.sqlite').execute(\"SELECT accessToken FROM Session WHERE id='offline_storetranslatorapp.myshopify.com'\").fetchone()[0])")
export ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' .env | cut -d= -f2-)

if [ -z "$TOKEN" ]; then echo "No offline session token found in prisma/dev.sqlite — open the app once, then retry."; exit 1; fi
if [ -z "$ANTHROPIC_API_KEY" ]; then echo "ANTHROPIC_API_KEY missing from .env"; exit 1; fi

echo "Translating store $SHOP ..."
node scripts/translate-all.mjs
