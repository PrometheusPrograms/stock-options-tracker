"""
Helper to convert Excel trade data to API request format for POST /api/trades
"""
from typing import Dict, Any
from .test_config import ACCOUNT_ID


def create_api_request(trade_data: Dict[str, Any], account_id: int = None) -> Dict[str, Any]:
    """
    Convert Excel trade data to API request format for POST /api/trades
    
    Args:
        trade_data: Dictionary containing trade data from Excel parser
        account_id: Account ID to use (defaults to config value)
        
    Returns:
        Dictionary in the format expected by POST /api/trades endpoint
    """
    if account_id is None:
        account_id = ACCOUNT_ID
    
    input_data = trade_data.get('input_data', {})
    
    # Map Excel fields to API fields
    api_request = {
        'ticker': input_data.get('ticker', '').upper(),
        'tradeDate': input_data.get('date_trade_open', ''),
        'expirationDate': input_data.get('expiration_date', ''),
        'num_of_contracts': input_data.get('num_of_contracts', 1),
        'premium': input_data.get('credit_debit', 0.0),
        'currentPrice': input_data.get('current_price', 0.0),
        'strikePrice': input_data.get('strike_price', 0.0),
        'tradeType': input_data.get('trade_type', 'ROCT PUT'),
        'accountId': account_id,
    }
    
    return api_request


