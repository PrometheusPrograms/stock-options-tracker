# PythonAnywhere Deployment Instructions

## After pulling latest code, update the database:

### Option 1: Via PythonAnywhere Console

1. Open the PythonAnywhere console (bash or Python)
2. Navigate to your project directory
3. Run the deployment script:

```bash
cd /home/prometheusprograms/stock-options-tracker  # or your project path
python3 deploy_to_pythonanywhere.py
```

### Option 2: Via Direct SQL (Faster)

1. Go to your PythonAnywhere web interface
2. Click on "Databases" tab
3. Click on your trades.db file
4. Run these commands:

```sql
-- First, update the cash_flows schema if needed
-- Check current schema
SELECT sql FROM sqlite_master WHERE type='table' AND name='cash_flows';

-- If ASSIGNMENT is not in the CHECK constraint, you'll need to update it
-- (This requires dropping and recreating the table, so use Option 1 instead)
```

### Option 3: Manual Endpoint Calls

1. After your code is deployed, restart your web app
2. Open your browser to: `http://prometheusprograms.pythonanywhere.com/api/repopulate-cash-flows`
3. Then visit: `http://prometheusprograms.pythonanywhere.com/api/repopulate-cost-basis`

## Quick Steps:

1. SSH into PythonAnywhere or use the console
2. Pull latest code:
   ```bash
   cd /home/prometheusprograms/stock-options-tracker
   git pull origin main
   ```
3. If you have the schema update script, run it
4. Otherwise, restart your web app and call the repopulate endpoints via browser

## Restart Your Web App

After pulling code, always:
1. Go to Web tab in PythonAnywhere
2. Click "Reload prometheusprograms.pythonanywhere.com"

## Verify the Update

Visit your dashboard and check:
- Premium graph shows only positive numbers (OPTIONS transactions only)
- Net credit uses cash_flows calculations
- Cost basis entries exist for assigned trades

