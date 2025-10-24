# 🚀 PythonAnywhere Deployment Guide

## 📋 Prerequisites
- PythonAnywhere account (free tier available)
- Your Stock Options Tracker code ready in Git

## 🔧 Step-by-Step Deployment

### Step 1: Create PythonAnywhere Account
1. Go to [PythonAnywhere.com](https://pythonanywhere.com)
2. Sign up for a free account
3. Verify your email address

### Step 2: Upload Your Code
1. **Option A: Upload from Git (Recommended)**
   - Go to **Files** tab
   - Click **"Clone from Git"**
   - Enter your GitHub repository URL: `https://github.com/YOUR_USERNAME/stock-options-tracker.git`
   - Click **"Clone"**

2. **Option B: Manual Upload**
   - Go to **Files** tab
   - Navigate to `/home/YOUR_USERNAME/`
   - Upload all files from your local project

### Step 3: Install Dependencies
1. Go to **Consoles** tab
2. Click **"Bash"** to open a console
3. Navigate to your project directory:
   ```bash
   cd stock-options-tracker
   ```
4. Install dependencies:
   ```bash
   pip3.10 install --user flask python-dotenv requests
   ```

### Step 4: Create Web App
1. Go to **Web** tab
2. Click **"Add a new web app"**
3. Choose **"Flask"**
4. Set Python version to **3.10**
5. Set source code directory to: `/home/YOUR_USERNAME/stock-options-tracker`
6. Set WSGI file to: `app.py`

### Step 5: Configure WSGI File
1. Click on the WSGI file link in the Web tab
2. Replace the content with:
   ```python
   import sys
   path = '/home/YOUR_USERNAME/stock-options-tracker'
   if path not in sys.path:
       sys.path.append(path)

   from app import app as application
   ```

### Step 6: Set Environment Variables
1. Go to **Web** tab
2. Click **"Environment variables"**
3. Add these variables:
   - `ALPHA_VANTAGE_API_KEY`: Your Alpha Vantage API key
   - `FLASK_ENV`: `production`

### Step 7: Reload Web App
1. Go to **Web** tab
2. Click **"Reload"** button
3. Your app will be available at: `https://YOUR_USERNAME.pythonanywhere.com`

## 🔧 Configuration Files

### WSGI Configuration (wsgi.py)
```python
import sys
path = '/home/YOUR_USERNAME/stock-options-tracker'
if path not in sys.path:
    sys.path.append(path)

from app import app as application
```

### Environment Variables
- `ALPHA_VANTAGE_API_KEY`: Your Alpha Vantage API key
- `FLASK_ENV`: `production`

## 🚨 Troubleshooting

### Common Issues:
1. **Import Errors**: Make sure all dependencies are installed
2. **Database Issues**: SQLite database will be created automatically
3. **Static Files**: Ensure CSS/JS files are in the correct directories
4. **API Keys**: Set environment variables in the Web tab

### Debug Steps:
1. Check the **Error log** in the Web tab
2. Verify file permissions
3. Ensure all dependencies are installed
4. Check environment variables are set correctly

## 📱 Features Available After Deployment
- ✅ Complete stock options tracking
- ✅ Real-time dashboard
- ✅ Cost basis calculations
- ✅ Commission tracking
- ✅ Symbol filtering
- ✅ Status monitoring
- ✅ Modern responsive UI

## 🔄 Updates and Maintenance
- To update your app, push changes to Git and pull them in PythonAnywhere
- Monitor the error logs regularly
- Keep dependencies updated

## 📞 Support
- PythonAnywhere documentation: https://help.pythonanywhere.com/
- Free tier limitations: 1 web app, limited CPU seconds
- Upgrade options available for production use
