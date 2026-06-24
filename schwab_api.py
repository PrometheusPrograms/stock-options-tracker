"""
Schwab API Integration Module
Handles authentication and data retrieval from Charles Schwab API
"""
import os
import json
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
import logging

try:
    from schwab.client import Client as SchwabClient  # v1.x uses Client, not SchwabClient
    from schwab.auth import easy_client, client_from_token_file
    SCHWAB_AVAILABLE = True
except ImportError:
    SCHWAB_AVAILABLE = False
    logging.warning("schwab-py library not installed. Install with: pip install schwab-py")

logger = logging.getLogger(__name__)


class SchwabAPIClient:
    """Wrapper for Schwab API operations"""
    
    def __init__(self):
        self.client = None
        self._initialize_client()
    
    def _initialize_client(self):
        """Initialize Schwab API client with OAuth credentials"""
        if not SCHWAB_AVAILABLE:
            logger.error("Schwab API library not available")
            return
        
        try:
            # Get credentials from environment variables
            app_key = os.getenv('SCHWAB_APP_KEY')
            app_secret = os.getenv('SCHWAB_APP_SECRET')
            redirect_uri = os.getenv('SCHWAB_REDIRECT_URI', 'http://localhost:5005/auth/schwab/callback')
            token_file = os.getenv('SCHWAB_TOKEN_FILE', 'schwab_tokens.json')
            
            if not app_key or not app_secret:
                logger.warning("Schwab API credentials not found in environment variables")
                return
            
            # Use easy_client which handles OAuth flow automatically
            # It will check for existing tokens and prompt for auth if needed
            try:
                # Prefer loading from existing token file (no browser prompt needed)
                if os.path.exists(token_file):
                    try:
                        from schwab.auth import client_from_token_file
                        self.client = client_from_token_file(token_file, app_key, app_secret)
                        logger.info("Schwab client initialized from token file")
                    except Exception as tf_err:
                        logger.warning(f"client_from_token_file failed: {tf_err}, trying easy_client")
                        self.client = easy_client(
                            app_key=app_key,
                            app_secret=app_secret,
                            redirect_uri=redirect_uri,
                            token_path=token_file
                        )
                else:
                    self.client = easy_client(
                        app_key=app_key,
                        app_secret=app_secret,
                        redirect_uri=redirect_uri,
                        token_path=token_file
                    )
                logger.info("Schwab client initialized successfully")
            except Exception as auth_error:
                logger.warning(f"Could not initialize Schwab client: {auth_error}")
                logger.info("User needs to authenticate via the web interface")
                self.client = None
                
        except Exception as e:
            logger.error(f"Error initializing Schwab client: {e}")
            self.client = None
    
    def _load_tokens(self, token_file: str) -> Optional[Dict]:
        """Load OAuth tokens from file"""
        try:
            if os.path.exists(token_file):
                with open(token_file, 'r') as f:
                    return json.load(f)
        except Exception as e:
            logger.error(f"Error loading tokens: {e}")
        return None
    
    def _save_tokens(self, token_file: str, tokens: Dict):
        """Save OAuth tokens to file"""
        try:
            with open(token_file, 'w') as f:
                json.dump(tokens, f, indent=2)
        except Exception as e:
            logger.error(f"Error saving tokens: {e}")
    
    def _refresh_token_if_needed(self):
        """
        Check if the access token is expired and refresh it using the refresh token.
        Schwab access tokens last 30 min; refresh tokens last 7 days.
        schwab-py should handle this automatically but doesn't always, so we do it explicitly.
        """
        if not SCHWAB_AVAILABLE:
            return
        try:
            import base64, requests as _req, time as _time
            token_file = os.getenv('SCHWAB_TOKEN_FILE', 'schwab_tokens.json')
            if not os.path.exists(token_file):
                return
            with open(token_file) as f:
                stored = json.load(f)

            created = stored.get('creation_timestamp', 0)
            token   = stored.get('token', stored)  # support both wrapped and raw formats
            expires_in = token.get('expires_in', 1800)
            age = _time.time() - created

            if age < expires_in - 60:
                return  # still valid (with 60s buffer)

            refresh_token = token.get('refresh_token')
            if not refresh_token:
                logger.warning("No refresh token available — cannot auto-refresh")
                return

            app_key    = os.getenv('SCHWAB_APP_KEY')
            app_secret = os.getenv('SCHWAB_APP_SECRET')
            auth_hdr   = base64.b64encode(f'{app_key}:{app_secret}'.encode()).decode()

            r = _req.post(
                'https://api.schwabapi.com/v1/oauth/token',
                headers={'Authorization': f'Basic {auth_hdr}',
                         'Content-Type': 'application/x-www-form-urlencoded'},
                data={'grant_type': 'refresh_token', 'refresh_token': refresh_token},
                timeout=15,
            )
            if r.status_code == 200:
                new_token = r.json()
                schwab_fmt = {'creation_timestamp': _time.time(), 'token': new_token}
                with open(token_file, 'w') as f:
                    json.dump(schwab_fmt, f, indent=2)
                # Re-initialize the client with fresh tokens
                self.client = client_from_token_file(token_file, app_key, app_secret)
                logger.info("Schwab token auto-refreshed successfully")
            else:
                logger.warning(f"Token refresh failed ({r.status_code}): {r.text[:100]}")
        except Exception as e:
            logger.warning(f"Token refresh error: {e}")

    def is_authenticated(self) -> bool:
        """Check if client is authenticated"""
        return self.client is not None
    
    def get_authorization_url(self) -> str:
        """Get the OAuth authorization URL for user to visit"""
        if not SCHWAB_AVAILABLE:
            raise RuntimeError("Schwab API library not available")
        
        app_key = os.getenv('SCHWAB_APP_KEY')
        app_secret = os.getenv('SCHWAB_APP_SECRET')
        redirect_uri = os.getenv('SCHWAB_REDIRECT_URI', 'http://localhost:5005/auth/schwab/callback')
        
        if not app_key or not app_secret:
            raise ValueError("Schwab API credentials not configured")
        
        try:
            # Try to use schwab-py's OAuth helper
            from schwab.auth import oauth
            auth_url = oauth.get_authorization_url(app_key, redirect_uri)
            return auth_url
        except (ImportError, AttributeError):
            # If oauth helper doesn't exist, construct URL manually
            # Schwab OAuth URL format
            base_url = "https://api.schwabapi.com/v1/oauth/authorize"
            import urllib.parse
            params = {
                'client_id': app_key,
                'redirect_uri': redirect_uri,
                'response_type': 'code'
            }
            auth_url = f"{base_url}?{urllib.parse.urlencode(params)}"
            return auth_url
    
    def authenticate_with_code(self, authorization_code: str) -> Dict[str, Any]:
        """Complete authentication using authorization code from OAuth callback"""
        if not SCHWAB_AVAILABLE:
            raise RuntimeError("Schwab API library not available")
        
        app_key = os.getenv('SCHWAB_APP_KEY')
        app_secret = os.getenv('SCHWAB_APP_SECRET')
        redirect_uri = os.getenv('SCHWAB_REDIRECT_URI', 'http://localhost:5005/auth/schwab/callback')
        token_file = os.getenv('SCHWAB_TOKEN_FILE', 'schwab_tokens.json')
        
        if not app_key or not app_secret:
            raise ValueError("Schwab API credentials not configured")
        
        try:
            # Try to use client_from_manual_flow if available
            try:
                from schwab.auth import client_from_manual_flow
                self.client = client_from_manual_flow(
                    app_key=app_key,
                    app_secret=app_secret,
                    redirect_uri=redirect_uri,
                    token_path=token_file,
                    authorization_code=authorization_code
                )
            except (ImportError, AttributeError):
                # Fallback: manually exchange code for tokens
                import requests
                import base64
                
                # Exchange authorization code for tokens
                token_url = "https://api.schwabapi.com/v1/oauth/token"
                auth_header = base64.b64encode(f"{app_key}:{app_secret}".encode()).decode()
                
                data = {
                    'grant_type': 'authorization_code',
                    'code': authorization_code,
                    'redirect_uri': redirect_uri
                }
                
                headers = {
                    'Authorization': f'Basic {auth_header}',
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
                
                response = requests.post(token_url, data=data, headers=headers)
                response.raise_for_status()
                tokens = response.json()
                
                # Save tokens
                token_data = {
                    'access_token': tokens.get('access_token'),
                    'refresh_token': tokens.get('refresh_token'),
                    'expires_in': tokens.get('expires_in'),
                    'token_type': tokens.get('token_type', 'Bearer')
                }
                self._save_tokens(token_file, token_data)
                
                # Create client with tokens
                self.client = SchwabClient(
                    app_key=app_key,
                    app_secret=app_secret,
                    redirect_uri=redirect_uri,
                    access_token=token_data['access_token'],
                    refresh_token=token_data['refresh_token']
                )
            
            if self.client:
                return {
                    'success': True,
                    'message': 'Authentication successful',
                    'authenticated': True
                }
            else:
                return {
                    'success': False,
                    'message': 'Authentication failed',
                    'authenticated': False
                }
        except Exception as e:
            logger.error(f"Authentication error: {e}")
            return {
                'success': False,
                'message': f'Authentication error: {str(e)}',
                'authenticated': False
            }
    
    def authenticate(self) -> Dict[str, Any]:
        """Try to authenticate - will attempt easy_client if possible"""
        if not SCHWAB_AVAILABLE:
            raise RuntimeError("Schwab API library not available")
        
        app_key = os.getenv('SCHWAB_APP_KEY')
        app_secret = os.getenv('SCHWAB_APP_SECRET')
        redirect_uri = os.getenv('SCHWAB_REDIRECT_URI', 'http://localhost:5005/auth/schwab/callback')
        token_file = os.getenv('SCHWAB_TOKEN_FILE', 'schwab_tokens.json')
        
        if not app_key or not app_secret:
            raise ValueError("Schwab API credentials not configured")
        
        try:
            # Try easy_client - this works if tokens already exist or if running in CLI context
            self.client = easy_client(
                app_key=app_key,
                app_secret=app_secret,
                redirect_uri=redirect_uri,
                token_path=token_file
            )
            
            if self.client:
                return {
                    'success': True,
                    'message': 'Authentication successful',
                    'authenticated': True
                }
            else:
                # Need manual authentication
                auth_url = self.get_authorization_url()
                return {
                    'success': False,
                    'message': 'Manual authentication required',
                    'authenticated': False,
                    'auth_url': auth_url
                }
        except Exception as e:
            logger.error(f"Authentication error: {e}")
            # Try to get auth URL for manual flow
            try:
                auth_url = self.get_authorization_url()
                return {
                    'success': False,
                    'message': f'Please authenticate manually: {str(e)}',
                    'authenticated': False,
                    'auth_url': auth_url
                }
            except:
                return {
                    'success': False,
                    'message': f'Authentication error: {str(e)}. Please check your credentials.',
                    'authenticated': False
                }
    
    def get_accounts(self) -> List[Dict]:
        """Get all accounts"""
        if not self.is_authenticated():
            raise RuntimeError("Not authenticated with Schwab API")
        
        try:
            accounts = self.client.get_account_numbers()
            account_details = []
            
            for account_number in accounts:
                account = self.client.get_account(account_number)
                account_details.append({
                    'account_number': account_number,
                    'account_type': account.get('type', 'Unknown'),
                    'account_name': account.get('displayName', f'Account {account_number}'),
                    'balance': account.get('currentBalances', {}).get('cashBalance', 0),
                    'buying_power': account.get('currentBalances', {}).get('buyingPower', 0),
                    'equity': account.get('currentBalances', {}).get('equity', 0)
                })
            
            return account_details
        except Exception as e:
            logger.error(f"Error fetching accounts: {e}")
            raise
    
    def get_positions(self, account_number: Optional[str] = None) -> List[Dict]:
        """Get positions for an account or all accounts"""
        if not self.is_authenticated():
            raise RuntimeError("Not authenticated with Schwab API")
        
        try:
            if account_number:
                accounts = [account_number]
            else:
                accounts = self.client.get_account_numbers()
            
            all_positions = []
            for acc_num in accounts:
                positions = self.client.get_account(acc_num).get('positions', [])
                for pos in positions:
                    all_positions.append({
                        'account_number': acc_num,
                        'symbol': pos.get('instrument', {}).get('symbol', ''),
                        'quantity': pos.get('longQuantity', 0) - pos.get('shortQuantity', 0),
                        'average_price': pos.get('averagePrice', 0),
                        'current_price': pos.get('currentDayProfitLoss', 0),  # This might need adjustment
                        'market_value': pos.get('marketValue', 0),
                        'cost_basis': pos.get('averagePrice', 0) * (pos.get('longQuantity', 0) - pos.get('shortQuantity', 0))
                    })
            
            return all_positions
        except Exception as e:
            logger.error(f"Error fetching positions: {e}")
            raise
    
    def get_orders(self, account_number: Optional[str] = None, 
                   start_date: Optional[datetime] = None,
                   end_date: Optional[datetime] = None) -> List[Dict]:
        """Get orders (trades) for an account"""
        if not self.is_authenticated():
            raise RuntimeError("Not authenticated with Schwab API")
        
        try:
            if account_number:
                accounts = [account_number]
            else:
                accounts = self.client.get_account_numbers()
            
            # Default to last 30 days if no dates specified
            if not start_date:
                start_date = datetime.now() - timedelta(days=30)
            if not end_date:
                end_date = datetime.now()
            
            all_orders = []
            for acc_num in accounts:
                try:
                    # Get orders for the account
                    orders = self.client.get_orders(
                        account_number=acc_num,
                        from_entered_time=start_date,
                        to_entered_time=end_date
                    )
                    
                    for order in orders:
                        # Parse order details
                        order_dict = {
                            'order_id': order.get('orderId', ''),
                            'account_number': acc_num,
                            'status': order.get('status', ''),
                            'entered_time': order.get('enteredTime', ''),
                            'close_time': order.get('closeTime', ''),
                            'order_type': order.get('orderType', ''),
                            'price': order.get('price', 0),
                            'quantity': order.get('quantity', 0),
                            'filled_quantity': order.get('filledQuantity', 0),
                            'symbol': '',
                            'trade_type': '',
                            'strike_price': None,
                            'expiration_date': None,
                            'option_type': None
                        }
                        
                        # Extract instrument details
                        order_legs = order.get('orderLegCollection', [])
                        if order_legs:
                            first_leg = order_legs[0]
                            instrument = first_leg.get('instrument', {})
                            order_dict['symbol'] = instrument.get('symbol', '')
                            
                            # Check if it's an option
                            asset_type = instrument.get('assetType', '')
                            if asset_type == 'OPTION':
                                order_dict['trade_type'] = 'OPTION'
                                order_dict['strike_price'] = instrument.get('strikePrice', 0)
                                order_dict['expiration_date'] = instrument.get('expirationDate', '')
                                order_dict['option_type'] = instrument.get('putCall', '')
                            else:
                                order_dict['trade_type'] = asset_type
                        
                        all_orders.append(order_dict)
                        
                except Exception as e:
                    logger.warning(f"Error fetching orders for account {acc_num}: {e}")
                    continue
            
            return all_orders
        except Exception as e:
            logger.error(f"Error fetching orders: {e}")
            raise
    
    def get_quotes(self, symbols: List[str]) -> Dict[str, Dict]:
        """Get real-time quotes for symbols"""
        if not self.is_authenticated():
            raise RuntimeError("Not authenticated with Schwab API")
        
        try:
            quotes = self.client.get_quotes(symbols)
            quote_dict = {}
            
            for symbol, quote in quotes.items():
                quote_dict[symbol] = {
                    'symbol': symbol,
                    'bid': quote.get('bidPrice', 0),
                    'ask': quote.get('askPrice', 0),
                    'last': quote.get('lastPrice', 0),
                    'volume': quote.get('totalVolume', 0),
                    'high': quote.get('highPrice', 0),
                    'low': quote.get('lowPrice', 0),
                    'open': quote.get('openPrice', 0),
                    'close': quote.get('closePrice', 0),
                    'timestamp': quote.get('quoteTime', '')
                }
            
            return quote_dict
        except Exception as e:
            logger.error(f"Error fetching quotes: {e}")
            raise
    
    def get_historical_data(self, symbol: str, 
                           start_date: datetime,
                           end_date: datetime,
                           period_type: str = 'day',
                           frequency_type: str = 'daily',
                           frequency: int = 1) -> List[Dict]:
        """Get historical price data for a symbol"""
        if not self.is_authenticated():
            raise RuntimeError("Not authenticated with Schwab API")
        
        try:
            # Convert dates to epoch milliseconds
            start_epoch = int(start_date.timestamp() * 1000)
            end_epoch = int(end_date.timestamp() * 1000)
            
            candles = self.client.get_price_history(
                symbol=symbol,
                period_type=period_type,
                frequency_type=frequency_type,
                frequency=frequency,
                start_date=start_epoch,
                end_date=end_epoch
            )
            
            historical_data = []
            for candle in candles.get('candles', []):
                historical_data.append({
                    'datetime': datetime.fromtimestamp(candle['datetime'] / 1000),
                    'open': candle.get('open', 0),
                    'high': candle.get('high', 0),
                    'low': candle.get('low', 0),
                    'close': candle.get('close', 0),
                    'volume': candle.get('volume', 0)
                })
            
            return historical_data
        except Exception as e:
            logger.error(f"Error fetching historical data for {symbol}: {e}")
            raise
    
    def get_account_hashes(self) -> List[Dict]:
        """Return list of {account_number, hash_value} for all linked accounts"""
        self._refresh_token_if_needed()
        if not self.is_authenticated():
            raise RuntimeError("Not authenticated with Schwab API")
        resp = self.client.get_account_numbers()
        resp.raise_for_status()
        return resp.json()  # [{accountNumber, hashValue}, ...]

    def get_bto_transactions(self, since=None, until=None):
        """Backward-compat shim — calls get_all_trade_transactions and filters to BTO equity."""
        all_txns = self.get_all_trade_transactions(since=since, until=until)
        return [t for t in all_txns if t['category'] == 'BTO']

    def get_all_trade_transactions(self,
                                   since: Optional[datetime] = None,
                                   until: Optional[datetime] = None) -> List[Dict]:
        """
        Fetch ALL filled TRADE transactions across all linked accounts.

        Each returned dict has:
          transaction_id, account_hash, account_number, symbol, date,
          price_per_share, num_shares, num_contracts,
          category   – one of: BTO | STC | OPTION_SELL_OPEN | OPTION_BUY_CLOSE |
                                OPTION_BUY_OPEN | OPTION_SELL_CLOSE | UNKNOWN
          instruction, asset_type, option_type (PUT/CALL or ''),
          strike_price, expiration_date, underlying_symbol,
          needs_review  – True for anything that isn't plain BTO/STC equity
        """
        self._refresh_token_if_needed()
        if not self.is_authenticated():
            raise RuntimeError("Not authenticated with Schwab API")

        start = since if since else (datetime.now() - timedelta(days=60))
        end = until or datetime.now()

        # Schwab API limits each get_transactions call to 365 days.
        # Chunk the requested range into 365-day windows and merge results.
        chunk_days = 365
        all_results = []

        try:
            account_hashes = self.get_account_hashes()
        except Exception as e:
            logger.error(f"Error fetching account hashes: {e}")
            return []

        chunk_start = start
        while chunk_start < end:
            chunk_end = min(chunk_start + timedelta(days=chunk_days), end)

            for acct in account_hashes:
                hash_val = acct.get('hashValue') or acct.get('hash_value', '')
                if not hash_val:
                    continue
                try:
                    resp = self.client.get_transactions(
                        hash_val,
                        start_date=chunk_start,
                        end_date=chunk_end,
                        transaction_types=self.client.Transactions.TransactionType.TRADE,
                    )
                    resp.raise_for_status()
                    transactions = resp.json()
                    if not isinstance(transactions, list):
                        transactions = [transactions]
                    all_results.append((hash_val, transactions))
                    logger.info(f"Fetched {len(transactions)} txns for {hash_val} {chunk_start.date()}–{chunk_end.date()}")
                except Exception as e:
                    logger.warning(f"Error fetching transactions {chunk_start}–{chunk_end} for {hash_val}: {e}")

                # Also fetch RECEIVE_AND_DELIVER for assignments and expirations
                try:
                    resp2 = self.client.get_transactions(
                        hash_val,
                        start_date=chunk_start,
                        end_date=chunk_end,
                        transaction_types=self.client.Transactions.TransactionType.RECEIVE_AND_DELIVER,
                    )
                    resp2.raise_for_status()
                    rad_txns = resp2.json()
                    if not isinstance(rad_txns, list):
                        rad_txns = [rad_txns]
                    # Tag these so we can distinguish them in processing
                    for t in rad_txns:
                        t['_schwab_type'] = 'RECEIVE_AND_DELIVER'
                    all_results.append((hash_val, rad_txns))
                except Exception as e:
                    logger.warning(f"Error fetching RECEIVE_AND_DELIVER {chunk_start}–{chunk_end} for {hash_val}: {e}")
            chunk_start = chunk_end + timedelta(seconds=1)

        # Now process all collected raw transactions
        # Build a mapping so we can look up account numbers
        acct_map = {
            a.get('hashValue') or a.get('hash_value', ''): a
            for a in account_hashes
        }

        results = []
        for hash_val, transactions in all_results:
            acct = acct_map.get(hash_val, {})
            for txn in transactions:
                    # Skip non-VALID transactions
                    if txn.get('status', 'VALID') != 'VALID':
                        continue

                    schwab_type = txn.get('_schwab_type', 'TRADE')

                    transfer_items = txn.get('transferItems', [])

                    # Parse trade date
                    raw_time = txn.get('time') or txn.get('tradeDate') or ''
                    try:
                        trade_dt   = datetime.fromisoformat(raw_time.replace('Z', '+00:00'))
                        trade_date = trade_dt.strftime('%Y-%m-%d')
                    except Exception:
                        trade_date = datetime.now().strftime('%Y-%m-%d')

                    # -------------------------------------------------------
                    # Handle RECEIVE_AND_DELIVER: assignments and expirations
                    # -------------------------------------------------------
                    if schwab_type == 'RECEIVE_AND_DELIVER':
                        description = txn.get('description', '')
                        is_assignment = 'assignment' in description.lower()
                        is_expiration = 'expiration' in description.lower()
                        if not (is_assignment or is_expiration):
                            continue
                        for ti in transfer_items:
                            inst = ti.get('instrument', {})
                            if inst.get('assetType', '').upper() != 'OPTION':
                                continue
                            underlying = (inst.get('underlyingSymbol') or inst.get('symbol') or '').upper()
                            if not underlying:
                                continue
                            strike = float(inst.get('strikePrice') or 0)
                            raw_exp = inst.get('expirationDate') or ''
                            exp_date = ''
                            if raw_exp:
                                try:
                                    exp_date = datetime.fromisoformat(
                                        raw_exp.replace('Z', '+00:00')
                                    ).strftime('%Y-%m-%d')
                                except Exception:
                                    exp_date = raw_exp[:10] if len(raw_exp) >= 10 else raw_exp
                            option_type = (inst.get('putCall') or '').upper()
                            num_contracts = int(abs(float(ti.get('amount') or 0)))
                            category = 'OPTION_ASSIGNED' if is_assignment else 'OPTION_EXPIRED'
                            results.append({
                                'transaction_id':  str(txn.get('activityId') or ''),
                                'account_hash':    hash_val,
                                'account_number':  acct.get('accountNumber', ''),
                                'symbol':          underlying,
                                'occ_symbol':      inst.get('symbol', ''),
                                'date':            trade_date,
                                'price_per_share': 0,
                                'num_shares':      0,
                                'num_contracts':   num_contracts,
                                'category':        category,
                                'asset_type':      'OPTION',
                                'option_type':     option_type,
                                'strike_price':    strike,
                                'expiration_date': exp_date,
                                'description':     description,
                                'needs_review':    False,
                                'commission':      0,
                            })
                        continue  # done with this RECEIVE_AND_DELIVER event

                    # Sum commissions from CURRENCY fee items
                    total_commission = 0.0
                    for ti in transfer_items:
                        inst = ti.get('instrument', {})
                        if inst.get('assetType') == 'CURRENCY' and ti.get('feeType') == 'COMMISSION':
                            total_commission += abs(float(ti.get('amount') or 0))

                    # Process each non-CURRENCY instrument leg
                    for ti in transfer_items:
                        inst = ti.get('instrument', {})
                        asset_type = (inst.get('assetType') or '').upper()
                        if asset_type in ('CURRENCY', ''):
                            continue

                        amount         = float(ti.get('amount') or 0)   # +buy/-sell for equity; -sell/+buy for options
                        price          = float(ti.get('price') or 0)
                        pos_effect     = (ti.get('positionEffect') or '').upper()
                        raw_symbol     = (inst.get('symbol') or '').upper()
                        underlying     = (inst.get('underlyingSymbol') or raw_symbol).upper()
                        option_type    = (inst.get('putCall') or '').upper()
                        strike         = float(inst.get('strikePrice') or 0)
                        description    = inst.get('description', underlying)

                        if not underlying:
                            continue

                        # Parse option expiration
                        raw_exp  = inst.get('expirationDate') or ''
                        exp_date = ''
                        if raw_exp:
                            try:
                                exp_date = datetime.fromisoformat(
                                    raw_exp.replace('Z', '+00:00')
                                ).strftime('%Y-%m-%d')
                            except Exception:
                                exp_date = raw_exp[:10] if len(raw_exp) >= 10 else raw_exp

                        # Categorise by asset type + amount sign + position effect
                        if asset_type == 'EQUITY':
                            qty = abs(amount)
                            comm_per_share = round(total_commission / qty, 4) if qty else 0
                            if amount > 0 or pos_effect == 'OPENING':
                                category, needs_review = 'BTO', False
                            else:
                                category, needs_review = 'STC', False

                            results.append({
                                'transaction_id':  str(txn.get('activityId') or ''),
                                'account_hash':    hash_val,
                                'account_number':  acct.get('accountNumber', ''),
                                'symbol':          underlying,
                                'occ_symbol':      raw_symbol,
                                'date':            trade_date,
                                'price_per_share': price,
                                'num_shares':      qty,
                                'num_contracts':   0,
                                'category':        category,
                                'asset_type':      'EQUITY',
                                'option_type':     '',
                                'strike_price':    0,
                                'expiration_date': '',
                                'description':     description,
                                'needs_review':    needs_review,
                                'commission':      comm_per_share,
                            })

                        elif asset_type == 'OPTION':
                            num_contracts = int(abs(amount))
                            comm_per_contract = round(total_commission / num_contracts, 4) if num_contracts else 0

                            # amount < 0 = sold contracts; OPENING = sell-to-open
                            if amount < 0 and pos_effect == 'OPENING':
                                category, needs_review = 'OPTION_SELL_OPEN', True
                            elif amount > 0 and pos_effect == 'CLOSING':
                                category, needs_review = 'OPTION_BUY_CLOSE', True
                            elif amount > 0 and pos_effect == 'OPENING':
                                category, needs_review = 'OPTION_BUY_OPEN', True
                            elif amount < 0 and pos_effect == 'CLOSING':
                                category, needs_review = 'OPTION_SELL_CLOSE', True
                            else:
                                category, needs_review = 'UNKNOWN', True

                            results.append({
                                'transaction_id':  str(txn.get('activityId') or ''),
                                'account_hash':    hash_val,
                                'account_number':  acct.get('accountNumber', ''),
                                'symbol':          underlying,
                                'occ_symbol':      raw_symbol,
                                'date':            trade_date,
                                'price_per_share': price,
                                'num_shares':      0,
                                'num_contracts':   num_contracts,
                                'category':        category,
                                'asset_type':      'OPTION',
                                'option_type':     option_type,
                                'strike_price':    strike,
                                'expiration_date': exp_date,
                                'description':     description,
                                'needs_review':    needs_review,
                                'commission':      comm_per_contract,
                            })
                        else:
                            # Unknown asset type — flag for review
                            results.append({
                                'transaction_id':  str(txn.get('activityId') or ''),
                                'account_hash':    hash_val,
                                'account_number':  acct.get('accountNumber', ''),
                                'symbol':          underlying,
                                'occ_symbol':      raw_symbol,
                                'date':            trade_date,
                                'price_per_share': price,
                                'num_shares':      abs(amount),
                                'num_contracts':   0,
                                'category':        'UNKNOWN',
                                'asset_type':      asset_type,
                                'option_type':     '',
                                'strike_price':    0,
                                'expiration_date': '',
                                'description':     description,
                                'needs_review':    True,
                                'commission':      0,
                            })

        return results

    def sync_trades_to_database(self, account_number: Optional[str] = None,
                                start_date: Optional[datetime] = None,
                                end_date: Optional[datetime] = None) -> Dict[str, Any]:
        """
        Sync trades from Schwab API to the local database
        Returns statistics about the sync operation
        """
        if not self.is_authenticated():
            raise RuntimeError("Not authenticated with Schwab API")
        
        try:
            orders = self.get_orders(account_number, start_date, end_date)
            
            # This would need to be integrated with the database
            # For now, return the orders for the Flask endpoint to handle
            return {
                'success': True,
                'orders_found': len(orders),
                'orders': orders
            }
        except Exception as e:
            logger.error(f"Error syncing trades: {e}")
            return {
                'success': False,
                'error': str(e)
            }

