# Schwab API Integration Setup Guide

This guide will help you set up the Charles Schwab API integration to sync real-time and historical trade data.

## Prerequisites

1. A Charles Schwab account
2. Python 3.7 or higher
3. Access to the Schwab Developer Portal

## Step 1: Register Your Application

1. Go to [Charles Schwab Developer Portal](https://developer.schwab.com/)
2. Create an account or sign in
3. Register a new application
4. You'll receive:
   - **App Key** (also called Client ID)
   - **App Secret** (also called Client Secret)

## Step 2: Configure Environment Variables

Create a `.env` file in the project root (or add to your existing `.env` file) with the following:

```env
# Schwab API Configuration
SCHWAB_APP_KEY=your_app_key_here
SCHWAB_APP_SECRET=your_app_secret_here
SCHWAB_REDIRECT_URI=http://localhost:5005/auth/schwab/callback
SCHWAB_TOKEN_FILE=schwab_tokens.json
```

**Important Notes:**
- Replace `your_app_key_here` and `your_app_secret_here` with your actual credentials
- The `SCHWAB_REDIRECT_URI` must match the redirect URI you registered in the Schwab Developer Portal
- The `SCHWAB_TOKEN_FILE` will store your OAuth tokens (keep this secure and don't commit to git)

## Step 3: Install Dependencies

Install the required Python package:

```bash
pip install schwab-py==1.3.0
```

Or install all requirements:

```bash
pip install -r requirements.txt
```

## Step 4: Run Database Migration

Run the migration to add the Schwab order ID column to the trades table:

```bash
python migrations/migrate.py
```

## Step 5: Authenticate with Schwab

The first time you use the Schwab API, you'll need to authenticate:

1. Start your Flask application:
   ```bash
   python app.py
   ```

2. Click the "Schwab Sync" button in the UI

3. If not authenticated, you'll be prompted to authenticate via OAuth
   - You'll be redirected to Schwab's login page
   - Log in and authorize the application
   - You'll be redirected back to your app
   - Tokens will be saved to `schwab_tokens.json`

## Step 6: Sync Trades

Once authenticated, you can sync trades:

1. Click the "Schwab Sync" button
2. Select:
   - **Account**: Choose a specific Schwab account or "All Accounts"
   - **Start Date**: Beginning of the date range
   - **End Date**: End of the date range
   - **Map to Local Account**: Select which local account to import trades into
3. Click "Sync Trades"

The system will:
- Fetch orders from Schwab for the specified date range
- Import them into your local database
- Skip duplicates (based on Schwab order ID)
- Show you a summary of imported/skipped trades

## Features

### Available Endpoints

- **GET /api/schwab/status** - Check API connection status
- **GET /api/schwab/accounts** - Get all Schwab accounts
- **GET /api/schwab/positions** - Get current positions
- **GET /api/schwab/orders** - Get orders (trades) for a date range
- **GET /api/schwab/quotes** - Get real-time quotes for symbols
- **GET /api/schwab/historical** - Get historical price data
- **POST /api/schwab/sync-trades** - Sync trades to local database

### JavaScript Functions

- `openSchwabSyncModal()` - Open the sync modal
- `checkSchwabStatus()` - Check API authentication status
- `syncSchwabTrades()` - Sync trades from Schwab
- `getSchwabQuotes(symbols)` - Get real-time quotes
- `getSchwabHistorical(symbol, startDate, endDate)` - Get historical data

## Troubleshooting

### "Schwab API not available"
- Make sure `schwab-py` is installed: `pip install schwab-py`
- Check that the library imported correctly

### "Not Authenticated"
- Verify your `.env` file has correct credentials
- Make sure `SCHWAB_APP_KEY` and `SCHWAB_APP_SECRET` are set
- Try re-authenticating (delete `schwab_tokens.json` and try again)

### "Error fetching accounts/orders"
- Check your internet connection
- Verify your API credentials are correct
- Make sure your tokens haven't expired (they auto-refresh, but may need re-authentication)

### Import Issues
- Check that the date range is valid
- Verify the local account mapping is correct
- Check the browser console for detailed error messages

## Security Notes

- **Never commit** your `.env` file or `schwab_tokens.json` to version control
- Add both files to `.gitignore`
- Keep your App Secret secure
- Tokens are stored locally in `schwab_tokens.json` - keep this file secure

## API Rate Limits

Be aware of Schwab's API rate limits:
- Real-time quotes: Limited requests per minute
- Historical data: Limited requests per day
- Account/order queries: Limited requests per minute

The integration includes error handling for rate limits, but be mindful of making too many requests in a short time.

## Support

For issues with:
- **Schwab API**: Check [Schwab Developer Portal](https://developer.schwab.com/)
- **Integration code**: Check the application logs and browser console
- **Library issues**: Check [schwab-py GitHub](https://github.com/alexgolec/schwab-py)


