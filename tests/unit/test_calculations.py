"""
Unit tests for calculation functions
"""
import pytest
import sqlite3
from datetime import datetime, timedelta

def calculate_margin_capital(strike_price, premium, commission, num_of_contracts):
    """Calculate margin capital for options trades"""
    # Margin capital = (strike_price - (premium - commission)) * num_of_contracts * 100
    return (strike_price - (premium - commission)) * num_of_contracts * 100

def calculate_total_premium(premium, num_of_contracts, is_options=True):
    """Calculate total premium"""
    if is_options:
        return premium * num_of_contracts * 100
    else:
        return premium * num_of_contracts

def calculate_cost_basis_shares_running(running_shares, num_of_contracts, trade_type):
    """Calculate running shares for cost basis"""
    if trade_type == 'STC':
        return running_shares - num_of_contracts
    elif trade_type == 'BTO':
        return running_shares + num_of_contracts
    else:
        return running_shares + 0  # Options trades don't add to shares

class TestCalculations:
    """Test calculation functions"""
    
    def test_margin_capital_put(self):
        """Test margin capital calculation for PUT option"""
        result = calculate_margin_capital(strike_price=245.00, premium=2.50, 
                                          commission=1.00, num_of_contracts=1)
        # Expected: (245 - (2.50 - 1.00)) * 1 * 100 = 243.50 * 100 = 24,350
        assert result == 24350.00
    
    def test_margin_capital_multiple_contracts(self):
        """Test margin capital with multiple contracts"""
        result = calculate_margin_capital(strike_price=100.00, premium=1.50,
                                          commission=0.65, num_of_contracts=3)
        # Expected: (100 - (1.50 - 0.65)) * 3 * 100 = 99.15 * 300 = 29,745
        assert abs(result - 29745.00) < 0.01  # Allow floating point precision
    
    def test_total_premium_options(self):
        """Test premium calculation for options (multiply by 100)"""
        result = calculate_total_premium(premium=2.50, num_of_contracts=1, is_options=True)
        assert result == 250.00
    
    def test_total_premium_stock(self):
        """Test premium calculation for stock (no multiplication)"""
        result = calculate_total_premium(premium=50.00, num_of_contracts=10, is_options=False)
        assert result == 500.00
    
    def test_running_shares_stc(self):
        """Test running shares calculation for STC (sell)"""
        result = calculate_cost_basis_shares_running(running_shares=100, 
                                                     num_of_contracts=10,
                                                     trade_type='STC')
        # Should subtract shares when selling
        assert result == 90
    
    def test_running_shares_bto(self):
        """Test running shares calculation for BTO (buy)"""
        result = calculate_cost_basis_shares_running(running_shares=100,
                                                     num_of_contracts=25,
                                                     trade_type='BTO')
        # Should add shares when buying
        assert result == 125
    
    def test_running_shares_options(self):
        """Test running shares for options (no change)"""
        result = calculate_cost_basis_shares_running(running_shares=100,
                                                     num_of_contracts=5,
                                                     trade_type='ROCT PUT')
        # Options should not change running shares
        assert result == 100
    
    def test_cost_basis_per_share_calculation(self):
        """Test basis per share calculation"""
        running_basis = 1000.00
        running_shares = 100
        
        basis_per_share = running_basis / running_shares if running_shares != 0 else running_basis
        assert basis_per_share == 10.00
    
    def test_cost_basis_per_share_zero_shares(self):
        """Test basis per share when shares are zero"""
        running_basis = 1000.00
        running_shares = 0
        
        basis_per_share = running_basis / running_shares if running_shares != 0 else running_basis
        assert basis_per_share == 1000.00
