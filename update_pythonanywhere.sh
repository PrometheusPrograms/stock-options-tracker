#!/bin/bash
# Script to update PythonAnywhere after pulling latest code

echo "Updating stock-options-tracker on PythonAnywhere..."

# Auto-detect account: greenmandev (test) or greenmangroup (prod)
USER="$(basename "$HOME")"
cd "$HOME/inv_track"

# Stash any local changes to trades.db
git stash push -m "Stash local trades.db changes"

# Pull latest code
git pull origin main

# If stash was created, drop it to keep repo version
if git stash list | grep -q "Stash local trades.db changes"; then
    echo "Dropping stashed trades.db to use repository version"
    git stash drop
fi

# Install/update Python packages from requirements.txt
echo ""
echo "Installing/updating Python packages..."
pip3 install --user -r requirements.txt

echo "✓ Code updated successfully"
echo "✓ Packages installed/updated"
echo ""
echo "Next steps:"
echo "1. Reload your web app in the Web tab"
echo "2. Visit: https://greenmangroup.pythonanywhere.com/api/env  (prod)"
echo "   or:   https://greenmandev.pythonanywhere.com/api/env     (test)"

