#!/bin/bash
# Script to update PythonAnywhere after pulling latest code

echo "Updating stock-options-tracker on PythonAnywhere..."

cd /home/prometheusprograms/stock-options-tracker

# Stash any local changes to trades.db
git stash push -m "Stash local trades.db changes"

# Pull latest code
git pull origin main

# If stash was created, drop it to keep repo version
if git stash list | grep -q "Stash local trades.db changes"; then
    echo "Dropping stashed trades.db to use repository version"
    git stash drop
fi

echo "✓ Code updated successfully"
echo ""
echo "Next steps:"
echo "1. Restart your web app in the Web tab"
echo "2. Visit: http://prometheusprograms.pythonanywhere.com/api/repopulate-cash-flows"
echo "3. Visit: http://prometheusprograms.pythonanywhere.com/api/repopulate-cost-basis"

