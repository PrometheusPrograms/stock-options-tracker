# Fixing 504 Error on PythonAnywhere

## Problem
Getting "Error code: 504-loadbalancer" when deploying to PythonAnywhere. This typically means the app is taking too long to start or respond.

## Root Cause
The Flask app runs database migrations on the first request via `@app.before_request`, which can cause a timeout if migrations are slow or hang.

## Solution Applied
1. **Non-blocking migrations**: Updated `app.py` to make migrations non-blocking - if they fail or timeout, the app continues without them
2. **Better error handling**: Added try-catch blocks to prevent migrations from blocking the first request

## Additional Steps Required

### 1. Update WSGI File
The `wsgi.py` file has a placeholder path that needs to be updated:

```python
# Change this line:
project_dir = '/home/YOUR_USERNAME/stock-options-tracker'

# To your actual PythonAnywhere path, e.g.:
project_dir = '/home/prometheusprograms/stock-options-tracker'
# OR
project_dir = '/home/greenmangroup/cursor_tracker/stock-options-tracker/stock-options-tracker'
```

### 2. Check PythonAnywhere Web Tab
1. Go to PythonAnywhere Web tab
2. Check the error log for any startup errors
3. Make sure the WSGI file path is correct
4. Click "Reload" after making changes

### 3. Run Migrations Manually (if needed)
If migrations are causing issues, you can run them manually:

```bash
# In PythonAnywhere console
cd /home/YOUR_USERNAME/stock-options-tracker
python3 -c "from migrations.migrate import run_migrations; run_migrations()"
```

### 4. Check for Database Locks
If the database is locked, it can cause timeouts:

```bash
# Check for database locks
lsof trades.db
```

### 5. Verify Dependencies
Make sure all dependencies are installed:

```bash
pip3 install --user -r requirements.txt
```

## Testing
After making changes:
1. Update `wsgi.py` with correct path
2. Reload web app in PythonAnywhere
3. Check error log for any issues
4. Test the app - it should load without 504 errors

