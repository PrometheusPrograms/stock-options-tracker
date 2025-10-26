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
        
        # Calculate total premium based on trade type
        if trade_type in ['BTO', 'STC']:
            # For stock trades, total premium = premium * quantity (no multiplier)
            total_premium = premium * quantity
        else:
            # For options trades, total premium = premium * quantity * 100
            total_premium = premium * quantity * 100
        
        # Calculate shares based on trade type
        if trade_type == 'BTO':
            # For BTO trades, shares = quantity (positive for long position)
            shares = quantity
        elif trade_type == 'STC':
            # For STC trades, shares = -quantity (negative for short position)
            shares = -quantity
        else:
            # For options trades, shares = quantity * 100
            shares = quantity * 100
        
        # Calculate cost_per_share based on trade type
        if trade_type == 'BTO':
            # For BTO trades, cost_per_share = strike_price (purchase price)
            cost_per_share = strike_price
        elif trade_type == 'STC':
            # For STC trades, cost_per_share = strike_price (sale price)
            cost_per_share = strike_price
        else:
            # For options trades, cost_per_share = 0 (not applicable)
            cost_per_share = 0
        
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO trades (ticker, trade_date, expiration_date, quantity, premium, total_premium, days_to_expiration, current_price, strike_price, trade_type, shares, cost_per_share)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (ticker, trade_date, expiration_date, quantity, premium, total_premium, days_to_expiration, current_price, strike_price, trade_type, shares, cost_per_share))
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

@app.route('/api/trades/<int:trade_id>', methods=['PUT'])
def update_trade(trade_id):
    try:
        data = request.get_json()
        
        # Validate required fields
        required_fields = ['ticker', 'tradeDate', 'expirationDate', 'strikePrice', 'premium', 'quantity', 'tradeType']
        for field in required_fields:
            if field not in data:
                return jsonify({'error': f'Missing required field: {field}'}), 400
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Check if trade exists
        cursor.execute('SELECT id FROM trades WHERE id = ?', (trade_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({'error': 'Trade not found'}), 404
        
        # Update the trade
        cursor.execute('''
            UPDATE trades SET 
                ticker = ?, trade_date = ?, expiration_date = ?, strike_price = ?, 
                premium = ?, quantity = ?, trade_type = ?, current_price = ?
            WHERE id = ?
        ''', (
            data['ticker'],
            data['tradeDate'],
            data['expirationDate'],
            data['strikePrice'],
            data['premium'],
            data['quantity'],
            data['tradeType'],
            data.get('currentPrice', 0),
            trade_id
        ))
        
        conn.commit()
        conn.close()
        
        return jsonify({'success': True, 'message': 'Trade updated successfully'})
    except Exception as e:
        print(f'Error updating trade: {e}')
        return jsonify({'error': 'Failed to update trade'}), 500

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
            # Only delete cost basis entry if trade type is ROC, CALL, ROP, or PUT
            trade_type = trade['trade_type'] or ''
            if 'ROC' in trade_type or 'CALL' in trade_type or 'ROP' in trade_type or 'PUT' in trade_type:
                # Delete the corresponding assigned cost basis entry
                delete_assigned_cost_basis_entry(trade, cursor)
        
        # Update the status
        cursor.execute('UPDATE trades SET status = ? WHERE id = ?', (status, trade_id))
        
        # Check if status changed to "assigned" and trade type has "ROC", "CALL", "ROP", or "PUT"
        if status == 'assigned':
            trade_type = trade['trade_type'] or ''
            if 'ROC' in trade_type or 'CALL' in trade_type or 'ROP' in trade_type or 'PUT' in trade_type:
                # Create automatic cost basis entry for assigned CALL/ROC/PUT/ROP
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
        
        # Create trade description based on original trade type
        original_trade_type = trade['trade_type'] or ''
        if 'ROP' in original_trade_type or 'PUT' in original_trade_type:
            trade_description = f"Assigned {expiration_formatted} PUT"
        elif 'ROC' in original_trade_type or 'CALL' in original_trade_type:
            trade_description = f"Assigned {expiration_formatted} CALL"
        else:
            trade_description = f"Assigned {expiration_formatted} CALL"  # Default fallback
        
        # Calculate values as specified:
        # Shares = shares (original shares)
        shares = trade['shares']  # Use existing shares value instead of recalculating
        
        # Cost = strike price
        cost = trade['strike_price']
        
        # Amount calculation based on trade type
        if 'ROP' in trade['trade_type'] or 'PUT' in trade['trade_type']:
            # Assigned PUT: amount = cost * shares (positive shares for long position)
            amount = trade['strike_price'] * shares
        elif 'ROC' in trade['trade_type'] or 'CALL' in trade['trade_type']:
            # Assigned CALL: amount = cost * -shares (negative shares for short position)
            amount = trade['strike_price'] * (-shares)
        else:
            # Fallback to original logic
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

@app.route('/api/company-search')
def search_companies():
    try:
        query = request.args.get('query', '').strip()
        if not query:
            return jsonify({'companies': [], 'query': query, 'source': 'empty_query'})
        
        # Try Alpha Vantage API first
        api_key = os.getenv('ALPHA_VANTAGE_API_KEY')
        if api_key:
            try:
                url = f'https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords={query}&apikey={api_key}'
                response = requests.get(url, timeout=10)
                data = response.json()
                
                if 'bestMatches' in data and data['bestMatches']:
                    companies = []
                    for match in data['bestMatches'][:10]:  # Limit to 10 results
                        companies.append({
                            'symbol': match['1. symbol'],
                            'name': match['2. name'],
                            'type': match['3. type'],
                            'region': match['4. region']
                        })
                    return jsonify({'companies': companies, 'query': query, 'source': 'alpha_vantage'})
            except Exception as e:
                print(f'Alpha Vantage API error: {e}')
        
        # Fallback to static data
        static_companies = [
            {'symbol': 'AAPL', 'name': 'Apple Inc.'},
            {'symbol': 'MSFT', 'name': 'Microsoft Corporation'},
            {'symbol': 'GOOGL', 'name': 'Alphabet Inc.'},
            {'symbol': 'AMZN', 'name': 'Amazon.com Inc.'},
            {'symbol': 'TSLA', 'name': 'Tesla Inc.'},
            {'symbol': 'META', 'name': 'Meta Platforms Inc.'},
            {'symbol': 'NVDA', 'name': 'NVIDIA Corporation'},
            {'symbol': 'NFLX', 'name': 'Netflix Inc.'},
            {'symbol': 'AMD', 'name': 'Advanced Micro Devices Inc.'},
            {'symbol': 'INTC', 'name': 'Intel Corporation'},
            {'symbol': 'RIVN', 'name': 'Rivian Automotive Inc.'},
            {'symbol': 'SPY', 'name': 'SPDR S&P 500 ETF Trust'},
            {'symbol': 'QQQ', 'name': 'Invesco QQQ Trust'},
            {'symbol': 'IWM', 'name': 'iShares Russell 2000 ETF'},
            {'symbol': 'VTI', 'name': 'Vanguard Total Stock Market ETF'}
        ]
        
        # Filter static companies by query
        filtered_companies = [c for c in static_companies 
                             if query.upper() in c['symbol'].upper() or query.upper() in c['name'].upper()]
        
        return jsonify({'companies': filtered_companies[:10], 'query': query, 'source': 'static'})
        
    except Exception as e:
        print(f'Error in company search: {e}')
        return jsonify({'companies': [], 'query': query, 'error': str(e)}), 500

@app.route('/api/cost-basis')
def get_cost_basis():
    try:
        # Get commission from query parameter (default to 0)
        commission = float(request.args.get('commission', 0.0))
        
        # Get ticker from query parameter (optional)
        ticker = request.args.get('ticker')
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        if ticker:
            cursor.execute('SELECT * FROM trades WHERE ticker = ? AND ticker IS NOT NULL AND ticker != "" ORDER BY ticker, trade_date ASC', (ticker,))
        else:
            cursor.execute('SELECT * FROM trades WHERE ticker IS NOT NULL AND ticker != "" ORDER BY ticker, trade_date ASC')
        
        trades = cursor.fetchall()
        conn.close()
        
        # Group trades by ticker
        ticker_groups = {}
        for trade in trades:
            ticker = trade['ticker']
            if ticker not in ticker_groups:
                ticker_groups[ticker] = []
            # Create a deep copy to avoid modifying original data
            trade_copy = dict(trade)
            ticker_groups[ticker].append(trade_copy)
        
        result = []
        for ticker, trades_list in ticker_groups.items():
            # Sort trades by trade date (ascending - oldest first)
            trades_list.sort(key=lambda x: x['trade_date'])
            
            # Calculate running totals for basis column
            running_basis = 0
            running_shares = 0
            
            for trade in trades_list:
                # Generate trade description if not already present
                if not trade.get('trade_description'):
                    if trade['trade_type'] == 'BTO':
                        trade['trade_description'] = f"BTO {trade['quantity']} {trade['ticker']}"
                    elif trade['trade_type'] == 'STC':
                        trade['trade_description'] = f"STC {trade['quantity']} {trade['ticker']}"
                    elif trade['trade_type'] == 'ASSIGNED':
                        # Format expiration date to DD-MMM-YY
                        try:
                            exp_date = datetime.strptime(str(trade['expiration_date']), '%Y-%m-%d')
                            formatted_date = exp_date.strftime('%d-%b-%y').upper()
                        except:
                            formatted_date = str(trade['expiration_date'])
                        
                        if 'PUT' in trade.get('trade_description', '') or 'put' in trade.get('trade_description', '').lower():
                            trade['trade_description'] = f"Assigned {formatted_date} PUT"
                        elif 'CALL' in trade.get('trade_description', '') or 'call' in trade.get('trade_description', '').lower():
                            trade['trade_description'] = f"Assigned {formatted_date} CALL"
                        else:
                            trade['trade_description'] = f"Assigned {formatted_date}"
                    elif trade['trade_type'] not in ['BTO', 'STC', 'ASSIGNED']:
                        # Format expiration date to DD-MMM-YY
                        try:
                            exp_date = datetime.strptime(str(trade['expiration_date']), '%Y-%m-%d')
                            formatted_date = exp_date.strftime('%d-%b-%y').upper()
                        except:
                            formatted_date = str(trade['expiration_date'])
                        
                        if 'ROP' in trade['trade_type'] or 'put' in trade['trade_type'].lower():
                            trade['trade_description'] = f"SELL -{trade['quantity']} {trade['ticker']} 100 {formatted_date} {trade['strike_price']} PUT @{trade['premium']}"
                        elif 'ROC' in trade['trade_type'] or 'call' in trade['trade_type'].lower():
                            trade['trade_description'] = f"SELL -{trade['quantity']} {trade['ticker']} 100 {formatted_date} {trade['strike_price']} CALL @{trade['premium']}"
                        else:
                            trade['trade_description'] = f"{trade['trade_type']} {trade['quantity']} {trade['ticker']} @ {trade['premium']}"
                
                # Calculate basis for this trade based on trade type
                if trade['trade_type'] == 'BTO':
                    # Buy to Open: shares = quantity, cost = strike_price (purchase price)
                    trade['shares'] = trade['quantity']
                    trade['cost_per_share'] = trade['strike_price']  # Purchase price
                    trade['amount'] = trade['quantity'] * trade['strike_price']
                    trade['basis'] = trade['amount']  # Will be updated with running basis later
                elif trade['trade_type'] == 'STC':
                    # Sell to Close: amount = shares * cost_per_share (shares are already negative)
                    # This gives negative amount (money received from selling)
                    trade['basis'] = trade['shares'] * trade['cost_per_share']
                    trade['amount'] = trade['shares'] * trade['cost_per_share']
                elif trade['trade_type'] == 'ASSIGNED':
                    # Assigned: differentiate between CALL and PUT
                    if 'CALL' in trade.get('trade_description', ''):
                        # Assigned CALL: amount = cost * shares (shares are already negative for short position)
                        trade['basis'] = trade['strike_price'] * trade['shares']
                        trade['amount'] = trade['strike_price'] * trade['shares']
                    elif 'PUT' in trade.get('trade_description', ''):
                        # Assigned PUT: amount = cost * shares (positive shares for long position)
                        trade['basis'] = trade['strike_price'] * trade['shares']
                        trade['amount'] = trade['strike_price'] * trade['shares']
                    else:
                        # Fallback to original logic if no CALL/PUT specified
                        trade['basis'] = -(trade['shares'] * trade['strike_price'])
                        trade['amount'] = -(trade['shares'] * trade['strike_price'])
                elif 'SELL' in trade.get('trade_description', ''):
                    # SELL trades: shares = 0, cost = 0, amount = -net_credit_total
                    # net_credit_total = (premium - commission) * quantity * 100
                    net_credit_per_share = trade['premium'] - commission
                    net_credit_total = net_credit_per_share * trade['quantity'] * 100
                    
                    trade['shares'] = 0
                    trade['cost_per_share'] = 0
                    trade['amount'] = -net_credit_total
                    trade['basis'] = trade['amount']
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
        cursor.execute('SELECT * FROM trades WHERE ticker IS NOT NULL AND ticker != "" AND trade_type NOT IN ("BTO", "STC", "ASSIGNED")')
        trades = cursor.fetchall()
        conn.close()
        
        # Calculate summary statistics
        total_trades = len(trades)
        open_trades = len([t for t in trades if t['status'] == 'open'])
        closed_trades = len([t for t in trades if t['status'] == 'closed'])
        
        # Calculate wins and losses based on net credit total
        wins = len([t for t in trades if t['total_premium'] > 0])
        losses = len([t for t in trades if t['total_premium'] < 0])
        winning_percentage = (wins / total_trades * 100) if total_trades > 0 else 0
        
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
            'wins': wins,
            'losses': losses,
            'winning_percentage': round(winning_percentage, 1),
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
        # Get filter parameters from query string
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Build query with optional date filtering
        query = 'SELECT * FROM trades WHERE trade_type NOT IN ("BTO", "STC", "ASSIGNED")'
        params = []
        
        if start_date:
            query += ' AND trade_date >= ?'
            params.append(start_date)
        if end_date:
            query += ' AND trade_date <= ?'
            params.append(end_date)
            
        query += ' ORDER BY trade_date ASC'
        
        cursor.execute(query, params)
        trades = cursor.fetchall()
        conn.close()
        
        # Group by date and calculate daily premium
        daily_premiums = {}
        for trade in trades:
            date = trade['trade_date']
            if date not in daily_premiums:
                daily_premiums[date] = 0
            daily_premiums[date] += trade['total_premium']
        
        # Convert to arrays for chart and format dates
        dates = sorted(daily_premiums.keys())
        formatted_dates = []
        for date in dates:
            try:
                # Parse the date and format it for display
                parsed_date = datetime.strptime(str(date), '%Y-%m-%d')
                formatted_dates.append(parsed_date.strftime('%m/%d'))
            except:
                # Fallback to original date if parsing fails
                formatted_dates.append(str(date))
        
        premiums = [daily_premiums[date] for date in dates]
        
        return jsonify({
            'dates': formatted_dates,
            'premiums': premiums
        })
    except Exception as e:
        print(f'Error fetching chart data: {e}')
        return jsonify({'error': 'Failed to fetch chart data'}), 500

@app.route('/test')
def test_endpoint():
    """Simple test endpoint to verify app is running"""
    return 'App is running!', 200

@app.route('/webhook/deploy', methods=['POST'])
def webhook_deploy():
    """Webhook endpoint for automatic deployment from GitHub"""
    try:
        import subprocess
        import os
        import hmac
        import hashlib
        
        # Optional: Verify webhook secret for security
        # webhook_secret = os.environ.get('WEBHOOK_SECRET', '')
        # if webhook_secret:
        #     signature = request.headers.get('X-Hub-Signature-256', '')
        #     if not signature.startswith('sha256='):
        #         return 'Invalid signature', 401
        #     
        #     expected_signature = 'sha256=' + hmac.new(
        #         webhook_secret.encode(),
        #         request.get_data(),
        #         hashlib.sha256
        #     ).hexdigest()
        #     
        #     if not hmac.compare_digest(signature, expected_signature):
        #         return 'Signature mismatch', 401
        
        # Change to the project directory
        project_dir = '/home/PrometheusPrograms/stock-options-tracker'
        
        # Pull latest changes from GitHub
        result = subprocess.run(['git', 'pull'], 
                              cwd=project_dir, 
                              capture_output=True, 
                              text=True)
        
        if result.returncode == 0:
            print(f"Deployment successful: {result.stdout}")
            return 'Deployment successful', 200
        else:
            print(f"Deployment failed: {result.stderr}")
            return f'Deployment failed: {result.stderr}', 500
            
    except Exception as e:
        print(f"Webhook deployment error: {e}")
        return f'Deployment error: {str(e)}', 500

if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5005)
