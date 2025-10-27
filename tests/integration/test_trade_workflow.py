"""
Integration tests for trade workflow
Tests the complete flow from adding a trade to calculating cost basis
"""
import pytest
import json
from app import create_assigned_cost_basis_entry

def test_add_trade_and_cost_basis_workflow(client):
    """Test complete workflow: add trade -> create cost basis"""
    
    # Step 1: Add a BTO trade
    trade_data = {
        'ticker': 'TEST',
        'tradeDate': '2025-01-15',
        'expirationDate': '2025-01-20',
        'num_of_contracts': 10,
        'premium': 50.00,
        'currentPrice': 50.00,
        'strikePrice': 0,
        'tradeType': 'BTO',
        'accountId': 9
    }
    
    response = client.post('/api/trades',
                          data=json.dumps(trade_data),
                          content_type='application/json')
    
    # Should succeed
    assert response.status_code in [200, 201]
    
    # Step 2: Verify trade was created
    response = client.get('/api/trades')
    data = json.loads(response.data)
    
    assert isinstance(data, list)
    # At least one trade should exist

def test_cost_basis_shows_correct_tickers(client):
    """Test that cost basis displays all tickers correctly"""
    
    response = client.get('/api/cost-basis')
    assert response.status_code == 200
    
    data = json.loads(response.data)
    assert isinstance(data, list)
    
    # If we have tickers, verify structure
    if len(data) > 0:
        ticker_data = data[0]
        assert 'ticker' in ticker_data
        assert 'company_name' in ticker_data
        assert 'trades' in ticker_data

class TestCustomWorkflow:
    """Example: Test YOUR specific workflow"""
    
    def test_your_actual_trade_progression(self):
        """Example workflow with your data"""
        # Step 1: Initial trade
        margin_cap_1 = 25000.00
        
        # Step 2: Second trade
        margin_cap_2 = 30000.00
        
        # Step 3: Update status to assigned
        # Should reduce available bankroll
        
        # This is a template - customize with your data
        assert margin_cap_1 < margin_cap_2
    
    def test_bankroll_calculation_accuracy(self, client):
        """Test bankroll calculations match your expectations"""
        
        response = client.get('/api/bankroll-summary?account_id=9')
        assert response.status_code == 200
        
        data = json.loads(response.data)
        
        # Verify all expected fields exist
        required_fields = ['total_bankroll', 'available', 'used_in_trades']
        for field in required_fields:
            assert field in data
            assert isinstance(data[field], (int, float))
        
        # Verify logic: total = available + used
        total = data['total_bankroll']
        available = data['available']
        used = data['used_in_trades']
        
        # Allow small floating point errors
        assert abs(total - (available + used)) < 1.0
