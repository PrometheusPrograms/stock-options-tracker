# 🚀 Automated Git to PythonAnywhere Deployment

## ⚡ Quick Setup

### 1. Push Code to GitHub
```bash
git add .
git commit -m "Update with automated deployment"
git push origin main
```

### 2. Set Up PythonAnywhere
- **Files** tab → **Clone from Git**
- URL: `https://github.com/PrometheusPrograms/stock-options-tracker.git`
- **Web** tab → **Add web app** → Flask, Python 3.10
- Source: `/home/YOUR_USERNAME/stock-options-tracker`
- WSGI: `wsgi.py`

### 3. Configure WSGI
```python
import sys
path = '/home/YOUR_USERNAME/stock-options-tracker'
if path not in sys.path:
    sys.path.append(path)

from app import app as application
```

### 4. Set Environment Variables
- `ALPHA_VANTAGE_API_KEY` = `17WLKVB018T72SGJ`
- `FLASK_ENV` = `production`

### 5. Install Dependencies
```bash
cd stock-options-tracker
pip3.10 install --user -r requirements.txt
```

### 6. Deploy
- Click **Reload** in Web tab
- Visit: `https://YOUR_USERNAME.pythonanywhere.com`

## 🤖 Automation Methods

### Method 1: Scheduled Task (Free Tier)
- **Tasks** tab → **Add task**
- Command: `cd /home/YOUR_USERNAME/stock-options-tracker && git pull`
- Run every 5 minutes

### Method 2: Always-on Task (Paid Tier)
- **Tasks** tab → **Add task**
- Command:
```bash
while true; do
  cd /home/YOUR_USERNAME/stock-options-tracker
  git pull
  sleep 60
done
```

### Method 3: GitHub Actions (Advanced)
- Uses `.github/workflows/deploy.yml`
- Automatic deployment on push
- Requires SSH setup

## 🔄 Update Workflow
1. Make changes locally
2. `git add . && git commit -m "Update" && git push`
3. PythonAnywhere automatically pulls updates
4. Click **Reload** in Web tab

## ✅ Benefits
- ✅ Automatic deployment from Git
- ✅ Version control and rollback
- ✅ Professional workflow
- ✅ Cloud backup
- ✅ Multiple automation options
