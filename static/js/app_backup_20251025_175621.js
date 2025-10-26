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

// Add trade type functionality
function addTradeType(tradeType) {
    console.log(`addTradeType called with: ${tradeType}`);
    if (tradeType === 'BTO') {
        console.log('Calling addBTOTrade...');
        addBTOTrade();
    } else {
        // For other trade types, show a message or implement specific functionality
        console.log(`Adding ${tradeType} trade - functionality to be implemented`);
        alert(`${tradeType} functionality not yet implemented`);
    }
}

// Legacy function - now replaced by openBTOModal()

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded, initializing app...');
    
    // Load commission settings
    loadCommission();
    
    // Load initial data
    loadTrades();
    loadSummary();
    loadCostBasis();
    
    // Initialize chart
    initializeChart();
    
    // Update chart with data
    setTimeout(() => {
        updateChart();
    }, 100);
    
    // Set up event listeners
    setupStatusFilter();
    setupSymbolFilter();
    
    console.log('App initialized');
});

// Update current date in trade date field
function updateCurrentDate() {
    const today = new Date();
    const dateString = today.toISOString().split('T')[0];
    document.getElementById('trade-date').value = dateString;
}

// Initialize Chart.js chart
function initializeChart() {
    const ctx = document.getElementById('premiumChart');
    if (!ctx) {
        console.error('Chart canvas not found');
        return;
    }
    
    premiumChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Daily Premium ($)',
                data: [],
                borderColor: 'rgb(75, 192, 192)',
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                borderWidth: 2,
                tension: 0.1,
                fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: function(value) {
                            return '$' + value.toLocaleString();
                        }
                    }
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
        console.error('Error loading trades:', error);
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
    if (window.symbolFilter) {
        filteredTrades = filteredTrades.filter(trade => trade.ticker === window.symbolFilter);
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
            firstCell.style.textAlign = 'center';
            firstCell.style.whiteSpace = 'normal';
            firstCell.style.wordWrap = 'break-word';
            firstCell.style.verticalAlign = 'middle';
            firstCell.style.backgroundColor = 'transparent';
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
                    cellContent = `<div style="text-align: center; white-space: normal; word-wrap: break-word; vertical-align: middle;"><strong>${isExpired ? '<i class="fas fa-exclamation-triangle text-danger me-1" title="Expired"></i>' : ''}<span class="clickable-symbol" onclick="filterBySymbol('${trade.ticker}')" style="cursor: pointer; color: #007bff; text-decoration: underline;">${trade.ticker}</span> ${tradeType}</strong></div>`;
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
        console.log('Trade added successfully');
            document.getElementById('trade-form').reset();
            updateCurrentDate();
            await loadTrades();
            loadSummary();
            // Only reload cost basis if a ticker is currently selected
            if (selectedTicker) {
                loadCostBasis(selectedTicker);
            }
        } else {
            console.error(result.error || 'Failed to add trade');
        }
    } catch (error) {
        console.error('Error adding trade:', error);
        console.error('Failed to add trade');
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
                
                console.log('Trade deleted successfully');
            } else {
                console.error(result.error || 'Failed to delete trade');
            }
        } catch (error) {
            console.error('Error deleting trade:', error);
            console.error('Failed to delete trade');
        }
    }
}

// Setup symbol filter with autocomplete
function setupSymbolFilter() {
    const symbolFilterInput = document.getElementById('symbol-filter');
    const suggestionsDiv = document.getElementById('symbol-suggestions');
    const clearButton = document.getElementById('clear-symbol');
    
    if (!symbolFilterInput || !suggestionsDiv) return;
    
    let debounceTimer;
    
    // Add input event listener for autocomplete
    symbolFilterInput.addEventListener('input', function() {
        const value = this.value.trim();
        symbolFilter = value.toUpperCase();
        
        // Clear previous timer
        clearTimeout(debounceTimer);
        
        if (value.length === 0) {
            suggestionsDiv.style.display = 'none';
            symbolFilter = '';
            if (clearButton) clearButton.style.display = 'none';
            updateTradesTable();
        } else {
            if (clearButton) clearButton.style.display = 'block';
            
            // Debounce API calls
            debounceTimer = setTimeout(async () => {
                try {
                    const response = await fetch(`/api/company-search?query=${encodeURIComponent(value)}`);
                    const data = await response.json();
                    
                    if (data.companies && data.companies.length > 0) {
                        suggestionsDiv.innerHTML = data.companies.slice(0, 10).map(company => 
                            `<div class="dropdown-item" onclick="selectSymbol('${company.symbol}')" style="cursor: pointer;">
                                <strong>${company.symbol}</strong> - ${company.name}
                            </div>`
                        ).join('');
                        suggestionsDiv.style.display = 'block';
                    } else {
                        // Fallback to local symbols if API fails
                        const uniqueSymbols = [...new Set(trades
                            .filter(trade => trade.trade_type !== 'BTO' && trade.trade_type !== 'STC' && trade.trade_type !== 'ASSIGNED')
                            .map(trade => trade.ticker))];
                        
                        const matches = uniqueSymbols.filter(symbol => 
                            symbol.toUpperCase().includes(value.toUpperCase())
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
                } catch (error) {
                    console.error('Error fetching company suggestions:', error);
                    suggestionsDiv.style.display = 'none';
                }
            }, 300);
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
    const clearButton = document.getElementById('clear-symbol');
    
    if (symbolFilterInput) {
        symbolFilterInput.value = symbol;
        window.symbolFilter = symbol; // Set global symbolFilter variable
        suggestionsDiv.style.display = 'none';
        
        // Show clear button when symbol is selected
        if (clearButton) clearButton.style.display = 'inline-block';
        
        // Also update cost basis symbol filter input
        const costBasisSymbolFilter = document.getElementById('cost-basis-symbol-filter');
        const costBasisClearButton = document.getElementById('clear-cost-basis-symbol');
        
        if (costBasisSymbolFilter) {
            costBasisSymbolFilter.value = symbol;
        }
        
        if (costBasisClearButton) {
            costBasisClearButton.style.display = 'inline-block';
        }
        
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
    window.symbolFilter = symbol; // Set global symbolFilter variable
    const symbolFilterInput = document.getElementById('symbol-filter');
    const clearButton = document.getElementById('clear-symbol');
    
    if (symbolFilterInput) {
        symbolFilterInput.value = symbol;
    }
    
    // Show clear button for trades table
    if (clearButton) {
        clearButton.style.display = 'inline-block';
    }
    
    // Also update cost basis symbol filter input
    const costBasisSymbolFilter = document.getElementById('cost-basis-symbol-filter');
    const costBasisClearButton = document.getElementById('clear-cost-basis-symbol');
    
    if (costBasisSymbolFilter) {
        costBasisSymbolFilter.value = symbol;
    }
    
    if (costBasisClearButton) {
        costBasisClearButton.style.display = 'inline-block';
    }
    
    updateTradesTable();
    // Load cost basis for the selected symbol
    loadCostBasis(symbol);
    
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
    
    // Clear trades table symbol filter
    if (symbolFilterInput) {
        symbolFilterInput.value = '';
        window.symbolFilter = ''; // Set global symbolFilter variable
        suggestionsDiv.style.display = 'none';
        if (clearButton) clearButton.style.display = 'none';
        updateTradesTable();
    }
    
    // Clear cost basis symbol filter
    const costBasisSymbolFilter = document.getElementById('cost-basis-symbol-filter');
    const costBasisSuggestions = document.getElementById('cost-basis-symbol-suggestions');
    const costBasisClearButton = document.getElementById('clear-cost-basis-symbol');
    
    if (costBasisSymbolFilter) {
        costBasisSymbolFilter.value = '';
        costBasisSuggestions.style.display = 'none';
        if (costBasisClearButton) costBasisClearButton.style.display = 'none';
        loadCostBasis(); // Show all symbols
    }
}

// Set up cost basis symbol filter
function setupCostBasisSymbolFilter() {
    const symbolFilter = document.getElementById('cost-basis-symbol-filter');
    const suggestions = document.getElementById('cost-basis-symbol-suggestions');
    const clearButton = document.getElementById('clear-cost-basis-symbol');
    
    if (!symbolFilter || !suggestions || !clearButton) return;
    
    symbolFilter.addEventListener('input', function() {
        const query = this.value.toLowerCase();
        
        if (query.length === 0) {
            suggestions.style.display = 'none';
            clearButton.style.display = 'none';
            return;
        }
        
        clearButton.style.display = 'inline-block';
        
        // Get unique symbols from trades
        const symbols = [...new Set(trades.map(trade => trade.ticker))];
        const matches = symbols.filter(symbol => 
            symbol.toLowerCase().includes(query)
        ).slice(0, 5);
        
        if (matches.length > 0) {
            suggestions.innerHTML = matches.map(symbol => 
                `<div class="dropdown-item" onclick="selectCostBasisSymbol('${symbol}')">${symbol}</div>`
            ).join('');
            suggestions.style.display = 'block';
        } else {
            suggestions.style.display = 'none';
        }
    });
    
    // Handle when user types a symbol and presses Enter or loses focus
    symbolFilter.addEventListener('blur', function() {
        const symbol = this.value.trim().toUpperCase();
        if (symbol && symbol.length > 0) {
            // Check if the symbol exists in trades
            const symbols = [...new Set(trades.map(trade => trade.ticker))];
            if (symbols.includes(symbol)) {
                selectCostBasisSymbol(symbol);
            }
        }
    });
    
    // Handle Enter key press
    symbolFilter.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            const symbol = this.value.trim().toUpperCase();
            if (symbol && symbol.length > 0) {
                // Check if the symbol exists in trades
                const symbols = [...new Set(trades.map(trade => trade.ticker))];
                if (symbols.includes(symbol)) {
                    selectCostBasisSymbol(symbol);
                }
            }
        }
    });
    
    // Hide suggestions when clicking outside
    document.addEventListener('click', function(e) {
        if (!symbolFilter.contains(e.target) && !suggestions.contains(e.target)) {
            suggestions.style.display = 'none';
        }
    });
}

// Select cost basis symbol
function selectCostBasisSymbol(symbol) {
    const symbolFilter = document.getElementById('cost-basis-symbol-filter');
    const suggestions = document.getElementById('cost-basis-symbol-suggestions');
    const clearButton = document.getElementById('clear-cost-basis-symbol');
    
    symbolFilter.value = symbol;
    suggestions.style.display = 'none';
    clearButton.style.display = 'inline-block';
    
    // Also filter trades table on the same symbol
    const tradesSymbolFilterInput = document.getElementById('symbol-filter');
    const tradesClearButton = document.getElementById('clear-symbol');
    
    if (tradesSymbolFilterInput) {
        tradesSymbolFilterInput.value = symbol;
        window.symbolFilter = symbol; // Set global symbolFilter variable
        
        if (tradesClearButton) tradesClearButton.style.display = 'inline-block';
        updateTradesTable();
    }
    
    // Load cost basis for the selected symbol only
    loadCostBasis(symbol);
}

// Clear cost basis symbol filter
function clearCostBasisSymbolFilter() {
    // Clear cost basis symbol filter
    const symbolFilter = document.getElementById('cost-basis-symbol-filter');
    const suggestions = document.getElementById('cost-basis-symbol-suggestions');
    const clearButton = document.getElementById('clear-cost-basis-symbol');
    
    if (symbolFilter) {
        symbolFilter.value = '';
        suggestions.style.display = 'none';
        if (clearButton) clearButton.style.display = 'none';
        loadCostBasis(); // Show all symbols
    }
    
    // Clear trades table symbol filter
    const tradesSymbolFilterInput = document.getElementById('symbol-filter');
    const tradesSuggestionsDiv = document.getElementById('symbol-suggestions');
    const tradesClearButton = document.getElementById('clear-symbol');
    
    if (tradesSymbolFilterInput) {
        tradesSymbolFilterInput.value = '';
        window.symbolFilter = ''; // Set global symbolFilter variable
        tradesSuggestionsDiv.style.display = 'none';
        if (tradesClearButton) tradesClearButton.style.display = 'none';
        updateTradesTable();
    }
}

// Clear cost basis filter
function clearCostBasisFilter() {
    // Clear symbol filter
    window.symbolFilter = ''; // Set global symbolFilter variable
    const symbolFilterInput = document.getElementById('symbol-filter');
    if (symbolFilterInput) {
        symbolFilterInput.value = '';
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
    
    // Set up cost basis symbol filter
    setupCostBasisSymbolFilter();
    
    // Set up cost basis status filter
    const costBasisStatusFilter = document.getElementById('cost-basis-status-filter');
    if (costBasisStatusFilter) {
        costBasisStatusFilter.addEventListener('change', function() {
            // Get the currently selected symbol from the filter
            const symbolFilter = document.getElementById('cost-basis-symbol-filter');
            const selectedSymbol = symbolFilter ? symbolFilter.value : null;
            
            if (selectedSymbol) {
                loadCostBasis(selectedSymbol);
            } else {
                loadCostBasis();
            }
        });
    }
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
                console.log(`Trade status updated to ${newStatus} and duplicate entry created`);
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
                
                console.log(`Trade status updated to ${newStatus}`);
            }
        } else {
            console.error('Error updating trade status: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error updating trade status:', error);
        console.error('Error updating trade status. Please try again.');
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
            
            // Update cost basis table if any field that affects cost basis was changed
            if (fieldName === 'quantity' || fieldName === 'premium' || fieldName === 'trade_date' || 
                fieldName === 'expiration_date' || fieldName === 'strike_price' || fieldName === 'status') {
                await loadCostBasis(selectedTicker);
            }
            
            console.log(`${fieldName} updated successfully`);
        } else {
            console.error('Error updating field: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error updating trade field:', error);
        console.error('Error updating field. Please try again.');
    }
}

// Load cost basis data
async function loadCostBasis(ticker = null) {
    try {
        const commission = localStorage.getItem('commission') || '0.0';
        const url = ticker ? `/api/cost-basis?ticker=${ticker}&commission=${commission}` : `/api/cost-basis?commission=${commission}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (ticker) {
            selectedTicker = ticker;
            updateCostBasisTable(data);
        } else {
            // Show all available symbols
            showAllSymbols(data);
        }
    } catch (error) {
        console.error('Error loading cost basis:', error);
    }
}

// Show all available symbols when no ticker is selected
function showAllSymbols(data) {
    const costBasisContainer = document.getElementById('cost-basis-table-container');
    if (!costBasisContainer) return;
    
    if (!data || data.length === 0) {
        costBasisContainer.innerHTML = `
            <div class="text-center text-muted">
                <i class="fas fa-info-circle me-2"></i>
                No trades found. Add some trades to see symbols here.
            </div>
        `;
        return;
    }
    
    // Create a list of all available symbols
    const symbols = data.map(item => item.ticker).sort();
    const uniqueSymbols = [...new Set(symbols)];
    
    let symbolsHtml = '<div class="row">';
    uniqueSymbols.forEach(symbol => {
        const symbolData = data.find(item => item.ticker === symbol);
        const tradeCount = symbolData ? symbolData.trades.length : 0;
        
        symbolsHtml += `
            <div class="col-md-3 col-sm-4 col-6 mb-3">
                <div class="card h-100 symbol-card" onclick="selectCostBasisSymbol('${symbol}')" style="cursor: pointer;">
                    <div class="card-body text-center">
                        <h5 class="card-title text-primary">${symbol}</h5>
                        <p class="card-text text-muted">${tradeCount} trade${tradeCount !== 1 ? 's' : ''}</p>
                    </div>
                </div>
            </div>
        `;
    });
    symbolsHtml += '</div>';
    
    costBasisContainer.innerHTML = `
        <div class="mb-3">
            <h6 class="text-primary mb-3">
                <i class="fas fa-list me-2"></i>
                Available Stock Symbols (${uniqueSymbols.length})
            </h6>
            ${symbolsHtml}
            <div class="text-center mt-3">
                <small class="text-muted">Click on any symbol to view its cost basis</small>
            </div>
        </div>
    `;
}

function hideCostBasisTable() {
    const container = document.getElementById('cost-basis-table-container');
    container.innerHTML = `
        <div class="text-center text-muted">
            <i class="fas fa-info-circle me-2"></i>
            Click on a stock symbol above to view its cost basis
        </div>
    `;
    selectedTicker = null;
}

async function updateCostBasisTable(costBasisData) {
    const container = document.getElementById('cost-basis-table-container');
    
    if (!costBasisData || costBasisData.length === 0) {
        container.innerHTML = `
            <div class="text-center text-muted">
                <i class="fas fa-info-circle me-2"></i>
                No cost basis data available for the selected stock symbol.
            </div>
        `;
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
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h6 class="text-primary mb-0">
                        <i class="fas fa-chart-line me-2"></i>${displayTitle}
                    </h6>
                </div>
                
                <!-- Summary Cards -->
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
                    <table class="table table-sm table-striped">
                        <thead class="table-dark">
                            <tr>
                                <th class="text-center">Trade Date</th>
                                <th class="text-start">Trade Description</th>
                                <th class="text-end">Shares</th>
                                <th class="text-end">Cost</th>
                                <th class="text-end">Amount</th>
                                <th class="text-end">Closing Amount</th>
                                <th class="text-end">Basis</th>
                                <th class="text-end">Basis/Share</th>
                                <th class="text-center"></th>
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
            
            // Format date as DD-MMM-YY
            const formatDate = (dateString) => {
                if (!dateString) return '';
                const date = new Date(dateString);
                if (isNaN(date.getTime())) return dateString; // Return original if invalid date
                
                const day = date.getDate().toString().padStart(2, '0');
                const month = date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
                const year = date.getFullYear().toString().slice(-2);
                
                return `${day}-${month}-${year}`;
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
                    <td class="text-start">${trade.trade_description || ''}</td>
                    <td class="text-end ${sharesClass}">${formatShares(trade.shares || 0)}</td>
                    <td class="text-end ${costClass}">${formatNumber(trade.cost_per_share || 0)}</td>
                    <td class="text-end ${amountClass}">${formatNumber(trade.amount || 0)}</td>
                    <td class="text-end ${closingAmountClass}">${formatNumber(trade.closing_amount || 0)}</td>
                    <td class="text-end ${runningBasisClass}">${formatNumber(trade.running_basis)}</td>
                    <td class="text-end ${runningBasisPerShareClass}">${formatNumber(trade.running_basis_per_share)}</td>
                    <td class="text-center">
                        <button class="btn btn-sm btn-outline-primary me-1" onclick="editCostBasisTrade(${trade.id})" title="Edit Trade">
                            <i class="fas fa-edit"></i>
                        </button>
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
    
    // Add event listeners for editable cells
    addEditableCellListeners();
}

// Add event listeners for editable cells
function addEditableCellListeners() {
    const editableCells = document.querySelectorAll('.editable-cell');
    
    editableCells.forEach(cell => {
        cell.addEventListener('blur', async function() {
            const tradeId = this.dataset.tradeId;
            const field = this.dataset.field;
            const value = this.value;
            
            try {
                const response = await fetch(`/api/trades/${tradeId}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        [field]: value
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    console.log(`Updated ${field} for trade ${tradeId}`);
                    // Reload cost basis to update running totals
                    if (selectedTicker) {
                        await loadCostBasis(selectedTicker);
                    }
                } else {
                    console.error('Failed to update field:', result.error);
                    // Revert the value
                    this.value = this.dataset.originalValue || '';
                }
            } catch (error) {
                console.error('Error updating field:', error);
                // Revert the value
                this.value = this.dataset.originalValue || '';
            }
        });
        
        // Store original value for reverting
        cell.addEventListener('focus', function() {
            this.dataset.originalValue = this.value;
        });
    });
}

// Edit cost basis trade - opens BTO form in edit mode
function editCostBasisTrade(tradeId) {
    // Find the trade data
    const trade = trades.find(t => t.id === tradeId);
    if (!trade) {
        alert('Trade not found');
        return;
    }
    
    // Determine which modal to open based on trade type
    if (trade.trade_type === 'STC') {
        // Open STC modal for STC trades
        const modal = new bootstrap.Modal(document.getElementById('stcModal'));
        modal.show();
        
        // Populate STC form with trade data
        document.getElementById('stc-trade-date').value = trade.trade_date || '';
        document.getElementById('stc-underlying').value = trade.ticker || '';
        document.getElementById('stc-sale-price').value = trade.strike_price || 0;
        document.getElementById('stc-shares').value = Math.abs(trade.shares) || 1; // Use absolute value for display
        
        // Store the trade ID for updating
        document.getElementById('stcModal').dataset.editingTradeId = tradeId;
        // Flag that this edit came from cost basis table
        document.getElementById('stcModal').dataset.fromCostBasis = 'true';
        // Store the ticker for reloading the correct filtered view
        document.getElementById('stcModal').dataset.editingTicker = trade.ticker || '';
        
        // Change modal title to indicate editing
        document.getElementById('stcModalLabel').innerHTML = '<i class="fas fa-edit me-2"></i>Edit STC Trade';
        
        // Change submit button text
        const submitButton = document.querySelector('#stcModal .btn-primary');
        submitButton.innerHTML = '<i class="fas fa-save me-2"></i>Update STC Trade';
        
        // Set up underlying autocomplete
        setupSTCUnderlyingAutocomplete();
    } else {
        // Open BTO modal for BTO trades (existing logic)
        const modal = new bootstrap.Modal(document.getElementById('btoModal'));
        modal.show();
        
        // Populate form with trade data
        document.getElementById('bto-trade-date').value = trade.trade_date || '';
        document.getElementById('bto-underlying').value = trade.ticker || '';
        document.getElementById('bto-purchase-price').value = trade.strike_price || 0;
        document.getElementById('bto-shares').value = trade.quantity || 1;
        
        // Store the trade ID for updating
        document.getElementById('btoModal').dataset.editingTradeId = tradeId;
        // Flag that this edit came from cost basis table
        document.getElementById('btoModal').dataset.fromCostBasis = 'true';
        // Store the ticker for reloading the correct filtered view
        document.getElementById('btoModal').dataset.editingTicker = trade.ticker || '';
        
        // Change modal title to indicate editing
        document.getElementById('btoModalLabel').innerHTML = '<i class="fas fa-edit me-2"></i>Edit BTO Trade';
        
        // Change submit button text
        const submitButton = document.querySelector('#btoModal .btn-primary');
        submitButton.innerHTML = '<i class="fas fa-save me-2"></i>Update BTO Trade';
        
        // Set up underlying autocomplete
        setupBTOUnderlyingAutocomplete();
    }
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
                console.log('Cost basis entry deleted successfully');
                // Reload trades and cost basis to refresh the display
                await loadTrades();
                if (selectedTicker) {
                    await loadCostBasis(selectedTicker);
                }
            } else {
                console.error('Error deleting cost basis entry: ' + (result.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error deleting cost basis entry:', error);
            console.error('Error deleting cost basis entry. Please try again.');
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
            document.getElementById('wins').textContent = summary.wins;
            document.getElementById('losses').textContent = summary.losses;
            document.getElementById('winning-percentage').textContent = `${summary.winning_percentage}%`;
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
    
    // Update cost basis table to reflect new commission
    loadCostBasis(selectedTicker);
    
    console.log('Commission settings saved');
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
    
    console.log('Filter applied');
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
    
    console.log('Filter cleared');
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
    // Ensure chart is initialized before updating
    if (!premiumChart) {
        console.log('Chart not initialized yet, skipping update');
        return;
    }
    
    // Build URL with filter parameters
    let url = '/api/chart-data';
    const params = new URLSearchParams();
    
    if (currentFilter.startDate) {
        params.append('start_date', currentFilter.startDate);
    }
    if (currentFilter.endDate) {
        params.append('end_date', currentFilter.endDate);
    }
    
    if (params.toString()) {
        url += '?' + params.toString();
    }
    
    console.log('Updating chart with URL:', url);
    
    // Fetch chart data from API
    fetch(url)
        .then(response => response.json())
        .then(data => {
            console.log('Chart data received:', data);
            if (data.dates && data.premiums) {
                if (premiumChart) {
                    console.log('Updating chart with data:', data.dates, data.premiums);
                    premiumChart.data.labels = data.dates;
                    premiumChart.data.datasets[0].data = data.premiums;
                    premiumChart.update();
                    console.log('Chart updated successfully');
                } else {
                    console.error('premiumChart is null');
                }
            } else {
                console.error('Invalid chart data format:', data);
            }
        })
        .catch(error => {
            console.error('Error loading chart data:', error);
        });
}

// Open ROCT CALL modal
function openROCTCallModal() {
    const modal = new bootstrap.Modal(document.getElementById('roctCallModal'));
    modal.show();
    
    // Set default values
    const today = new Date();
    const eightDaysFromNow = new Date(today);
    eightDaysFromNow.setDate(today.getDate() + 8);
    
    // Set trade date to today
    document.getElementById('roct-call-trade-date').value = today.toISOString().split('T')[0];
    
    // Set expiration date to 8 days from today
    document.getElementById('roct-call-expiration-date').value = eightDaysFromNow.toISOString().split('T')[0];
    
    // Calculate DTE
    updateROCTCallDTE();
    
    // Set up autocomplete for underlying field
    setupROCTCallUnderlyingAutocomplete();
    
    // Add event listeners for date changes to update DTE
    document.getElementById('roct-call-trade-date').addEventListener('change', updateROCTCallDTE);
    document.getElementById('roct-call-expiration-date').addEventListener('change', updateROCTCallDTE);
}

// Update DTE calculation for ROCT CALL
function updateROCTCallDTE() {
    const tradeDate = document.getElementById('roct-call-trade-date').value;
    const expirationDate = document.getElementById('roct-call-expiration-date').value;
    
    if (tradeDate && expirationDate) {
        const trade = new Date(tradeDate);
        const expiration = new Date(expirationDate);
        const diffTime = expiration - trade;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        document.getElementById('roct-call-dte').value = diffDays;
    }
}

// Setup autocomplete for ROCT CALL underlying field
function setupROCTCallUnderlyingAutocomplete() {
    const underlyingInput = document.getElementById('roct-call-underlying');
    const suggestionsDiv = document.getElementById('roct-call-underlying-suggestions');
    
    if (!underlyingInput || !suggestionsDiv) return;
    
    let debounceTimer;
    
    underlyingInput.addEventListener('input', function() {
        const value = this.value.trim();
        
        clearTimeout(debounceTimer);
        
        if (value.length === 0) {
            suggestionsDiv.style.display = 'none';
        } else {
            debounceTimer = setTimeout(async () => {
                try {
                    const response = await fetch(`/api/company-search?query=${encodeURIComponent(value)}`);
                    const data = await response.json();
                    
                    if (data.companies && data.companies.length > 0) {
                        suggestionsDiv.innerHTML = data.companies.slice(0, 10).map(company => 
                            `<div class="dropdown-item" onclick="selectROCTCallUnderlying('${company.symbol}', '${company.name}')" style="cursor: pointer;">
                                <strong>${company.symbol}</strong> - ${company.name}
                            </div>`
                        ).join('');
                        suggestionsDiv.style.display = 'block';
                    } else {
                        suggestionsDiv.style.display = 'none';
                    }
                } catch (error) {
                    console.error('Error fetching company suggestions:', error);
                    suggestionsDiv.style.display = 'none';
                }
            }, 300);
        }
    });
    
    // Handle keyboard navigation
    underlyingInput.addEventListener('keydown', function(e) {
        const suggestions = suggestionsDiv.querySelectorAll('.dropdown-item');
        let currentIndex = -1;
        
        suggestions.forEach((item, index) => {
            if (item.classList.contains('active')) {
                currentIndex = index;
            }
        });
        
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            suggestions.forEach(item => item.classList.remove('active'));
            if (currentIndex < suggestions.length - 1) {
                suggestions[currentIndex + 1].classList.add('active');
            } else {
                suggestions[0].classList.add('active');
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            suggestions.forEach(item => item.classList.remove('active'));
            if (currentIndex > 0) {
                suggestions[currentIndex - 1].classList.add('active');
            } else {
                suggestions[suggestions.length - 1].classList.add('active');
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const activeItem = suggestionsDiv.querySelector('.dropdown-item.active');
            if (activeItem) {
                activeItem.click();
            }
        } else if (e.key === 'Escape') {
            suggestionsDiv.style.display = 'none';
        }
    });
    
    // Hide suggestions when clicking outside
    document.addEventListener('click', function(e) {
        if (!underlyingInput.contains(e.target) && !suggestionsDiv.contains(e.target)) {
            suggestionsDiv.style.display = 'none';
        }
    });
}

// Select ROCT CALL underlying from autocomplete
function selectROCTCallUnderlying(symbol, name) {
    const underlyingInput = document.getElementById('roct-call-underlying');
    const suggestionsDiv = document.getElementById('roct-call-underlying-suggestions');
    
    underlyingInput.value = `${symbol} - ${name}`;
    underlyingInput.dataset.symbol = symbol;
    suggestionsDiv.style.display = 'none';
    
    // Load cost basis for the selected symbol
    loadCostBasisForSymbol(symbol);
}

// Load cost basis for selected symbol
async function loadCostBasisForSymbol(symbol) {
    try {
        const commission = localStorage.getItem('commission') || '0.0';
        const response = await fetch(`/api/cost-basis?ticker=${symbol}&commission=${commission}`);
        const data = await response.json();
        
        if (data && data.length > 0) {
            // Get the cost basis for this symbol
            const symbolData = data.find(item => item.ticker === symbol);
            if (symbolData) {
                document.getElementById('roct-call-cost-basis').value = symbolData.total_cost_basis || 0;
            } else {
                document.getElementById('roct-call-cost-basis').value = 0;
            }
        } else {
            document.getElementById('roct-call-cost-basis').value = 0;
        }
    } catch (error) {
        console.error('Error loading cost basis:', error);
        document.getElementById('roct-call-cost-basis').value = 0;
    }
}

// Submit ROCT CALL form
async function submitROCTCallForm(action = 'addAndClose') {
    const form = document.getElementById('roctCallForm');
    const underlyingInput = document.getElementById('roct-call-underlying');
    
    // Get the symbol from the underlying field
    const underlyingValue = underlyingInput.value;
    const symbol = underlyingInput.dataset.symbol || underlyingValue.split(' - ')[0];
    
    const formData = {
        ticker: symbol,
        tradeDate: document.getElementById('roct-call-trade-date').value,
        expirationDate: document.getElementById('roct-call-expiration-date').value,
        strikePrice: parseFloat(document.getElementById('roct-call-strike-price').value),
        premium: parseFloat(document.getElementById('roct-call-credit-debit').value),
        quantity: 1, // Default to 1 contract for ROCT CALL
        currentPrice: parseFloat(document.getElementById('roct-call-price').value),
        tradeType: 'ROCT CALL'
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
            // Handle different actions
            if (action === 'addAndClose') {
                // Close modal
                const modal = document.getElementById('roctCallModal');
                const modalInstance = bootstrap.Modal.getInstance(modal);
                modalInstance.hide();
            } else if (action === 'addAnother') {
                // Reset form for new entry
                resetROCTCallForm();
            }
            
            // Reload data
            await loadTrades();
            loadSummary();
            await loadCostBasis();
        } else {
            alert('Failed to add ROCT CALL trade: ' + result.error);
        }
    } catch (error) {
        console.error('Error adding ROCT CALL trade:', error);
        alert('Error adding ROCT CALL trade: ' + error.message);
    }
}

// Reset ROCT CALL form for new entry
function resetROCTCallForm() {
    const today = new Date();
    const eightDaysFromNow = new Date(today);
    eightDaysFromNow.setDate(today.getDate() + 8);
    
    // Reset form fields
    document.getElementById('roct-call-trade-date').value = today.toISOString().split('T')[0];
    document.getElementById('roct-call-underlying').value = '';
    document.getElementById('roct-call-underlying').dataset.symbol = '';
    document.getElementById('roct-call-price').value = '';
    document.getElementById('roct-call-expiration-date').value = eightDaysFromNow.toISOString().split('T')[0];
    document.getElementById('roct-call-strike-price').value = '';
    document.getElementById('roct-call-credit-debit').value = '';
    document.getElementById('roct-call-cost-basis').value = '';
    
    // Hide suggestions
    document.getElementById('roct-call-underlying-suggestions').style.display = 'none';
    
    // Recalculate DTE
    updateROCTCallDTE();
    
    // Focus on first field
    document.getElementById('roct-call-trade-date').focus();
}

// Open ROCT PUT modal
function openROCTPutModal() {
    const modal = new bootstrap.Modal(document.getElementById('roctPutModal'));
    modal.show();
    
    // Set default values
    const today = new Date();
    const eightDaysFromNow = new Date(today);
    eightDaysFromNow.setDate(today.getDate() + 8);
    
    // Set trade date to today
    document.getElementById('roct-put-trade-date').value = today.toISOString().split('T')[0];
    
    // Set expiration date to 8 days from today
    document.getElementById('roct-put-expiration-date').value = eightDaysFromNow.toISOString().split('T')[0];
    
    // Calculate DTE
    updateROCTPutDTE();
    
    // Set up autocomplete for underlying field
    setupROCTPutUnderlyingAutocomplete();
    
    // Add event listeners for date changes to update DTE
    document.getElementById('roct-put-trade-date').addEventListener('change', updateROCTPutDTE);
    document.getElementById('roct-put-expiration-date').addEventListener('change', updateROCTPutDTE);
}

// Update DTE calculation for ROCT PUT
function updateROCTPutDTE() {
    const tradeDate = document.getElementById('roct-put-trade-date').value;
    const expirationDate = document.getElementById('roct-put-expiration-date').value;
    
    if (tradeDate && expirationDate) {
        const trade = new Date(tradeDate);
        const expiration = new Date(expirationDate);
        const diffTime = expiration - trade;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        document.getElementById('roct-put-dte').value = diffDays;
    }
}

// Setup autocomplete for ROCT PUT underlying field
function setupROCTPutUnderlyingAutocomplete() {
    const underlyingInput = document.getElementById('roct-put-underlying');
    const suggestionsDiv = document.getElementById('roct-put-underlying-suggestions');
    
    if (!underlyingInput || !suggestionsDiv) return;
    
    let debounceTimer;
    
    underlyingInput.addEventListener('input', function() {
        const value = this.value.trim();
        
        clearTimeout(debounceTimer);
        
        if (value.length === 0) {
            suggestionsDiv.style.display = 'none';
        } else {
            debounceTimer = setTimeout(async () => {
                try {
                    const response = await fetch(`/api/company-search?query=${encodeURIComponent(value)}`);
                    const data = await response.json();
                    
                    if (data.companies && data.companies.length > 0) {
                        suggestionsDiv.innerHTML = data.companies.slice(0, 10).map(company => 
                            `<div class="dropdown-item" onclick="selectROCTPutUnderlying('${company.symbol}', '${company.name}')" style="cursor: pointer;">
                                <strong>${company.symbol}</strong> - ${company.name}
                            </div>`
                        ).join('');
                        suggestionsDiv.style.display = 'block';
                    } else {
                        suggestionsDiv.style.display = 'none';
                    }
                } catch (error) {
                    console.error('Error fetching company suggestions:', error);
                    suggestionsDiv.style.display = 'none';
                }
            }, 300);
        }
    });
    
    // Handle keyboard navigation
    underlyingInput.addEventListener('keydown', function(e) {
        const suggestions = suggestionsDiv.querySelectorAll('.dropdown-item');
        let currentIndex = -1;
        
        suggestions.forEach((item, index) => {
            if (item.classList.contains('active')) {
                currentIndex = index;
            }
        });
        
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            suggestions.forEach(item => item.classList.remove('active'));
            if (currentIndex < suggestions.length - 1) {
                suggestions[currentIndex + 1].classList.add('active');
            } else {
                suggestions[0].classList.add('active');
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            suggestions.forEach(item => item.classList.remove('active'));
            if (currentIndex > 0) {
                suggestions[currentIndex - 1].classList.add('active');
            } else {
                suggestions[suggestions.length - 1].classList.add('active');
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const activeItem = suggestionsDiv.querySelector('.dropdown-item.active');
            if (activeItem) {
                activeItem.click();
            }
        } else if (e.key === 'Escape') {
            suggestionsDiv.style.display = 'none';
        }
    });
    
    // Hide suggestions when clicking outside
    document.addEventListener('click', function(e) {
        if (!underlyingInput.contains(e.target) && !suggestionsDiv.contains(e.target)) {
            suggestionsDiv.style.display = 'none';
        }
    });
}

// Select ROCT PUT underlying from autocomplete
function selectROCTPutUnderlying(symbol, name) {
    const underlyingInput = document.getElementById('roct-put-underlying');
    const suggestionsDiv = document.getElementById('roct-put-underlying-suggestions');
    
    underlyingInput.value = `${symbol} - ${name}`;
    underlyingInput.dataset.symbol = symbol;
    suggestionsDiv.style.display = 'none';
}

// Submit ROCT PUT form
async function submitROCTPutForm(action = 'addAndClose') {
    const form = document.getElementById('roctPutForm');
    const underlyingInput = document.getElementById('roct-put-underlying');
    
    // Get the symbol from the underlying field
    const underlyingValue = underlyingInput.value;
    const symbol = underlyingInput.dataset.symbol || underlyingValue.split(' - ')[0];
    
    const formData = {
        ticker: symbol,
        tradeDate: document.getElementById('roct-put-trade-date').value,
        expirationDate: document.getElementById('roct-put-expiration-date').value,
        strikePrice: parseFloat(document.getElementById('roct-put-strike-price').value),
        premium: parseFloat(document.getElementById('roct-put-credit-debit').value),
        quantity: 1, // Default to 1 contract for ROCT PUT
        currentPrice: parseFloat(document.getElementById('roct-put-price').value),
        tradeType: 'ROCT PUT'
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
            // Handle different actions
            if (action === 'addAndClose') {
                // Close modal
                const modal = document.getElementById('roctPutModal');
                const modalInstance = bootstrap.Modal.getInstance(modal);
                modalInstance.hide();
            } else if (action === 'addAnother') {
                // Reset form for new entry
                resetROCTPutForm();
            }
            
            // Reload data
            await loadTrades();
            loadSummary();
            await loadCostBasis();
        } else {
            alert('Failed to add ROCT PUT trade: ' + result.error);
        }
    } catch (error) {
        console.error('Error adding ROCT PUT trade:', error);
        alert('Error adding ROCT PUT trade: ' + error.message);
    }
}

// Reset ROCT PUT form for new entry
function resetROCTPutForm() {
    const today = new Date();
    const eightDaysFromNow = new Date(today);
    eightDaysFromNow.setDate(today.getDate() + 8);
    
    // Reset form fields
    document.getElementById('roct-put-trade-date').value = today.toISOString().split('T')[0];
    document.getElementById('roct-put-underlying').value = '';
    document.getElementById('roct-put-underlying').dataset.symbol = '';
    document.getElementById('roct-put-price').value = '';
    document.getElementById('roct-put-expiration-date').value = eightDaysFromNow.toISOString().split('T')[0];
    document.getElementById('roct-put-strike-price').value = '';
    document.getElementById('roct-put-credit-debit').value = '';
    
    // Hide suggestions
    document.getElementById('roct-put-underlying-suggestions').style.display = 'none';
    
    // Recalculate DTE
    updateROCTPutDTE();
    
    // Focus on first field
    document.getElementById('roct-put-trade-date').focus();
}

// Open BTO modal and set default values
function openBTOModal() {
    // Set today's date as default
    const today = new Date();
    const todayString = today.toISOString().split('T')[0];
    
    document.getElementById('bto-trade-date').value = todayString;
    document.getElementById('bto-purchase-price').value = '';
    document.getElementById('bto-shares').value = '1';
    document.getElementById('bto-underlying').value = '';
    
    // Show the modal
    const modal = new bootstrap.Modal(document.getElementById('btoModal'));
    modal.show();
    
    // Set up underlying autocomplete
    setupBTOUnderlyingAutocomplete();
}

// Set up autocomplete for BTO underlying field
function setupBTOUnderlyingAutocomplete() {
    const underlyingInput = document.getElementById('bto-underlying');
    const suggestionsDiv = document.getElementById('bto-underlying-suggestions');
    
    if (!underlyingInput || !suggestionsDiv) return;
    
    // Remove any existing event listeners to prevent duplicates
    underlyingInput.removeEventListener('input', handleUnderlyingInput);
    underlyingInput.removeEventListener('keydown', handleUnderlyingKeydown);
    
    // Add new event listeners
    underlyingInput.addEventListener('input', handleUnderlyingInput);
    underlyingInput.addEventListener('keydown', handleUnderlyingKeydown);
    
    // Hide suggestions when clicking outside
    document.addEventListener('click', function(e) {
        if (!underlyingInput.contains(e.target) && !suggestionsDiv.contains(e.target)) {
            suggestionsDiv.style.display = 'none';
        }
    });
    
    async function handleUnderlyingInput() {
        const query = this.value.toLowerCase().trim();
        
        if (query.length < 1) {
            suggestionsDiv.style.display = 'none';
            return;
        }
        
        try {
            // Call the company search API
            const response = await fetch(`/api/company-search?query=${encodeURIComponent(query)}`);
            const data = await response.json();
            
            if (data.companies && data.companies.length > 0) {
                suggestionsDiv.innerHTML = data.companies.slice(0, 10).map(company => 
                    `<div class="dropdown-item" onclick="selectBTOUnderlying('${company.symbol}', '${company.name}')" style="cursor: pointer; padding: 8px 12px;">
                        <div class="d-flex justify-content-between align-items-center">
                            <div>
                                <strong>${company.symbol}</strong>
                                <small class="text-muted d-block">${company.name}</small>
                            </div>
                        </div>
                    </div>`
                ).join('');
                suggestionsDiv.style.display = 'block';
                suggestionsDiv.style.position = 'absolute';
                suggestionsDiv.style.top = '100%';
                suggestionsDiv.style.left = '0';
                suggestionsDiv.style.zIndex = '1000';
                suggestionsDiv.style.maxHeight = '200px';
                suggestionsDiv.style.overflowY = 'auto';
            } else {
                suggestionsDiv.style.display = 'none';
            }
        } catch (error) {
            console.error('Error searching companies:', error);
            suggestionsDiv.style.display = 'none';
        }
    }
    
    function handleUnderlyingKeydown(e) {
        const items = suggestionsDiv.querySelectorAll('.dropdown-item');
        const currentIndex = Array.from(items).findIndex(item => item.classList.contains('active'));
        
        switch(e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (currentIndex < items.length - 1) {
                    items[currentIndex + 1]?.classList.add('active');
                    items[currentIndex]?.classList.remove('active');
                }
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (currentIndex > 0) {
                    items[currentIndex - 1]?.classList.add('active');
                    items[currentIndex]?.classList.remove('active');
                }
                break;
            case 'Enter':
                e.preventDefault();
                const activeItem = suggestionsDiv.querySelector('.dropdown-item.active');
                if (activeItem) {
                    activeItem.click();
                }
                break;
            case 'Escape':
                suggestionsDiv.style.display = 'none';
                break;
        }
    }
}

// Select underlying from autocomplete
function selectBTOUnderlying(symbol, name) {
    const underlyingInput = document.getElementById('bto-underlying');
    const suggestionsDiv = document.getElementById('bto-underlying-suggestions');
    
    underlyingInput.value = `${symbol} - ${name}`;
    underlyingInput.dataset.symbol = symbol;
    suggestionsDiv.style.display = 'none';
}

// Submit BTO form
async function submitBTOForm(action = 'addAndClose') {
    const form = document.getElementById('btoForm');
    const underlyingInput = document.getElementById('bto-underlying');
    const modal = document.getElementById('btoModal');
    const editingTradeId = modal.dataset.editingTradeId;
    
    // Get the symbol from the underlying field
    const underlyingValue = underlyingInput.value;
    const symbol = underlyingInput.dataset.symbol || underlyingValue.split(' - ')[0];
    
    const formData = {
        ticker: symbol,
        tradeDate: document.getElementById('bto-trade-date').value,
        expirationDate: document.getElementById('bto-trade-date').value, // Use trade date as expiration for BTO
        strikePrice: parseFloat(document.getElementById('bto-purchase-price').value),
        premium: 0, // BTO doesn't have premium
        quantity: parseInt(document.getElementById('bto-shares').value),
        currentPrice: 0, // BTO doesn't need current price
        tradeType: 'BTO'
    };
    
    try {
        let response;
        let successMessage;
        
        if (editingTradeId) {
            // Update existing trade
            response = await fetch(`/api/trades/${editingTradeId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData)
            });
            successMessage = 'BTO trade updated successfully!';
        } else {
            // Create new trade
            response = await fetch('/api/trades', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData)
            });
            successMessage = 'BTO trade added successfully!';
        }
        
        const result = await response.json();
        
        if (result.success) {
            // Check if this was an edit from cost basis table before resetting modal state
            const wasFromCostBasis = modal.dataset.fromCostBasis === 'true';
            
            // Handle different actions
            if (action === 'addAndClose' || wasFromCostBasis) {
                // Close modal
                const modalInstance = bootstrap.Modal.getInstance(modal);
                modalInstance.hide();
            } else if (action === 'addAnother') {
                // Reset form for new entry
                document.getElementById('btoForm').reset();
                // Set today's date as default
                const today = new Date().toISOString().split('T')[0];
                document.getElementById('bto-trade-date').value = today;
            }
            
            // Reset modal state
            modal.dataset.editingTradeId = '';
            modal.dataset.fromCostBasis = '';
            modal.dataset.editingTicker = '';
            document.getElementById('btoModalLabel').innerHTML = '<i class="fas fa-plus-circle me-2"></i>Add BTO Trade';
            
            // Reload data
            await loadTrades();
            loadSummary();
            
            if (wasFromCostBasis) {
                // Keep the cost basis table open with current filter
                const editingTicker = modal.dataset.editingTicker || selectedTicker;
                await loadCostBasis(editingTicker);
            } else {
                // Normal behavior for new trades
                await loadCostBasis();
            }
        } else {
            alert(`Failed to ${editingTradeId ? 'update' : 'add'} BTO trade: ` + result.error);
        }
    } catch (error) {
        console.error(`Error ${editingTradeId ? 'updating' : 'adding'} BTO trade:`, error);
        alert(`Error ${editingTradeId ? 'updating' : 'adding'} BTO trade: ` + error.message);
    }
}

// STC Modal Functions
function openSTCModal() {
    // Set today's date as default
    const today = new Date();
    const todayString = today.toISOString().split('T')[0];
    
    document.getElementById('stc-trade-date').value = todayString;
    document.getElementById('stc-sale-price').value = '';
    document.getElementById('stc-shares').value = '1';
    document.getElementById('stc-underlying').value = '';
    
    // Show the modal
    const modal = new bootstrap.Modal(document.getElementById('stcModal'));
    modal.show();
    
    // Set up underlying autocomplete
    setupSTCUnderlyingAutocomplete();
}

// Set up autocomplete for STC underlying field
function setupSTCUnderlyingAutocomplete() {
    const underlyingInput = document.getElementById('stc-underlying');
    const suggestionsDiv = document.getElementById('stc-underlying-suggestions');
    
    if (!underlyingInput || !suggestionsDiv) return;
    
    // Remove any existing event listeners to prevent duplicates
    underlyingInput.removeEventListener('input', handleSTCUnderlyingInput);
    underlyingInput.removeEventListener('keydown', handleSTCUnderlyingKeydown);
    
    // Add new event listeners
    underlyingInput.addEventListener('input', handleSTCUnderlyingInput);
    underlyingInput.addEventListener('keydown', handleSTCUnderlyingKeydown);
    
    // Hide suggestions when clicking outside
    document.addEventListener('click', function(e) {
        if (!underlyingInput.contains(e.target) && !suggestionsDiv.contains(e.target)) {
            suggestionsDiv.style.display = 'none';
        }
    });
    
    async function handleSTCUnderlyingInput() {
        const query = this.value.toLowerCase().trim();
        
        if (query.length < 1) {
            suggestionsDiv.style.display = 'none';
            return;
        }
        
        try {
            // Call the company search API
            const response = await fetch(`/api/company-search?query=${encodeURIComponent(query)}`);
            const data = await response.json();
            
            if (data.companies && data.companies.length > 0) {
                suggestionsDiv.innerHTML = data.companies.slice(0, 10).map(company => 
                    `<div class="dropdown-item" onclick="selectSTCUnderlying('${company.symbol}', '${company.name}')" style="cursor: pointer; padding: 8px 12px;">
                        <div class="d-flex justify-content-between align-items-center">
                            <div>
                                <strong>${company.symbol}</strong>
                                <small class="text-muted d-block">${company.name}</small>
                            </div>
                        </div>
                    </div>`
                ).join('');
                suggestionsDiv.style.display = 'block';
                suggestionsDiv.style.position = 'absolute';
                suggestionsDiv.style.top = '100%';
                suggestionsDiv.style.left = '0';
                suggestionsDiv.style.zIndex = '1000';
                suggestionsDiv.style.maxHeight = '200px';
                suggestionsDiv.style.overflowY = 'auto';
            } else {
                suggestionsDiv.style.display = 'none';
            }
        } catch (error) {
            console.error('Error searching companies:', error);
            suggestionsDiv.style.display = 'none';
        }
    }
    
    function handleSTCUnderlyingKeydown(e) {
        const items = suggestionsDiv.querySelectorAll('.dropdown-item');
        const currentIndex = Array.from(items).findIndex(item => item.classList.contains('active'));
        
        switch(e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (currentIndex < items.length - 1) {
                    items[currentIndex + 1]?.classList.add('active');
                    items[currentIndex]?.classList.remove('active');
                }
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (currentIndex > 0) {
                    items[currentIndex - 1]?.classList.add('active');
                    items[currentIndex]?.classList.remove('active');
                }
                break;
            case 'Enter':
                e.preventDefault();
                const activeItem = suggestionsDiv.querySelector('.dropdown-item.active');
                if (activeItem) {
                    activeItem.click();
                }
                break;
            case 'Escape':
                suggestionsDiv.style.display = 'none';
                break;
        }
    }
}

// Select underlying from autocomplete
function selectSTCUnderlying(symbol, name) {
    const underlyingInput = document.getElementById('stc-underlying');
    const suggestionsDiv = document.getElementById('stc-underlying-suggestions');
    
    underlyingInput.value = `${symbol} - ${name}`;
    underlyingInput.dataset.symbol = symbol;
    suggestionsDiv.style.display = 'none';
}

// Submit STC form
async function submitSTCForm(action = 'addAndClose') {
    const form = document.getElementById('stcForm');
    const underlyingInput = document.getElementById('stc-underlying');
    const modal = document.getElementById('stcModal');
    const editingTradeId = modal.dataset.editingTradeId;
    
    // Get the symbol from the underlying field
    const underlyingValue = underlyingInput.value;
    const symbol = underlyingInput.dataset.symbol || underlyingValue.split(' - ')[0];
    
    const formData = {
        ticker: symbol,
        tradeDate: document.getElementById('stc-trade-date').value,
        expirationDate: document.getElementById('stc-trade-date').value, // Use trade date as expiration for STC
        strikePrice: parseFloat(document.getElementById('stc-sale-price').value),
        premium: 0, // STC doesn't have premium
        quantity: parseInt(document.getElementById('stc-shares').value),
        currentPrice: 0, // STC doesn't need current price
        tradeType: 'STC'
    };
    
    try {
        let response;
        let successMessage;
        
        if (editingTradeId) {
            // Update existing trade
            response = await fetch(`/api/trades/${editingTradeId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData)
            });
            successMessage = 'STC trade updated successfully!';
        } else {
            // Create new trade
            response = await fetch('/api/trades', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData)
            });
            successMessage = 'STC trade added successfully!';
        }
        
        const result = await response.json();
        
        if (result.success) {
            // Check if this was an edit from cost basis table before resetting modal state
            const wasFromCostBasis = modal.dataset.fromCostBasis === 'true';
            
            // Handle different actions
            if (action === 'addAndClose' || wasFromCostBasis) {
                // Close modal
                const modalInstance = bootstrap.Modal.getInstance(modal);
                modalInstance.hide();
            } else if (action === 'addAnother') {
                // Reset form for new entry
                document.getElementById('stcForm').reset();
                // Set today's date as default
                const today = new Date().toISOString().split('T')[0];
                document.getElementById('stc-trade-date').value = today;
            }
            
            // Reset modal state
            modal.dataset.editingTradeId = '';
            modal.dataset.fromCostBasis = '';
            modal.dataset.editingTicker = '';
            document.getElementById('stcModalLabel').innerHTML = '<i class="fas fa-plus-circle me-2"></i>Add STC Trade';
            
            // Reload data
            await loadTrades();
            loadSummary();
            
            if (wasFromCostBasis) {
                // Keep the cost basis table open with current filter
                const editingTicker = modal.dataset.editingTicker || selectedTicker;
                await loadCostBasis(editingTicker);
            } else {
                // Normal behavior for new trades
                await loadCostBasis();
            }
        } else {
            alert(`Failed to ${editingTradeId ? 'update' : 'add'} STC trade: ` + result.error);
        }
    } catch (error) {
        console.error(`Error ${editingTradeId ? 'updating' : 'adding'} STC trade:`, error);
        alert(`Error ${editingTradeId ? 'updating' : 'adding'} STC trade: ` + error.message);
    }
}
