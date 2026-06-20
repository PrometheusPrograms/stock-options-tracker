"""
Configuration for trade automation testing
"""
import os

# Test database path (use existing database or create test database)
TEST_DATABASE_PATH = os.getenv('TEST_DATABASE_PATH', 'trades.db')

# API base URL
API_BASE_URL = os.getenv('API_BASE_URL', 'http://localhost:5005')

# Excel file path(s) - can be a single file or list of files
EXCEL_FILE_PATH = os.getenv('EXCEL_FILE_PATH', None)

# Numeric tolerance for comparisons (default: 0.01 for 2 decimal places)
NUMERIC_TOLERANCE = float(os.getenv('NUMERIC_TOLERANCE', '0.01'))

# Account ID for testing (default: 9)
ACCOUNT_ID = int(os.getenv('TEST_ACCOUNT_ID', '9'))

# Expected value row mappings: Dictionary mapping Excel row numbers to expected calculated field names
# These rows contain the pre-calculated expected values in the Excel file
# Update this mapping based on your Excel file structure
EXPECTED_VALUE_ROW_MAPPING = {
    # Example mappings - update these based on your actual Excel file
    # Row numbers are 1-indexed (same as Excel)
    7: "days_to_expiration",
    23: "net_credit_per_share",
    24: "risk_capital_per_share",
    26: "margin_capital",
    29: "arorc",
    22: "commission_per_share",
    61: "total_premium",
    42: "num_of_shares",
    # Add more mappings as needed based on your Excel file structure
}

# Input data row mappings (standard OKW format)
INPUT_DATA_ROW_MAPPING = {
    1:  "trade_type_raw",      # Row 1 -> Format: "SLV ROCT CALL" -> Extract "SLV" as ticker, "ROCT CALL" as trade_type
    3:  "date_trade_open",      # Row 3 -> trades.date_trade_open  
    5:  "current_price",        # Row 5 -> trades.current_price
    8:  "expiration_date",      # Row 8 -> trades.expiration_date
    15: "strike_price",         # Row 15 -> trades.strike_price (short strike)
    21: "credit_debit",         # Row 21 -> trades.credit_debit
    41: "num_of_contracts",      # Row 41 -> trades.num_of_contracts
    57: "trade_status",         # Row 64 -> trades.trade_status (dropdown: open, expired, closed, roll, assigned)
    65: "roll_indicator",       # Row 65 -> "ROLL" indicates this column is a roll trade
}

# Fields to compare (all fields that should be validated)
COMPARISON_FIELDS = {
    # Input fields (should match Excel exactly)
    'input_fields': [
        'ticker',
        'date_trade_open',
        'expiration_date',
        'num_of_contracts',
        'credit_debit',
        'current_price',
        'strike_price',
        'trade_type',
        'trade_status',
    ],
    # Calculated fields (compare against Excel expected values)
    'calculated_fields': [
        'days_to_expiration',
        'num_of_shares',
        'net_credit_per_share',
        'risk_capital_per_share',
        'margin_capital',
        'commission_per_share',
        'total_premium',
        'ARORC',
        'cumulative_net_credit_total',  # For roll trades
    ],
}

# Field comparison types (for tolerance handling)
FIELD_COMPARISON_TYPES = {
    # Numeric fields with tolerance
    'numeric_tolerance': [
        'credit_debit',
        'current_price',
        'strike_price',
        'net_credit_per_share',
        'risk_capital_per_share',
        'margin_capital',
        'commission_per_share',
        'total_premium',
        'ARORC',
        'cumulative_net_credit_total',
    ],
    # Integer fields (exact match)
    'integer_exact': [
        'days_to_expiration',
        'num_of_contracts',
        'num_of_shares',
        'trade_id',
        'account_id',
    ],
    # String fields (exact match)
    'string_exact': [
        'ticker',
        'trade_type',
        'trade_status',
    ],
    # Date fields (exact match)
    'date_exact': [
        'date_trade_open',
        'expiration_date',
        'date_trade_rolled',
    ],
}


