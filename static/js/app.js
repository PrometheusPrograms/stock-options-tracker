let trades = [];
let currentFilter = { startDate: null, endDate: null, period: 'all' };
let statusFilter = '';
let symbolFilter = '';
let sortColumn = '';
let sortDirection = 'asc';
let commission = 0.0; // Commission per trade (5 decimal places)
let statusMonitorInterval = null; // For monitoring status changes
let lastTradeCount = 0; // Track number of trades for change detection
let selectedTicker = null; // Track selected ticker for cost basis
let premiumChart = null;

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    updateCurrentDate();
    initializeChart();
    loadTrades();
    loadSummary();
    updateChart(); // Load chart data
    hideCostBasisTable(); // Hide cost basis table by default
    
    // Set up form submission
    document.getElementById('trade-form').addEventListener('submit', handleTradeSubmit);
    
    // Start monitoring for trade status changes
    startStatusMonitoring();
    
    // Set up ticker input for real-time price lookup
    setupTickerInput();
    
    // Set up expiration date input for days calculation
    setupExpirationDateInput();
    
    // Set up trade type handler
    setupTradeTypeHandler();
    
    // Set up symbol filter
    setupSymbolFilter();
    
    // Set up status filter
    setupStatusFilter();
    
    // Load commission from localStorage
    loadCommission();
});

// Update current date in trade date field
function updateCurrentDate() {
    const today = new Date();
    const dateString = today.toISOString().split('T')[0];
    document.getElementById('trade-date').value = dateString;
}

// Initialize Chart.js chart
function initializeChart() {
    const ctx = document.getElementById('premiumChart').getContext('2d');
    premiumChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Daily Premium',
                data: [],
                borderColor: 'rgb(75, 192, 192)',
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true
                }
            }
        }
    });
}

// Load all trades
async function loadTrades() {
    try {
        console.log('Loading trades...');
        const response = await fetch('/api/trades');
        trades = await response.json();
        lastTradeCount = trades.length; // Update trade count for monitoring
        console.log('Trades loaded:', trades.length, 'trades');
        updateSymbolFilter();
        updateTradesTable();
        console.log('Trades table updated');
    } catch (error) {
        console.error('Error loading trades:', error);
        showAlert('Error loading trades', 'danger');
    }
}

// Update symbol filter dropdown with unique symbols
function updateSymbolFilter() {
    // Update the symbol filter autocomplete with current trades
    const symbolFilterInput = document.getElementById('symbol-filter');
    const suggestionsDiv = document.getElementById('symbol-suggestions');
    
    if (!symbolFilterInput || !suggestionsDiv) return;
    
    // Get unique symbols from current trades (excluding BTO/STC)
    const uniqueSymbols = [...new Set(trades
        .filter(trade => trade.trade_type !== 'BTO' && trade.trade_type !== 'STC' && trade.trade_type !== 'ASSIGNED')
        .map(trade => trade.ticker))];
    
    // If there's a current value in the filter, update suggestions
    const currentValue = symbolFilterInput.value.toUpperCase();
    if (currentValue.length > 0) {
        const matches = uniqueSymbols.filter(symbol => 
            symbol.toUpperCase().includes(currentValue)
        );
        
        if (matches.length > 0) {
            suggestionsDiv.innerHTML = matches.map(symbol => 
                `<div class="dropdown-item" onclick="selectSymbol('${symbol}')" style="cursor: pointer;">${symbol}</div>`
            ).join('');
            suggestionsDiv.style.display = 'block';
        } else {
            suggestionsDiv.style.display = 'none';
        }
    }
}

// Update trades table
function updateTradesTable() {
    console.log('updateTradesTable called with', trades.length, 'trades');
    const tbody = document.getElementById('trades-table');
    if (!tbody) {
        console.error('Trades table tbody not found');
        return;
    }
    tbody.innerHTML = '';
    
    // Filter trades by status and symbol
    let filteredTrades = trades;
    
    // Filter out BTO/STC trades from the trades table
    filteredTrades = filteredTrades.filter(trade => trade.trade_type !== 'BTO' && trade.trade_type !== 'STC' && trade.trade_type !== 'ASSIGNED');
    
    // Apply status filter
    if (statusFilter) {
        filteredTrades = filteredTrades.filter(trade => trade.status && trade.status === statusFilter);
    }
    
    // Apply symbol filter
    if (symbolFilter) {
        filteredTrades = filteredTrades.filter(trade => trade.ticker === symbolFilter);
    }
    
    // Sort trades if sort column is specified
    if (sortColumn) {
        filteredTrades.sort((a, b) => {
            let aVal, bVal;
            
            if (sortColumn === 'trade_date') {
                aVal = new Date(a.trade_date || a.created_at);
                bVal = new Date(b.trade_date || b.created_at);
            } else if (sortColumn === 'expiration_date') {
                aVal = new Date(a.expiration_date);
                bVal = new Date(b.expiration_date);
            } else {
                aVal = a[sortColumn];
                bVal = b[sortColumn];
            }
            
            if (sortDirection === 'asc') {
                return aVal > bVal ? 1 : -1;
            } else {
                return aVal < bVal ? 1 : -1;
            }
        });
    } else {
        // Default sort: newest trades on the right (reverse chronological order)
        filteredTrades.sort((a, b) => {
            // Primary sort: created_at (when trade was added to system)
            const aCreated = new Date(a.created_at);
            const bCreated = new Date(b.created_at);
            
            // Secondary sort: trade_date (when trade was executed)
            const aTradeDate = new Date(a.trade_date || a.created_at);
            const bTradeDate = new Date(b.trade_date || b.created_at);
            
            // Sort oldest first (so newest appears rightmost in transposed table)
            if (aCreated.getTime() !== bCreated.getTime()) {
                return aCreated - bCreated;
            } else {
                return aTradeDate - bTradeDate;
            }
        });
    }
    
    console.log('Sorted trades (oldest to newest):', filteredTrades.map(t => `${t.ticker} ${t.trade_type} (${t.created_at})`));
    
    // Always show all trades but mark filtered ones as hidden
    const allTrades = filteredTrades; // Use the sorted filteredTrades
    const visibleTrades = filteredTrades;
    
    // Create transposed table structure - no header row
    const fieldNames = [
        '', // Empty for symbol/type row (no label)
        'Trade Date', // Second row - Trade Date
        'Price', // Moved Trade Price to third row and renamed
        'Exp Date', // Moved Expiration to fourth row and renamed
        'DTE', // Moved Days to Exp to fifth row and renamed
        'Strike', // Moved Strike Price to sixth row and renamed
        'Credit', // Moved Premium to seventh row and renamed
        'Contracts', // New row - Contracts (quantity)
        'Shares', // Moved Shares to ninth row
        'Commission', // New row - Commission per trade
        'Net Credit Total', // Renamed from Net Credit - Net Credit Per Share * Shares
        'Risk Capital', // New row - Risk Capital = Strike - Net Credit Per Share
        'Margin Capital', // New row - Margin Capital = Risk Capital * Shares
        'RORC', // New row - RORC = Net Credit / Risk Capital
        'ARORC', // New row - ARORC = (365 / DTE) * RORC
        'Status',
        '' // Empty for actions row (no label)
    ];
    
    // Create data rows (transposed) - no header row
    fieldNames.forEach((fieldName, fieldIndex) => {
        const row = document.createElement('tr');
        // Only show field name if it's not empty (skip first row label)
        row.innerHTML = fieldName ? `<td class="fw-bold">${fieldName}</td>` : '<td></td>';
        
        // Apply fixed row height - 30px
        row.style.height = '30px';
        
        // Apply fixed column width for first column (field names) - 150px
        const firstCell = row.querySelector('td');
        if (firstCell) {
            firstCell.style.width = '150px';
            firstCell.style.minWidth = '150px';
            firstCell.style.maxWidth = '150px';
        }
        
        // Create columns for ALL trades (unlimited scalability)
        allTrades.forEach((trade, tradeIndex) => {
            // Check if this trade should be visible based on filters
            const isVisible = visibleTrades.some(visibleTrade => visibleTrade.id === trade.id);
            const tradeType = trade.trade_type || 'ROCT PUT';
            const status = trade.status || 'open';
            let bgColor = '';
            
            if (status === 'roll') {
                bgColor = 'background-color: #FFF2CC;';
            } else if (status === 'expired' && tradeType.toLowerCase().includes('put')) {
                bgColor = 'background-color: #C6E0B4;';
            } else if (status === 'assigned' && tradeType.toLowerCase().includes('put')) {
                bgColor = 'background-color: #A9D08F;';
            } else if (status === 'assigned' && tradeType.toLowerCase().includes('call')) {
                bgColor = 'background-color: #9BC2E6;';
            } else if (status === 'expired' && tradeType.toLowerCase().includes('call')) {
                bgColor = 'background-color: #DEEAF7;';
            }
            
            let cellContent = '';
            
            // Calculate financial metrics once for all cases that need them
            const netCreditPerShare = trade.premium - commission; // Net Credit Per Share = Credit - Commission
            const netCreditTotal = netCreditPerShare * (trade.quantity * 100); // Net Credit Total = Net Credit Per Share * Shares
            const riskCapital = trade.strike_price - netCreditPerShare; // Risk Capital = Strike - Net Credit Per Share
            const marginCapital = riskCapital * (trade.quantity * 100);
            const rorc = riskCapital !== 0 ? (netCreditPerShare / riskCapital) * 100 : 0; // RORC = Net Credit Per Share / Risk Capital
            const arorc = trade.days_to_expiration > 0 ? (365 / trade.days_to_expiration) * rorc : 0;
            
            switch (fieldIndex) {
                case 0: // Symbol/Type (back to first row)
                    const today = new Date();
                    const expirationDate = new Date(trade.expiration_date);
                    const isExpired = trade.status === 'open' && today > expirationDate;
                    cellContent = `<strong>${isExpired ? '<i class="fas fa-exclamation-triangle text-danger me-1" title="Expired"></i>' : ''}<span class="clickable-symbol" onclick="filterBySymbol('${trade.ticker}')" style="cursor: pointer; color: #007bff; text-decoration: underline;">${trade.ticker}</span> ${tradeType}</strong>`;
                    break;
                case 1: // Trade Date (moved to second row) - Editable
                    cellContent = `<input type="date" class="form-control form-control-sm text-center" value="${trade.trade_date || trade.created_at}" data-trade-id="${trade.id}" data-field="trade_date" onchange="updateTradeField(${trade.id}, 'trade_date', this.value)">`;
                    break;
                case 2: // Price (was Trade Price) - Editable
                    cellContent = `<div class="text-center"><span class="text-muted me-1">$</span><input type="text" class="form-control form-control-sm text-center d-inline-block" value="${parseFloat(trade.current_price).toFixed(2)}" data-trade-id="${trade.id}" data-field="current_price" onchange="updateTradeField(${trade.id}, 'current_price', this.value)" style="width: 80px;">`;
                    break;
                case 3: // Exp Date (was Expiration) - Editable
                    cellContent = `<input type="date" class="form-control form-control-sm text-center" value="${trade.expiration_date}" data-trade-id="${trade.id}" data-field="expiration_date" onchange="updateTradeField(${trade.id}, 'expiration_date', this.value)">`;
                    break;
                case 4: // DTE (was Days to Exp) - Read-only (calculated)
                    cellContent = `<span class="text-center">${trade.days_to_expiration}</span>`;
                    break;
                case 5: // Strike (was Strike Price) - Editable
                    cellContent = `<div class="text-center"><span class="text-muted me-1">$</span><input type="text" class="form-control form-control-sm text-center d-inline-block" value="${parseFloat(trade.strike_price || 0).toFixed(2)}" data-trade-id="${trade.id}" data-field="strike_price" onchange="updateTradeField(${trade.id}, 'strike_price', this.value)" style="width: 80px;">`;
                    break;
                case 6: // Credit (was Premium) - Editable
                    cellContent = `<div class="text-center"><span class="text-muted me-1">$</span><input type="text" class="form-control form-control-sm text-center d-inline-block" value="${parseFloat(trade.premium).toFixed(2)}" data-trade-id="${trade.id}" data-field="premium" onchange="updateTradeField(${trade.id}, 'premium', this.value)" style="width: 80px;">`;
                    break;
                case 7: // Contracts - Editable (quantity)
                    cellContent = `<input type="number" class="form-control form-control-sm text-center" value="${trade.quantity}" step="1" data-trade-id="${trade.id}" data-field="quantity" onchange="updateTradeField(${trade.id}, 'quantity', this.value)">`;
                    break;
                case 8: // Shares - Read-only (calculated from quantity)
                    cellContent = `<span class="text-center">${trade.quantity * 100}</span>`;
                    break;
                case 9: // Commission
                    cellContent = `<span class="text-center">$${commission.toLocaleString('en-US', {minimumFractionDigits: 5, maximumFractionDigits: 5})}</span>`;
                    break;
                case 10: // Net Credit Total = Net Credit Per Share * Shares
                    cellContent = `<strong class="text-center">$${netCreditTotal.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong>`;
                    break;
                case 11: // Risk Capital = Strike - Net Credit Per Share
                    cellContent = `<span class="text-center">$${riskCapital.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>`;
                    break;
                case 12: // Margin Capital = Risk Capital * Shares
                    cellContent = `<span class="text-center">$${marginCapital.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>`;
                    break;
                case 13: // RORC = Net Credit Per Share / Risk Capital
                    cellContent = `<span class="text-center">${rorc.toFixed(2)}%</span>`;
                    break;
                case 14: // ARORC = (365 / DTE) * RORC
                    cellContent = `<span class="text-center">${arorc.toFixed(1)}%</span>`;
                    break;
                case 15: // Status
                    cellContent = `
                        <div class="text-center">
                            <select class="form-select form-select-sm status-select" data-trade-id="${trade.id}" onchange="updateTradeStatus(${trade.id}, this.value)">
                                <option value="open" ${trade.status === 'open' ? 'selected' : ''}>Open</option>
                                <option value="closed" ${trade.status === 'closed' ? 'selected' : ''}>Closed</option>
                                <option value="assigned" ${trade.status === 'assigned' ? 'selected' : ''}>Assigned</option>
                                <option value="expired" ${trade.status === 'expired' ? 'selected' : ''}>Expired</option>
                                <option value="roll" ${trade.status === 'roll' ? 'selected' : ''}>Roll</option>
                            </select>
                        </div>
                    `;
                    break;
                case 16: // Actions
                    cellContent = `
                        <div class="text-center">
                            <button class="btn btn-sm btn-outline-primary me-1" onclick="editTrade(${trade.id})" title="Edit Trade">
                                <i class="fas fa-edit"></i>
                            </button>
                            <button class="btn btn-sm btn-outline-danger" onclick="deleteTrade(${trade.id})" title="Delete Trade">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    `;
                    break;
                default:
                    cellContent = '';
                    console.warn(`Unknown field index: ${fieldIndex}`);
                    break;
            }
            
            // Apply fixed column width to data cells - 160px with visibility control
            const visibilityStyle = isVisible ? '' : 'display: none;';
            row.innerHTML += `<td style="${bgColor}; width: 160px; min-width: 160px; max-width: 160px; ${visibilityStyle}">${cellContent}</td>`;
        });
        
        tbody.appendChild(row);
    });
    
    // Ensure all cells have fixed column widths after table update
    applyFixedColumnWidths();
    
    // Set table width based on number of visible columns to prevent stretching
    setTableWidth();
    
    console.log('Trades table update completed. Rows:', tbody.children.length);
}

// Apply fixed column widths to all table cells
function applyFixedColumnWidths() {
    const allRows = document.querySelectorAll('#trades-table tr');
    allRows.forEach(row => {
        const cells = row.querySelectorAll('td');
        cells.forEach((cell, cellIndex) => {
            if (cellIndex === 0) {
                // First column (field names) - 150px
                cell.style.width = '150px';
                cell.style.minWidth = '150px';
                cell.style.maxWidth = '150px';
            } else {
                // Trade data columns - 160px
                cell.style.width = '160px';
                cell.style.minWidth = '160px';
                cell.style.maxWidth = '160px';
                // Preserve visibility settings from inline styles
                const currentStyle = cell.getAttribute('style') || '';
                if (currentStyle.includes('display: none')) {
                    cell.style.display = 'none';
                }
            }
        });
    });
}

// Set table width based on number of visible columns to prevent stretching
function setTableWidth() {
    const table = document.getElementById('trades-table-main');
    if (!table) return;
    
    // Count visible columns (excluding the first field column)
    const firstRow = table.querySelector('tr');
    if (!firstRow) return;
    
    const cells = firstRow.querySelectorAll('td');
    let visibleColumns = 0;
    
    // Count visible data columns (skip first cell which is field names)
    for (let i = 1; i < cells.length; i++) {
        const cell = cells[i];
        const style = cell.getAttribute('style') || '';
        if (!style.includes('display: none')) {
            visibleColumns++;
        }
    }
    
    // Calculate total width: 150px (field column) + (visible columns × 160px)
    const totalWidth = 150 + (visibleColumns * 160);
    table.style.width = `${totalWidth}px`;
}

// Handle trade form submission
async function handleTradeSubmit(event) {
    event.preventDefault();
    
    const formData = {
        ticker: document.getElementById('ticker').value.toUpperCase(),
        tradeDate: document.getElementById('trade-date').value,
        expirationDate: document.getElementById('expiration-date').value,
        quantity: parseInt(document.getElementById('quantity').value),
        premium: parseFloat(document.getElementById('premium').value),
        currentPrice: parseFloat(document.getElementById('current-price').value),
        strikePrice: parseFloat(document.getElementById('strike-price').value || 0),
        tradeType: document.getElementById('trade-type').value
    };
    
    try {
        const response = await fetch('/api/trades', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(formData)
        });
        
        const result = await response.json();
        
        if (result.success) {
            showAlert('Trade added successfully', 'success');
            document.getElementById('trade-form').reset();
            updateCurrentDate();
            await loadTrades();
            loadSummary();
            // Only reload cost basis if a ticker is currently selected
            if (selectedTicker) {
                loadCostBasis(selectedTicker);
            }
        } else {
            showAlert(result.error || 'Failed to add trade', 'danger');
        }
    } catch (error) {
        console.error('Error adding trade:', error);
        showAlert('Failed to add trade', 'danger');
    }
}

// Delete trade
async function deleteTrade(tradeId) {
    if (confirm('Are you sure you want to delete this trade?')) {
        try {
            const response = await fetch(`/api/trades/${tradeId}`, {
                method: 'DELETE'
            });
            
            const result = await response.json();
            
            if (result.success) {
                await loadTrades();
                loadSummary();
                // Only reload cost basis if a ticker is currently selected
                if (selectedTicker) {
                    loadCostBasis(selectedTicker);
                }
                
                showAlert('Trade deleted successfully', 'success');
            } else {
                showAlert(result.error || 'Failed to delete trade', 'danger');
            }
        } catch (error) {
            console.error('Error deleting trade:', error);
            showAlert('Failed to delete trade', 'danger');
        }
    }
}

// Setup symbol filter with autocomplete
function setupSymbolFilter() {
    const symbolFilterInput = document.getElementById('symbol-filter');
    const suggestionsDiv = document.getElementById('symbol-suggestions');
    const clearButton = document.getElementById('clear-symbol');
    
    if (!symbolFilterInput || !suggestionsDiv) return;
    
    // Add input event listener for autocomplete
    symbolFilterInput.addEventListener('input', function() {
        const value = this.value.toUpperCase();
        symbolFilter = value;
        
        if (value.length === 0) {
            suggestionsDiv.style.display = 'none';
            symbolFilter = '';
            if (clearButton) clearButton.style.display = 'none';
        } else {
            if (clearButton) clearButton.style.display = 'block';
            
            // Get unique symbols from current trades (excluding BTO/STC)
            const uniqueSymbols = [...new Set(trades
                .filter(trade => trade.trade_type !== 'BTO' && trade.trade_type !== 'STC' && trade.trade_type !== 'ASSIGNED')
                .map(trade => trade.ticker))];
            
            // Filter symbols that match the input
            const matches = uniqueSymbols.filter(symbol => 
                symbol.toUpperCase().includes(value)
            );
            
            if (matches.length > 0) {
                suggestionsDiv.innerHTML = matches.map(symbol => 
                    `<div class="dropdown-item" onclick="selectSymbol('${symbol}')" style="cursor: pointer;">${symbol}</div>`
                ).join('');
                suggestionsDiv.style.display = 'block';
            } else {
                suggestionsDiv.style.display = 'none';
            }
        }
        
        updateTradesTable();
    });
    
    // Add clear button functionality
    if (clearButton) {
        clearButton.addEventListener('click', function() {
            symbolFilterInput.value = '';
            symbolFilter = '';
            suggestionsDiv.style.display = 'none';
            this.style.display = 'none';
            updateTradesTable();
        });
        
        // Hide clear button initially
        clearButton.style.display = 'none';
    }
    
    // Hide suggestions when clicking outside
    document.addEventListener('click', function(e) {
        if (!symbolFilterInput.contains(e.target) && !suggestionsDiv.contains(e.target)) {
            suggestionsDiv.style.display = 'none';
        }
    });
}

// Select symbol from autocomplete
function selectSymbol(symbol) {
    const symbolFilterInput = document.getElementById('symbol-filter');
    const suggestionsDiv = document.getElementById('symbol-suggestions');
    
    if (symbolFilterInput) {
        symbolFilterInput.value = symbol;
        symbolFilter = symbol;
        suggestionsDiv.style.display = 'none';
        updateTradesTable();
        loadCostBasis(symbol);
        
        // Scroll to cost basis table
        setTimeout(() => {
            const costBasisElement = document.getElementById('cost-basis-summary');
            if (costBasisElement) {
                costBasisElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }, 500); // Wait for cost basis to load
    }
}

// Filter by symbol function (called when clicking on symbol)
function filterBySymbol(symbol) {
    symbolFilter = symbol;
    const symbolFilterInput = document.getElementById('symbol-filter');
    if (symbolFilterInput) {
        symbolFilterInput.value = symbol;
    }
    updateTradesTable();
    // Load cost basis for the selected symbol
    loadCostBasis(symbol);
    
    // Show clear cost basis button
    const clearCostBasisButton = document.getElementById('clear-cost-basis-filter');
    if (clearCostBasisButton) {
        clearCostBasisButton.style.display = 'block';
    }
    
    // Scroll to cost basis table
    setTimeout(() => {
        const costBasisElement = document.getElementById('cost-basis-summary');
        if (costBasisElement) {
            costBasisElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, 500); // Wait for cost basis to load
}

// Clear symbol filter
function clearSymbolFilter() {
    const symbolFilterInput = document.getElementById('symbol-filter');
    const suggestionsDiv = document.getElementById('symbol-suggestions');
    const clearButton = document.getElementById('clear-symbol');
    
    if (symbolFilterInput) {
        symbolFilterInput.value = '';
        symbolFilter = '';
        suggestionsDiv.style.display = 'none';
        if (clearButton) clearButton.style.display = 'none';
        updateTradesTable();
    }
}

// Clear cost basis filter
function clearCostBasisFilter() {
    // Clear symbol filter
    symbolFilter = '';
    const symbolFilterInput = document.getElementById('symbol-filter');
    if (symbolFilterInput) {
        symbolFilterInput.value = '';
    }
    
    // Hide clear cost basis button
    const clearCostBasisButton = document.getElementById('clear-cost-basis-filter');
    if (clearCostBasisButton) {
        clearCostBasisButton.style.display = 'none';
    }
    
    // Hide cost basis table
    hideCostBasisTable();
    
    // Update trades table
    updateTradesTable();
}

// Set up trade type change handler
function setupTradeTypeHandler() {
    const tradeTypeSelect = document.getElementById('trade-type');
    const expirationDateContainer = document.getElementById('expiration-date-container');
    const quantityContainer = document.getElementById('quantity-container');
    const sharesContainer = document.getElementById('shares-container');
    const pricePerShareContainer = document.getElementById('price-per-share-container');
    const premiumContainer = document.getElementById('premium-container');
    const strikePriceContainer = document.getElementById('strike-price-container');
    
    tradeTypeSelect.addEventListener('change', function() {
        const tradeType = this.value;
        
        if (tradeType === 'BTO' || tradeType === 'STC') {
            // Hide options-specific fields
            expirationDateContainer.style.display = 'none';
            quantityContainer.style.display = 'none';
            premiumContainer.style.display = 'none';
            strikePriceContainer.style.display = 'none';
            
            // Show stock-specific fields
            sharesContainer.style.display = 'block';
            pricePerShareContainer.style.display = 'block';
        } else {
            // Show options-specific fields
            expirationDateContainer.style.display = 'block';
            quantityContainer.style.display = 'block';
            premiumContainer.style.display = 'block';
            
            // Hide stock-specific fields
            sharesContainer.style.display = 'none';
            pricePerShareContainer.style.display = 'none';
            
            // Show/hide strike price based on trade type
            if (tradeType === 'BTC' || tradeType === 'STO') {
                strikePriceContainer.style.display = 'none';
            } else {
                strikePriceContainer.style.display = 'block';
            }
        }
    });
}

// Set up ticker input for real-time price lookup
function setupTickerInput() {
    const tickerInput = document.getElementById('ticker');
    
    tickerInput.addEventListener('blur', async function() {
        const ticker = this.value.toUpperCase();
        if (ticker) {
            try {
                // For now, we'll use a placeholder price
                // In a real implementation, you'd call an API here
                const currentPrice = 100.00; // Placeholder
                document.getElementById('current-price').value = currentPrice.toFixed(2);
            } catch (error) {
                console.error('Error fetching current price:', error);
            }
        }
    });
}

// Set up expiration date input for days calculation
function setupExpirationDateInput() {
    const expirationDateInput = document.getElementById('expiration-date');
    const daysToExpirationInput = document.getElementById('days-to-expiration');
    
    expirationDateInput.addEventListener('change', function() {
        const tradeDate = document.getElementById('trade-date').value;
        const expirationDate = this.value;
        
        if (tradeDate && expirationDate) {
            const tradeDateObj = new Date(tradeDate);
            const expirationDateObj = new Date(expirationDate);
            const daysDiff = Math.ceil((expirationDateObj - tradeDateObj) / (1000 * 60 * 60 * 24));
            daysToExpirationInput.value = daysDiff;
        }
    });
}

// Set up status filter
function setupStatusFilter() {
    const statusFilterSelect = document.getElementById('status-filter');
    
    statusFilterSelect.addEventListener('change', function() {
        statusFilter = this.value;
        updateTradesTable();
    });
}

// Update trade status
async function updateTradeStatus(tradeId, newStatus) {
    try {
        const response = await fetch(`/api/trades/${tradeId}/status`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ status: newStatus })
        });
        
        const result = await response.json();
        
        if (result.success) {
            // If status changed to "roll", reload all trades to get the new duplicate
            if (newStatus === 'roll') {
                await loadTrades();
                showAlert(`Trade status updated to ${newStatus} and duplicate entry created`, 'success');
            } else {
                // Update the trade in our local array
                const tradeIndex = trades.findIndex(trade => trade.id === tradeId);
                if (tradeIndex !== -1) {
                    trades[tradeIndex].status = newStatus;
                }
                
                // Update the table
                updateTradesTable();
                
                // Reload cost basis if it's currently displayed
                if (selectedTicker) {
                    await loadCostBasis(selectedTicker);
                }
                
                showAlert(`Trade status updated to ${newStatus}`, 'success');
            }
        } else {
            showAlert('Error updating trade status: ' + (result.error || 'Unknown error'), 'danger');
        }
    } catch (error) {
        console.error('Error updating trade status:', error);
        showAlert('Error updating trade status. Please try again.', 'danger');
    }
}

// Update trade field
async function updateTradeField(tradeId, fieldName, newValue) {
    try {
        const response = await fetch(`/api/trades/${tradeId}/field`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ field: fieldName, value: newValue })
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Update the trade in our local array
            const tradeIndex = trades.findIndex(trade => trade.id === tradeId);
            if (tradeIndex !== -1) {
                trades[tradeIndex][fieldName] = newValue;
                
                // Recalculate days_to_expiration if trade_date or expiration_date changed
                if (fieldName === 'trade_date' || fieldName === 'expiration_date') {
                    const tradeDate = trades[tradeIndex].trade_date;
                    const expirationDate = trades[tradeIndex].expiration_date;
                    if (tradeDate && expirationDate) {
                        const tradeDateObj = new Date(tradeDate);
                        const expirationDateObj = new Date(expirationDate);
                        const daysDiff = Math.ceil((expirationDateObj - tradeDateObj) / (1000 * 60 * 60 * 24));
                        trades[tradeIndex].days_to_expiration = daysDiff;
                    }
                }
                
                // Recalculate total_premium if premium or quantity changed
                if (fieldName === 'premium' || fieldName === 'quantity') {
                    trades[tradeIndex].total_premium = trades[tradeIndex].premium * trades[tradeIndex].quantity * 100;
                }
            }
            
            // Update the table
            updateTradesTable();
            
            showAlert(`${fieldName} updated successfully`, 'success');
        } else {
            showAlert('Error updating field: ' + (result.error || 'Unknown error'), 'danger');
        }
    } catch (error) {
        console.error('Error updating trade field:', error);
        showAlert('Error updating field. Please try again.', 'danger');
    }
}

// Load cost basis data
async function loadCostBasis(ticker = null) {
    if (!ticker) {
        // Hide cost basis table if no ticker selected
        hideCostBasisTable();
        return;
    }
    
    try {
        const response = await fetch(`/api/cost-basis?commission=${commission}`);
        const costBasisData = await response.json();
        
        if (response.ok) {
            // Filter data for the selected ticker only
            const tickerData = costBasisData.filter(data => data.ticker === ticker);
            await updateCostBasisTable(tickerData);
            selectedTicker = ticker;
        } else {
            console.error('Error loading cost basis:', costBasisData.error);
        }
    } catch (error) {
        console.error('Error loading cost basis:', error);
    }
}

function hideCostBasisTable() {
    const container = document.getElementById('cost-basis-summary');
    container.innerHTML = '<p class="text-muted">Click on a stock symbol in the Trades table to view its cost basis summary.</p>';
    selectedTicker = null;
}

async function updateCostBasisTable(costBasisData) {
    const container = document.getElementById('cost-basis-summary');
    
    if (!costBasisData || costBasisData.length === 0) {
        container.innerHTML = '<p class="text-muted">No cost basis data available for the selected stock symbol.</p>';
        return;
    }
    
    let html = '';
    
    for (const tickerData of costBasisData) {
        const { ticker, total_shares, total_cost_basis, total_cost_basis_per_share, trades } = tickerData;
        
        // Get company name for the ticker (now async)
        const companyName = await getCompanyName(ticker);
        const displayTitle = companyName ? `${ticker} - ${companyName}` : ticker;
        
        html += `
            <div class="mb-4">
                <h6 class="text-primary mb-3">
                    <i class="fas fa-chart-line me-2"></i>${displayTitle}
                </h6>
                
                <!-- Summary Row -->
                <div class="row mb-3">
                    <div class="col-md-3">
                        <div class="card bg-light">
                            <div class="card-body text-center">
                                <h6 class="card-title">Total Shares</h6>
                                <p class="card-text h5 ${total_shares < 0 ? 'text-danger' : ''}">${total_shares < 0 ? `(${Math.abs(total_shares).toLocaleString()})` : total_shares.toLocaleString()}</p>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-3">
                        <div class="card bg-light">
                            <div class="card-body text-center">
                                <h6 class="card-title">Total Cost Basis</h6>
                                <p class="card-text h5 ${total_cost_basis < 0 ? 'text-danger' : ''}">${total_cost_basis < 0 ? `($${Math.abs(total_cost_basis).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})})` : `$${total_cost_basis.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</p>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-3">
                        <div class="card bg-light">
                            <div class="card-body text-center">
                                <h6 class="card-title">Cost Basis/Share</h6>
                                <p class="card-text h5 ${total_cost_basis_per_share < 0 ? 'text-danger' : ''}">${total_cost_basis_per_share < 0 ? `($${Math.abs(total_cost_basis_per_share).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})})` : `$${total_cost_basis_per_share.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</p>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-3">
                        <div class="card bg-light">
                            <div class="card-body text-center">
                                <h6 class="card-title">Total Trades</h6>
                                <p class="card-text h5">${trades.length}</p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Individual Trades Table -->
                <div class="table-responsive">
                    <table class="table table-sm">
                        <thead style="background-color: transparent;">
                            <tr>
                                <th class="text-center" style="color: black; background-color: transparent;">Trade Date</th>
                                <th class="text-start" style="color: black; background-color: transparent;">Trade Description</th>
                                <th class="text-end" style="color: black; background-color: transparent;">Shares</th>
                                <th class="text-end" style="color: black; background-color: transparent;">Cost</th>
                                <th class="text-end" style="color: black; background-color: transparent;">Amount</th>
                                <th class="text-end" style="color: black; background-color: transparent;">Closing Amount</th>
                                <th class="text-end" style="color: black; background-color: transparent;">Basis</th>
                                <th class="text-end" style="color: black; background-color: transparent;">Basis/Share</th>
                                <th class="text-center" style="color: black; background-color: transparent;"></th>
                            </tr>
                        </thead>
                        <tbody>
        `;
        
        trades.forEach(trade => {
            // Format numbers with parentheses for negative values
            const formatNumber = (value, isCurrency = false) => {
                const formatted = value.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
                if (value < 0) {
                    return `($${formatted.replace('-', '')})`;
                }
                return `$${formatted}`;
            };
            
            const formatShares = (value) => {
                const formatted = value.toLocaleString();
                if (value < 0) {
                    return `(${formatted.replace('-', '')})`;
                }
                return formatted;
            };
            
            const sharesClass = trade.shares < 0 ? 'text-danger' : '';
            const runningBasisClass = trade.running_basis < 0 ? 'text-danger' : '';
            const runningBasisPerShareClass = trade.running_basis_per_share < 0 ? 'text-danger' : '';
            const costClass = trade.cost_per_share < 0 ? 'text-danger' : '';
            const amountClass = trade.amount < 0 ? 'text-danger' : '';
            const closingAmountClass = trade.closing_amount < 0 ? 'text-danger' : '';
            
            // Apply same color logic as trades table
            const tradeType = trade.trade_type || 'ROCT PUT';
            const status = trade.status || 'open';
            let bgColor = '';
            
            if (status === 'roll') {
                bgColor = 'background-color: #FFF2CC;';
            } else if (status === 'expired' && tradeType.toLowerCase().includes('put')) {
                bgColor = 'background-color: #C6E0B4;';
            } else if (status === 'assigned' && tradeType.toLowerCase().includes('put')) {
                bgColor = 'background-color: #A9D08F;';
            } else if (status === 'assigned' && tradeType.toLowerCase().includes('call')) {
                bgColor = 'background-color: #9BC2E6;';
            } else if (status === 'expired' && tradeType.toLowerCase().includes('call')) {
                bgColor = 'background-color: #DEEAF7;';
            }
            
            const rowStyle = bgColor ? `style="${bgColor}"` : '';
            
            html += `
                <tr ${rowStyle}>
                    <td class="text-center">${formatDate(trade.trade_date)}</td>
                    <td class="text-start">${trade.trade_description}</td>
                    <td class="text-end ${sharesClass}">${formatShares(trade.shares)}</td>
                    <td class="text-end ${costClass}">${formatNumber(trade.cost_per_share)}</td>
                    <td class="text-end ${amountClass}">${formatNumber(trade.amount)}</td>
                    <td class="text-end ${closingAmountClass}">${formatNumber(trade.closing_amount)}</td>
                    <td class="text-end ${runningBasisClass}">${formatNumber(trade.running_basis)}</td>
                    <td class="text-end ${runningBasisPerShareClass}">${formatNumber(trade.running_basis_per_share)}</td>
                    <td class="text-center">
                        <button class="btn btn-sm btn-outline-danger" onclick="deleteCostBasisTrade(${trade.id})" title="Delete Trade">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `;
        });
        
        html += `
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

// Delete cost basis trade function
async function deleteCostBasisTrade(tradeId) {
    if (confirm('Are you sure you want to delete this cost basis entry? This action cannot be undone.')) {
        try {
            const response = await fetch(`/api/trades/${tradeId}`, {
                method: 'DELETE'
            });
            
            const result = await response.json();
            
            if (result.success) {
                showAlert('Cost basis entry deleted successfully', 'success');
                // Reload trades and cost basis to refresh the display
                await loadTrades();
                if (selectedTicker) {
                    await loadCostBasis(selectedTicker);
                }
            } else {
                showAlert('Error deleting cost basis entry: ' + (result.error || 'Unknown error'), 'danger');
            }
        } catch (error) {
            console.error('Error deleting cost basis entry:', error);
            showAlert('Error deleting cost basis entry. Please try again.', 'danger');
        }
    }
}

// Status monitoring functions
function startStatusMonitoring() {
    // Check every 3 seconds for changes
    statusMonitorInterval = setInterval(checkForTradeChanges, 3000);
    console.log('Started trade status monitoring');
}

function stopStatusMonitoring() {
    if (statusMonitorInterval) {
        clearInterval(statusMonitorInterval);
        statusMonitorInterval = null;
        console.log('Stopped trade status monitoring');
    }
}

async function checkForTradeChanges() {
    try {
        const response = await fetch('/api/trades');
        const newTrades = await response.json();
        
        // Check if number of trades changed
        if (newTrades.length !== lastTradeCount) {
            console.log(`Trade count changed: ${lastTradeCount} -> ${newTrades.length}`);
            lastTradeCount = newTrades.length;
            await loadTrades(); // Reload all trades
            return;
        }
        
        // Check for status changes in existing trades
        let hasChanges = false;
        for (let i = 0; i < trades.length; i++) {
            const oldTrade = trades[i];
            const newTrade = newTrades.find(t => t.id === oldTrade.id);
            
            if (newTrade && newTrade.status !== oldTrade.status) {
                console.log(`Trade ${oldTrade.id} status changed: ${oldTrade.status} -> ${newTrade.status}`);
                hasChanges = true;
                break;
            }
        }
        
        if (hasChanges) {
            console.log('Status changes detected, reloading trades and cost basis');
            await loadTrades(); // Reload all trades
            // Also reload cost basis if it's currently displayed
            if (selectedTicker) {
                await loadCostBasis(selectedTicker);
            }
        }
        
    } catch (error) {
        console.error('Error checking for trade changes:', error);
    }
}

// Clean up monitoring when page is unloaded
window.addEventListener('beforeunload', function() {
    stopStatusMonitoring();
});

// Format currency with proper styling
function formatCurrency(amount) {
    const isNegative = amount < 0;
    const formatted = Math.abs(amount).toFixed(2);
    return `<span class="${isNegative ? 'text-danger' : ''}">$${formatted}</span>`;
}

// Format date as DD-MMM-YY
function formatDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const day = date.getDate().toString().padStart(2, '0');
    const month = date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    const year = date.getFullYear().toString().slice(-2);
    return `${day}-${month}-${year}`;
}

// Get company name (placeholder function)
async function getCompanyName(ticker) {
    // This would typically call an API to get company names
    // For now, return a placeholder
    return `${ticker} Corp`;
}

// Show alert message
function showAlert(message, type = 'info') {
    const alertContainer = document.getElementById('alert-container');
    const alertId = 'alert-' + Date.now();
    
    const alertHtml = `
        <div id="${alertId}" class="alert alert-${type} alert-dismissible fade show" role="alert">
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        </div>
    `;
    
    alertContainer.insertAdjacentHTML('beforeend', alertHtml);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        const alertElement = document.getElementById(alertId);
        if (alertElement) {
            alertElement.remove();
        }
    }, 5000);
}

// Load summary data
async function loadSummary() {
    try {
        const response = await fetch('/api/summary');
        const summary = await response.json();
        
        if (response.ok) {
            // Update dashboard cards
            document.getElementById('total-trades').textContent = summary.total_trades;
            document.getElementById('open-trades').textContent = summary.open_trades;
            document.getElementById('closed-trades').textContent = summary.closed_trades;
            document.getElementById('total-net-credit').textContent = `$${summary.total_net_credit.toFixed(2)}`;
            document.getElementById('days-remaining').textContent = summary.days_remaining;
            document.getElementById('days-done').textContent = summary.days_done;
        } else {
            console.error('Error loading summary:', summary.error);
        }
    } catch (error) {
        console.error('Error loading summary:', error);
    }
}

// Commission settings functions
function toggleCommissionSettings() {
    const modal = new bootstrap.Modal(document.getElementById('commission-modal'));
    modal.show();
}

function saveCommission() {
    const commissionInput = document.getElementById('commission-input');
    const newCommission = parseFloat(commissionInput.value) || 0;
    
    commission = newCommission;
    localStorage.setItem('commission', commission.toString());
    
    // Close modal
    const modal = bootstrap.Modal.getInstance(document.getElementById('commission-modal'));
    modal.hide();
    
    // Update trades table to reflect new commission
    updateTradesTable();
    
    showAlert('Commission settings saved', 'success');
}

function loadCommission() {
    const savedCommission = localStorage.getItem('commission');
    if (savedCommission) {
        commission = parseFloat(savedCommission);
        document.getElementById('commission-input').value = commission;
    }
}

// Filter functions
function setFilter(period) {
    const today = new Date();
    let startDate, endDate;
    
    switch (period) {
        case 'week':
            // Current week (Monday to Friday)
            const dayOfWeek = today.getDay();
            const monday = new Date(today);
            monday.setDate(today.getDate() - dayOfWeek + 1);
            const friday = new Date(monday);
            friday.setDate(monday.getDate() + 4);
            startDate = monday.toISOString().split('T')[0];
            endDate = friday.toISOString().split('T')[0];
            break;
        case 'month':
            // Current month (first day to last day)
            startDate = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
            endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];
            break;
        case 'quarter':
            // Current quarter
            const quarter = Math.floor(today.getMonth() / 3);
            startDate = new Date(today.getFullYear(), quarter * 3, 1).toISOString().split('T')[0];
            endDate = new Date(today.getFullYear(), quarter * 3 + 3, 0).toISOString().split('T')[0];
            break;
        case 'year':
            // Current year
            startDate = new Date(today.getFullYear(), 0, 1).toISOString().split('T')[0];
            endDate = new Date(today.getFullYear(), 11, 31).toISOString().split('T')[0];
            break;
        default:
            return;
    }
    
    document.getElementById('start-date').value = startDate;
    document.getElementById('end-date').value = endDate;
    
    // Highlight the active filter button
    document.querySelectorAll('.btn-outline-primary').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
}

function applyFilter() {
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;
    
    currentFilter = { startDate, endDate, period: 'custom' };
    
    // Update dashboard and chart
    loadSummary();
    updateChartForFilter();
    
    showAlert('Filter applied', 'success');
}

function clearFilter() {
    document.getElementById('start-date').value = '';
    document.getElementById('end-date').value = '';
    
    currentFilter = { startDate: null, endDate: null, period: 'all' };
    
    // Remove active class from all filter buttons
    document.querySelectorAll('.btn-outline-primary').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Update dashboard and chart
    loadSummary();
    updateChartForFilter();
    
    showAlert('Filter cleared', 'info');
}

function updateChartForFilter() {
    // This would typically call an API to get chart data based on the filter
    // For now, we'll just update the chart with current data
    if (premiumChart) {
        // Update chart data based on filter
        updateChart();
    }
}

function updateChart() {
    // Fetch chart data from API
    fetch('/api/chart-data')
        .then(response => response.json())
        .then(data => {
            if (data.dates && data.premiums) {
                if (premiumChart) {
                    premiumChart.data.labels = data.dates;
                    premiumChart.data.datasets[0].data = data.premiums;
                    premiumChart.update();
                }
            }
        })
        .catch(error => {
            console.error('Error loading chart data:', error);
        });
}
