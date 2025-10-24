#!/bin/bash

# Stock Options Tracker - GitHub Deployment Script
# Run this script after creating your GitHub repository

echo "🚀 Stock Options Tracker - GitHub Deployment"
echo "============================================="
echo ""

# Check if we're in a git repository
if [ ! -d ".git" ]; then
    echo "❌ Error: Not in a git repository. Run 'git init' first."
    exit 1
fi

# Check if we have commits
if [ -z "$(git log --oneline 2>/dev/null)" ]; then
    echo "❌ Error: No commits found. Make a commit first."
    exit 1
fi

echo "📋 Instructions:"
echo "1. Go to https://github.com and create a new repository"
echo "2. Name it 'stock-options-tracker' (or your preferred name)"
echo "3. DO NOT initialize with README, .gitignore, or license"
echo "4. Copy the repository URL from GitHub"
echo "5. Run the commands below with your repository URL"
echo ""
echo "🔗 Commands to run (replace YOUR_USERNAME and YOUR_REPO_NAME):"
echo "git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git"
echo "git branch -M main"
echo "git push -u origin main"
echo ""
echo "📝 Example:"
echo "git remote add origin https://github.com/johndoe/stock-options-tracker.git"
echo "git branch -M main"
echo "git push -u origin main"
echo ""
echo "✅ After pushing, your code will be available at:"
echo "https://github.com/YOUR_USERNAME/YOUR_REPO_NAME"
