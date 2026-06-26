#!/bin/bash
# One-time setup for PythonAnywhere (greenmandev = test, greenmangroup = prod)
# Paste into a Bash console on each account, then reload the web app.

set -e

USER="$(basename "$HOME")"
REPO="https://github.com/PrometheusPrograms/stock-options-tracker.git"
PROJECT="$HOME/inv_track"

echo "=== PythonAnywhere setup for $USER ==="

# ── Clone or update repo ──────────────────────────────────────────────────────
if [ -d "$PROJECT/.git" ]; then
    echo "Updating existing repo..."
    cd "$PROJECT"
    git fetch origin
    git reset --hard origin/main
else
    echo "Cloning repo..."
    git clone "$REPO" "$PROJECT"
    cd "$PROJECT"
fi

# ── Virtualenv ────────────────────────────────────────────────────────────────
if [ ! -d "$PROJECT/.venv" ]; then
    echo "Creating virtualenv..."
    python3.11 -m venv "$PROJECT/.venv"
fi
source "$PROJECT/.venv/bin/activate"
pip install --upgrade pip
pip install -r "$PROJECT/requirements.txt"

# ── Environment-specific database ─────────────────────────────────────────────
if [ "$USER" = "greenmangroup" ]; then
    DB_FILE="$PROJECT/trades.db"
    APP_ENV="production"
    SITE="https://greenmangroup.pythonanywhere.com"
elif [ "$USER" = "greenmandev" ]; then
    DB_FILE="$PROJECT/trades_test.db"
    APP_ENV="test"
    SITE="https://greenmandev.pythonanywhere.com"
else
    echo "Unknown user $USER — edit this script for your account."
    exit 1
fi

# Create empty DB if missing (migrations run on first app load)
if [ ! -f "$DB_FILE" ]; then
    echo "Creating database: $DB_FILE"
    touch "$DB_FILE"
fi

# ── .env for secrets (Schwab keys — never commit this file) ───────────────────
ENV_FILE="$PROJECT/.env"
if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" << EOF
APP_ENV=$APP_ENV
DB_PATH=$DB_FILE
SCHWAB_REDIRECT_URI=$SITE/auth/schwab/callback
SCHWAB_TOKEN_FILE=$PROJECT/schwab_tokens.json
SCHWAB_APP_KEY=PASTE_YOUR_KEY_HERE
SCHWAB_APP_SECRET=PASTE_YOUR_SECRET_HERE
EOF
    chmod 600 "$ENV_FILE"
    echo "Created $ENV_FILE — edit it and add your Schwab API keys."
else
    echo ".env already exists — leaving unchanged."
fi

# ── WSGI stub (PythonAnywhere system file) ────────────────────────────────────
if [ "$USER" = "greenmandev" ]; then
    WSGI="/var/www/greenmandev_pythonanywhere_com_wsgi.py"
elif [ "$USER" = "greenmangroup" ]; then
    WSGI="/var/www/greenmangroup_pythonanywhere_com_wsgi.py"
fi

cat > "$WSGI" << 'WSGIEOF'
import sys
import os

project_home = os.path.expanduser('~/inv_track')
if project_home not in sys.path:
    sys.path.insert(0, project_home)

os.chdir(project_home)

from app import app as application
WSGIEOF

echo "Wrote $WSGI"

# ── Web tab settings (manual check) ───────────────────────────────────────────
echo ""
echo "=== Done. Verify in the Web tab ==="
echo "  Source code:  $PROJECT"
echo "  Working dir:  $PROJECT"
echo "  Virtualenv:   $PROJECT/.venv"
echo "  WSGI file:    $WSGI"
echo "  Database:     $DB_FILE"
echo ""
echo "1. Edit $ENV_FILE and set SCHWAB_APP_KEY / SCHWAB_APP_SECRET"
echo "2. Web tab → set virtualenv to: $PROJECT/.venv"
echo "3. Web tab → set source/working directory to: $PROJECT"
echo "4. Web tab → click Reload"
echo "5. Visit $SITE/api/env to confirm environment"
