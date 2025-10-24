# 🚀 Automated PythonAnywhere Deployment

## ⚡ Quick Start

### 1. Create GitHub Repository
- Go to [github.com](https://github.com) → **New repository**
- Name: `stock-options-tracker`
- **Don't** initialize with README
- Click **Create repository**

### 2. Connect Local to GitHub
```bash
git remote add origin https://github.com/YOUR_USERNAME/stock-options-tracker.git
git push -u origin main
```

### 3. Configure PythonAnywhere
- **Files** tab → **Clone from Git**
- URL: `https://github.com/YOUR_USERNAME/stock-options-tracker.git`
- **Web** tab → **Add web app** → Flask, Python 3.10
- Source: `/home/YOUR_USERNAME/stock-options-tracker`
- WSGI: `wsgi.py`

### 4. Deploy
- **Consoles** → Bash: `cd stock-options-tracker && pip3.10 install --user -r requirements.txt`
- **Web** tab → **Reload**

## 🔄 Update Process

### Method 1: Manual (Free Tier)
```bash
# Local changes
git add .
git commit -m "Update message"
git push

# PythonAnywhere
cd stock-options-tracker
git pull
# Then reload web app
```

### Method 2: Scheduled Task (Free Tier)
- **Tasks** tab → **Add task**
- Command: `cd /home/YOUR_USERNAME/stock-options-tracker && git pull`
- Run every 5 minutes

### Method 3: GitHub Actions (Advanced)
- Uses `.github/workflows/deploy.yml`
- Automatic deployment on push to main
- Requires SSH setup

## ✅ Benefits
- ✅ Version control
- ✅ Easy updates
- ✅ Cloud backup
- ✅ Collaboration ready
- ✅ Rollback capability
- ✅ Automated deployment options
