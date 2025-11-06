# Package Installation on PythonAnywhere

## Overview

When deploying to PythonAnywhere, **packages are NOT automatically installed** by default. You need to manually install packages from `requirements.txt` after pulling code.

## Automatic Installation (Recommended)

### Option 1: Using the Updated Deployment Script

The `update_pythonanywhere.sh` script now automatically installs packages:

```bash
cd /home/prometheusprograms/stock-options-tracker
bash update_pythonanywhere.sh
```

This will:
1. Pull latest code
2. **Install/update packages from requirements.txt**
3. Provide next steps

### Option 2: Using the Webhook Deploy Endpoint

The `/webhook/deploy` endpoint now automatically installs packages:

```bash
# Called automatically by GitHub webhook
# Or manually via:
curl -X POST http://prometheusprograms.pythonanywhere.com/webhook/deploy
```

This will:
1. Pull latest code
2. **Install/update packages from requirements.txt**
3. Reload WSGI application
4. Repopulate database tables

## Manual Installation

If you're deploying manually, you need to install packages:

### Step 1: Pull Code
```bash
cd /home/prometheusprograms/stock-options-tracker
git pull origin main
```

### Step 2: Install Packages
```bash
pip3 install --user -r requirements.txt
```

**Important Notes:**
- Use `pip3 install --user` on PythonAnywhere (not `pip install`)
- The `--user` flag installs packages to your user directory (required on PythonAnywhere)
- Always install packages after pulling code with new dependencies

### Step 3: Restart Web App
1. Go to PythonAnywhere Web tab
2. Click "Reload" button

## Current Requirements

After the latest changes, `requirements.txt` includes:
- Flask==2.3.3
- python-dotenv==1.0.0
- requests==2.31.0
- pandas==2.1.3
- openpyxl==3.1.2
- **SQLAlchemy==2.0.23** (NEW - added for hybrid approach)

## Verification

After deployment, verify packages are installed:

```bash
python3 -c "import sqlalchemy; print(f'SQLAlchemy version: {sqlalchemy.__version__}')"
```

If SQLAlchemy is not installed, you'll get an import error when the app starts.

## Troubleshooting

### Import Error: No module named 'sqlalchemy'

**Solution:** Install packages manually:
```bash
cd /home/prometheusprograms/stock-options-tracker
pip3 install --user -r requirements.txt
```

Then restart your web app.

### Permission Errors

**Solution:** Always use `--user` flag on PythonAnywhere:
```bash
pip3 install --user -r requirements.txt
```

### Package Version Conflicts

**Solution:** Check if package is already installed:
```bash
pip3 list --user | grep SQLAlchemy
```

If version is wrong, upgrade:
```bash
pip3 install --user --upgrade SQLAlchemy==2.0.23
```

## Best Practices

1. **Always install packages after pulling code** - New dependencies won't work without installation
2. **Use the updated deployment scripts** - They now handle package installation automatically
3. **Verify installation** - Check that imports work before restarting the app
4. **Keep requirements.txt updated** - Add new packages to requirements.txt when adding dependencies

## Deployment Checklist

After deploying to PythonAnywhere:

- [ ] Pull latest code (`git pull origin main`)
- [ ] Install/update packages (`pip3 install --user -r requirements.txt`)
- [ ] Run migrations (if needed) (`python3 deploy_to_pythonanywhere.py`)
- [ ] Restart web app (PythonAnywhere Web tab)
- [ ] Verify app is running (check logs for import errors)



