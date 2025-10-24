from flask import Flask, render_template, request, jsonify
import sqlite3
import os
from datetime import datetime, timedelta
import requests
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

app = Flask(__name__)

# Database configuration
DATABASE = 'trades.db'

def get_db_connection():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Create trades table with all necessary columns
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            trade_date TEXT NOT NULL,
            expiration_date TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            premium REAL NOT NULL,
            total_premium REAL NOT NULL,
            days_to_expiration INTEGER NOT NULL,
            current_price REAL NOT NULL,
            strike_price REAL DEFAULT 0,
            status TEXT DEFAULT 'open',
            trade_type TEXT DEFAULT 'ROCT PUT',
            shares INTEGER DEFAULT 0,
            cost_per_share REAL DEFAULT 0,
            total_cost REAL DEFAULT 0,
            closing_amount REAL DEFAULT 0,
            transaction_type TEXT DEFAULT 'sell',
            trade_description TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    # Add trade_description column if it doesn't exist (migration)
    try:
        cursor.execute('ALTER TABLE trades ADD COLUMN trade_description TEXT DEFAULT ""')
    except sqlite3.OperationalError:
        pass  # Column already exists
    
    conn.commit()
    conn.close()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/trades', methods=['GET'])
def get_trades():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM trades ORDER BY created_at DESC')
        trades = cursor.fetchall()
        conn.close()
        
        trades_list = []
        for trade in trades:
            trades_list.append(dict(trade))
        
        return jsonify(trades_list)
    except Exception as e:
        print(f'Error fetching trades: {e}')
        return jsonify({'error': 'Failed to fetch trades'}), 500

@app.route('/api/trades', methods=['POST'])
def add_trade():
    try:
        data = request.get_json()
        ticker = data['ticker'].upper()
        trade_date = data['tradeDate']
        expiration_date = data['expirationDate']
        quantity = int(data['quantity'])
        premium = float(data['premium'])
        current_price = float(data['currentPrice'])
        strike_price = float(data.get('strikePrice', 0))
        trade_type = data.get('tradeType', 'ROCT PUT')
        
        # Calculate days to expiration
        trade_date_obj = datetime.strptime(trade_date, '%Y-%m-%d').date()
        expiration = datetime.strptime(expiration_date, '%Y-%m-%d').date()
        days_to_expiration = (expiration - trade_date_obj).days
        
        # Calculate total premium
        total_premium = premium * quantity * 100
        
        # Calculate shares
        shares = quantity * 100
        
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO trades (ticker, trade_date, expiration_date, quantity, premium, total_premium, days_to_expiration, current_price, strike_price, trade_type, shares)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (ticker, trade_date, expiration_date, quantity, premium, total_premium, days_to_expiration, current_price, strike_price, trade_type, shares))
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'message': 'Trade added successfully'})
    except Exception as e:
        print(f'Error adding trade: {e}')
        return jsonify({'error': 'Failed to add trade'}), 500

@app.route('/api/trades/<int:trade_id>', methods=['DELETE'])
def delete_trade(trade_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Check if trade exists
        cursor.execute('SELECT id FROM trades WHERE id = ?', (trade_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({'error': 'Trade not found'}), 404
        
        # Delete the trade
        cursor.execute('DELETE FROM trades WHERE id = ?', (trade_id,))
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'message': 'Trade deleted successfully'})
    except Exception as e:
        print(f'Error deleting trade: {e}')
        return jsonify({'error': 'Failed to delete trade'}), 500

@app.route('/api/trades/<int:trade_id>/status', methods=['PUT'])
def update_trade_status(trade_id):
    try:
        data = request.get_json()
        status = data.get('status')
        
        if status not in ['open', 'closed', 'assigned', 'expired', 'roll']:
            return jsonify({'error': 'Invalid status. Must be open, closed, assigned, expired, or roll'}), 400
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Get the trade details before updating
        cursor.execute('SELECT * FROM trades WHERE id = ?', (trade_id,))
        trade = cursor.fetchone()
        
        if not trade:
            conn.close()
            return jsonify({'error': 'Trade not found'}), 404
        
        # Check if status is changing from "assigned" to something else
        old_status = trade['status']
        if old_status == 'assigned' and status != 'assigned':
            # Only delete cost basis entry if trade type is ROC or CALL
            trade_type = trade['trade_type'] or ''
            if 'ROC' in trade_type or 'CALL' in trade_type:
                # Delete the corresponding assigned cost basis entry
                delete_assigned_cost_basis_entry(trade, cursor)
        
        # Update the status
        cursor.execute('UPDATE trades SET status = ? WHERE id = ?', (status, trade_id))
        
        # Check if status changed to "assigned" and trade type has "ROC" or "CALL"
        if status == 'assigned':
            trade_type = trade['trade_type'] or ''
            if 'ROC' in trade_type or 'CALL' in trade_type:
                # Create automatic cost basis entry for assigned CALL/ROC
                create_assigned_cost_basis_entry(trade, cursor)
        
        # Check if status changed to "roll" - create duplicate entry
        if status == 'roll':
            create_roll_duplicate_entry(trade, cursor)
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'status': status})
    except Exception as e:
        print(f'Error updating trade status: {e}')
        return jsonify({'error': 'Failed to update trade status'}), 500

def create_assigned_cost_basis_entry(trade, cursor):
    """Create automatic cost basis entry for assigned CALL/ROC trades"""
    try:
        # Check if an assigned entry already exists for this trade
        cursor.execute('''
            SELECT COUNT(*) as count FROM trades 
            WHERE ticker = ? AND trade_type = 'ASSIGNED' AND trade_description LIKE ?
        ''', (trade['ticker'], f"Assigned {trade['expiration_date']}%"))
        
        existing_count = cursor.fetchone()['count']
        if existing_count > 0:
            print(f"Assigned cost basis entry already exists for trade {trade['id']}, skipping creation")
            return
        
        # Format expiration date as DD-MMM-YY
        try:
            from datetime import datetime
            exp_date = datetime.strptime(trade['expiration_date'], '%Y-%m-%d')
            expiration_formatted = exp_date.strftime('%d-%b-%y').upper()
        except:
            expiration_formatted = trade['expiration_date']  # Fallback
        
        # Create trade description: "Assigned [expiration date] CALL"
        trade_description = f"Assigned {expiration_formatted} CALL"
        
        # Calculate values as specified:
        # Shares = shares (original shares)
        shares = trade['quantity'] * 100
        
        # Cost = strike price
        cost = trade['strike_price']
        
        # Amount = -(shares * strike) (negative for assigned trades)
        amount = -(shares * trade['strike_price'])
        
        # Insert cost basis transaction into database
        # For assigned trades, use expiration_date as trade_date
        cursor.execute('''
            INSERT INTO trades (ticker, trade_date, expiration_date, quantity, premium, total_premium, days_to_expiration, current_price, status, trade_type, shares, cost_per_share, total_cost, closing_amount, transaction_type, trade_description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (trade['ticker'], trade['expiration_date'], trade['expiration_date'], shares // 100, 0, 0, 0, trade['strike_price'], 'closed', 'ASSIGNED', shares, trade['strike_price'], amount, 0.0, 'buy', trade_description))
        
        print(f"Created automatic cost basis entry for assigned trade {trade['id']}: {trade_description}")
        
    except Exception as e:
        print(f"Error creating automatic cost basis entry: {e}")

def delete_assigned_cost_basis_entry(trade, cursor):
    """Delete automatic cost basis entry when status changes from assigned to something else"""
    try:
        # Find and delete the assigned cost basis entry for this trade
        cursor.execute('''
            DELETE FROM trades 
            WHERE ticker = ? AND trade_type = 'ASSIGNED' AND trade_description LIKE ?
        ''', (trade['ticker'], f"Assigned {trade['expiration_date']}%"))
        
        deleted_count = cursor.rowcount
        if deleted_count > 0:
            print(f"Deleted {deleted_count} assigned cost basis entry(ies) for trade {trade['id']}: {trade['ticker']}")
        else:
            print(f"No assigned cost basis entry found to delete for trade {trade['id']}: {trade['ticker']}")
        
    except Exception as e:
        print(f"Error deleting assigned cost basis entry: {e}")

def create_roll_duplicate_entry(trade, cursor):
    """Create a duplicate trade entry when status changes to roll"""
    try:
        # Get the original trade's created_at timestamp
        original_created_at = trade['created_at']
        
        # Create a timestamp that's 1 second after the original to ensure adjacency
        from datetime import datetime, timedelta
        original_datetime = datetime.fromisoformat(original_created_at.replace('Z', '+00:00'))
        new_created_at = (original_datetime + timedelta(seconds=1)).isoformat()
        
        # Create a duplicate of the original trade with status 'open'
        # Use the same values as the original trade but with a slightly newer created_at
        cursor.execute('''
            INSERT INTO trades (ticker, trade_date, expiration_date, quantity, premium, total_premium, days_to_expiration, current_price, strike_price, status, trade_type, shares, cost_per_share, total_cost, closing_amount, transaction_type, trade_description, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            trade['ticker'], 
            trade['trade_date'], 
            trade['expiration_date'], 
            trade['quantity'], 
            trade['premium'], 
            trade['total_premium'], 
            trade['days_to_expiration'], 
            trade['current_price'], 
            trade['strike_price'],  # Added missing strike_price field
            'open',  # New trade starts as open
            trade['trade_type'], 
            trade['shares'], 
            trade['cost_per_share'], 
            trade['total_cost'], 
            trade['closing_amount'], 
            trade['transaction_type'], 
            trade['trade_description'],
            new_created_at  # Set specific created_at to ensure adjacency
        ))
        
        print(f"Created roll duplicate entry for trade {trade['id']}: {trade['ticker']} {trade['trade_type']} with created_at: {new_created_at}")
        
    except Exception as e:
        print(f"Error creating roll duplicate entry: {e}")

@app.route('/api/trades/<int:trade_id>/field', methods=['PUT'])
def update_trade_field(trade_id):
    try:
        data = request.get_json()
        field_name = data.get('field')
        new_value = data.get('value')
        
        if not field_name or new_value is None:
            return jsonify({'error': 'Field name and value are required'}), 400
        
        # Validate field name
        allowed_fields = ['trade_date', 'expiration_date', 'current_price', 'strike_price', 'premium', 'quantity']
        if field_name not in allowed_fields:
            return jsonify({'error': f'Field {field_name} is not editable'}), 400
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Check if trade exists
        cursor.execute('SELECT * FROM trades WHERE id = ?', (trade_id,))
        trade = cursor.fetchone()
        
        if not trade:
            conn.close()
            return jsonify({'error': 'Trade not found'}), 404
        
        # Update the field
        cursor.execute(f'UPDATE trades SET {field_name} = ? WHERE id = ?', (new_value, trade_id))
        
        # Recalculate days_to_expiration if trade_date or expiration_date changed
        if field_name in ['trade_date', 'expiration_date']:
            cursor.execute('SELECT trade_date, expiration_date FROM trades WHERE id = ?', (trade_id,))
            dates = cursor.fetchone()
            if dates['trade_date'] and dates['expiration_date']:
                trade_date_obj = datetime.strptime(dates['trade_date'], '%Y-%m-%d').date()
                expiration = datetime.strptime(dates['expiration_date'], '%Y-%m-%d').date()
                days_to_expiration = (expiration - trade_date_obj).days
                cursor.execute('UPDATE trades SET days_to_expiration = ? WHERE id = ?', (days_to_expiration, trade_id))
        
        # Recalculate total_premium if premium or quantity changed
        if field_name in ['premium', 'quantity']:
            cursor.execute('SELECT premium, quantity FROM trades WHERE id = ?', (trade_id,))
            values = cursor.fetchone()
            total_premium = values['premium'] * values['quantity'] * 100
            cursor.execute('UPDATE trades SET total_premium = ? WHERE id = ?', (total_premium, trade_id))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'field': field_name, 'value': new_value})
    except Exception as e:
        print(f'Error updating trade field: {e}')
        return jsonify({'error': 'Failed to update trade field'}), 500

@app.route('/api/cost-basis')
def get_cost_basis():
    try:
        # Get commission from query parameter (default to 0)
        commission = float(request.args.get('commission', 0.0))
        
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM trades ORDER BY ticker, trade_date ASC')
        trades = cursor.fetchall()
        conn.close()
        
        # Group trades by ticker
        ticker_groups = {}
        for trade in trades:
            ticker = trade['ticker']
            if ticker not in ticker_groups:
                ticker_groups[ticker] = []
            ticker_groups[ticker].append(dict(trade))
        
        result = []
        for ticker, trades_list in ticker_groups.items():
            # Sort trades by trade date (ascending - oldest first)
            trades_list.sort(key=lambda x: x['trade_date'])
            
            # Calculate running totals for basis column
            running_basis = 0
            running_shares = 0
            
            for trade in trades_list:
                # Calculate basis for this trade based on trade type
                if trade['trade_type'] == 'BTO':
                    # Buy to Open: basis = shares * cost_per_share
                    trade['basis'] = trade['shares'] * trade['cost_per_share']
                    trade['amount'] = trade['shares'] * trade['cost_per_share']
                elif trade['trade_type'] == 'STC':
                    # Sell to Close: basis = -(shares * cost_per_share)
                    trade['basis'] = -(trade['shares'] * trade['cost_per_share'])
                    trade['amount'] = -(trade['shares'] * trade['cost_per_share'])
                elif trade['trade_type'] == 'ASSIGNED':
                    # Assigned: basis = -(shares * strike_price)
                    trade['basis'] = -(trade['shares'] * trade['strike_price'])
                    trade['amount'] = -(trade['shares'] * trade['strike_price'])
                elif trade['trade_type'] not in ['BTO', 'STC', 'ASSIGNED']:
                    # Options trades: basis = -(premium * quantity * 100) - (commission * shares)
                    # For options, shares = quantity * 100
                    shares = trade['quantity'] * 100
                    trade['basis'] = -(trade['premium'] * trade['quantity'] * 100) - (commission * shares)
                    trade['amount'] = -(trade['premium'] * trade['quantity'] * 100) - (commission * shares)
                
                # Update running totals
                running_shares += trade['shares']
                running_basis += trade['basis']
                
                # Update the trade with running totals
                trade['running_basis'] = running_basis
                trade['running_shares'] = running_shares
                
                # Calculate running basis per share
                # If total shares are 0, use the same value as basis
                try:
                    if running_shares == 0:
                        trade['running_basis_per_share'] = running_basis
                    else:
                        trade['running_basis_per_share'] = running_basis / running_shares
                except (ZeroDivisionError, TypeError):
                    trade['running_basis_per_share'] = running_basis
            
            # Calculate totals
            total_shares = sum(trade['shares'] for trade in trades_list)
            total_cost_basis = sum(trade['basis'] for trade in trades_list)
            
            try:
                if total_shares != 0:
                    total_cost_basis_per_share = total_cost_basis / total_shares
                else:
                    total_cost_basis_per_share = 0
            except (ZeroDivisionError, TypeError):
                total_cost_basis_per_share = 0
            
            result.append({
                'ticker': ticker,
                'total_shares': total_shares,
                'total_cost_basis': total_cost_basis,
                'total_cost_basis_per_share': total_cost_basis_per_share,
                'trades': trades_list
            })
        
        return jsonify(result)
    except Exception as e:
        print(f'Error fetching cost basis: {e}')
        return jsonify({'error': 'Failed to fetch cost basis'}), 500

@app.route('/api/summary')
def get_summary():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM trades WHERE trade_type NOT IN ("BTO", "STC", "ASSIGNED")')
        trades = cursor.fetchall()
        conn.close()
        
        # Calculate summary statistics
        total_trades = len(trades)
        open_trades = len([t for t in trades if t['status'] == 'open'])
        closed_trades = len([t for t in trades if t['status'] == 'closed'])
        
        # Calculate total net credit
        total_net_credit = sum(t['total_premium'] for t in trades)
        
        # Calculate days remaining (days until end of year)
        today = datetime.now().date()
        end_of_year = datetime(today.year, 12, 31).date()
        days_remaining = (end_of_year - today).days
        
        # Calculate days done (days since start of year)
        start_of_year = datetime(today.year, 1, 1).date()
        days_done = (today - start_of_year).days
        
        return jsonify({
            'total_trades': total_trades,
            'open_trades': open_trades,
            'closed_trades': closed_trades,
            'total_net_credit': total_net_credit,
            'days_remaining': days_remaining,
            'days_done': days_done
        })
    except Exception as e:
        print(f'Error fetching summary: {e}')
        return jsonify({'error': 'Failed to fetch summary'}), 500

@app.route('/api/chart-data')
def get_chart_data():
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM trades WHERE trade_type NOT IN ("BTO", "STC", "ASSIGNED") ORDER BY trade_date ASC')
        trades = cursor.fetchall()
        conn.close()
        
        # Group by date and calculate daily premium
        daily_premiums = {}
        for trade in trades:
            date = trade['trade_date']
            if date not in daily_premiums:
                daily_premiums[date] = 0
            daily_premiums[date] += trade['total_premium']
        
        # Convert to arrays for chart
        dates = sorted(daily_premiums.keys())
        premiums = [daily_premiums[date] for date in dates]
        
        return jsonify({
            'dates': dates,
            'premiums': premiums
        })
    except Exception as e:
        print(f'Error fetching chart data: {e}')
        return jsonify({'error': 'Failed to fetch chart data'}), 500

if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5005)
