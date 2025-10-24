# Stock Options Tracker

A Flask-based web application for tracking stock options trades with cost basis calculations.

## Features

- Add and manage stock options trades
- Real-time cost basis calculations
- Dashboard with trade statistics
- Interactive charts showing premium over time
- Commission tracking
- Multiple trade types (BTO, STC, ROCT CALL, ROCT PUT, ROP, ROC)
- Status tracking (Open, Closed, Assigned, Expired, Roll)
- Symbol filtering and autocomplete
- Inline editing of trade fields

## Setup

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Set up environment variables:
Create a `.env` file with your Alpha Vantage API key:
```
ALPHA_VANTAGE_API_KEY=your_api_key_here
```

3. Run the application:
```bash
python app.py
```

4. Open your browser and navigate to `http://localhost:5005`

## Usage

1. **Add New Trade**: Fill out the form on the left to add a new trade
2. **View Trades**: All trades are displayed in the transposed table format
3. **Filter Trades**: Use the symbol filter and status dropdown to filter trades
4. **View Cost Basis**: Click on any stock symbol to view its cost basis summary
5. **Edit Trades**: Click the edit button or edit fields directly in the table
6. **Update Status**: Use the status dropdown to change trade status
7. **Commission Settings**: Click the gear icon to set commission per trade

## Trade Types

- **BTO**: Buy to Open
- **STC**: Sell to Close  
- **ROCT CALL**: Roll Over Covered Call
- **ROCT PUT**: Roll Over Covered Put
- **ROP**: Roll Over Put
- **ROC**: Roll Over Call

## Status Types

- **Open**: Active trade
- **Closed**: Completed trade
- **Assigned**: Option was assigned
- **Expired**: Option expired worthless
- **Roll**: Rolled to new expiration/strike

## Database

The application uses SQLite database (`trades.db`) to store all trade data. The database is automatically created when you first run the application.

## API Endpoints

- `GET /api/trades` - Get all trades
- `POST /api/trades` - Add new trade
- `DELETE /api/trades/<id>` - Delete trade
- `PUT /api/trades/<id>/status` - Update trade status
- `PUT /api/trades/<id>/field` - Update trade field
- `GET /api/cost-basis` - Get cost basis data

## Cost Basis Calculations

The cost basis table shows:
- **Shares**: Number of shares (positive for long, negative for short)
- **Cost**: Cost per share
- **Amount**: Total amount (shares × cost)
- **Closing Amount**: Amount received when closing
- **Basis**: Running total of cost basis
- **Basis/Share**: Running average cost per share

## Commission

Commission is applied per trade and affects:
- Net Credit calculations
- Cost basis calculations
- All financial metrics

Set commission using the gear icon in the header.
