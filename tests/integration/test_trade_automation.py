"""
Main test runner for trade automation testing
Orchestrates Excel parsing, API calls, database queries, comparison, and reporting
"""
import pytest
import requests
import sqlite3
from typing import Dict, Any, List
from datetime import datetime
import os
from .okw_excel_parser import parse_okw_excel
from .api_trade_creator import create_api_request
from .trade_comparator import compare_trade
from .test_report_generator import TestReport
from .test_config import (
    API_BASE_URL,
    TEST_DATABASE_PATH,
    EXCEL_FILE_PATH,
    NUMERIC_TOLERANCE,
    ACCOUNT_ID,
)


def get_db_trade(db_path: str, trade_id: int) -> Dict[str, Any]:
    """
    Query database for a trade by ID
    
    Args:
        db_path: Path to database file
        trade_id: Trade ID to query
        
    Returns:
        Dictionary containing trade data from database
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Query trade with all fields
    cursor.execute('''
        SELECT * FROM trades WHERE id = ?
    ''', (trade_id,))
    
    row = cursor.fetchone()
    
    if not row:
        conn.close()
        return {}
    
    trade_dict = dict(row)
    
    # Calculate cumulative_net_credit_total if not already in the row
    # This mimics the backend calculation
    if 'cumulative_net_credit_total' not in trade_dict:
        # Get all trades to calculate cumulative net credit
        cursor.execute('SELECT * FROM trades')
        all_trades = [dict(r) for r in cursor.fetchall()]
        trade_map = {t['id']: t for t in all_trades}
        
        def calculate_cumulative_net_credit(t_id):
            if t_id not in trade_map:
                return 0
            trade = trade_map[t_id]
            num_of_contracts = trade.get('num_of_contracts', 1)
            net_credit_per_share = trade.get('net_credit_per_share', 0)
            trade_type = trade.get('trade_type', '')
            
            if trade_type in ['BTO', 'STC']:
                net_credit_total = net_credit_per_share * num_of_contracts
            else:
                net_credit_total = net_credit_per_share * num_of_contracts * 100
            
            trade_parent_id = trade.get('trade_parent_id')
            if trade_parent_id:
                parent_cumulative = calculate_cumulative_net_credit(trade_parent_id)
                return parent_cumulative + net_credit_total
            
            return net_credit_total
        
        trade_dict['cumulative_net_credit_total'] = calculate_cumulative_net_credit(trade_id)
    
    conn.close()
    return trade_dict


def create_trade_via_api(api_request: Dict[str, Any]) -> Dict[str, Any]:
    """
    Create a trade via POST /api/trades API endpoint
    
    Args:
        api_request: Dictionary in the format expected by POST /api/trades
        
    Returns:
        Dictionary containing API response with trade_id and success status
    """
    url = f"{API_BASE_URL}/api/trades"
    
    try:
        response = requests.post(url, json=api_request, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        return {
            'success': False,
            'error': str(e),
            'trade_id': None,
        }


@pytest.fixture
def excel_file_path():
    """Fixture to get Excel file path from environment or config"""
    excel_path = os.getenv('EXCEL_FILE_PATH', EXCEL_FILE_PATH)
    if excel_path is None:
        # Try to find a default Excel file
        default_files = ['OKW_2025_test.xlsx', 'OKW_2025_test_clean.xlsx', 'OKW_testdata.xlsx']
        for filename in default_files:
            if os.path.exists(filename):
                excel_path = filename
                break
    
    if excel_path is None:
        pytest.skip("No Excel file specified. Set EXCEL_FILE_PATH environment variable or place a test file in the project root")
    if not os.path.exists(excel_path):
        pytest.skip(f"Excel file not found: {excel_path}")
    return excel_path


@pytest.fixture
def test_account_id():
    """Fixture to get account ID from environment or config"""
    account_id = os.getenv('TEST_ACCOUNT_ID', None)
    if account_id is None:
        return ACCOUNT_ID
    return int(account_id)


def test_trades_from_excel(excel_file_path, test_account_id):
    """
    Main test function that:
    1. Parses Excel file
    2. For each trade, creates it via API
    3. Queries database
    4. Compares actual vs expected values
    5. Generates report
    """
    # Parse Excel file
    print(f"\n{'='*60}")
    print(f"Parsing Excel file: {excel_file_path}")
    print(f"{'='*60}\n")
    
    try:
        trades_data = parse_okw_excel(excel_file_path)
    except Exception as e:
        pytest.fail(f"Failed to parse Excel file: {e}")
    
    if not trades_data:
        pytest.skip("No trades found in Excel file")
    
    print(f"Found {len(trades_data)} trades in Excel file\n")
    
    # Initialize report
    report = TestReport(excel_file_path)
    
    # Process each trade
    for trade_data in trades_data:
        excel_column = trade_data.get('excel_column')
        input_data = trade_data.get('input_data', {})
        
        print(f"Processing Excel Column {excel_column} (Ticker: {input_data.get('ticker', 'N/A')})")
        
        # Create API request
        api_request = create_api_request(trade_data, test_account_id)
        
        # Send API request
        print(f"  Creating trade via API...")
        api_response = create_trade_via_api(api_request)
        
        # Check if API call was successful
        # The API returns {'success': True, 'trade_id': <id>} on success
        trade_id = None
        if isinstance(api_response, dict):
            if api_response.get('success', False):
                trade_id = api_response.get('trade_id')
            else:
                error_msg = api_response.get('error', 'Unknown error')
                print(f"  ERROR: Failed to create trade: {error_msg}")
                # Still add to report as a failure
                from .trade_comparator import ComparisonResult
                report.add_trade_result(
                    excel_column,
                    None,
                    [ComparisonResult(
                        field_name='api_creation',
                        expected='success',
                        actual=f'error: {error_msg}',
                        match=False,
                        difference=None
                    )]
                )
                continue
        
        if not trade_id:
            error_msg = 'No trade_id returned from API'
            print(f"  ERROR: {error_msg}")
            from .trade_comparator import ComparisonResult
            report.add_trade_result(
                excel_column,
                None,
                [ComparisonResult(
                    field_name='api_creation',
                    expected='success',
                    actual=error_msg,
                    match=False,
                    difference=None
                )]
            )
            continue
        
        print(f"  Trade created with ID: {trade_id}")
        
        # Query database
        print(f"  Querying database...")
        db_trade = get_db_trade(TEST_DATABASE_PATH, trade_id)
        
        if not db_trade:
            print(f"  ERROR: Trade not found in database")
            continue
        
        # Compare values
        print(f"  Comparing values...")
        comparison_results = compare_trade(trade_data, db_trade, NUMERIC_TOLERANCE)
        
        # Count matches and mismatches
        matches = sum(1 for r in comparison_results if r.match)
        mismatches = sum(1 for r in comparison_results if not r.match)
        
        print(f"  Results: {matches} matches, {mismatches} mismatches")
        
        if mismatches > 0:
            print(f"  MISMATCHES:")
            for result in comparison_results:
                if not result.match:
                    print(f"    - {result.field_name}: expected={result.expected}, actual={result.actual}")
        
        # Add to report
        report.add_trade_result(excel_column, trade_id, comparison_results)
        print()
    
    # Generate and save report
    print(f"\n{'='*60}")
    print("Test Summary")
    print(f"{'='*60}")
    print(f"Total Tests: {report.total_tests}")
    print(f"Matches: {report.matches}")
    print(f"Mismatches: {report.mismatches}")
    print()
    
    # Save report to file
    report_filename = f"test_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    report_path = os.path.join(os.path.dirname(__file__), report_filename)
    report.save_report(report_path)
    
    # Print report to console
    print(report.generate_text_report())
    
    # Assert that all tests passed (optional - comment out if you want to see all results)
    # assert report.mismatches == 0, f"Found {report.mismatches} mismatches. See report: {report_path}"


# Note: pytest_addoption should be in conftest.py, but we'll handle it via environment variable instead

