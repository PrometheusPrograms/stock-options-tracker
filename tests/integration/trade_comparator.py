"""
Comparison engine for comparing actual database values vs Excel control values
"""
from typing import Dict, List, Any, Optional, Tuple
from datetime import datetime
from .test_config import NUMERIC_TOLERANCE, FIELD_COMPARISON_TYPES


class ComparisonResult:
    """Result of comparing a single field"""
    def __init__(self, field_name: str, expected: Any, actual: Any, match: bool, difference: Optional[float] = None):
        self.field_name = field_name
        self.expected = expected
        self.actual = actual
        self.match = match
        self.difference = difference
    
    def __repr__(self):
        if self.match:
            return f"{self.field_name}: MATCH (expected={self.expected}, actual={self.actual})"
        else:
            diff_str = f", difference={self.difference}" if self.difference is not None else ""
            return f"{self.field_name}: MISMATCH (expected={self.expected}, actual={self.actual}{diff_str})"


def compare_values(field_name: str, expected: Any, actual: Any, tolerance: float = NUMERIC_TOLERANCE) -> ComparisonResult:
    """
    Compare expected vs actual value for a single field
    
    Args:
        field_name: Name of the field being compared
        expected: Expected value (from Excel)
        actual: Actual value (from database)
        tolerance: Numeric tolerance for floating point comparisons
        
    Returns:
        ComparisonResult object
    """
    # Handle None/NULL values
    if expected is None and actual is None:
        return ComparisonResult(field_name, expected, actual, True)
    
    if expected is None or actual is None:
        return ComparisonResult(field_name, expected, actual, False)
    
    # Determine comparison type based on field name
    if field_name in FIELD_COMPARISON_TYPES['numeric_tolerance']:
        # Numeric comparison with tolerance
        try:
            exp_float = float(expected)
            act_float = float(actual)
            diff = abs(exp_float - act_float)
            match = diff <= tolerance
            return ComparisonResult(field_name, expected, actual, match, diff)
        except (ValueError, TypeError):
            # If conversion fails, do string comparison
            match = str(expected) == str(actual)
            return ComparisonResult(field_name, expected, actual, match)
    
    elif field_name in FIELD_COMPARISON_TYPES['integer_exact']:
        # Integer exact match
        try:
            exp_int = int(float(expected)) if expected else 0
            act_int = int(float(actual)) if actual else 0
            match = exp_int == act_int
            diff = abs(exp_int - act_int) if not match else None
            return ComparisonResult(field_name, expected, actual, match, diff)
        except (ValueError, TypeError):
            match = str(expected) == str(actual)
            return ComparisonResult(field_name, expected, actual, match)
    
    elif field_name in FIELD_COMPARISON_TYPES['string_exact']:
        # String exact match
        exp_str = str(expected).strip() if expected else ""
        act_str = str(actual).strip() if actual else ""
        match = exp_str == act_str
        return ComparisonResult(field_name, expected, actual, match)
    
    elif field_name in FIELD_COMPARISON_TYPES['date_exact']:
        # Date exact match (normalize to YYYY-MM-DD format)
        try:
            exp_date = normalize_date(expected)
            act_date = normalize_date(actual)
            match = exp_date == act_date
            return ComparisonResult(field_name, expected, actual, match)
        except Exception:
            # If date parsing fails, do string comparison
            match = str(expected) == str(actual)
            return ComparisonResult(field_name, expected, actual, match)
    
    else:
        # Default: string comparison
        match = str(expected) == str(actual)
        return ComparisonResult(field_name, expected, actual, match)


def normalize_date(date_value: Any) -> str:
    """
    Normalize date value to YYYY-MM-DD format
    
    Args:
        date_value: Date value in various formats
        
    Returns:
        Date string in YYYY-MM-DD format
    """
    if date_value is None:
        return ""
    
    if isinstance(date_value, datetime):
        return date_value.strftime('%Y-%m-%d')
    
    if isinstance(date_value, str):
        # Try parsing various date formats
        for fmt in ['%Y-%m-%d', '%m/%d/%Y', '%m-%d-%Y', '%d/%m/%Y', '%Y/%m/%d']:
            try:
                dt = datetime.strptime(date_value, fmt)
                return dt.strftime('%Y-%m-%d')
            except ValueError:
                continue
    
    return str(date_value)


def compare_trade(trade_data: Dict[str, Any], db_trade: Dict[str, Any], tolerance: float = NUMERIC_TOLERANCE) -> List[ComparisonResult]:
    """
    Compare a trade's database values against Excel expected values
    
    Args:
        trade_data: Trade data from Excel parser (contains input_data and expected_values)
        db_trade: Trade data from database query
        tolerance: Numeric tolerance for floating point comparisons
        
    Returns:
        List of ComparisonResult objects, one per field compared
    """
    results = []
    
    input_data = trade_data.get('input_data', {})
    expected_values = trade_data.get('expected_values', {})
    
    # Compare input fields (should match Excel input data)
    input_fields_to_compare = {
        'ticker': input_data.get('ticker'),
        'date_trade_open': input_data.get('date_trade_open'),
        'expiration_date': input_data.get('expiration_date'),
        'num_of_contracts': input_data.get('num_of_contracts'),
        'credit_debit': input_data.get('credit_debit'),
        'current_price': input_data.get('current_price'),
        'strike_price': input_data.get('strike_price'),
        'trade_type': input_data.get('trade_type'),
        'trade_status': input_data.get('trade_status', 'open'),  # Default to 'open' if not specified
    }
    
    # Map database field names (may differ from Excel field names)
    db_field_mapping = {
        'ticker': 'ticker',
        'date_trade_open': 'date_trade_open',
        'expiration_date': 'expiration_date',
        'num_of_contracts': 'num_of_contracts',
        'credit_debit': 'credit_debit',
        'current_price': 'current_price',
        'strike_price': 'strike_price',
        'trade_type': 'trade_type',
        'trade_status': 'trade_status',
    }
    
    # Compare input fields
    for field_name, expected_value in input_fields_to_compare.items():
        db_field = db_field_mapping.get(field_name, field_name)
        actual_value = db_trade.get(db_field)
        
        # Special handling for trade_type (may include ticker prefix in DB)
        if field_name == 'trade_type':
            # Extract base trade type from DB value (remove ticker prefix if present)
            if actual_value:
                parts = str(actual_value).split()
                if len(parts) > 1:
                    # Assume ticker is first part, trade type is the rest
                    actual_value = ' '.join(parts[1:])
        
        result = compare_values(field_name, expected_value, actual_value, tolerance)
        results.append(result)
    
    # Compare calculated fields (against expected values from Excel)
    calculated_fields_to_compare = {
        'days_to_expiration': expected_values.get('days_to_expiration'),
        'num_of_shares': expected_values.get('num_of_shares'),
        'net_credit_per_share': expected_values.get('net_credit_per_share'),
        'risk_capital_per_share': expected_values.get('risk_capital_per_share'),
        'margin_capital': expected_values.get('margin_capital'),
        'commission_per_share': expected_values.get('commission_per_share'),
        'total_premium': expected_values.get('total_premium'),
        'ARORC': expected_values.get('arorc'),  # Note: Excel may use lowercase 'arorc'
        'cumulative_net_credit_total': expected_values.get('cumulative_net_credit_total'),
    }
    
    # Map database field names for calculated fields
    db_calculated_mapping = {
        'days_to_expiration': 'days_to_expiration',
        'num_of_shares': 'num_of_shares',
        'net_credit_per_share': 'net_credit_per_share',
        'risk_capital_per_share': 'risk_capital_per_share',
        'margin_capital': 'margin_capital',
        'commission_per_share': 'commission_per_share',
        'total_premium': 'total_premium',
        'ARORC': 'ARORC',
        'cumulative_net_credit_total': 'cumulative_net_credit_total',
    }
    
    # Compare calculated fields
    for field_name, expected_value in calculated_fields_to_compare.items():
        if expected_value is None:
            # Skip if expected value is not provided in Excel
            continue
        
        db_field = db_calculated_mapping.get(field_name, field_name)
        actual_value = db_trade.get(db_field)
        
        result = compare_values(field_name, expected_value, actual_value, tolerance)
        results.append(result)
    
    return results

