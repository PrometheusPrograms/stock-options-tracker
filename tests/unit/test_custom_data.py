"""
Custom test inputs and outputs for your specific data
Instructions:
1. Add your actual trade data below
2. Calculate expected outputs manually (in Excel or by hand)
3. Run tests to verify the app calculates correctly
"""
import pytest
import sqlite3

# ======================================================================
# CUSTOM TEST DATA - ADD YOUR ACTUAL TRADES HERE
# ======================================================================

# Test data structure:
# {
#     'trade_type': 'ROCT PUT',  # BTO, STC, ROCT PUT, ROCT CALL, etc.
#     'strike': 245.00,
#     'premium': 2.50,
#     'contracts': 1,
#     'commission': 1.00,
#     'expected_margin_capital': 24350.00,
#     'expected_total_premium': 250.00,
#     'expected_running_basis': 250.00,
#     'notes': 'Description of what this trade tests'
# }

CUSTOM_TEST_TRADES = [
    # Example - Replace with your actual trades
    {
        'trade_type': 'ROCT PUT',
        'ticker': 'TEST',
        'strike': 245.00,
        'premium': 2.50,
        'contracts': 1,
        'commission': 1.00,
        'expected_margin_capital': 24350.00,
        'expected_total_premium': 250.00,
        'expected_running_basis': 250.00,
        'notes': 'Single PUT contract - your first trade'
    },
    {
        'trade_type': 'ROCT PUT',
        'ticker': 'RIVN',
        'strike': 10.00,
        'premium': 0.75,
        'contracts': 10,
        'commission': 0.65,
        'expected_margin_capital': 9235.00,  # Manually calculate this
        'expected_total_premium': 750.00,
        'expected_running_basis': 1000.00,  # Starting at 250 + this trade
        'notes': 'Your second trade - 10 contracts'
    },
    # Add more trades below...
]

CUSTOM_COST_BASIS_TESTS = [
    # Example cost basis progression
    {
        'initial_shares': 0,
        'initial_basis': 0,
        'trade_type': 'BTO',
        'shares': 10,
        'price': 50.00,
        'expected_running_shares': 10,
        'expected_running_basis': 500.00,
        'expected_basis_per_share': 50.00,
        'notes': 'First buy - should start basis tracking'
    },
    {
        'initial_shares': 10,
        'initial_basis': 500.00,
        'trade_type': 'STC',
        'shares': 5,  # Selling 5 shares
        'price': 60.00,  # Selling at higher price
        'expected_running_shares': 5,  # 10 - 5
        'expected_running_basis': 200.00,  # 500 - 300 (5 shares * 60)
        'expected_basis_per_share': 40.00,  # 200 / 5
        'notes': 'Sell half - check basis calculation'
    },
    # Add more cost basis tests...
]

# ======================================================================
# TEST FUNCTIONS - These will run your custom test data
# ======================================================================

def calculate_margin_capital(strike_price, premium, commission, num_of_contracts):
    """Calculate margin capital"""
    return (strike_price - (premium - commission)) * num_of_contracts * 100

def calculate_total_premium(premium, num_of_contracts):
    """Calculate total premium for options"""
    return premium * num_of_contracts * 100

class TestCustomTradeData:
    """Tests using YOUR actual trade data"""
    
    @pytest.mark.parametrize("trade", CUSTOM_TEST_TRADES)
    def test_margin_capital_using_your_data(self, trade):
        """Test margin capital calculation with your data"""
        result = calculate_margin_capital(
            strike_price=trade['strike'],
            premium=trade['premium'],
            commission=trade['commission'],
            num_of_contracts=trade['contracts']
        )
        print(f"\nTesting: {trade['notes']}")
        print(f"Strike: {trade['strike']}, Premium: {trade['premium']}, Contracts: {trade['contracts']}")
        print(f"Expected: {trade['expected_margin_capital']}, Got: {result}")
        assert result == trade['expected_margin_capital'], \
            f"Expected {trade['expected_margin_capital']}, got {result}"
    
    @pytest.mark.parametrize("trade", CUSTOM_TEST_TRADES)
    def test_total_premium_using_your_data(self, trade):
        """Test premium calculation with your data"""
        result = calculate_total_premium(
            premium=trade['premium'],
            num_of_contracts=trade['contracts']
        )
        print(f"\nTesting: {trade['notes']}")
        print(f"Expected: {trade['expected_total_premium']}, Got: {result}")
        assert result == trade['expected_total_premium'], \
            f"Expected {trade['expected_total_premium']}, got {result}"

class TestCustomCostBasis:
    """Tests using YOUR actual cost basis data"""
    
    @pytest.mark.parametrize("test", CUSTOM_COST_BASIS_TESTS)
    def test_cost_basis_progression(self, test):
        """Test cost basis calculations with your data"""
        # Simulate the progression
        running_shares = test['initial_shares']
        running_basis = test['initial_basis']
        
        if test['trade_type'] == 'BTO':
            # Buying adds to position
            running_shares += test['shares']
            running_basis += test['shares'] * test['price']
        elif test['trade_type'] == 'STC':
            # Selling reduces position
            running_shares -= test['shares']
            running_basis -= test['shares'] * test['price']
        
        basis_per_share = running_basis / running_shares if running_shares != 0 else running_basis
        
        print(f"\nTesting: {test['notes']}")
        print(f"Initial: {test['initial_shares']} shares, ${test['initial_basis']} basis")
        print(f"Trade: {test['trade_type']} {test['shares']} shares @ ${test['price']}")
        print(f"Expected shares: {test['expected_running_shares']}, Got: {running_shares}")
        print(f"Expected basis: ${test['expected_running_basis']}, Got: ${running_basis}")
        
        assert running_shares == test['expected_running_shares']
        assert abs(running_basis - test['expected_running_basis']) < 0.01
        assert abs(basis_per_share - test['expected_basis_per_share']) < 0.01

# ======================================================================
# HOW TO USE THIS FILE:
# 1. Edit CUSTOM_TEST_TRADES above with your actual trades
# 2. Edit CUSTOM_COST_BASIS_TESTS with your cost basis scenarios
# 3. Run: pytest tests/unit/test_custom_data.py -v
# ======================================================================
