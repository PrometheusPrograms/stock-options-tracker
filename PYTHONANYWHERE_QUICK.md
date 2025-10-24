# 🚀 PythonAnywhere Quick Deploy Guide

## ⚡ Quick Steps

### 1. Sign Up & Upload
- Go to [pythonanywhere.com](https://pythonanywhere.com)
- Sign up for free account
- **Files** tab → **Clone from Git** → Enter your GitHub URL

### 2. Install Dependencies
- **Consoles** tab → **Bash**
- `cd stock-options-tracker`
- `pip3.10 install --user -r requirements-pythonanywhere.txt`

### 3. Create Web App
- **Web** tab → **Add a new web app**
- Choose **Flask**, Python **3.10**
- Source: `/home/YOUR_USERNAME/stock-options-tracker`
- WSGI: `wsgi.py`

### 4. Set Environment Variables
- **Web** tab → **Environment variables**
- `ALPHA_VANTAGE_API_KEY` = your_api_key
- `FLASK_ENV` = production

### 5. Deploy
- **Web** tab → **Reload**
- Visit: `https://YOUR_USERNAME.pythonanywhere.com`

## 🔧 Key Files
- `wsgi.py` - WSGI configuration
- `requirements-pythonanywhere.txt` - Dependencies
- `PYTHONANYWHERE_DEPLOYMENT.md` - Detailed guide

## 🚨 Troubleshooting
- Check **Error log** in Web tab
- Verify dependencies installed
- Check environment variables
- Ensure file permissions

## ✅ Features After Deployment
- Complete stock options tracking
- Real-time dashboard with charts
- Cost basis calculations
- Commission tracking
- Symbol filtering & autocomplete
- Status monitoring
- Modern responsive UI
