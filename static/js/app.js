let trades = [];
let cachedTrades = null; // Cache original unfiltered trades data
let cachedCostBasis = null; // Cache original unfiltered cost basis data
let currentFilter = { startDate: null, endDate: null, period: 'all' };
let statusFilter = '';
let sortColumn = 'trade_date'; // Default to sorting by trade date
let sortDirection = 'desc'; // Default to descending (newest first)
let commission = 0.0;
let statusMonitorInterval = null;
let lastTradeCount = 0;
let selectedTicker = null;
let premiumChart = null;

// Abort controllers for canceling pending API requests
let tradesAbortController = null;
let costBasisAbortController = null;
let summaryAbortController = null;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function formatCurrency(amount) {
    return amount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

// ============================================================================
// STANDARDIZED DATE UTILITIES
// ============================================================================

/**
 * Convert date from database format (YYYY-MM-DD) to DD-MMM-YY format
 */
function formatDate(dateString) {
    if (!dateString) return '';
    
    try {
        // Parse date string directly without timezone conversion
        const parts = dateString.split(/[-T]/);
        if (parts.length >= 3) {
            const year = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1; // JavaScript months are 0-indexed
            const day = parseInt(parts[2]);
            const date = new Date(year, month, day);
            
            const dayStr = date.getDate().toString().padStart(2, '0');
            const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
            const monthStr = monthNames[date.getMonth()];
            const yearStr = date.getFullYear().toString().slice(-2);
            return `${dayStr}-${monthStr}-${yearStr}`;
        }
    } catch (e) {
        console.error('Error formatting date:', e);
    }
    
    return dateString;
}

/**
 * Convert date from database format (YYYY-MM-DD) to display format using browser locale
 */
function formatDateLocale(dateString) {
    if (!dateString) return '';
    
    try {
        // Parse date string directly without timezone conversion
        const parts = dateString.split(/[-T]/);
        if (parts.length >= 3) {
            const year = parseInt(parts[0]);
            const month = parseInt(parts[1]) - 1; // JavaScript months are 0-indexed
            const day = parseInt(parts[2]);
            const date = new Date(year, month, day);
            
            // Use browser's locale for date formatting
            const options = { year: '2-digit', month: 'short', day: '2-digit' };
            return date.toLocaleDateString(undefined, options);
        }
    } catch (e) {
        console.error('Error formatting date:', e);
    }
    
    return dateString;
}

/**
 * Convert date from display format back to database format (YYYY-MM-DD)
 */
function parseDisplayDate(displayDate) {
    if (!displayDate) return '';
    
    try {
        // Primary: Try DD-MMM-YY format (e.g., "26-OCT-25")
        const dateParts = displayDate.split(/[-\s,]/);
        if (dateParts.length >= 3) {
            const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
                               'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
            const month = dateParts[1].toLowerCase();
            let monthIndex = monthNames.indexOf(month);
            if (monthIndex >= 12) monthIndex -= 12; // Handle full month names
            if (monthIndex >= 0) {
                const day = String(parseInt(dateParts[0])).padStart(2, '0');
                const year = '20' + dateParts[2].slice(-2); // Assume 20XX
                const monthNum = String(monthIndex + 1).padStart(2, '0');
                return `${year}-${monthNum}-${day}`;
            }
        }
        
        // Fallback: Try parsing as Date object (for locale-aware formats)
        const date = new Date(displayDate);
        if (!isNaN(date.getTime())) {
            // Valid date, format as YYYY-MM-DD
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }
    } catch (e) {
        console.error('Error parsing display date:', e);
    }
    
    return displayDate;
}

async function getCompanyName(ticker) {
    try {
        const response = await fetch(`/api/company-search?q=${ticker}`);
        const companies = await response.json();
        return companies.find(c => c.symbol === ticker)?.name || ticker;
    } catch (error) {
        console.error('Error fetching company name:', error);
        return ticker;
    }
}

// ============================================================================
// GENERIC FORM HANDLING
// ============================================================================

async function submitTradeForm(formType, action = 'addAndClose') {
    const form = document.getElementById(`${formType}Form`);
    const modal = document.getElementById(`${formType}Modal`);
    const editingTradeId = form.dataset.editingTradeId;
    
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }
    
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());
    
    // Map form field names to backend field names
    if (formType === 'roctPut' || formType === 'roctCall') {
        // Transform options trade field names
        data.ticker = (data.underlying || data.ticker || '').toUpperCase();
        data.premium = data.creditDebit || data.premium;
        data.currentPrice = data.price || data.currentPrice;
        // Set trade type with proper spacing
        if (formType === 'roctPut') {
            data.tradeType = 'ROCT PUT';
        } else if (formType === 'roctCall') {
            data.tradeType = 'ROCT CALL';
        } else {
            data.tradeType = formType.toUpperCase();
        }
        
        // Convert dates from display format to YYYY-MM-DD format
        if (data.tradeDate) {
            data.tradeDate = parseDisplayDate(data.tradeDate);
        }
        
        if (data.expirationDate) {
            data.expirationDate = parseDisplayDate(data.expirationDate);
        }
    } else if (formType === 'bto' || formType === 'stc') {
        // Map BTO/STC fields to backend expected format
        data.ticker = (data.underlying || data.ticker || '').toUpperCase();
        data.premium = data.purchasePrice || data.salePrice || data.premium;
        data.currentPrice = data.purchasePrice || data.salePrice || data.currentPrice;
        data.num_of_contracts = data.shares || data.num_of_contracts;
        
        // Convert date from display format to YYYY-MM-DD format
        if (data.tradeDate) {
            data.tradeDate = parseDisplayDate(data.tradeDate);
        }
        
        data.expirationDate = data.tradeDate || data.expirationDate;
        data.tradeType = formType.toUpperCase();
    } else {
        data.tradeType = formType;
        // Ensure ticker is uppercase if present
        if (data.ticker) {
            data.ticker = data.ticker.toUpperCase();
        }
    }
    
    try {
        const url = editingTradeId ? `/api/trades/${editingTradeId}` : '/api/trades';
        const method = editingTradeId ? 'PUT' : 'POST';
        
        const response = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        
        const result = await response.json();
        
        if (result.success) {
            const wasFromCostBasis = modal.dataset.fromCostBasis === 'true';
            
            // Capture ticker information before resetting modal state
            const editingTicker = modal.dataset.editingTicker || null;
            const tradeTicker = data.ticker || editingTicker || null;
            
            if (action === 'addAndClose' || action === 'save' || wasFromCostBasis) {
                const modalInstance = bootstrap.Modal.getInstance(modal);
                modalInstance.hide();
            } else if (action === 'addAnother') {
                form.reset();
                const today = new Date().toISOString().split('T')[0];
                const dateField = form.querySelector('input[type="date"]');
                if (dateField) dateField.value = today;
            }
            
            // Reset modal state
            modal.dataset.editingTradeId = '';
            modal.dataset.fromCostBasis = '';
            modal.dataset.editingTicker = '';
            
            // Determine which ticker to show in cost basis and set filter if needed
            let tickerToShow = null;
            let filterWasSet = false;
            if (wasFromCostBasis) {
                // If opened from cost basis, use the editing ticker or selected ticker
                tickerToShow = editingTicker || selectedTicker || window.symbolFilter || null;
            } else {
                // If opened from quick add, check if there's a currently selected ticker in cost basis
                const currentTicker = window.symbolFilter || null;
                if (currentTicker && tradeTicker && currentTicker.toUpperCase() === tradeTicker.toUpperCase()) {
                    // If the trade is for the currently selected ticker, preserve the view
                    tickerToShow = currentTicker;
                } else if (tradeTicker) {
                    // If there's a ticker in the trade data, show that ticker's details
                    tickerToShow = tradeTicker;
                    
                    // If no symbol filter is currently set, check if cost basis table is showing a specific ticker
                    if (!currentTicker || currentTicker.trim() === '') {
                        // Try to get the ticker from the cost basis table if it's showing details
                        const costBasisTicker = getTickerFromCostBasisTable();
                        if (costBasisTicker) {
                            // Set the universal ticker filter to the ticker displayed in cost basis table
                            setUniversalTickerFilterSilent(costBasisTicker);
                            tickerToShow = costBasisTicker;
                            filterWasSet = true;
                        } else {
                            // If no ticker found in cost basis table, use the trade ticker and set filter
                            setUniversalTickerFilterSilent(tradeTicker);
                            filterWasSet = true;
                        }
                    } else {
                        // Filter is already set, just update it silently
                        setUniversalTickerFilterSilent(tradeTicker);
                        filterWasSet = true;
                    }
                } else {
                    // Otherwise, show all symbols
                    tickerToShow = null;
                }
            }
            
            // Reload data after filter is set (if it was set)
            // This ensures trades and dashboard use the new filter
            await loadTrades();
            loadSummary();
            await loadCostBasis(tickerToShow);
        } else {
            alert(`Failed to ${editingTradeId ? 'update' : 'add'} ${formType} trade: ` + result.error);
        }
    } catch (error) {
        console.error(`Error ${editingTradeId ? 'updating' : 'adding'} ${formType} trade:`, error);
        const errorMessage = error.message || error.response?.data?.error || error.toString();
        alert(`Error ${editingTradeId ? 'updating' : 'adding'} ${formType} trade: ` + errorMessage);
    }
}

// ============================================================================
// GENERIC AUTOCOMPLETE HANDLING
// ============================================================================

// Track autocomplete setup to prevent duplicate listeners
const autocompleteSetup = new Set();

function setupAutocomplete(inputId, suggestionsId, onSelectCallback) {
    const input = document.getElementById(inputId);
    const suggestions = document.getElementById(suggestionsId);
    
    if (!input || !suggestions) return;
    
    // Prevent duplicate setup
    const setupKey = `${inputId}-${suggestionsId}`;
    if (autocompleteSetup.has(setupKey)) {
        return; // Already set up
    }
    autocompleteSetup.add(setupKey);
    
    let debounceTimer;
    
    input.addEventListener('input', function() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            const query = this.value.trim().toUpperCase();
            
            if (query.length < 1) {
                suggestions.style.display = 'none';
                return;
            }
            
            try {
                const response = await fetch(`/api/company-search?q=${query}`);
                const companies = await response.json();
                
                if (companies.length > 0) {
                    suggestions.innerHTML = companies.map(company => 
                        `<div class="suggestion-item" data-symbol="${company.symbol}" data-name="${company.name}">
                            <strong>${company.symbol}</strong> - ${company.name}
                        </div>`
                    ).join('');
                    suggestions.style.display = 'block';
                } else {
                    suggestions.style.display = 'none';
                }
            } catch (error) {
                console.error('Error fetching suggestions:', error);
                suggestions.style.display = 'none';
            }
        }, 300);
    });
    
    // Handle suggestion clicks
    suggestions.addEventListener('click', function(e) {
        const item = e.target.closest('.suggestion-item');
        if (item) {
            const symbol = item.dataset.symbol.toUpperCase();
            const name = item.dataset.name;
            input.value = symbol;
            suggestions.style.display = 'none';
            if (onSelectCallback) onSelectCallback(symbol, name);
        }
    });
    
    // Handle keyboard navigation
    input.addEventListener('keydown', function(e) {
        const items = suggestions.querySelectorAll('.suggestion-item');
        const current = suggestions.querySelector('.suggestion-item.active');
        
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (current) {
                current.classList.remove('active');
                const next = current.nextElementSibling;
                if (next) next.classList.add('active');
            } else if (items.length > 0) {
                items[0].classList.add('active');
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (current) {
                current.classList.remove('active');
                const prev = current.previousElementSibling;
                if (prev) prev.classList.add('active');
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (current) {
                const symbol = current.dataset.symbol.toUpperCase();
                const name = current.dataset.name;
                input.value = symbol;
                suggestions.style.display = 'none';
                if (onSelectCallback) onSelectCallback(symbol, name);
            }
        } else if (e.key === 'Escape') {
            suggestions.style.display = 'none';
        }
    });
    
    // Hide suggestions when clicking outside - use a single document listener
    // Store handler reference to allow removal if needed
    const clickHandler = function(e) {
        if (!input.contains(e.target) && !suggestions.contains(e.target)) {
            suggestions.style.display = 'none';
        }
    };
    document.addEventListener('click', clickHandler);
}

// ============================================================================
// GENERIC SYMBOL FILTER HANDLING
// ============================================================================

function setupSymbolFilter(containerId, onFilterCallback) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    const symbolFilterInput = container.querySelector('input[type="text"]');
    const clearButton = container.querySelector('.clear-symbol-filter');
    
    if (!symbolFilterInput) return;
    
    // Setup autocomplete
    setupAutocomplete(symbolFilterInput.id, `${containerId}-suggestions`, (symbol) => {
        if (onFilterCallback) onFilterCallback(symbol);
    });
    
    // Clear button functionality
    if (clearButton) {
        clearButton.addEventListener('click', function() {
            symbolFilterInput.value = '';
            clearButton.style.display = 'none';
            if (onFilterCallback) onFilterCallback('');
        });
    }
    
    // Show/hide clear button
    symbolFilterInput.addEventListener('input', function() {
        if (clearButton) {
            clearButton.style.display = this.value.trim() ? 'block' : 'none';
        }
    });
}

// ============================================================================
// GENERIC MODAL HANDLING
// ============================================================================

function openModal(modalType, tradeData = null) {
    const modal = document.getElementById(`${modalType}Modal`);
    const form = document.getElementById(`${modalType}Form`);
    
    if (!modal || !form) return;
    
    // Reset form
    form.reset();
    
    // Set today's date as default for text date fields
    const todayDDMMMYY = getTodayInDDMMMYY();
    const dateFields = form.querySelectorAll('input[data-display-format="DD-MMM-YY"]');
    dateFields.forEach(field => {
        if (!field.value) {
            field.value = todayDDMMMYY;
        }
    });
    
    // If editing, populate form
    if (tradeData) {
        // Store editing state in a way that doesn't interfere with Bootstrap modal
        form.dataset.editingTradeId = tradeData.id;
        form.dataset.editingTicker = tradeData.ticker;
        
        // Populate form fields based on trade data
        Object.keys(tradeData).forEach(key => {
            const field = form.querySelector(`[name="${key}"]`);
            if (field) field.value = tradeData[key];
        });
    } else {
        form.removeAttribute('data-editing-trade-id');
        form.removeAttribute('data-editing-ticker');
    }
    
    // Show modal
    const modalInstance = new bootstrap.Modal(modal);
    modalInstance.show();
}

// ============================================================================
// CALCULATION UTILITIES
// ============================================================================

function calculateNetCredit(premium, commission, num_of_contracts) {
    const netCreditPerShare = premium - commission;
    return netCreditPerShare * num_of_contracts * 100;
}

function calculateRiskCapital(strike, netCreditPerShare) {
    return strike - netCreditPerShare;
}

function calculateMarginCapital(riskCapital, shares) {
    return riskCapital * shares;
}

function calculateRORC(netCreditPerShare, riskCapital) {
    return riskCapital !== 0 ? (netCreditPerShare / riskCapital) * 100 : 0;
}

function calculateExpirationDate(tradeDate) {
    if (!tradeDate) return '';
    
    const date = new Date(tradeDate);
    date.setDate(date.getDate() + 8);
    
    // Format as YYYY-MM-DD for input type="date"
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    return `${year}-${month}-${day}`;
}

function setupExpirationDateCalculation(tradeDateId, expirationDateId) {
    const tradeDateField = document.getElementById(tradeDateId);
    const expirationDateField = document.getElementById(expirationDateId);
    
    if (!tradeDateField || !expirationDateField) {
        console.error('Expiration date calculation setup failed: missing fields');
        return;
    }
    
    function updateExpirationDate() {
        const tradeDate = tradeDateField.value;
        const expirationDate = calculateExpirationDate(tradeDate);
        expirationDateField.value = expirationDate;
        
        // Also update DTE if DTE calculation is set up
        if (typeof setupDTECalculation === 'function') {
            // Trigger DTE calculation by dispatching change event
            expirationDateField.dispatchEvent(new Event('change'));
        }
    }
    
    // Add event listener for trade date changes
    tradeDateField.addEventListener('change', updateExpirationDate);
    
    // Set initial expiration date if trade date is already filled
    updateExpirationDate();
}

function calculateDaysToExpiration(expirationDate, tradeDate) {
    if (!expirationDate || !tradeDate) return 0;
    
    // Parse dates from DD-MMM-YY format to YYYY-MM-DD format first
    const parsedExpirationDate = parseDateInput(expirationDate);
    const parsedTradeDate = parseDateInput(tradeDate);
    
    if (!parsedExpirationDate || !parsedTradeDate) return 0;
    
    // Create Date objects from parsed dates (YYYY-MM-DD format)
    const expDate = new Date(parsedExpirationDate + 'T00:00:00');
    const tradeDateObj = new Date(parsedTradeDate + 'T00:00:00');
    
    // Check if dates are valid
    if (isNaN(expDate.getTime()) || isNaN(tradeDateObj.getTime())) {
        console.warn('Invalid dates for DTE calculation:', { expirationDate, tradeDate, parsedExpirationDate, parsedTradeDate });
        return 0;
    }
    
    const diffTime = expDate - tradeDateObj;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays > 0 ? diffDays : 0;
}

function setupDTECalculation(tradeDateId, expirationDateId, dteId) {
    console.log('Setting up DTE calculation for:', tradeDateId, expirationDateId, dteId);
    const tradeDateField = document.getElementById(tradeDateId);
    const expirationDateField = document.getElementById(expirationDateId);
    const dteField = document.getElementById(dteId);
    
    console.log('Fields found:', { tradeDateField, expirationDateField, dteField });
    
    if (!tradeDateField || !expirationDateField || !dteField) {
        console.error('DTE calculation setup failed: missing fields');
        return;
    }
    
    function calculateDTE() {
        const tradeDate = tradeDateField.value;
        const expirationDate = expirationDateField.value;
        
        console.log('Calculating DTE:', { tradeDate, expirationDate });
        
        if (tradeDate && expirationDate) {
            const dte = calculateDaysToExpiration(expirationDate, tradeDate);
            dteField.value = dte;
            console.log('DTE calculated:', dte);
        } else {
            dteField.value = '';
            console.log('DTE cleared - missing dates');
        }
    }
    
    // Auto-set expiration date to 8 days from trade date when trade date changes
    function updateExpirationDate() {
        const tradeDate = tradeDateField.value;
        
        // Only auto-update if expiration date is empty or if in add mode (not edit mode)
        const form = tradeDateField.closest('form');
        const isEditMode = form && form.hasAttribute('data-editing-trade-id');
        
        if (tradeDate && !isEditMode) {
            try {
                // Parse the trade date (DD-MMM-YY format)
                const tradeDateParsed = parseDateInput(tradeDate);
                if (tradeDateParsed) {
                    const tradeDateObj = new Date(tradeDateParsed);
                    
                    // Add 8 days
                    const expirationDateObj = new Date(tradeDateObj);
                    expirationDateObj.setDate(tradeDateObj.getDate() + 8);
                    
                    // Format as DD-MMM-YY
                    const expDateFormatted = formatDate(expirationDateObj.toISOString().split('T')[0]);
                    
                    // Only update if expiration field is empty
                    if (!expirationDateField.value) {
                        expirationDateField.value = expDateFormatted;
                    }
                    
                    // Recalculate DTE
                    calculateDTE();
                }
            } catch (error) {
                console.error('Error auto-setting expiration date:', error);
            }
        }
    }
    
    // Add event listeners
    tradeDateField.addEventListener('change', function() {
        updateExpirationDate();
        calculateDTE();
    });
    expirationDateField.addEventListener('change', calculateDTE);
    
    // Calculate initial DTE if both fields have values
    calculateDTE();
}

function calculateARORC(rorc, dte) {
    return dte !== 0 ? (365 / dte) * rorc : 0;
}

// Calculate ARORC for ROCT PUT form
function calculateROCTPutARORC() {
    const strikePriceField = document.getElementById('roct-put-strike-price');
    const creditDebitField = document.getElementById('roct-put-credit-debit');
    const dteField = document.getElementById('roct-put-dte');
    const arorcField = document.getElementById('roct-put-arorc');
    
    if (!strikePriceField || !creditDebitField || !dteField || !arorcField) {
        return;
    }
    
    const strikePrice = parseFloat(strikePriceField.value) || 0;
    const creditDebit = parseFloat(creditDebitField.value) || 0;
    const dte = parseFloat(dteField.value) || 0;
    
    // Calculate ARORC: (365 / DTE) * (net_credit_per_share / (risk_capital_per_share * margin_percent)) * 100
    // For preview, we'll use credit_debit directly (commission will be calculated on backend)
    // risk_capital_per_share = strike_price - net_credit_per_share
    // net_credit_per_share ≈ credit_debit (approximation for preview)
    // margin_percent = 100.0
    
    if (dte > 0 && strikePrice > 0 && creditDebit > 0) {
        const netCreditPerShare = creditDebit; // Approximation - backend will calculate with commission
        const riskCapitalPerShare = strikePrice - netCreditPerShare;
        const marginPercent = 100.0; // Stored as percentage (100 = 100%)
        
        if (riskCapitalPerShare > 0) {
            // margin_percent is stored as percentage (100 = 100%), convert to decimal (divide by 100)
            const denominator = riskCapitalPerShare * (marginPercent / 100.0);
            // Calculate ARORC as decimal, then convert to percentage and round to 1 decimal
            const arorcDecimal = (365.0 / dte) * (netCreditPerShare / denominator);
            const arorcPercentage = arorcDecimal * 100.0;
            arorcField.value = parseFloat(arorcPercentage.toFixed(1));
        } else {
            arorcField.value = '';
        }
    } else {
        arorcField.value = '';
    }
}

// ============================================================================
// DATA LOADING FUNCTIONS
// ============================================================================

async function loadTrades() {
    try {
        // Cancel any pending trades request
        if (tradesAbortController) {
            tradesAbortController.abort();
        }
        tradesAbortController = new AbortController();
        
        console.log('Loading trades...');
        
        // Get account filter
        const accountFilter = document.getElementById('universal-account-filter')?.value || '';
        console.log('[DEBUG] loadTrades - accountFilter:', accountFilter);
        
        // Get ticker filter - check both window.symbolFilter and input value
        const universalTickerInput = document.getElementById('universal-ticker-filter');
        const tickerFilter = window.symbolFilter || (universalTickerInput ? universalTickerInput.value.trim() : '') || '';
        
        // Use dashboard date filters if available, otherwise use current filter
        const dashboardStartDate = document.getElementById('dashboard-start-date')?.value;
        const dashboardEndDate = document.getElementById('dashboard-end-date')?.value;
        
        const params = new URLSearchParams();
        if (accountFilter) {
            params.append('account_id', accountFilter);
            console.log('[DEBUG] loadTrades - adding account_id to params:', accountFilter);
        }
        if (tickerFilter) {
            params.append('ticker', tickerFilter);
        }
        if (dashboardStartDate) {
            params.append('start_date', dashboardStartDate);
        } else if (currentFilter.startDate) {
            params.append('start_date', currentFilter.startDate);
        }
        
        if (dashboardEndDate) {
            params.append('end_date', dashboardEndDate);
        } else if (currentFilter.endDate) {
            params.append('end_date', currentFilter.endDate);
        }
        
        const response = await fetch(`/api/trades?${params}`, {
            signal: tradesAbortController.signal
        });
        trades = await response.json();
        
        // Ensure trades is an array
        if (!Array.isArray(trades)) {
            console.error('trades is not an array:', trades);
            trades = [];
        }
        
        // Cache unfiltered trades data (when no ticker filter is applied)
        // Use structuredClone for better performance, fallback to JSON for compatibility
        if (!tickerFilter) {
            try {
                cachedTrades = structuredClone ? structuredClone(trades) : JSON.parse(JSON.stringify(trades));
            } catch (e) {
                cachedTrades = JSON.parse(JSON.stringify(trades)); // Fallback
            }
        }
        
        lastTradeCount = trades.length;
        console.log('Trades loaded:', trades.length, 'trades');
        console.log('Sample trade:', trades[0]);
        
        updateTradesTable();
        updateSymbolFilter();
    } catch (error) {
        // Ignore abort errors
        if (error.name === 'AbortError') {
            console.log('Trades request aborted');
            return;
        }
        console.error('Error loading trades:', error);
    }
}

async function loadSummary() {
    try {
        // Cancel any pending summary request
        if (summaryAbortController) {
            summaryAbortController.abort();
        }
        summaryAbortController = new AbortController();
        
        console.log('Loading summary...');
        const params = new URLSearchParams();
        
        // Get account filter
        const accountFilter = document.getElementById('universal-account-filter')?.value || '';
        if (accountFilter) {
            params.append('account_id', accountFilter);
        }
        
        // Get ticker filter
        if (window.symbolFilter) {
            params.append('ticker', window.symbolFilter);
        }
        
        // Use dashboard date filters if available, otherwise use current filter
        const dashboardStartDate = document.getElementById('dashboard-start-date')?.value;
        const dashboardEndDate = document.getElementById('dashboard-end-date')?.value;
        
        if (dashboardStartDate) {
            params.append('start_date', dashboardStartDate);
        } else if (currentFilter.startDate) {
            params.append('start_date', currentFilter.startDate);
        }
        
        if (dashboardEndDate) {
            params.append('end_date', dashboardEndDate);
        } else if (currentFilter.endDate) {
            params.append('end_date', currentFilter.endDate);
        }
        
        const response = await fetch(`/api/summary?${params}`, {
            signal: summaryAbortController.signal
        });
        const summary = await response.json();
        console.log('Summary loaded:', summary);
        
        // Update center text
        document.getElementById('total-trades-center').textContent = summary.total_trades;
        
        // Update doughnut chart
        updateTradeDistributionChart(summary.open_trades, summary.closed_trades, summary);
        
        // Update financial card elements
        document.getElementById('total-net-credit').textContent = `$${formatCurrency(summary.total_net_credit)}`;
        document.getElementById('days-remaining').textContent = summary.days_remaining;
        document.getElementById('days-done').textContent = summary.days_done;
        
        // Update bankroll chart
        updateBankroll();
    } catch (error) {
        // Ignore abort errors
        if (error.name === 'AbortError') {
            console.log('Summary request aborted');
            return;
        }
        console.error('Error loading summary:', error);
    }
}

let sunburstChart = null;
let currentHighlightedSegment = null;

function updateTradeDistributionChart(openTrades, closedTrades, summary) {
    console.log('Chart called with - Open:', openTrades, 'Closed:', closedTrades, 'Total:', openTrades + closedTrades);
    
    // Set up dimensions first to avoid hoisting issues
    const width = 450;
    const height = 450;
    const radius = Math.min(width, height) / 2;
    
    // Check if D3.js is available
    if (typeof d3 === 'undefined') {
        console.error('D3.js is not loaded');
        return;
    }
    
    const container = document.getElementById('sunburst-chart');
    if (!container) {
        console.error('Sunburst chart container not found');
        return;
    }
    
    // Clear existing chart completely
    container.innerHTML = '';
    
    // Prevent multiple renders by checking if we already have the same data
    if (sunburstChart && sunburstChart.openTrades === openTrades && sunburstChart.closedTrades === closedTrades) {
        return;
    }
    
    // Store current data to prevent duplicate renders
    sunburstChart = { openTrades, closedTrades, summary };
    
    const totalTrades = openTrades + closedTrades;
    
    // If no trades, show empty chart
    if (totalTrades === 0) {
        container.innerHTML = '<div class="d-flex align-items-center justify-content-center h-100 text-muted">No trades to display</div>';
        return;
    }
    
    // Create hierarchical data structure for sunburst chart
    // Ensure wins + losses = completed trades for proper D3.js hierarchy
    const actualWins = Math.min(summary.wins, closedTrades);
    const actualLosses = Math.min(summary.losses, closedTrades - actualWins);
    
    const data = {
        name: "Trades",
        children: [
            {
                name: "Open Trades",
                value: openTrades,
                children: []
            },
            {
                name: "Completed Trades",
                value: closedTrades,
                children: closedTrades > 0 ? [
                    { name: "Wins", value: actualWins },
                    { name: "Losses", value: actualLosses }
                ] : []
            }
        ]
    };
    
    console.log('Data structure:', JSON.stringify(data, null, 2));
    
    // Debug: Check individual values before D3.js processing
    console.log('Before D3.js - Open:', openTrades, 'Closed:', closedTrades, 'Wins:', actualWins, 'Losses:', actualLosses);
    console.log('Expected total:', openTrades + closedTrades, 'Expected completed:', closedTrades);
    
    // Create SVG
    const svg = d3.select(container)
        .append("svg")
        .attr("width", width)
        .attr("height", height)
        .style("max-width", "100%")
        .style("height", "auto");
    
    const g = svg.append("g")
        .attr("transform", `translate(${width/2},${height/2})`);
    
    // Create partition layout
    const partition = d3.partition()
        .size([2 * Math.PI, radius]);
    
    // Create hierarchy
    const root = d3.hierarchy(data)
        .sum(d => {
            // For parent nodes with children, don't count their own value
            // D3.js will sum the children automatically
            if (d.children && d.children.length > 0) {
                console.log('D3 sum - parent node:', d.name, 'value: 0 (has children)');
                return 0;
            } else {
                console.log('D3 sum - leaf node:', d.name, 'value:', d.value);
                return d.value;
            }
        });
    
    console.log('After D3.js hierarchy - root value:', root.value);
    console.log('After D3.js hierarchy - children:', root.children?.map(c => ({ name: c.data.name, value: c.value })));
    
    partition(root);
    
    console.log('After partition - root value:', root.value);
    console.log('After partition - children:', root.children?.map(c => ({ name: c.data.name, value: c.value })));
    
    // Color scale
    const color = d3.scaleOrdinal()
        .domain(["Open Trades", "Completed Trades", "Wins", "Losses"])
        .range(["#28a745", "#ffc107", "#17a2b8", "#dc3545"]);
    
    // Create arcs
    const arc = d3.arc()
        .startAngle(d => d.x0)
        .endAngle(d => d.x1)
        .innerRadius(d => d.y0)
        .outerRadius(d => d.y1);
    
    // Add arcs to chart
    const descendants = root.descendants();
    console.log('Rendering', descendants.length, 'arcs:', descendants.map(d => d.data.name + ':' + d.value));
    
    g.selectAll("path")
        .data(descendants)
        .enter()
        .append("path")
        .attr("d", arc)
        .style("fill", d => {
            if (d.depth === 0) return "#6c757d"; // Root
            if (d.depth === 1) return color(d.data.name); // Trade status
            if (d.depth === 2) return color(d.data.name); // Outcomes
            return "#6c757d";
        })
        .style("stroke", "#fff")
        .style("stroke-width", 2)
        .style("opacity", 0.8)
        .on("mouseover", function(event, d) {
            d3.select(this).style("opacity", 1);
            
            // Show enhanced tooltip with Chart.js style
            const tooltip = d3.select("body").append("div")
                .attr("class", "chart-tooltip")
                .style("position", "absolute")
                .style("background", "rgba(0, 0, 0, 0.8)")
                .style("color", "white")
                .style("padding", "8px 12px")
                .style("border-radius", "4px")
                .style("font-size", "12px")
                .style("pointer-events", "none")
                .style("z-index", "1000")
                .style("box-shadow", "0 2px 4px rgba(0,0,0,0.2)")
                .style("border", "1px solid rgba(255,255,255,0.1)")
                .style("font-family", "Arial, sans-serif")
                .style("line-height", "1.4");
            
            const percentage = ((d.value / root.value) * 100).toFixed(1);
            
            tooltip.html(`
                <div style="display: flex; align-items: center; margin-bottom: 4px;">
                    <div style="width: 10px; height: 10px; background-color: ${d.depth === 1 ? color(d.data.name) : d.depth === 2 ? color(d.data.name) : '#6c757d'}; border-radius: 2px; margin-right: 8px;"></div>
                    <span style="font-weight: bold;">${d.data.name}</span>
                </div>
                <div style="margin-left: 18px; font-size: 11px;">
                    ${d.value} trades (${percentage}%)
                </div>
            `);
        })
        .on("mousemove", function(event) {
            d3.select(".chart-tooltip")
                .style("left", (event.pageX + 10) + "px")
                .style("top", (event.pageY - 10) + "px");
        })
        .on("mouseout", function() {
            d3.select(this).style("opacity", 0.8);
            d3.select(".chart-tooltip").remove();
        })
        .on("click", function(event, d) {
            event.stopPropagation();
            // Toggle highlight: if clicking the same segment, reset; otherwise highlight
            if (currentHighlightedSegment === d.data.name) {
                resetLegendHighlight();
            } else {
                highlightLegend(d.data.name, d.depth);
            }
        })
        .style("cursor", "pointer");
    
    // Labels removed - using legend instead
    // g.selectAll("text.outer")...
    // g.selectAll("text.inner")...
    
    // Update legend with counts and percentages
    updateLegendCounts(openTrades, closedTrades, summary, totalTrades);
}

// Function to update legend counts and percentages
function updateLegendCounts(openTrades, closedTrades, summary, totalTrades) {
    if (totalTrades === 0) {
        document.getElementById('legend-open-count').textContent = '0 (0%)';
        document.getElementById('legend-completed-count').textContent = '0 (0%)';
        document.getElementById('legend-wins-count').textContent = '0 (0%)';
        document.getElementById('legend-losses-count').textContent = '0 (0%)';
        return;
    }
    
    const openPercent = ((openTrades / totalTrades) * 100).toFixed(1);
    const completedPercent = ((closedTrades / totalTrades) * 100).toFixed(1);
    
    document.getElementById('legend-open-count').textContent = `${openTrades} (${openPercent}%)`;
    document.getElementById('legend-completed-count').textContent = `${closedTrades} (${completedPercent}%)`;
    
    const wins = summary.wins || 0;
    const losses = summary.losses || 0;
    const winsPercent = closedTrades > 0 ? ((wins / closedTrades) * 100).toFixed(1) : '0.0';
    const lossesPercent = closedTrades > 0 ? ((losses / closedTrades) * 100).toFixed(1) : '0.0';
    
    document.getElementById('legend-wins-count').textContent = `${wins} (${winsPercent}%)`;
    document.getElementById('legend-losses-count').textContent = `${losses} (${lossesPercent}%)`;
}

// Function to highlight legend when chart segment is clicked
function highlightLegend(segmentName, depth) {
    // Store the currently highlighted segment
    currentHighlightedSegment = segmentName;
    
    // Map segment names to legend text
    const legendMap = {
        "Open Trades": "Open",
        "Completed Trades": "Completed",
        "Wins": "Wins",
        "Losses": "Losses"
    };
    
    const legendText = legendMap[segmentName] || segmentName;
    
    // Find all legend items
    const legendContainer = document.querySelector('.legend-container');
    if (!legendContainer) return;
    
    const legendItems = legendContainer.querySelectorAll('.d-flex.align-items-center');
    
    legendItems.forEach(item => {
        const textElement = item.querySelector('.legend-text');
        if (textElement) {
            const text = textElement.textContent.trim();
            
            if (text === legendText) {
                // Highlight the clicked legend
                item.style.opacity = '1';
                item.style.transform = 'scale(1.05)';
                item.style.fontWeight = 'bold';
            } else {
                // Dim other legends
                item.style.opacity = '0.3';
                item.style.transform = 'scale(1)';
                item.style.fontWeight = 'normal';
            }
        }
    });
    
    // Also highlight/dim the chart segments
    const svg = d3.select('#sunburst-chart svg');
    if (svg.empty()) return;
    
            svg.selectAll('path').style('opacity', function(d) {
                const data = d3.select(this).datum().data;
                if (data.name === segmentName) {
                    return '1';
                } else {
                    return '0.3';
                }
            });
    
    // Update bankroll chart when clicking on trade segments
    if (segmentName === 'Open Trades') {
        updateBankroll('open'); // Filter bankroll to only open trades
    } else if (segmentName === 'Completed Trades') {
        updateBankroll('completed'); // Filter bankroll to only completed trades
    } else {
        updateBankroll(null); // Show all trades
    }
}

// Function to reset legend highlight
function resetLegendHighlight() {
    currentHighlightedSegment = null;
    
    // Reset all legend items
    const legendContainer = document.querySelector('.legend-container');
    if (legendContainer) {
        const legendItems = legendContainer.querySelectorAll('.d-flex.align-items-center');
        legendItems.forEach(item => {
            item.style.opacity = '1';
            item.style.transform = 'scale(1)';
            item.style.fontWeight = 'normal';
        });
    }
    
    // Reset chart segments
    const svg = d3.select('#sunburst-chart svg');
    if (!svg.empty()) {
        svg.selectAll('path').style('opacity', 0.8);
    }
    
    // Reset bankroll chart to show all trades (no filter)
    updateBankroll(null);
}

// Function to update bankroll chart
function updateBankrollChart(totalBankroll, availableBankroll, usedBankroll, breakdown = null) {
    if (typeof d3 === 'undefined') {
        console.error('D3.js is not loaded');
        return;
    }
    
    const container = document.getElementById('bankroll-chart');
    if (!container) {
        console.error('Bankroll chart container not found');
        return;
    }
    
    container.innerHTML = '';
    
    const width = 450;
    const height = 450;
    const radius = Math.min(width, height) / 2;
    const innerRadius = radius * 0.4;
    
    // Create SVG
    const svg = d3.select(container)
        .append("svg")
        .attr("width", width)
        .attr("height", height);
    
    const g = svg.append("g")
        .attr("transform", `translate(${width/2},${height/2})`);
    
    // Simple pie chart data - just show the total available bankroll
    const pie = d3.pie()
        .value(d => d.value)
        .sort(null);
    
    // Simple data - just the total bankroll
    const data = [
        { name: "Total Bankroll", value: totalBankroll }
    ];
    
    const arcs = pie(data);
    
    // Create arc paths
    const arc = d3.arc()
        .innerRadius(innerRadius)
        .outerRadius(radius);
    
    // Add the donut segment
    g.selectAll("path")
        .data(arcs)
        .enter()
        .append("path")
        .attr("d", arc)
        .style("fill", "#28a745")
        .style("stroke", "#fff")
        .style("stroke-width", 2);
    
    // Add text in the center showing the total amount
    g.append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.35em")
        .attr("class", "h5")
        .style("fill", "#333")
        .style("font-weight", "bold")
        .text(`$${formatCurrency(totalBankroll)}`);
    
    // Update legend values
    document.getElementById('bankroll-available').textContent = `$${formatCurrency(availableBankroll)}`;
    document.getElementById('bankroll-in-use').textContent = `$${formatCurrency(usedBankroll)}`;
    document.getElementById('bankroll-total-display').textContent = `$${formatCurrency(totalBankroll)}`;
}

// Function to calculate and update bankroll
async function updateBankroll(statusFilter = null) {
    try {
        // Get date filters
        const startDate = document.getElementById('dashboard-start-date')?.value || null;
        const endDate = document.getElementById('dashboard-end-date')?.value || null;
        
        // Get account_id (default to Rule One account = 9)
        const accountId = 9;
        
        // Build URL with date parameters
        const params = new URLSearchParams();
        params.append('account_id', accountId);
        if (startDate) params.append('start_date', startDate);
        if (endDate) params.append('end_date', endDate);
        if (statusFilter) params.append('status_filter', statusFilter);
        
        // Calculate total deposits from accounts table
        const response = await fetch(`/api/bankroll-summary?${params}`);
        const data = await response.json();
        
        const totalBankroll = data.total_bankroll || 0;
        const usedBankroll = data.used_in_trades || 0;
        const availableBankroll = data.available || 0;
        const breakdown = data.breakdown || {};
        
        updateBankrollChart(totalBankroll, availableBankroll, usedBankroll, breakdown);
    } catch (error) {
        console.error('Error updating bankroll:', error);
    }
}

async function loadCostBasis(ticker = null) {
    console.log('loadCostBasis called with ticker:', ticker);
    try {
        // Cancel any pending cost basis request
        if (costBasisAbortController) {
            costBasisAbortController.abort();
        }
        costBasisAbortController = new AbortController();
        
        // Set window.symbolFilter to match the ticker parameter so updateCostBasisTable knows a ticker is selected
        if (ticker) {
            window.symbolFilter = ticker;
        } else {
            window.symbolFilter = '';
        }
        
        // Get account filter
        const accountFilter = document.getElementById('universal-account-filter')?.value || '';
        console.log('[DEBUG] loadCostBasis - accountFilter:', accountFilter, 'ticker:', ticker);
        
        const params = new URLSearchParams();
        if (accountFilter) {
            params.append('account_id', accountFilter);
            console.log('[DEBUG] loadCostBasis - adding account_id to params:', accountFilter);
        }
        if (ticker) params.append('ticker', ticker);
        params.append('commission', commission.toString());
        
        const response = await fetch(`/api/cost-basis?${params}`, {
            signal: costBasisAbortController.signal
        });
        const data = await response.json();
        console.log('Cost basis API response:', data);
        
        // Cache unfiltered cost basis data (when no ticker filter is applied)
        // Use structuredClone for better performance, fallback to JSON for compatibility
        if (!ticker) {
            try {
                cachedCostBasis = structuredClone ? structuredClone(data) : JSON.parse(JSON.stringify(data));
            } catch (e) {
                cachedCostBasis = JSON.parse(JSON.stringify(data)); // Fallback
            }
        }
        
        if (ticker) {
            // If a specific ticker is selected, show the detailed cost basis table
            if (data.length === 0) {
                console.log('No cost basis data found for ticker:', ticker);
                hideCostBasisTable();
            } else {
                console.log('Updating cost basis table with data for ticker:', ticker);
                updateCostBasisTable(data);
            }
        } else {
            // If no ticker is selected, show all available symbols
            // Check if we already have symbols displayed from trades data
            // If symbols are already showing, don't overwrite to avoid lag
            const costBasisContainer = document.getElementById('cost-basis-table-container');
            const alreadyShowingSymbols = costBasisContainer && costBasisContainer.querySelector('.symbol-card');
            
            // If symbols are already displayed, skip the API update to prevent lag
            // The immediate display from showAllSymbolsFromTrades is sufficient
            if (alreadyShowingSymbols) {
                console.log('Symbols already displayed, skipping API update to prevent lag');
                return; // Don't overwrite the immediate display
            }
            
            if (data.length === 0) {
                // If API returns no data, check if we have trades data to show symbols from
                if (trades && trades.length > 0) {
                    showAllSymbolsFromTrades();
                } else {
                    hideCostBasisTable();
                }
            } else {
                // Use API data which may have more complete information
                showAllSymbols(data);
            }
        }
    } catch (error) {
        // Ignore abort errors
        if (error.name === 'AbortError') {
            console.log('Cost basis request aborted');
            return;
        }
        console.error('Error loading cost basis:', error);
    }
}

// ============================================================================
// DATE EDITING FUNCTIONS
// ============================================================================

function formatDateForInput(dateString) {
    // Convert DD-MMM-YY format to YYYY-MM-DD for date input
    if (!dateString) return '';
    
    try {
        // Handle DD-MMM-YY format
        if (dateString.includes('-') && dateString.length === 8) {
            const parts = dateString.split('-');
            if (parts.length === 3) {
                const day = parts[0].padStart(2, '0');
                const month = parts[1];
                const year = '20' + parts[2]; // Convert YY to YYYY
                
                // Convert month name to number
                const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 
                                  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
                const monthNum = monthNames.indexOf(month.toUpperCase());
                if (monthNum !== -1) {
                    const monthStr = (monthNum + 1).toString().padStart(2, '0');
                    return `${year}-${monthStr}-${day}`;
                }
            }
        }
        
        // Handle MM/DD/YY format
        if (dateString.includes('/') && dateString.length === 8) {
            const parts = dateString.split('/');
            if (parts.length === 3) {
                const month = parts[0].padStart(2, '0');
                const day = parts[1].padStart(2, '0');
                const year = '20' + parts[2]; // Convert YY to YYYY
                return `${year}-${month}-${day}`;
            }
        }
        
        // Handle YYYY-MM-DD format (already correct)
        if (dateString.includes('-') && dateString.length === 10) {
            return dateString;
        }
        
        // Try to parse as Date and convert
        const date = new Date(dateString);
        if (!isNaN(date.getTime())) {
            return date.toISOString().split('T')[0];
        }
        
        return '';
    } catch (error) {
        console.error('Error formatting date for input:', error);
        return '';
    }
}

function parseDateInput(inputValue) {
    // Convert various input formats to YYYY-MM-DD
    if (!inputValue) return '';
    
    try {
        // Handle DD-MMM-YY format
        if (inputValue.includes('-') && inputValue.length === 8) {
            const parts = inputValue.split('-');
            if (parts.length === 3) {
                const day = parts[0].padStart(2, '0');
                const month = parts[1];
                const year = '20' + parts[2]; // Convert YY to YYYY
                
                // Convert month name to number
                const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 
                                  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
                const monthNum = monthNames.indexOf(month.toUpperCase());
                if (monthNum !== -1) {
                    const monthStr = (monthNum + 1).toString().padStart(2, '0');
                    return `${year}-${monthStr}-${day}`;
                }
            }
        }
        
        // Handle MM/DD/YY format
        if (inputValue.includes('/') && inputValue.length === 8) {
            const parts = inputValue.split('/');
            if (parts.length === 3) {
                const month = parts[0].padStart(2, '0');
                const day = parts[1].padStart(2, '0');
                const year = '20' + parts[2]; // Convert YY to YYYY
                return `${year}-${month}-${day}`;
            }
        }
        
        // Handle MM/DD format (assume current year)
        if (inputValue.includes('/') && inputValue.length <= 5) {
            const parts = inputValue.split('/');
            if (parts.length === 2) {
                const currentYear = new Date().getFullYear();
                const month = parts[0].padStart(2, '0');
                const day = parts[1].padStart(2, '0');
                return `${currentYear}-${month}-${day}`;
            }
        }
        
        // Handle YYYY-MM-DD format (already correct)
        if (inputValue.includes('-') && inputValue.length === 10) {
            return inputValue;
        }
        
        // Try to parse as Date and convert
        const date = new Date(inputValue);
        if (!isNaN(date.getTime())) {
            return date.toISOString().split('T')[0];
        }
        
        return inputValue; // Return as-is if can't parse
    } catch (error) {
        console.error('Error parsing date input:', error);
        return inputValue;
    }
}

async function updateTradeDate(tradeId, field, inputValue) {
    console.log('updateTradeDate called:', { tradeId, field, inputValue });
    
    // Parse the input value to YYYY-MM-DD format
    const parsedDate = parseDateInput(inputValue);
    console.log('Parsed date:', parsedDate);
    
    if (!parsedDate) {
        console.error('Invalid date format:', inputValue);
        return;
    }
    
    try {
        const response = await fetch(`/api/trades/${tradeId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: parsedDate })
        });
        
        const result = await response.json();
        console.log('Update response:', result);
        
        if (result.success) {
            // Reload trades to reflect the change
            await loadTrades();
            loadSummary();
            await loadCostBasis();
        } else {
            console.error('Failed to update trade date:', result.error);
        }
    } catch (error) {
        console.error('Error updating trade date:', error);
    }
}

function convertToUppercase(inputElement) {
    // Convert the input value to uppercase
    if (inputElement && inputElement.value) {
        inputElement.value = inputElement.value.toUpperCase();
    }
}

function handleNumberInputFocus(inputElement) {
    // Store the original value before clearing
    if (!inputElement.dataset.originalValue) {
        inputElement.dataset.originalValue = inputElement.value;
    }
    
    // Clear the input
    inputElement.value = '';
}

function handleNumberInputBlur(inputElement) {
    const currentValue = inputElement.value.trim();
    
    // If empty, restore the original value
    if (!currentValue) {
        inputElement.value = inputElement.dataset.originalValue || '';
        delete inputElement.dataset.originalValue;
        return;
    }
    
    // Clear the original value flag since we have a new value
    delete inputElement.dataset.originalValue;
}

function handleDateInputFocus(inputElement) {
    // Store the original value before clearing
    if (!inputElement.dataset.originalValue) {
        inputElement.dataset.originalValue = inputElement.value;
    }
    
    // Clear the input
    inputElement.value = '';
    inputElement.placeholder = 'MM/DD';
}

function handleDateInputBlur(inputElement) {
    const currentValue = inputElement.value.trim();
    
    // If empty, restore the original value
    if (!currentValue) {
        inputElement.value = inputElement.dataset.originalValue || '';
        inputElement.placeholder = 'DD-MMM-YY';
        delete inputElement.dataset.originalValue;
        return;
    }
    
    // Clear the original value flag since we have a new value
    delete inputElement.dataset.originalValue;
    
    // Parse MM/DD format (assume current year)
    if (currentValue.includes('/')) {
        const parts = currentValue.split('/');
        if (parts.length === 2) {
            const month = parts[0].padStart(2, '0');
            const day = parts[1].padStart(2, '0');
            const year = new Date().getFullYear().toString().slice(-2);
            
            // Convert to DD-MMM-YY for display
            const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 
                              'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
            const monthIndex = parseInt(month) - 1;
            if (monthIndex >= 0 && monthIndex < 12) {
                const monthName = monthNames[monthIndex];
                inputElement.value = `${day}-${monthName}-${year}`;
                inputElement.placeholder = 'DD-MMM-YY';
                return;
            }
        } else if (parts.length === 3) {
            // Handle MM/DD/YY format
            const month = parts[0];
            const day = parts[1];
            const year = parts[2];
            
            const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 
                              'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
            const monthIndex = parseInt(month) - 1;
            if (monthIndex >= 0 && monthIndex < 12) {
                const monthName = monthNames[monthIndex];
                inputElement.value = `${day}-${monthName}-${year}`;
                inputElement.placeholder = 'DD-MMM-YY';
                return;
            }
        }
    }
    
    // If value couldn't be parsed, restore original
    if (currentValue !== inputElement.dataset.originalValue) {
        inputElement.value = inputElement.dataset.originalValue || '';
    }
    inputElement.placeholder = 'DD-MMM-YY';
}

function getTodayInDDMMMYY() {
    const today = new Date();
    const day = today.getDate().toString().padStart(2, '0');
    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 
                      'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const month = monthNames[today.getMonth()];
    const year = today.getFullYear().toString().slice(-2);
    return `${day}-${month}-${year}`;
}

function handleDateInputBlurForRollField(inputElement, tradeId) {
    // First call the standard blur handler to format the date
    handleDateInputBlur(inputElement);
    
    // Then parse the formatted date and auto-save
    const formattedValue = inputElement.value;
    if (formattedValue) {
        // Parse DD-MMM-YY format to YYYY-MM-DD for database
        const parsedDate = parseDateInput(formattedValue);
        if (parsedDate) {
            // Get the field name from the input element
            const field = inputElement.dataset.field || 'expiration_date';
            
            // Auto-save the parsed date
            autoSaveTradeField(tradeId, field, parsedDate);
            
            // Update DTE cell if expiration_date or trade_date changed
            if (field === 'expiration_date') {
                updateDTECell(tradeId, parsedDate);
            } else if (field === 'trade_date') {
                // When trade_date changes, we need to recalculate DTE using the current expiration_date
                // The trade object in memory should already be updated with the new trade_date
                const trade = trades.find(t => t.id === tradeId);
                if (trade && trade.expiration_date) {
                    // Use the updated trade_date from memory (which was just updated)
                    updateDTECell(tradeId, trade.expiration_date);
                }
            }
        }
    }
}

function updateDTECell(tradeId, expirationDate) {
    // Find the trade in memory
    const trade = trades.find(t => t.id === tradeId);
    if (!trade) return;
    
    // Calculate new DTE
    const tradeDate = trade.trade_date;
    if (tradeDate && expirationDate) {
        const newDTE = calculateDaysToExpiration(expirationDate, tradeDate);
        
        // Update trade in memory
        trade.days_to_expiration = newDTE;
        trade.expiration_date = expirationDate;
        
        // The table is transposed: rows are fields, columns are trades
        // DTE is fieldIndex 6, so we need to find row index 6 (0-based)
        // Then find the column for this trade_id
        
        const tbody = document.getElementById('trades-table');
        if (!tbody) return;
        
        const rows = tbody.querySelectorAll('tr');
        if (rows.length <= 6) return; // DTE row doesn't exist
        
        // DTE row is at index 6 (fieldIndex 6)
        const dteRow = rows[6];
        if (!dteRow) return;
        
        // Find the column index for this trade
        // The first column (index 0) is the field name, so trade columns start at index 1
        // We need to find which column (td) corresponds to this trade_id
        let tradeColumnIndex = -1;
        
        // Look for an input with this trade_id in any row to find the column index
        for (let i = 0; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            // Skip the first cell (field name) and check data cells
            for (let j = 1; j < cells.length; j++) {
                const input = cells[j].querySelector(`input[data-trade-id="${tradeId}"]`);
                if (input) {
                    tradeColumnIndex = j; // j is already the correct index (includes field name column)
                    break;
                }
            }
            if (tradeColumnIndex !== -1) break;
        }
        
        if (tradeColumnIndex !== -1) {
            const cells = dteRow.querySelectorAll('td');
            if (cells[tradeColumnIndex]) {
                const dteCell = cells[tradeColumnIndex];
                const span = dteCell.querySelector('span.text-center');
                if (span) {
                    span.textContent = newDTE;
                } else {
                    dteCell.textContent = newDTE;
                }
            }
        }
    }
}


function getTodayInMMDDYY() {
    const today = new Date();
    const month = (today.getMonth() + 1).toString().padStart(2, '0');
    const day = today.getDate().toString().padStart(2, '0');
    const year = today.getFullYear().toString().slice(-2);
    return `${month}/${day}/${year}`;
}

// ============================================================================
// TABLE RENDERING FUNCTIONS
// ============================================================================

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
    
    // Apply status filter (case-insensitive)
    if (statusFilter) {
        filteredTrades = filteredTrades.filter(trade => trade.trade_status && trade.trade_status.toLowerCase() === statusFilter.toLowerCase());
    }
    
    // Apply symbol filter
    if (window.symbolFilter) {
        filteredTrades = filteredTrades.filter(trade => trade.ticker === window.symbolFilter);
    }
    
    // First, identify related trades using trade_parent_id BEFORE sorting
    // Trades are related if one has trade_parent_id pointing to the other
    // Handle chains of related trades: A -> B -> C -> D should all be grouped together
    const processedChildTrades = new Set();
    const parentTradeMap = new Map(); // Maps parent trade id to child trade
    const childToParentMap = new Map(); // Maps child trade id to parent trade id
    const tradeChainMap = new Map(); // Maps original trade id to array of all related trades in chain
    
    // Build chains of related trades
    // First, build parent-child relationships
    // Use a map that can store multiple children per parent (for chains)
    const parentToChildrenMap = new Map(); // Maps parent trade id to array of child trades
    
    filteredTrades.forEach(trade => {
        // If this trade has a parent, find the parent trade
        if (trade.trade_parent_id) {
            const parentTrade = filteredTrades.find(t => t.id === trade.trade_parent_id);
            if (parentTrade && !processedChildTrades.has(trade.id)) {
                // Store in parentTradeMap for backward compatibility (single child)
                parentTradeMap.set(parentTrade.id, trade);
                // Also store in parentToChildrenMap (multiple children)
                if (!parentToChildrenMap.has(parentTrade.id)) {
                    parentToChildrenMap.set(parentTrade.id, []);
                }
                parentToChildrenMap.get(parentTrade.id).push(trade);
                childToParentMap.set(trade.id, parentTrade.id);
                processedChildTrades.add(trade.id);
            }
        }
    });
    
    // Build chains: find all chains of related trades
    // A chain can start from any trade and follow its descendants
    // Reset processedChildTrades for chain building (we'll rebuild it)
    processedChildTrades.clear();
    
    // First, find all trades that are part of a chain (have a parent or have children)
    const tradesInChains = new Set();
    filteredTrades.forEach(trade => {
        if (trade.trade_parent_id || parentTradeMap.has(trade.id)) {
            tradesInChains.add(trade.id);
        }
    });
    
    // Build chains: find all chains of related trades
    // For each trade that has a parent, find the root of its chain and build the full chain
    filteredTrades.forEach(trade => {
        // Skip if already processed as part of another chain
        if (processedChildTrades.has(trade.id)) {
            return;
        }
        
        // Find the root trade (the one with no parent in this chain)
        // If this trade has no parent, it might be the root, or it might be an orphan
        let rootTrade = trade;
        const visited = new Set();
        
        // Walk up to find the root
        while (rootTrade.trade_parent_id) {
            if (visited.has(rootTrade.id)) {
                break; // Avoid infinite loops
            }
            visited.add(rootTrade.id);
            
            const parentTrade = filteredTrades.find(t => t.id === rootTrade.trade_parent_id);
            if (!parentTrade) {
                break; // Parent not found in filtered trades
            }
            rootTrade = parentTrade;
        }
        
        // Skip if root is already processed (part of another chain)
        if (processedChildTrades.has(rootTrade.id) && rootTrade.id !== trade.id) {
            return;
        }
        
        // Build chain starting from root trade
        const chain = [rootTrade];
        let currentTrade = rootTrade;
        const chainVisited = new Set([rootTrade.id]);
        
        // Follow the chain of child trades
        // Use parentToChildrenMap to get all children, then follow the chain
        while (parentToChildrenMap.has(currentTrade.id)) {
            const children = parentToChildrenMap.get(currentTrade.id);
            // For chains, we want the first child (chronologically by trade_date)
            // Sort children by trade_date to get the next in sequence
            const sortedChildren = children.sort((a, b) => {
                const aDate = new Date(a.trade_date || a.created_at);
                const bDate = new Date(b.trade_date || b.created_at);
                return aDate - bDate;
            });
            
            // Get the first child that hasn't been visited
            const childTrade = sortedChildren.find(child => !chainVisited.has(child.id));
            if (!childTrade) {
                break; // No more children to add
            }
            
            // Check if child trade is already in a chain (avoid duplicates)
            if (chainVisited.has(childTrade.id)) {
                break;
            }
            chain.push(childTrade);
            chainVisited.add(childTrade.id);
            currentTrade = childTrade;
        }
        
        // Also check if there are any trades that should be part of this chain
        // (e.g., trades that have the last trade in the chain as their parent)
        if (chain.length > 0) {
            const lastTradeInChain = chain[chain.length - 1];
            // Check if any other trades have this trade as their parent
            filteredTrades.forEach(t => {
                if (t.trade_parent_id === lastTradeInChain.id && !chainVisited.has(t.id)) {
                    chain.push(t);
                    chainVisited.add(t.id);
                }
            });
        }
        
        // Only store chains with more than one trade
        if (chain.length > 1) {
            // Use the first trade in the chain as the key
            tradeChainMap.set(chain[0].id, chain);
            console.log(`Built chain starting from trade ${chain[0].id} (${chain[0].ticker} ${chain[0].trade_date}):`, chain.map(t => `${t.id} (${t.trade_date})`).join(' -> '));
            // Mark all trades in the chain as processed (except the first)
            chain.slice(1).forEach(childTrade => {
                processedChildTrades.add(childTrade.id);
            });
        }
    });
    
    // Sort trades if sort column is specified
    // For child trades (with trade_parent_id), use their parent trade's date for sorting so they stay grouped
    if (sortColumn === 'trade_date') {
        filteredTrades.sort((a, b) => {
            // If either trade is a child trade, use its parent trade's date for sorting
            const aParentId = childToParentMap.get(a.id);
            const aTradeForSort = aParentId ? filteredTrades.find(t => t.id === aParentId) : a;
            const bParentId = childToParentMap.get(b.id);
            const bTradeForSort = bParentId ? filteredTrades.find(t => t.id === bParentId) : b;
            
            // Primary sort: trade_date (when trade was executed)
            const aTradeDate = new Date(aTradeForSort.trade_date || aTradeForSort.created_at);
            const bTradeDate = new Date(bTradeForSort.trade_date || bTradeForSort.created_at);
            
            // Secondary sort: ticker symbol (alphabetical)
            const aTicker = (aTradeForSort.ticker || '').toUpperCase();
            const bTicker = (bTradeForSort.ticker || '').toUpperCase();
            
            // Tertiary sort: account (Rule One first)
            const aAccountName = aTradeForSort.account_name || '';
            const bAccountName = bTradeForSort.account_name || '';
            const aAccountOrder = aAccountName === 'Rule One' ? 0 : 1;
            const bAccountOrder = bAccountName === 'Rule One' ? 0 : 1;
            
            if (sortDirection === 'asc') {
                // Ascending: oldest first
                if (aTradeDate.getTime() !== bTradeDate.getTime()) {
                    return aTradeDate - bTradeDate;
                } else {
                    // If same date, sort by ticker symbol (alphabetical)
                    if (aTicker !== bTicker) {
                        return aTicker.localeCompare(bTicker);
                    } else {
                        // If same ticker, sort by account (Rule One first)
                        if (aAccountOrder !== bAccountOrder) {
                            return aAccountOrder - bAccountOrder;
                        } else {
                            return aAccountName.localeCompare(bAccountName);
                        }
                    }
                }
            } else {
                // Descending: newest first
                if (aTradeDate.getTime() !== bTradeDate.getTime()) {
                    return bTradeDate - aTradeDate;
                } else {
                    // If same date, sort by ticker symbol (alphabetical)
                    if (aTicker !== bTicker) {
                        return aTicker.localeCompare(bTicker);
                    } else {
                        // If same ticker, sort by account (Rule One first)
                        if (aAccountOrder !== bAccountOrder) {
                            return aAccountOrder - bAccountOrder;
                        } else {
                            return aAccountName.localeCompare(bAccountName);
                        }
                    }
                }
            }
        });
    } else if (sortColumn) {
        // Handle other sort columns
        // For child trades (with trade_parent_id), use their parent trade for sorting
        filteredTrades.sort((a, b) => {
            // If either trade is a child trade, use its parent trade for sorting
            const aParentId = childToParentMap.get(a.id);
            const aTradeForSort = aParentId ? filteredTrades.find(t => t.id === aParentId) : a;
            const bParentId = childToParentMap.get(b.id);
            const bTradeForSort = bParentId ? filteredTrades.find(t => t.id === bParentId) : b;
            
            let aVal, bVal;
            
            if (sortColumn === 'expiration_date') {
                aVal = new Date(aTradeForSort.expiration_date);
                bVal = new Date(bTradeForSort.expiration_date);
            } else {
                aVal = aTradeForSort[sortColumn];
                bVal = bTradeForSort[sortColumn];
            }
            
            if (sortDirection === 'asc') {
                return aVal > bVal ? 1 : -1;
            } else {
                return aVal < bVal ? 1 : -1;
            }
        });
    } else {
        // Default sort: newest trades on the right (reverse chronological order)
        // For child trades (with trade_parent_id), use their parent trade for sorting
        filteredTrades.sort((a, b) => {
            // If either trade is a child trade, use its parent trade for sorting
            const aParentId = childToParentMap.get(a.id);
            const aTradeForSort = aParentId ? filteredTrades.find(t => t.id === aParentId) : a;
            const bParentId = childToParentMap.get(b.id);
            const bTradeForSort = bParentId ? filteredTrades.find(t => t.id === bParentId) : b;
            
            // Primary sort: created_at (when trade was added to system)
            const aCreated = new Date(aTradeForSort.created_at);
            const bCreated = new Date(bTradeForSort.created_at);
            
            // Secondary sort: trade_date (when trade was executed)
            const aTradeDate = new Date(aTradeForSort.trade_date || aTradeForSort.created_at);
            const bTradeDate = new Date(bTradeForSort.trade_date || bTradeForSort.created_at);
            
            // Sort oldest first (so newest appears rightmost in transposed table)
            if (aCreated.getTime() !== bCreated.getTime()) {
                return aCreated - bCreated;
            } else {
                return aTradeDate - bTradeDate;
            }
        });
    }
    
    console.log('Sorted trades (oldest to newest):', filteredTrades.map(t => `${t.ticker} ${t.trade_type} (${t.created_at})`));
    
    // Build grouped trades array: each entry is either a single trade, a chain, or [parent, child]
    // Related trades (via trade_parent_id) will stay grouped together regardless of sort order
    const groupedTrades = [];
    
    filteredTrades.forEach(trade => {
        // Skip child trades (they'll be added with their parent/chain)
        if (processedChildTrades.has(trade.id)) {
            return;
        }
        
        // Check if this trade is part of a chain (has multiple descendants)
        const chain = tradeChainMap.get(trade.id);
        if (chain && chain.length > 1) {
            // Add all trades in the chain together
            groupedTrades.push({ type: 'chain', trades: chain });
        } else {
            // Check if this trade has a child trade (via trade_parent_id) - single parent-child pair
            const childTrade = parentTradeMap.get(trade.id);
            if (childTrade) {
                // Add both parent and child trade together
                groupedTrades.push({ type: 'group', original: trade, roll: childTrade });
            } else {
                // Add single trade
                groupedTrades.push({ type: 'single', trade: trade });
            }
        }
    });
    
    // Always show all trades but mark filtered ones as hidden
    const allTrades = filteredTrades; // Use the sorted filteredTrades for backward compatibility
    const visibleTrades = filteredTrades;
    
    // Create transposed table structure - no header row
    const fieldNames = [
        '', // Empty for symbol/type row (no label)
        'Account', // Account row
        'Ticker', // Ticker row
        'Trade Date', // Trade Date row
        'Price', // Moved Trade Price to fourth row and renamed
        'Exp Date', // Moved Expiration to fifth row and renamed
        'DTE', // Moved Days to Exp to sixth row and renamed
        'Strike', // Moved Strike Price to seventh row and renamed
        'Credit', // Moved Premium to eighth row and renamed
        'Contracts', // New row - Contracts (num_of_contracts)
        'Shares', // Moved Shares to tenth row
        'Commission', // New row - Commission per trade
        'Net Credit Total', // Renamed from Net Credit - Net Credit Per Share * Shares
        'Risk Capital', // New row - Risk Capital = Strike - Net Credit Per Share
        'Margin Capital', // New row - Margin Capital = Risk Capital * Shares
        'RORC', // New row - RORC = Net Credit / Risk Capital
        'ARORC', // New row - ARORC = (365 / DTE) * RORC
        'Status',
        '' // Empty for actions row (no label)
    ];
    
    // Use document fragment for better performance
    const fragment = document.createDocumentFragment();
    
    // Create data rows (transposed) - no header row
    fieldNames.forEach((fieldName, fieldIndex) => {
        const row = document.createElement('tr');
        
        // Special handling for Trade Date row - make it sortable
        if (fieldIndex === 3 && fieldName === 'Trade Date') {
            const sortIcon = sortColumn === 'trade_date' 
                ? (sortDirection === 'asc' ? '<i class="fas fa-sort-up"></i>' : '<i class="fas fa-sort-down"></i>')
                : '<i class="fas fa-sort text-muted"></i>';
            row.innerHTML = `<td class="fw-bold" style="cursor: pointer;" onclick="toggleTradeDateSort()" title="Click to sort by trade date">
                ${fieldName} ${sortIcon}
            </td>`;
        } else {
            // Only show field name if it's not empty (skip first row label)
            row.innerHTML = fieldName ? `<td class="fw-bold">${fieldName}</td>` : '<td></td>';
        }
        
        // Apply fixed row height - 30px
        row.style.height = '30px';
        
        // Apply fixed column width for first column (field names) - 105px (reduced from 150px for condensed layout)
        const firstCell = row.querySelector('td');
        if (firstCell) {
            firstCell.style.width = '105px';
            firstCell.style.minWidth = '105px';
            firstCell.style.maxWidth = '105px';
            firstCell.style.textAlign = 'center';
            firstCell.style.whiteSpace = 'normal';
            firstCell.style.wordWrap = 'break-word';
            firstCell.style.verticalAlign = 'middle';
            // Force white background with !important
            firstCell.style.setProperty('background-color', '#ffffff', 'important');
            firstCell.style.setProperty('background', '#ffffff', 'important');
            // Force visible borders and high z-index to cover scrolling columns
            firstCell.style.setProperty('border-left', '1px solid #dee2e6', 'important');
            firstCell.style.setProperty('border-right', '2px solid #dee2e6', 'important');
            firstCell.style.setProperty('border-top', '1px solid #dee2e6', 'important');
            firstCell.style.setProperty('border-bottom', '1px solid #dee2e6', 'important');
            firstCell.style.setProperty('border-style', 'solid', 'important');
            firstCell.style.setProperty('position', 'sticky', 'important');
            firstCell.style.setProperty('left', '0', 'important');
            firstCell.style.setProperty('z-index', '100', 'important');
            firstCell.style.setProperty('isolation', 'isolate', 'important');
            firstCell.style.setProperty('overflow', 'visible', 'important');
            firstCell.classList.add('trades-first-column');
            
            // Create overlay element to cover scrolling columns
            // position: sticky works as a positioned ancestor for absolute children
            const overlay = document.createElement('div');
            overlay.style.position = 'absolute';
            overlay.style.top = '0';
            overlay.style.right = '-6px';
            overlay.style.bottom = '0';
            overlay.style.width = '6px';
            overlay.style.backgroundColor = '#ffffff';
            overlay.style.zIndex = '101';
            overlay.style.pointerEvents = 'none';
            firstCell.appendChild(overlay);
        }
        
        // Build cell HTML using array for better performance
        const cellHTMLs = [];
        
        // Add spacer column after the first column (field names) - make it sticky
        cellHTMLs.push(`<td class="sticky-spacer-column" style="width: 14px; min-width: 14px; max-width: 14px; padding: 0; background-color: #f5f7fa; border-left: 2px solid #dee2e6 !important; border-right: none !important; border-top: none !important; border-bottom: none !important; position: sticky; left: 105px; z-index: 9;"></td>`);
        
        // Create columns for grouped trades with spacers
        groupedTrades.forEach((group, groupIndex) => {
            // Add spacer before each group (except the first) with a visual separator
            if (groupIndex > 0) {
                // Add a visible border/divider in the spacer column to separate groups
                cellHTMLs.push(`<td style="width: 14px; min-width: 14px; max-width: 14px; padding: 0; background-color: #f5f7fa; border-left: 2px solid #dee2e6 !important; border-right: none !important; border-top: none !important; border-bottom: none !important;"></td>`);
            }
            
            // Render trades in this group
            // For grouped trades, sort by trade_date within the group
            let tradesToRender;
            if (group.type === 'chain') {
                // Chain of related trades: A -> B -> C -> D
                tradesToRender = group.trades;
                // Sort by trade_date within the chain
                tradesToRender.sort((a, b) => {
                    const aDate = new Date(a.trade_date || a.created_at);
                    const bDate = new Date(b.trade_date || b.created_at);
                    return aDate - bDate; // Oldest first
                });
            } else if (group.type === 'group') {
                tradesToRender = [group.original, group.roll];
                // Sort by trade_date within the group
                tradesToRender.sort((a, b) => {
                    const aDate = new Date(a.trade_date || a.created_at);
                    const bDate = new Date(b.trade_date || b.created_at);
                    return aDate - bDate;
                });
            } else {
                tradesToRender = [group.trade];
            }
            
            // Track if this is the first trade in a group to add left border
            let isFirstTradeInGroup = true;
            
            tradesToRender.forEach((trade) => {
            // Check if this trade should be visible based on filters
            const isVisible = visibleTrades.some(visibleTrade => visibleTrade.id === trade.id);
            const tradeType = trade.trade_type || 'ROCT PUT';
            const status = trade.trade_status || 'open';
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
            // Use commission_per_share from database (account-specific and trade-date-specific)
            const tradeCommission = trade.commission_per_share !== null && trade.commission_per_share !== undefined ? trade.commission_per_share : 0.0;
            const premium = trade.credit_debit || trade.premium;
            // Use net_credit_per_share from database if available, otherwise calculate
            const netCreditPerShare = trade.net_credit_per_share !== null && trade.net_credit_per_share !== undefined ? trade.net_credit_per_share : (premium - tradeCommission);
            const netCreditTotal = netCreditPerShare * (trade.num_of_contracts * 100); // Net Credit Total = Net Credit Per Share * Shares
            // Use risk_capital_per_share from database if available, otherwise calculate
            const riskCapital = trade.risk_capital_per_share !== null && trade.risk_capital_per_share !== undefined ? trade.risk_capital_per_share : (trade.strike_price - netCreditPerShare); // Risk Capital = Strike - Net Credit Per Share
            // Use margin_capital from database if available, otherwise calculate
            const marginCapital = trade.margin_capital !== null && trade.margin_capital !== undefined ? trade.margin_capital : (riskCapital * (trade.num_of_contracts * 100));
            const rorc = riskCapital !== 0 ? (netCreditPerShare / riskCapital) * 100 : 0; // RORC = Net Credit Per Share / Risk Capital
            // Calculate ARORC as percentage (already in percentage format, round to 1 decimal)
            const arorc = trade.days_to_expiration > 0 ? parseFloat(((365 / trade.days_to_expiration) * rorc).toFixed(1)) : 0;
            
            // Calculate today's date once for all cases
            const todayDate = new Date();
            const todayISO = todayDate.toISOString().split('T')[0];
            
            switch (fieldIndex) {
                case 0: // Symbol/Type (back to first row)
                    const expirationDate = new Date(trade.expiration_date);
                    const isExpired = trade.trade_status && trade.trade_status.toLowerCase() === 'open' && todayDate > expirationDate;
                    // Use type_name from trade_types table if available, otherwise use trade.ticker + tradeType
                    const displayType = trade.type_name ? `${trade.ticker} ${trade.type_name}` : `${trade.ticker} ${tradeType}`;
                    cellContent = `<div style="text-align: center; white-space: normal; word-wrap: break-word; vertical-align: top;"><strong>${isExpired ? '<i class="fas fa-exclamation-triangle text-danger me-1" title="Expired"></i>' : ''}<span class="clickable-symbol" onclick="filterBySymbol('${trade.ticker}')" style="cursor: pointer; color: #007bff; text-decoration: underline;">${displayType}</span></strong></div>`;
                    break;
                case 1: // Account - Read-only
                    const accountName = trade.account_name || 'Unknown';
                    cellContent = `<span class="text-center">${accountName}</span>`;
                    break;
                case 2: // Ticker - Editable for all trades
                    cellContent = `
                        <input type="text" 
                               class="form-control form-control-sm text-center" 
                               value="${trade.ticker || ''}" 
                               data-trade-id="${trade.id}" 
                               data-field="ticker" 
                               data-field-row="2"
                               onfocus="this.select()"
                               onkeydown="handleTabNavigation(event, ${trade.id}, 2)"
                               oninput="autoSaveTradeField(${trade.id}, 'ticker', this.value.toUpperCase())"
                               style="width: 70px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem; text-transform: uppercase;">
                    `;
                    break;
                case 3: // Trade Date - Editable for all trades
                    // Make editable with auto-save using DD-MMM-YY format like quick add modal
                    const tradeDateValue = trade.trade_date ? formatDate(trade.trade_date) : getTodayInDDMMMYY();
                    cellContent = `
                        <input type="text" 
                               class="form-control form-control-sm text-center no-ellipsis" 
                               value="${tradeDateValue}" 
                               placeholder="DD-MMM-YY"
                               data-display-format="DD-MMM-YY"
                               data-edit-format="MM/DD/YY"
                               data-trade-id="${trade.id}" 
                               data-field="trade_date" 
                               data-field-row="3"
                               onfocus="handleDateInputFocus(this)" 
                               onkeydown="handleTabNavigation(event, ${trade.id}, 3)"
                               onblur="handleDateInputBlurForRollField(this, ${trade.id})"
                               style="width: 100px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem; text-overflow: clip !important; overflow: visible !important; white-space: normal !important;">
                    `;
                    break;
                case 4: // Price - Editable for all trades
                    // Make editable with auto-save for all trades
                    cellContent = `
                        <div style="position: relative; display: flex; align-items: center; justify-content: center;">
                            <span style="position: absolute; left: 0; top: 50%; transform: translateY(-50%); font-size: 0.6125rem;">$</span>
                            <input type="number" 
                                   class="form-control form-control-sm text-center" 
                                   value="${parseFloat(trade.current_price || trade.price || 0).toFixed(2)}" 
                                   step="0.01"
                                   min="0"
                                   data-trade-id="${trade.id}" 
                                   data-field="current_price" 
                                   data-field-row="4"
                                   onfocus="this.select()"
                                   onkeydown="handleTabNavigation(event, ${trade.id}, 4)"
                                   oninput="limitToTwoDecimals(this); autoSaveTradeField(${trade.id}, 'current_price', this.value)"
                                   style="width: 70px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem;">
                        </div>
                    `;
                    break;
                case 5: // Exp Date - Editable for all trades
                    // Make editable with auto-save using DD-MMM-YY format like quick add modal
                    const expDateValue = trade.expiration_date ? formatDate(trade.expiration_date) : getTodayInDDMMMYY();
                    cellContent = `
                        <input type="text" 
                               class="form-control form-control-sm text-center no-ellipsis" 
                               value="${expDateValue}" 
                               placeholder="DD-MMM-YY"
                               data-display-format="DD-MMM-YY"
                               data-edit-format="MM/DD/YY"
                               data-trade-id="${trade.id}" 
                               data-field="expiration_date" 
                               data-field-row="5"
                               onfocus="handleDateInputFocus(this)" 
                               onkeydown="handleTabNavigation(event, ${trade.id}, 5)"
                               onblur="handleDateInputBlurForRollField(this, ${trade.id})"
                               style="width: 100px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem; text-overflow: clip !important; overflow: visible !important; white-space: normal !important;">
                    `;
                    break;
                case 6: // DTE (was Days to Exp) - Read-only (calculated)
                    cellContent = `<span class="text-center">${trade.days_to_expiration || calculateDaysToExpiration(trade.expiration_date, trade.trade_date)}</span>`;
                    break;
                case 7: // Strike - Editable for all trades
                    // Make editable with auto-save for all trades
                    cellContent = `
                        <div style="position: relative; display: flex; align-items: center; justify-content: center;">
                            <span style="position: absolute; left: 0; top: 50%; transform: translateY(-50%); font-size: 0.6125rem;">$</span>
                            <input type="number" 
                                   class="form-control form-control-sm text-center" 
                                   value="${parseFloat(trade.strike_price || 0).toFixed(2)}" 
                                   step="0.01"
                                   min="0"
                                   data-trade-id="${trade.id}" 
                                   data-field="strike_price" 
                                   data-field-row="7"
                                   onfocus="this.select()"
                                   onkeydown="handleTabNavigation(event, ${trade.id}, 7)"
                                   oninput="limitToTwoDecimals(this); autoSaveTradeField(${trade.id}, 'strike_price', this.value)"
                                   style="width: 70px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem;">
                        </div>
                    `;
                    break;
                case 8: // Credit - Editable for all trades
                    // Make editable with auto-save for all trades
                    cellContent = `
                        <div style="position: relative; display: flex; align-items: center; justify-content: center;">
                            <span style="position: absolute; left: 0; top: 50%; transform: translateY(-50%); font-size: 0.6125rem;">$</span>
                            <input type="number" 
                                   class="form-control form-control-sm text-center" 
                                   value="${parseFloat(trade.credit_debit || trade.premium || 0).toFixed(2)}" 
                                   step="0.01"
                                   data-trade-id="${trade.id}" 
                                   data-field="credit_debit" 
                                   data-field-row="8"
                                   onfocus="this.select()"
                                   onkeydown="handleTabNavigation(event, ${trade.id}, 8)"
                                   oninput="limitToTwoDecimals(this); autoSaveTradeField(${trade.id}, 'credit_debit', this.value)"
                                   style="width: 70px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem;">
                        </div>
                    `;
                    break;
                case 9: // Contracts - Editable for all trades
                    // Make editable with auto-save for all trades
                    cellContent = `
                        <input type="number" 
                               class="form-control form-control-sm text-center" 
                               value="${trade.num_of_contracts}" 
                               step="1"
                               min="1"
                               data-trade-id="${trade.id}" 
                               data-field="num_of_contracts" 
                               data-field-row="9"
                               onfocus="this.select()"
                               onkeydown="handleTabNavigation(event, ${trade.id}, 9)"
                               oninput="autoSaveTradeField(${trade.id}, 'num_of_contracts', this.value)"
                               style="width: 60px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem;">
                    `;
                    break;
                case 10: // Shares - Read-only (calculated from num_of_contracts)
                    cellContent = `<span class="text-center">${trade.num_of_contracts * 100}</span>`;
                    break;
                case 11: // Commission - Use commission_per_share from database (account-specific and trade-date-specific)
                    const tradeCommission = trade.commission_per_share !== null && trade.commission_per_share !== undefined ? trade.commission_per_share : 0.0;
                    cellContent = `<span class="text-center">$${tradeCommission.toLocaleString('en-US', {minimumFractionDigits: 5, maximumFractionDigits: 5})}</span>`;
                    break;
                case 12: // Net Credit Total = Net Credit Per Share * Shares
                    cellContent = `<strong class="text-center">$${netCreditTotal.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong>`;
                    break;
                case 13: // Risk Capital = Strike - Net Credit Per Share
                    cellContent = `<span class="text-center">$${riskCapital.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>`;
                    break;
                case 14: // Margin Capital = Risk Capital * Shares
                    cellContent = `<span class="text-center">$${marginCapital.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>`;
                    break;
                case 15: // RORC = Net Credit Per Share / Risk Capital
                    cellContent = `<span class="text-center">${rorc.toFixed(2)}%</span>`;
                    break;
                case 16: // ARORC - Use database value if available, otherwise calculate
                    // Database stores ARORC as percentage (20.4 = 20.4%), display directly
                    const dbARORC = trade.ARORC !== null && trade.ARORC !== undefined ? trade.ARORC : arorc;
                    if (dbARORC !== null && dbARORC !== undefined && !isNaN(dbARORC)) {
                        // ARORC is stored as percentage (e.g., 20.4 for 20.4%), display directly
                        cellContent = `<span class="text-center">${parseFloat(dbARORC).toFixed(1)}%</span>`;
                    } else {
                        cellContent = `<span class="text-center">-</span>`;
                    }
                    break;
                case 17: // Status - Editable dropdown (case-insensitive)
                    const tradeStatusLower = trade.trade_status ? trade.trade_status.toLowerCase() : 'open';
                    cellContent = `
                        <select class="form-select form-select-sm status-select" data-trade-id="${trade.id}" onchange="updateTradeStatus(${trade.id}, this.value)" style="font-size: 0.6125rem; padding: 0.1rem 0.25rem; width: 100%; height: auto; line-height: 1.1; text-align: center; text-align-last: center;">
                            <option value="assigned" ${tradeStatusLower === 'assigned' ? 'selected' : ''}>Assigned</option>
                            <option value="closed" ${tradeStatusLower === 'closed' ? 'selected' : ''}>Closed</option>
                            <option value="expired" ${tradeStatusLower === 'expired' ? 'selected' : ''}>Expired</option>
                            <option value="open" ${tradeStatusLower === 'open' ? 'selected' : ''}>Open</option>
                            <option value="roll" ${tradeStatusLower === 'roll' ? 'selected' : ''}>Roll</option>
                        </select>
                    `;
                    break;
                case 18: // Actions - Delete only
                    cellContent = `
                        <div class="text-center">
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
            
            // Apply fixed column width to data cells - 112px (reduced from 160px for condensed layout) with visibility control
            const visibilityStyle = isVisible ? '' : 'display: none;';
            // Top align for Symbol/Type column (fieldIndex 0), middle align for dates (1, 3), center for status (16)
            let verticalAlign = '';
            let textAlign = '';
            if (fieldIndex === 0) {
                verticalAlign = 'vertical-align: top;';
            } else if (fieldIndex === 1 || fieldIndex === 3) {
                verticalAlign = 'vertical-align: middle;';
            } else if (fieldIndex === 17) {
                // Status column - center align
                textAlign = 'text-align: center;';
                verticalAlign = 'vertical-align: middle;';
            }
            
            // Add left border to first trade in each group to visually separate groups
            const leftBorderStyle = isFirstTradeInGroup && groupIndex > 0 ? 'border-left: 2px solid #dee2e6 !important;' : '';
            
            cellHTMLs.push(`<td style="${bgColor}; width: 112px; min-width: 112px; max-width: 112px; ${visibilityStyle} ${verticalAlign} ${textAlign} ${leftBorderStyle}">${cellContent}</td>`);
            
            isFirstTradeInGroup = false;
            });
        });
        
        // Set all cells at once for better performance
        row.innerHTML += cellHTMLs.join('');
        fragment.appendChild(row);
    });
    
    // Append all rows at once for better performance
    tbody.appendChild(fragment);
    
    console.log('Trades table update completed. Rows:', tbody.children.length);
    
    // Set table width based on total columns (fixed width)
    setTableWidth();
}

function toggleTradeDateSort() {
    // Toggle sort direction
    if (sortColumn === 'trade_date') {
        // If already sorting by trade_date, toggle direction
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        // If not sorting by trade_date, set to trade_date with default desc
        sortColumn = 'trade_date';
        sortDirection = 'desc';
    }
    
    // Re-render the table with new sort
    updateTradesTable();
}

function setTableWidth() {
    const table = document.getElementById('trades-table-main');
    if (!table) return;
    
    const allRows = table.querySelectorAll('tbody tr');
    if (allRows.length === 0) return;
    
    // Count ALL columns (excluding the first field name column)
    // Use the first row to count total columns, regardless of visibility
    const firstRow = allRows[0];
    const cells = firstRow.querySelectorAll('td');
    const totalColumns = cells.length - 1; // Subtract 1 for the field name column
    
    // Calculate total width: 105px (field column) + (total columns × 112px) - reduced for condensed layout
    const totalWidth = 105 + (totalColumns * 112);
    
    // Set both width and min-width to prevent stretching
    table.style.width = `${totalWidth}px`;
    table.style.minWidth = `${totalWidth}px`;
    table.style.maxWidth = `${totalWidth}px`;
}

function updateCostBasisTable(costBasisData) {
    const container = document.getElementById('cost-basis-table-container');
    const inlineContainer = document.getElementById('cost-basis-inline-container');
    
    const targetContainers = [container, inlineContainer].filter(c => c !== null);
    
    if (!costBasisData || costBasisData.length === 0) {
        targetContainers.forEach(c => {
            c.innerHTML = `
                <div class="text-center text-muted">
                    <i class="fas fa-info-circle me-2"></i>
                    No cost basis data available for the selected stock symbol.
                </div>
            `;
        });
        return;
    }
    
    let html = '';
    
    // Check if a ticker is selected by checking window.symbolFilter
    const isTickerSelected = window.symbolFilter && window.symbolFilter.trim() !== '';
    
    // Sort cost basis data based on whether ticker is selected
    const sortedCostBasisData = [...costBasisData].sort((a, b) => {
        const aIsRuleOne = a.account_id === 9;
        const bIsRuleOne = b.account_id === 9;
        
        // Rule One account always comes first
        if (aIsRuleOne && !bIsRuleOne) return -1;
        if (!aIsRuleOne && bIsRuleOne) return 1;
        
        if (!isTickerSelected) {
            // When no ticker is selected, sort by ticker alphabetically
            const tickerA = (a.ticker || '').toUpperCase();
            const tickerB = (b.ticker || '').toUpperCase();
            return tickerA.localeCompare(tickerB);
        } else {
            // When ticker is selected, keep original order (already sorted by backend with Rule One first)
            return 0;
        }
    });
    
    for (const tickerData of sortedCostBasisData) {
        const { ticker, company_name, account_id, account_name, total_shares, total_cost_basis, total_cost_basis_per_share, trades } = tickerData;
        const accountDisplay = account_name ? ` (${account_name})` : '';
        
        if (!isTickerSelected) {
            // Original layout when no ticker is selected
            html += `
            <div class="mb-4">
                <!-- Ticker and Summary Cards in one row when no ticker selected -->
                <div class="row mb-2 g-2 align-items-center">
                    <div style="flex: 0 0 42px !important; width: 42px !important; min-width: 42px !important; max-width: 42px !important;">
                        <div class="card bg-light cost-basis-ticker-card" style="cursor: pointer; width: 42px !important; height: 56px !important; min-width: 42px !important; max-width: 42px !important; overflow: hidden !important; box-sizing: border-box !important;" onclick="setUniversalTickerFilter('${ticker}')" title="Click to filter trades and cost basis by ${ticker}" onmouseover="this.style.backgroundColor='#e9ecef'" onmouseout="this.style.backgroundColor='#f8f9fa'">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; overflow: hidden; box-sizing: border-box; padding: 0.35rem !important;">
                                <h6 class="text-primary mb-0" style="font-size: 0.6125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0; padding: 0; width: 100%; display: block;">
                                    ${ticker}
                                </h6>
                            </div>
                        </div>
                    </div>
                    <div style="flex: 0 0 42px !important; width: 42px !important; min-width: 42px !important; max-width: 42px !important;">
                        <div class="card bg-light" style="width: 42px !important; height: 56px !important; min-width: 42px !important; max-width: 42px !important; box-sizing: border-box !important;">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; overflow: hidden; box-sizing: border-box; padding: 0.35rem !important;">
                                <h6 class="card-title mb-1" style="font-size: 0.525rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Total Shares</h6>
                                <p class="card-text mb-0" style="font-size: 0.77rem; ${total_shares < 0 ? 'color: red;' : ''}">${total_shares < 0 ? `(${Math.abs(total_shares).toLocaleString()})` : total_shares.toLocaleString()}</p>
                            </div>
                        </div>
                    </div>
                    <div style="flex: 0 0 42px !important; width: 42px !important; min-width: 42px !important; max-width: 42px !important;">
                        <div class="card bg-light" style="width: 42px !important; height: 56px !important; min-width: 42px !important; max-width: 42px !important; box-sizing: border-box !important;">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; overflow: hidden; box-sizing: border-box; padding: 0.35rem !important;">
                                <h6 class="card-title mb-1" style="font-size: 0.525rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Total Cost Basis</h6>
                                <p class="card-text mb-0" style="font-size: 0.77rem; ${total_cost_basis < 0 ? 'color: red;' : ''}">${total_cost_basis < 0 ? `($${Math.abs(total_cost_basis).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})})` : `$${total_cost_basis.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</p>
                            </div>
                        </div>
                    </div>
                    <div style="flex: 0 0 42px !important; width: 42px !important; min-width: 42px !important; max-width: 42px !important;">
                        <div class="card bg-light" style="width: 42px !important; height: 56px !important; min-width: 42px !important; max-width: 42px !important; box-sizing: border-box !important;">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; overflow: hidden; box-sizing: border-box; padding: 0.35rem !important;">
                                <h6 class="card-title mb-1" style="font-size: 0.525rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Cost Basis/Share</h6>
                                <p class="card-text mb-0" style="font-size: 0.77rem; ${total_cost_basis_per_share < 0 ? 'color: red;' : ''}">${total_cost_basis_per_share < 0 ? `($${Math.abs(total_cost_basis_per_share).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})})` : `$${total_cost_basis_per_share.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</p>
                            </div>
                        </div>
                    </div>
                    <div style="flex: 0 0 42px !important; width: 42px !important; min-width: 42px !important; max-width: 42px !important;">
                        <div class="card bg-light" style="width: 42px !important; height: 56px !important; min-width: 42px !important; max-width: 42px !important; box-sizing: border-box !important;">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; overflow: hidden; box-sizing: border-box; padding: 0.35rem !important;">
                                <h6 class="card-title mb-1" style="font-size: 0.525rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Total Trades</h6>
                                <p class="card-text mb-0" style="font-size: 0.77rem;">${trades.length}</p>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        } else {
            // When ticker is selected, show header card and summary cards for each account
            html += `
            <div class="mb-4">
                <!-- First row: Ticker and Company Name card when ticker is selected -->
                <div class="row mb-2 g-2 align-items-center">
                    <div class="col-12">
                        <div class="card bg-light" style="height: 56px;">
                            <div class="card-body d-flex align-items-center justify-content-center" style="padding: 0.35rem !important;">
                                <h6 class="mb-0 text-center" style="font-size: 0.49rem; font-weight: 600;">
                                    ${ticker} - ${company_name || ticker}${accountDisplay}
                                </h6>
                            </div>
                        </div>
                    </div>
                </div>
                <!-- Summary Cards in second row - showing totals for this account -->
                <div class="row mb-2 g-2 align-items-center">
                    <div class="col-md-4 col-sm-4 col-12">
                        <div class="card bg-light" style="height: 56px;">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; padding: 0.35rem !important;">
                                <h6 class="card-title mb-1" style="font-size: 0.525rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Total Shares</h6>
                                <p class="card-text mb-0" style="font-size: 0.77rem; ${total_shares < 0 ? 'color: red;' : ''}">${total_shares < 0 ? `(${Math.abs(total_shares).toLocaleString()})` : total_shares.toLocaleString()}</p>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-4 col-sm-4 col-12">
                        <div class="card bg-light" style="height: 56px;">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; padding: 0.35rem !important;">
                                <h6 class="card-title mb-1" style="font-size: 0.525rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Total Cost Basis</h6>
                                <p class="card-text mb-0" style="font-size: 0.77rem; ${total_cost_basis < 0 ? 'color: red;' : ''}">${total_cost_basis < 0 ? `($${Math.abs(total_cost_basis).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})})` : `$${total_cost_basis.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</p>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-4 col-sm-4 col-12">
                        <div class="card bg-light" style="height: 56px;">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; padding: 0.35rem !important;">
                                <h6 class="card-title mb-1" style="font-size: 0.525rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Cost Basis/Share</h6>
                                <p class="card-text mb-0" style="font-size: 0.77rem; ${total_cost_basis_per_share < 0 ? 'color: red;' : ''}">${total_cost_basis_per_share < 0 ? `($${Math.abs(total_cost_basis_per_share).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})})` : `$${total_cost_basis_per_share.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</p>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }
        
        // Render transactions table for each ticker data entry (each account separately)
        const tableTrades = trades;
        html += `
                
                <!-- Transactions Table -->
                <div class="table-responsive">
                    <table class="table table-sm table-striped">
                        <thead class="table-dark">
                            <tr>
                                <th class="text-center align-middle" style="width: 8%;">Trade Date</th>
                                <th class="text-start align-middle" style="width: 25%;">Trade Description</th>
                                <th class="text-end align-middle">Shares</th>
                                <th class="text-end align-middle">Cost</th>
                                <th class="text-end align-middle">Amount</th>
                                <th class="text-end align-middle">Basis</th>
                                <th class="text-end align-middle">Basis/Share</th>
                            </tr>
                        </thead>
                        <tbody>
            `;
            
            // Add each trade as a row
            tableTrades.forEach(trade => {
                // Format numbers with parentheses for negative values
                const formatNumber = (value, isCurrency = false) => {
                    if (value === null || value === undefined) return '';
                    if (value === 0) return '0'; // Special case for zero values
                    const formatted = value.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
                    if (value < 0) {
                        return `($${formatted.replace('-', '')})`;
                    }
                    return `$${formatted}`;
                };
                
                const formatShares = (value) => {
                    if (value === null || value === undefined) return '0';
                    if (value === 0) return '0'; // Special case for zero values
                    const formatted = value.toLocaleString();
                    if (value < 0) {
                        return `(${formatted.replace('-', '')})`;
                    }
                    return formatted;
                };
                
                // Determine if value is zero for styling
                const isSharesZero = trade.shares === 0 || trade.shares === null || trade.shares === undefined;
                const isCostZero = trade.cost_per_share === 0 || trade.cost_per_share === null || trade.cost_per_share === undefined;
                const isAmountZero = trade.amount === 0 || trade.amount === null || trade.amount === undefined;
                const isBasisZero = trade.running_basis === 0 || trade.running_basis === null || trade.running_basis === undefined;
                const isBasisPerShareZero = trade.running_basis_per_share === 0 || trade.running_basis_per_share === null || trade.running_basis_per_share === undefined;
                
                const sharesClass = trade.shares < 0 ? 'text-danger' : '';
                const runningBasisClass = trade.running_basis < 0 ? 'text-danger' : '';
                const runningBasisPerShareClass = trade.running_basis_per_share < 0 ? 'text-danger' : '';
                const costClass = trade.cost_per_share < 0 ? 'text-danger' : '';
                const amountClass = trade.amount < 0 ? 'text-danger' : '';
                
                // Apply same color coding as trades table based on trade_status and trade_type
                const tradeType = trade.trade_type || trade.trade_description || 'ROCT PUT';
                const status = trade.trade_status || 'open';
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
                        <td class="text-center align-middle" style="white-space: nowrap; padding: 0.35rem 0.525rem;">${formatDate(trade.trade_date)}</td>
                        <td class="text-start align-middle" style="width: 25%; word-wrap: break-word; overflow-wrap: break-word; padding: 0.35rem 0.525rem;">${trade.trade_description || ''}</td>
                        <td class="text-end align-middle ${sharesClass}" style="${isSharesZero ? 'color: transparent;' : ''}">${formatShares(trade.shares || 0)}</td>
                        <td class="text-end align-middle ${costClass}" style="${isCostZero ? 'color: transparent;' : ''}">${formatNumber(trade.cost_per_share || 0)}</td>
                        <td class="text-end align-middle ${amountClass}" style="${isAmountZero ? 'color: transparent;' : ''}">${formatNumber(trade.amount || 0)}</td>
                        <td class="text-end align-middle ${runningBasisClass}">${formatNumber(trade.running_basis)}</td>
                        <td class="text-end align-middle ${runningBasisPerShareClass}">${formatNumber(trade.running_basis_per_share)}</td>
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
    
    // Set HTML for both containers
    targetContainers.forEach(c => {
        c.innerHTML = html;
    });
    
    // Set dynamic height to show exactly 10 rows after table is rendered
    // Use multiple timeouts to ensure DOM is fully rendered with dynamic row heights
    setTimeout(() => {
        setCostBasisTableHeight();
        // Recalculate after a short delay to account for any dynamic content rendering
        setTimeout(() => {
            setCostBasisTableHeight();
        }, 50);
    }, 0);
}

// Function to dynamically set cost basis table height to show 10 rows
function setCostBasisTableHeight() {
    const containers = [
        document.getElementById('cost-basis-table-container'),
        document.getElementById('cost-basis-inline-container')
    ].filter(c => c !== null);
    
    containers.forEach(container => {
        // Handle multiple tables in the container (one per ticker/account)
        const tableResponsives = container.querySelectorAll('.table-responsive');
        
        tableResponsives.forEach(tableResponsive => {
            const table = tableResponsive.querySelector('.table');
            if (!table) return;
            
            const thead = table.querySelector('thead');
            const tbody = table.querySelector('tbody');
            if (!thead || !tbody) return;
            
            // Get header height
            const headerHeight = thead.offsetHeight;
            
            // Get all rows
            const rows = Array.from(tbody.querySelectorAll('tr'));
            
            // If there are 10 or fewer rows, show all without scrolling
            if (rows.length <= 10) {
                tableResponsive.style.maxHeight = 'none';
                tableResponsive.style.overflowY = 'visible';
                return;
            }
            
            // Get first 10 rows to measure
            const rowsToMeasure = rows.slice(0, 10);
            
            if (rowsToMeasure.length === 0) return;
            
            // Calculate total height of first 10 rows
            // Use getBoundingClientRect for more accurate height measurement with dynamic row heights
            let totalRowsHeight = 0;
            rowsToMeasure.forEach(row => {
                const rect = row.getBoundingClientRect();
                totalRowsHeight += rect.height;
            });
            
            // Get header height using getBoundingClientRect for accuracy
            const headerRect = thead.getBoundingClientRect();
            
            // Set max-height to header height + height of 10 rows
            // Add a small buffer to account for any rounding or borders
            const maxHeight = headerRect.height + totalRowsHeight + 1;
            tableResponsive.style.maxHeight = `${maxHeight}px`;
            tableResponsive.style.overflowY = 'auto';
        });
    });
}

// ============================================================================
// SYMBOL FILTERING FUNCTIONS
// ============================================================================

function filterBySymbol(symbol) {
    // Use the universal ticker filter instead of the old separate filters
    setUniversalTickerFilter(symbol);
    
    // Scroll to cost basis table
    setTimeout(() => {
        const costBasisElement = document.getElementById('cost-basis-summary');
        if (costBasisElement) {
            costBasisElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, 500); // Wait for cost basis to load
}

function selectSymbol(symbol) {
    filterBySymbol(symbol);
}

function selectCostBasisSymbol(symbol) {
    // Use the universal ticker filter instead of the old separate filters
    setUniversalTickerFilter(symbol);
    
    // Scroll to cost basis table
    setTimeout(() => {
        const costBasisElement = document.getElementById('cost-basis-summary');
        if (costBasisElement) {
            costBasisElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }, 500); // Wait for cost basis to load
}

function clearSymbolFilter() {
    window.symbolFilter = '';
    selectedTicker = null;
    
    // Clear trades table symbol filter
    const symbolFilterInput = document.getElementById('symbol-filter');
    const clearButton = document.getElementById('clear-symbol');
    const jumpToCostBasisBtn = document.getElementById('jump-to-cost-basis');
    
    if (symbolFilterInput) {
        symbolFilterInput.value = '';
    }
    
    if (clearButton) {
        clearButton.style.display = 'none';
    }
    
    // Arrow buttons should always be visible, just update their positions
    updateArrowPositions();
    
    // Clear cost basis symbol filter
    const costBasisSymbolFilter = document.getElementById('cost-basis-symbol-filter');
    const costBasisClearButton = document.getElementById('clear-cost-basis-symbol');
    
    if (costBasisSymbolFilter) {
        costBasisSymbolFilter.value = '';
    }
    
    if (costBasisClearButton) {
        costBasisClearButton.style.display = 'none';
    }
    
    // Update both tables - use optimized function to avoid API call
    updateTradesTable();
    showAllSymbolsFromTrades(); // Show symbols instantly without API call
}

function clearCostBasisSymbolFilter() {
    selectedTicker = null;
    
    // Clear trades table symbol filter
    window.symbolFilter = '';
    const symbolFilterInput = document.getElementById('symbol-filter');
    const clearButton = document.getElementById('clear-symbol');
    
    if (symbolFilterInput) {
        symbolFilterInput.value = '';
    }
    
    if (clearButton) {
        clearButton.style.display = 'none';
    }
    
    // Clear cost basis symbol filter
    const costBasisSymbolFilter = document.getElementById('cost-basis-symbol-filter');
    const costBasisClearButton = document.getElementById('clear-cost-basis-symbol');
    const jumpToTradesBtn = document.getElementById('jump-to-trades');
    
    if (costBasisSymbolFilter) {
        costBasisSymbolFilter.value = '';
    }
    
    if (costBasisClearButton) {
        costBasisClearButton.style.display = 'none';
    }
    
    // Arrow buttons should always be visible, just update their positions
    updateArrowPositions();
    
    // Update both tables - use optimized function to avoid API call
    // Run updates in parallel to reduce delay
    Promise.all([
        updateTradesTable(),
        showAllSymbolsFromTrades() // Show symbols instantly without API call
    ]).catch(error => {
        console.error('Error updating tables after clearing cost basis symbol filter:', error);
    });
}

function showAllSymbols(data = null) {
    const costBasisContainer = document.getElementById('cost-basis-table-container');
    const inlineContainer = document.getElementById('cost-basis-inline-container');
    
    const targetContainers = [costBasisContainer, inlineContainer].filter(c => c !== null);
    if (targetContainers.length === 0) return;
    
    // Get all unique tickers from cost basis data if provided, otherwise from trades data
    let allTickers = [];
    if (data && data.length > 0) {
        // Use cost basis data to get unique tickers
        allTickers = [...new Set(data.map(entry => entry.ticker))].filter(ticker => ticker && ticker.trim() !== '').sort();
    } else if (trades && trades.length > 0) {
        // Fallback to trades data if cost basis data is not available
        allTickers = [...new Set(trades.map(trade => trade.ticker))].filter(ticker => ticker && ticker.trim() !== '').sort();
    }
    
    if (allTickers.length === 0) {
        targetContainers.forEach(c => {
            c.innerHTML = `
                <div class="text-center text-muted">
                    <i class="fas fa-info-circle me-2"></i>
                    No trades found. Add some trades to see symbols here.
                </div>
            `;
        });
        return;
    }
    
    // If data is provided, use it to count entries (optional optimization)
    const costBasisGroups = {};
    if (data && data.length > 0) {
        data.forEach(entry => {
            if (!costBasisGroups[entry.ticker]) {
                costBasisGroups[entry.ticker] = {
                    ticker: entry.ticker,
                    company_name: entry.company_name,
                    count: 0
                };
            }
            costBasisGroups[entry.ticker].count++;
        });
    }
    
    let symbolsHtml = '<div class="row">';
    allTickers.forEach(ticker => {
        symbolsHtml += `
            <div class="col-auto mb-2">
                <div class="card symbol-card" onclick="selectCostBasisSymbol('${ticker}')" style="cursor: pointer; min-width: fit-content;">
                    <div class="card-body text-center d-flex align-items-center justify-content-center" style="padding: 0.35rem !important;">
                        <h6 class="card-title text-primary mb-0" style="font-size: 0.56rem; white-space: nowrap; margin: 0;">${ticker}</h6>
                    </div>
                </div>
            </div>
        `;
    });
    symbolsHtml += '</div>';
    
    // Set HTML for both containers
    targetContainers.forEach(c => {
        c.innerHTML = symbolsHtml;
    });
}

// Optimized version that skips API call when clearing filters
function showAllSymbolsFromTrades() {
    console.log('Showing all symbols from trades data (no API call)');
    showAllSymbols(null);
}

function hideCostBasisTable() {
    const container = document.getElementById('cost-basis-table-container');
    const inlineContainer = document.getElementById('cost-basis-inline-container');
    
    [container, inlineContainer].forEach(c => {
        if (c) c.innerHTML = '';
    });
}

// ============================================================================

async function editTrade(tradeId) {
    try {
        // Fetch the trade data
        const response = await fetch(`/api/trades/${tradeId}`);
        const trade = await response.json();
        
        if (!trade) {
            alert('Trade not found');
            return;
        }
        
        console.log('Editing trade:', trade);
        
        // Open the appropriate modal based on trade type
        if (trade.trade_type === 'BTO') {
            openBTOModal(trade);
        } else if (trade.trade_type === 'STC') {
            openSTCModal(trade);
        } else if (trade.trade_type === 'ROC' || trade.trade_type.includes('CALL')) {
            openROCTCallModal(trade);
        } else if (trade.trade_type === 'ROP' || trade.trade_type.includes('PUT')) {
            openROCTPutModal(trade);
        } else {
            alert('Unknown trade type: ' + trade.trade_type);
        }
    } catch (error) {
        console.error('Error fetching trade:', error);
        alert('Error loading trade for editing: ' + error.message);
    }
}

async function deleteTrade(tradeId) {
    if (!confirm('Are you sure you want to delete this trade?')) return;
    
    try {
        const response = await fetch(`/api/trades/${tradeId}`, { method: 'DELETE' });
        const result = await response.json();
        
        if (result.success) {
            await loadTrades();
            loadSummary();
            await loadCostBasis();
        } else {
            alert('Failed to delete trade: ' + result.error);
        }
    } catch (error) {
        console.error('Error deleting trade:', error);
        alert('Error deleting trade: ' + error.message);
    }
}

async function updateTradeStatus(tradeId, newStatus) {
    try {
        const response = await fetch(`/api/trades/${tradeId}/status`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: newStatus })
        });
        
        const result = await response.json();
        
        if (result.success) {
            // If a new trade was created (roll status), handle it specially
            if (result.new_trade_id) {
                // Reload trades to get the new trade
                await loadTrades();
                
                // Find the new trade and make its fields editable
                const newTrade = trades.find(t => t.id === result.new_trade_id);
                if (newTrade) {
                    // Make the new trade row editable
                    makeTradeRowEditable(result.new_trade_id);
                }
            } else {
                await loadTrades();
            }
            loadSummary();
            // Reload cost basis with the selected ticker if one is set
            const selectedTicker = window.symbolFilter || document.getElementById('symbol-filter')?.value || '';
            await loadCostBasis(selectedTicker);
        } else {
            alert('Failed to update trade status: ' + result.error);
        }
    } catch (error) {
        console.error('Error updating trade status:', error);
        alert('Error updating trade status: ' + error.message);
    }
}

// Auto-save with debouncing for rolled trades
let autoSaveTimeouts = {};

// Limit input to 2 decimal places
function limitToTwoDecimals(input) {
    const value = input.value;
    // Check if value contains a decimal point
    if (value.includes('.')) {
        const parts = value.split('.');
        // If there are more than 2 decimal places, limit to 2
        if (parts[1] && parts[1].length > 2) {
            // Get the cursor position before changing value
            const cursorPos = input.selectionStart;
            // Format to 2 decimal places
            const formatted = parseFloat(value).toFixed(2);
            input.value = formatted;
            // Restore cursor position (adjust if needed)
            const newCursorPos = Math.min(cursorPos - 1, formatted.length);
            input.setSelectionRange(newCursorPos, newCursorPos);
        }
    }
}

// Prevent typing more than 2 decimal places on keypress
function preventMoreThanTwoDecimals(event) {
    const input = event.target;
    const value = input.value;
    const key = event.key;
    const selectionStart = input.selectionStart;
    const selectionEnd = input.selectionEnd;
    
    // Allow backspace, delete, tab, escape, enter, and arrow keys
    if (['Backspace', 'Delete', 'Tab', 'Escape', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) {
        return true;
    }
    
    // Allow Ctrl/Cmd + A, C, V, X, Z
    if (event.ctrlKey || event.metaKey) {
        return true;
    }
    
    // Get the value that would result after this keypress
    // Account for text selection that will be replaced
    const beforeSelection = value.substring(0, selectionStart);
    const afterSelection = value.substring(selectionEnd);
    const newValue = beforeSelection + key + afterSelection;
    
    // If the key is a decimal point
    if (key === '.') {
        // Only allow if there's no decimal point already (in the new value)
        if (newValue.includes('.')) {
            // Check if the decimal point is in the part that's being replaced
            const existingDecimal = value.includes('.');
            if (existingDecimal && !(selectionStart <= value.indexOf('.') && selectionEnd > value.indexOf('.'))) {
                event.preventDefault();
                return false;
            }
        }
        return true;
    }
    
    // If the key is a number
    if (/[0-9]/.test(key)) {
        // Check if we're trying to add a number after 2 decimal places
        if (newValue.includes('.')) {
            const parts = newValue.split('.');
            // If there are already 2 decimal places after the decimal point, prevent typing more numbers
            if (parts[1] && parts[1].length > 2) {
                event.preventDefault();
                return false;
            }
        }
        return true;
    }
    
    // Allow minus sign for negative numbers (though we have min="0" for price and strike)
    if (key === '-' && selectionStart === 0) {
        return true;
    }
    
    // Block all other characters
    event.preventDefault();
    return false;
}

function autoSaveTradeField(tradeId, field, value) {
    // Clear existing timeout for this field
    const timeoutKey = `${tradeId}_${field}`;
    if (autoSaveTimeouts[timeoutKey]) {
        clearTimeout(autoSaveTimeouts[timeoutKey]);
    }
    
    // Set new timeout to save after 500ms of no typing
    autoSaveTimeouts[timeoutKey] = setTimeout(() => {
        // Ticker changes require full reload to update symbol/type display
        const reloadTable = field === 'ticker';
        updateTradeField(tradeId, field, value, reloadTable);
        delete autoSaveTimeouts[timeoutKey];
    }, 500);
}

async function updateTradeField(tradeId, field, value, reloadTable = true) {
    try {
        const response = await fetch(`/api/trades/${tradeId}/field`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ field: field, value: value })
        });
        
        const result = await response.json();
        
        if (result.success) {
            if (reloadTable) {
                await loadTrades();
                loadSummary();
                // Reload cost basis with the selected ticker if one is set
                const selectedTicker = window.symbolFilter || document.getElementById('symbol-filter')?.value || '';
                await loadCostBasis(selectedTicker);
            } else {
                // Just update the trade in memory without reloading the table
                const tradeIndex = trades.findIndex(t => t.id === tradeId);
                if (tradeIndex !== -1) {
                    // Update the trade object
                    if (field === 'expiration_date') {
                        trades[tradeIndex].expiration_date = value;
                        // Recalculate DTE
                        if (trades[tradeIndex].trade_date) {
                            const newDTE = calculateDaysToExpiration(value, trades[tradeIndex].trade_date);
                            trades[tradeIndex].days_to_expiration = newDTE;
                            // Update DTE cell in the table
                            updateDTECell(tradeId, value);
                        }
                    } else if (field === 'trade_date') {
                        trades[tradeIndex].trade_date = value;
                        // Recalculate DTE
                        if (trades[tradeIndex].expiration_date) {
                            const newDTE = calculateDaysToExpiration(trades[tradeIndex].expiration_date, value);
                            trades[tradeIndex].days_to_expiration = newDTE;
                            // Update DTE cell in the table
                            updateDTECell(tradeId, trades[tradeIndex].expiration_date);
                        }
                    } else if (field === 'ticker') {
                        trades[tradeIndex].ticker = value.toUpperCase();
                        // Ticker change requires full reload to update symbol/type display
                        loadTrades();
                        loadSummary();
                        const selectedTicker = window.symbolFilter || document.getElementById('symbol-filter')?.value || '';
                        loadCostBasis(selectedTicker);
                        return; // Exit early since we're reloading
                    } else if (field === 'strike_price') {
                        trades[tradeIndex].strike_price = parseFloat(value) || 0;
                    } else if (field === 'credit_debit') {
                        trades[tradeIndex].credit_debit = parseFloat(value) || 0;
                    } else if (field === 'current_price') {
                        trades[tradeIndex].current_price = parseFloat(value) || 0;
                    } else if (field === 'num_of_contracts') {
                        trades[tradeIndex].num_of_contracts = parseInt(value) || 1;
                    }
                    // Update the table cell without full reload
                    updateTradeCell(tradeId, field, value);
                }
            }
        } else {
            alert('Failed to update trade field: ' + result.error);
        }
    } catch (error) {
        console.error('Error updating trade field:', error);
        alert('Error updating trade field: ' + error.message);
    }
}

// Update a single cell in the table without full reload
function updateTradeCell(tradeId, field, value) {
    // Find all cells with this trade ID and field
    const cells = document.querySelectorAll(`[data-trade-id="${tradeId}"][data-field="${field}"]`);
    cells.forEach(cell => {
        if (field === 'expiration_date') {
            // Update date input (can be date or text type)
            if (cell.tagName === 'INPUT') {
                if (cell.type === 'date') {
                    cell.value = formatDateForInput(value);
                } else if (cell.type === 'text' && cell.dataset.displayFormat === 'DD-MMM-YY') {
                    // Text input with DD-MMM-YY format
                    cell.value = formatDate(value);
                }
            }
            // Also update DTE cell when expiration date changes
            const trade = trades.find(t => t.id === tradeId);
            if (trade) {
                updateDTECell(tradeId, value);
            }
        } else if (field === 'trade_date') {
            // Update date input (can be date or text type)
            if (cell.tagName === 'INPUT') {
                if (cell.type === 'date') {
                    cell.value = formatDateForInput(value);
                } else if (cell.type === 'text' && cell.dataset.displayFormat === 'DD-MMM-YY') {
                    // Text input with DD-MMM-YY format
                    cell.value = formatDate(value);
                }
            }
            // Also update DTE cell when trade date changes
            // The trade object should already be updated with the new trade_date
            const trade = trades.find(t => t.id === tradeId);
            if (trade && trade.expiration_date) {
                // Use the updated trade_date from memory (which was just updated)
                updateDTECell(tradeId, trade.expiration_date);
            }
        } else if (field === 'ticker') {
            // Update ticker input
            if (cell.tagName === 'INPUT' && cell.type === 'text') {
                cell.value = value.toUpperCase();
            }
        } else if (field === 'strike_price') {
            // Update strike input
            if (cell.tagName === 'INPUT' && cell.type === 'number') {
                cell.value = parseFloat(value).toFixed(2);
            }
        } else if (field === 'credit_debit') {
            // Update credit input
            if (cell.tagName === 'INPUT' && cell.type === 'number') {
                cell.value = parseFloat(value).toFixed(2);
            }
        } else if (field === 'current_price') {
            // Update current price input
            if (cell.tagName === 'INPUT' && cell.type === 'number') {
                cell.value = parseFloat(value).toFixed(2);
            }
        } else if (field === 'num_of_contracts') {
            // Update contracts input
            if (cell.tagName === 'INPUT' && cell.type === 'number') {
                cell.value = parseInt(value) || 1;
            }
        }
    });
    
    // Update calculated fields (shares, DTE, etc.) in the same row
    const trade = trades.find(t => t.id === tradeId);
    if (trade) {
        // Update shares cell (calculated from contracts)
        const row = cells[0]?.closest('tr');
        if (row) {
            const sharesCell = row.querySelector('[data-field="shares"]') || 
                             Array.from(row.cells).find(cell => cell.textContent.includes((trade.num_of_contracts * 100).toString()));
            if (sharesCell && field === 'num_of_contracts') {
                sharesCell.textContent = (trade.num_of_contracts * 100).toString();
            }
        }
    }
}

// Make a trade row editable (called after new trade is created from roll)
function makeTradeRowEditable(tradeId) {
    // The row should already be rendered with editable fields
    // Just ensure the inputs are visible and focused
    const inputs = document.querySelectorAll(`[data-trade-id="${tradeId}"].roll-field`);
    if (inputs.length > 0) {
        // Focus on the first editable field
        inputs[0].focus();
    }
}

// Handle Tab key navigation within a column (same trade)
function handleTabNavigation(event, tradeId, currentFieldIndex) {
    if (event.key === 'Tab') {
        event.preventDefault();
        
        // Define the order of editable fields (field indices)
        const editableFieldOrder = [2, 3, 4, 5, 7, 8, 9]; // Ticker, Trade Date, Price, Exp Date, Strike, Credit, Contracts
        
        // Find current position in the order
        const currentIndex = editableFieldOrder.indexOf(currentFieldIndex);
        
        if (currentIndex === -1) return; // Current field not in editable list
        
        // Determine next/previous field
        let nextIndex;
        if (event.shiftKey) {
            // Shift+Tab: move up
            nextIndex = currentIndex > 0 ? currentIndex - 1 : editableFieldOrder.length - 1;
        } else {
            // Tab: move down
            nextIndex = currentIndex < editableFieldOrder.length - 1 ? currentIndex + 1 : 0;
        }
        
        const nextFieldIndex = editableFieldOrder[nextIndex];
        
        // Find the next editable field in the same column (same trade_id)
        const nextInput = document.querySelector(`input[data-trade-id="${tradeId}"][data-field-row="${nextFieldIndex}"]`);
        
        if (nextInput) {
            nextInput.focus();
            nextInput.select();
        }
    }
}

// ============================================================================
// SYMBOL FILTER SETUP FUNCTIONS
// ============================================================================

function setupTradesSymbolFilter() {
    const symbolFilterInput = document.getElementById('symbol-filter');
    const clearButton = document.getElementById('clear-symbol');
    
    if (!symbolFilterInput) return;
    
    // Setup autocomplete
    setupAutocomplete('symbol-filter', 'symbol-suggestions', (symbol) => {
        window.symbolFilter = symbol;
        updateTradesTable();
    });
    
    // Clear button functionality
    if (clearButton) {
        clearButton.addEventListener('click', function() {
            symbolFilterInput.value = '';
            clearButton.style.display = 'none';
            window.symbolFilter = '';
            updateTradesTable();
        });
    }
    
    // Show/hide clear button
    symbolFilterInput.addEventListener('input', function() {
        if (clearButton) {
            clearButton.style.display = this.value.trim() ? 'block' : 'none';
        }
    });
}

function setupStatusFilter() {
    const statusFilterSelect = document.getElementById('status-filter');
    
    if (!statusFilterSelect) {
        console.error('Status filter select not found');
        return;
    }
    
    statusFilterSelect.addEventListener('change', function() {
        statusFilter = this.value || '';
        console.log('Status filter changed to:', statusFilter || 'All');
        updateTradesTable();
    });
    
    console.log('Status filter setup complete');
}

function setupDashboardToggle() {
    const dashboardCollapse = document.getElementById('dashboardCollapse');
    const dashboardToggleIcon = document.getElementById('dashboardToggleIcon');
    
    if (!dashboardCollapse || !dashboardToggleIcon) {
        console.error('Dashboard collapse elements not found');
        return;
    }
    
    // Set initial icon state (expanded = chevron-down)
    dashboardToggleIcon.className = 'fas fa-chevron-down section-toggle-icon';
    
    // Listen for collapse events
    dashboardCollapse.addEventListener('show.bs.collapse', function() {
        dashboardToggleIcon.className = 'fas fa-chevron-down section-toggle-icon';
    });
    
    dashboardCollapse.addEventListener('hide.bs.collapse', function() {
        dashboardToggleIcon.className = 'fas fa-chevron-right section-toggle-icon';
    });
    
    console.log('Dashboard toggle setup complete');
}

// Toggle Trades Column (horizontally collapsible)
function toggleTrades() {
    const tradesColumn = document.getElementById('trades-column');
    const costBasisColumn = document.getElementById('cost-basis-column');
    const toggleIcon = document.getElementById('trades-toggle-icon');
    const collapsedCardToggle = document.getElementById('trades-collapsed-card-toggle');
    const collapsedCardIcon = document.getElementById('trades-collapsed-card-icon');
    
    if (!tradesColumn) return;
    
    // Check if cost basis is currently collapsed
    const costBasisIsCollapsed = costBasisColumn && !costBasisColumn.classList.contains('show');
    
    // Toggle collapse/show classes - CSS handles the flex adjustments
    if (tradesColumn.classList.contains('show')) {
        // Collapsing - store position BEFORE any DOM changes
        const tradesCard = document.getElementById('trades');
        const container = document.querySelector('.trades-cost-container');
        if (tradesCard && container) {
            const tradesHeader = tradesCard.querySelector('.card-header');
            if (tradesHeader) {
                // Get positions relative to viewport BEFORE collapsing
                const headerRect = tradesHeader.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                
                // Calculate position relative to container (not viewport)
                // Align with top of header instead of middle
                const headerTop = headerRect.top;
                const containerTop = containerRect.top;
                const offsetFromContainer = headerTop - containerTop;
                
            }
        }
        
        // Now hide the trades table
        tradesColumn.classList.remove('show');
        tradesColumn.classList.add('collapse');
        // When collapsed, arrow points right (to expand/show)
        if (toggleIcon) {
            toggleIcon.classList.remove('fa-chevron-left');
            toggleIcon.classList.add('fa-chevron-right');
        }
        if (collapsedCardIcon) {
            collapsedCardIcon.classList.remove('fa-chevron-left');
            collapsedCardIcon.classList.add('fa-chevron-right');
        }
        
        // If cost basis is also collapsed, automatically expand it to 100%
        if (costBasisIsCollapsed && costBasisColumn) {
            costBasisColumn.classList.remove('collapse');
            costBasisColumn.classList.add('show');
            // Update cost basis toggle icon
            const costBasisToggleIcon = document.getElementById('cost-basis-toggle-icon');
            if (costBasisToggleIcon) {
                costBasisToggleIcon.classList.remove('fa-chevron-left');
                costBasisToggleIcon.classList.add('fa-chevron-right');
            }
            // Update cost basis collapsed card icon
            const costBasisCollapsedCardIcon = document.getElementById('cost-basis-collapsed-card-icon');
            if (costBasisCollapsedCardIcon) {
                costBasisCollapsedCardIcon.classList.remove('fa-chevron-left');
                costBasisCollapsedCardIcon.classList.add('fa-chevron-right');
            }
        }
    } else {
        // Expanding - show the trades table
        tradesColumn.classList.remove('collapse');
        tradesColumn.classList.add('show');
        // When expanded, arrow points left (to collapse/hide)
        if (toggleIcon) {
            toggleIcon.classList.remove('fa-chevron-right');
            toggleIcon.classList.add('fa-chevron-left');
        }
        if (collapsedCardIcon) {
            collapsedCardIcon.classList.remove('fa-chevron-right');
            collapsedCardIcon.classList.add('fa-chevron-left');
        }
        
        // If cost basis is collapsed, automatically expand it to 60/40 split
        if (costBasisIsCollapsed && costBasisColumn) {
            costBasisColumn.classList.remove('collapse');
            costBasisColumn.classList.add('show');
            // Update cost basis toggle icon
            const costBasisToggleIcon = document.getElementById('cost-basis-toggle-icon');
            if (costBasisToggleIcon) {
                costBasisToggleIcon.classList.remove('fa-chevron-left');
                costBasisToggleIcon.classList.add('fa-chevron-right');
            }
            // Update cost basis collapsed card icon
            const costBasisCollapsedCardIcon = document.getElementById('cost-basis-collapsed-card-icon');
            if (costBasisCollapsedCardIcon) {
                costBasisCollapsedCardIcon.classList.remove('fa-chevron-left');
                costBasisCollapsedCardIcon.classList.add('fa-chevron-right');
            }
            // Update column widths first to ensure layout is correct
            updateColumnWidths();
        }
    }
    
    // Update column widths and collapsed card visibility
    updateColumnWidths();
    updateCollapsedCardVisibility();
}


function updateColumnWidths() {
    const tradesColumn = document.getElementById('trades-column');
    const costBasisColumn = document.getElementById('cost-basis-column');
    
    if (!tradesColumn || !costBasisColumn) return;
    
    const tradesIsVisible = tradesColumn.classList.contains('show');
    const costBasisIsVisible = costBasisColumn.classList.contains('show');
    
    // Reset widths and flex
    tradesColumn.style.width = '';
    tradesColumn.style.flex = '';
    tradesColumn.style.minWidth = '';
    costBasisColumn.style.width = '';
    costBasisColumn.style.flex = '';
    costBasisColumn.style.minWidth = '';
    
    if (tradesIsVisible && costBasisIsVisible) {
        // Both expanded: trades 60%, cost basis 40%
        tradesColumn.style.width = '60%';
        tradesColumn.style.flex = '0 0 60%';
        tradesColumn.style.minWidth = '0';
        costBasisColumn.style.width = '40%';
        costBasisColumn.style.flex = '0 0 40%';
        costBasisColumn.style.minWidth = '0';
    } else if (tradesIsVisible && !costBasisIsVisible) {
        // Only trades visible: trades full width
        tradesColumn.style.width = '100%';
        tradesColumn.style.flex = '1 1 100%';
        tradesColumn.style.minWidth = '0';
        costBasisColumn.style.width = '0';
        costBasisColumn.style.flex = '0 0 0';
        costBasisColumn.style.minWidth = '0';
    } else if (!tradesIsVisible && costBasisIsVisible) {
        // Only cost basis visible: cost basis full width
        tradesColumn.style.width = '0';
        tradesColumn.style.flex = '0 0 0';
        tradesColumn.style.minWidth = '0';
        costBasisColumn.style.width = '100%';
        costBasisColumn.style.flex = '1 1 100%';
        costBasisColumn.style.minWidth = '0';
    } else {
        // Both collapsed (shouldn't happen, but handle it)
        tradesColumn.style.width = '0';
        tradesColumn.style.flex = '0 0 0';
        costBasisColumn.style.width = '0';
        costBasisColumn.style.flex = '0 0 0';
    }
}

function updateCollapsedCardVisibility() {
    const tradesColumn = document.getElementById('trades-column');
    const costBasisColumn = document.getElementById('cost-basis-column');
    const collapsedCard = document.getElementById('collapsed-sections-card');
    
    if (!tradesColumn || !costBasisColumn || !collapsedCard) return;
    
    const tradesIsVisible = tradesColumn.classList.contains('show');
    const costBasisIsVisible = costBasisColumn.classList.contains('show');
    
    // Show collapsed card only when both sections are collapsed
    if (!tradesIsVisible && !costBasisIsVisible) {
        collapsedCard.style.display = 'block';
    } else {
        collapsedCard.style.display = 'none';
    }
}

function setupCostBasisToggle() {
    const costBasisCollapse = document.getElementById('costBasisCollapse');
    const costBasisToggleIcon = document.getElementById('costBasisToggleIcon');
    
    if (!costBasisCollapse || !costBasisToggleIcon) {
        console.error('Cost basis collapse elements not found');
        return;
    }
    
    // Set initial icon state (expanded = chevron-down)
    costBasisToggleIcon.className = 'fas fa-chevron-down section-toggle-icon';
    
    // Listen for collapse events
    costBasisCollapse.addEventListener('show.bs.collapse', function() {
        costBasisToggleIcon.className = 'fas fa-chevron-down section-toggle-icon';
    });
    
    costBasisCollapse.addEventListener('hide.bs.collapse', function() {
        costBasisToggleIcon.className = 'fas fa-chevron-right section-toggle-icon';
    });
    
    console.log('Cost basis toggle setup complete');
}

function setupDashboardDatePickers() {
    const startDateInput = document.getElementById('dashboard-start-date');
    const endDateInput = document.getElementById('dashboard-end-date');
    
    if (!startDateInput || !endDateInput) {
        console.error('Dashboard date picker elements not found');
        return;
    }
    
    // Set default values to empty (all time data)
    startDateInput.value = '';
    endDateInput.value = '';
    
    // Add event listeners
    startDateInput.addEventListener('change', function() {
        console.log('Dashboard start date changed to:', this.value);
        updateDashboardData();
        updateChart();
    });
    
    endDateInput.addEventListener('change', function() {
        console.log('Dashboard end date changed to:', this.value);
        updateDashboardData();
        updateChart();
    });
    
    console.log('Dashboard date pickers setup complete - defaulting to all time data');
}

function formatDateForDateInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function updateDashboardData() {
    const startDate = document.getElementById('dashboard-start-date').value;
    const endDate = document.getElementById('dashboard-end-date').value;
    
    console.log('Updating dashboard data for range:', startDate || 'all time', 'to', endDate || 'all time');
    
    // Reload summary data with custom date range (or all time if empty)
    loadSummary();
    
    // Reload trades data with custom date range (or all time if empty)
    loadTrades();
    
    // Reload top symbols data with custom date range (or all time if empty)
    loadTopSymbols();
    
    // You can add more specific dashboard data loading here
    // For example, filtering charts, updating statistics, etc.
}

function setDashboardPeriod(period) {
    const startDateInput = document.getElementById('dashboard-start-date');
    const endDateInput = document.getElementById('dashboard-end-date');
    
    if (!startDateInput || !endDateInput) {
        console.error('Dashboard date inputs not found');
        return;
    }
    
    const today = new Date();
    let startDate = new Date();
    
    switch(period) {
        case 'week':
            startDate.setDate(today.getDate() - 7);
            break;
        case 'month':
            startDate.setMonth(today.getMonth() - 1);
            break;
        case 'year':
            startDate.setFullYear(today.getFullYear() - 1);
            break;
        case 'ytd':
            startDate = new Date(today.getFullYear(), 0, 1); // January 1st of current year
            break;
        default:
            console.error('Invalid period:', period);
            return;
    }
    
    startDateInput.value = formatDateForDateInput(startDate);
    endDateInput.value = formatDateForDateInput(today);
    
    console.log('Dashboard period set to:', period, 'from', startDateInput.value, 'to', endDateInput.value);
    
    // Update dashboard data
    updateDashboardData();
    updateBankroll();
    updateChart();
}

function clearDashboardFilters() {
    const startDateInput = document.getElementById('dashboard-start-date');
    const endDateInput = document.getElementById('dashboard-end-date');
    
    if (!startDateInput || !endDateInput) {
        console.error('Dashboard date inputs not found');
        return;
    }
    
    // Clear the date inputs
    startDateInput.value = '';
    endDateInput.value = '';
    
    console.log('Dashboard filters cleared - showing all time data');
    
    // Reload data without date filters (all time)
    loadSummary();
    loadTrades();
    loadTopSymbols();
    updateBankroll();
    updateChart();
}

function setupCostBasisSymbolFilter() {
    const symbolFilterInput = document.getElementById('cost-basis-symbol-filter');
    const clearButton = document.getElementById('clear-cost-basis-symbol');
    
    if (!symbolFilterInput) return;
    
    // Setup autocomplete
    setupAutocomplete('cost-basis-symbol-filter', 'cost-basis-symbol-suggestions', (symbol) => {
        selectedTicker = symbol;
        loadCostBasis(symbol);
    });
    
    // Clear button functionality
    if (clearButton) {
        clearButton.addEventListener('click', function() {
            symbolFilterInput.value = '';
            clearButton.style.display = 'none';
            selectedTicker = null;
            showAllSymbolsFromTrades(); // Use optimized function to skip API call
        });
    }
    
    // Show/hide clear button
    symbolFilterInput.addEventListener('input', function() {
        if (clearButton) {
            clearButton.style.display = this.value.trim() ? 'block' : 'none';
        }
    });
}

// ============================================================================
// ACCOUNTS MANAGEMENT
// ============================================================================

async function loadAccounts() {
    try {
        const response = await fetch('/api/accounts');
        const accounts = await response.json();
        
        // Find the default account
        const defaultAccount = accounts.find(acc => acc.is_default === 1 || acc.is_default === true);
        const defaultAccountId = defaultAccount ? defaultAccount.id : (accounts.find(acc => acc.id === 9) ? 9 : (accounts.length > 0 ? accounts[0].id : null));
        
        // Sort accounts so default appears first, then alphabetically
        const sortedAccounts = [...accounts].sort((a, b) => {
            const aIsDefault = a.is_default === 1 || a.is_default === true;
            const bIsDefault = b.is_default === 1 || b.is_default === true;
            if (aIsDefault && !bIsDefault) return -1;
            if (!aIsDefault && bIsDefault) return 1;
            return a.account_name.localeCompare(b.account_name);
        });
        
        // Populate all account dropdowns
        const accountSelects = document.querySelectorAll('[id$="-account"], [id$="-account-id"]');
        accountSelects.forEach(select => {
            select.innerHTML = '';
            sortedAccounts.forEach((account, index) => {
                const option = document.createElement('option');
                option.value = account.id;
                option.textContent = account.account_name;
                // Set default account as selected
                if (account.id === defaultAccountId) {
                    option.selected = true;
                }
                select.appendChild(option);
            });
        });
        
        // Also populate import account select
        const importAccountSelect = document.getElementById('import-account-select');
        if (importAccountSelect) {
            importAccountSelect.innerHTML = '';
            sortedAccounts.forEach((account) => {
                const option = document.createElement('option');
                option.value = account.id;
                option.textContent = account.account_name;
                if (account.id === defaultAccountId) {
                    option.selected = true;
                }
                importAccountSelect.appendChild(option);
            });
        }
        
        // Populate universal account filter
        const universalAccountFilter = document.getElementById('universal-account-filter');
        if (universalAccountFilter) {
            universalAccountFilter.innerHTML = '<option value="">All</option>';
            sortedAccounts.forEach((account) => {
                const option = document.createElement('option');
                option.value = account.id;
                option.textContent = account.account_name;
                // Set default account as selected (not "All")
                if (account.id === defaultAccountId) {
                    option.selected = true;
                }
                universalAccountFilter.appendChild(option);
            });
            
            // Trigger change event to update filters with default account
            if (defaultAccountId) {
                universalAccountFilter.value = defaultAccountId;
                universalAccountFilter.dispatchEvent(new Event('change'));
            }
        }
        
        return defaultAccountId;
    } catch (error) {
        console.error('Error loading accounts:', error);
        return null;
    }
}

// ============================================================================
// ACCOUNTS SETTINGS MANAGEMENT
// ============================================================================

function toggleAccountsSettings() {
    const modal = new bootstrap.Modal(document.getElementById('accounts-modal'));
    modal.show();
    
    // Load accounts when modal opens
    loadAccountsTable();
}

async function loadAccountsTable() {
    try {
        const response = await fetch('/api/accounts');
        const accounts = await response.json();
        
        const tbody = document.getElementById('accounts-table-body');
        if (!tbody) return;
        
        if (accounts.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No accounts found</td></tr>';
            return;
        }
        
        // Sort accounts alphabetically by name
        const sortedAccounts = [...accounts].sort((a, b) => {
            return a.account_name.localeCompare(b.account_name);
        });
        
        tbody.innerHTML = sortedAccounts.map(account => {
            const startingBalance = account.starting_balance || 0;
            const formattedBalance = startingBalance.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
            const isDefault = account.is_default === 1 || account.is_default === true;
            return `
                <tr>
                    <td class="text-center">
                        <input type="checkbox" class="form-check-input" ${isDefault ? 'checked' : ''} 
                               onchange="setDefaultAccount(${account.id}, this.checked)" 
                               title="Set as default account">
                    </td>
                    <td>${account.account_name || ''}</td>
                    <td>${account.account_type || ''}</td>
                    <td>$${formattedBalance}</td>
                    <td>
                        <button class="btn btn-sm btn-outline-primary me-1" onclick="editAccount(${account.id}, '${(account.account_name || '').replace(/'/g, "\\'")}', '${(account.account_type || '').replace(/'/g, "\\'")}', ${startingBalance})">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-danger" onclick="deleteAccount(${account.id}, '${(account.account_name || '').replace(/'/g, "\\'")}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        console.error('Error loading accounts:', error);
        const tbody = document.getElementById('accounts-table-body');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-danger">Error loading accounts</td></tr>';
        }
    }
}

// Helper function to format currency for input field
function formatCurrencyInput(value) {
    if (!value || value === 0) return '$0.00';
    const numValue = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.-]/g, '')) : value;
    if (isNaN(numValue)) return '$0.00';
    return '$' + numValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

// Helper function to parse currency from input field
function parseCurrencyInput(value) {
    if (!value) return 0;
    // Remove $ and commas, then parse
    const cleaned = value.replace(/[$,]/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
}

function openNewAccountForm() {
    const formContainer = document.getElementById('account-form-container');
    const formTitle = document.getElementById('account-form-title');
    const editId = document.getElementById('account-edit-id');
    const nameInput = document.getElementById('account-name-input');
    const typeInput = document.getElementById('account-type-input');
    const balanceInput = document.getElementById('account-starting-balance-input');
    
    if (formContainer && formTitle && editId && nameInput && typeInput && balanceInput) {
        formTitle.textContent = 'New Account';
        editId.value = '';
        nameInput.value = '';
        typeInput.value = 'PRIMARY';
        balanceInput.value = '$0.00';
        formContainer.style.display = 'block';
        
        // Scroll to form
        formContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function editAccount(id, name, type, balance) {
    const formContainer = document.getElementById('account-form-container');
    const formTitle = document.getElementById('account-form-title');
    const editId = document.getElementById('account-edit-id');
    const nameInput = document.getElementById('account-name-input');
    const typeInput = document.getElementById('account-type-input');
    const balanceInput = document.getElementById('account-starting-balance-input');
    
    if (formContainer && formTitle && editId && nameInput && typeInput && balanceInput) {
        formTitle.textContent = 'Edit Account';
        editId.value = id;
        nameInput.value = name || '';
        typeInput.value = type || 'PRIMARY';
        balanceInput.value = formatCurrencyInput(balance || 0);
        formContainer.style.display = 'block';
        
        // Scroll to form
        formContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function cancelAccountForm() {
    const formContainer = document.getElementById('account-form-container');
    if (formContainer) {
        formContainer.style.display = 'none';
    }
}

async function setDefaultAccount(accountId, isDefault) {
    try {
        const response = await fetch(`/api/accounts/${accountId}/set-default`, {
            method: 'PUT'
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Reload accounts table to update checkboxes
            loadAccountsTable();
            // Reload all account dropdowns to update default selection
            loadAccounts();
            // Reload dashboard and other views that depend on accounts
            updateBankroll();
            loadTrades();
            loadCostBasis(selectedTicker);
            loadSummary();
            loadTopSymbols();
        } else {
            alert('Error setting default account: ' + (result.error || 'Unknown error'));
            // Reload table to reset checkbox
            loadAccountsTable();
        }
    } catch (error) {
        console.error('Error setting default account:', error);
        alert('Error setting default account: ' + error.message);
        // Reload table to reset checkbox
        loadAccountsTable();
    }
}

async function deleteAccount(id, name) {
    if (!confirm(`Are you sure you want to delete the account "${name}"?\n\nNote: You cannot delete an account that has trades, cost basis entries, cash flows, or commissions associated with it.`)) {
        return;
    }
    
    try {
        const response = await fetch(`/api/accounts/${id}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Reload accounts table
            loadAccountsTable();
            // Reload all account dropdowns
            loadAccounts();
            // Reload dashboard and other views that depend on accounts
            updateBankroll();
            loadTrades();
            loadCostBasis(selectedTicker);
        } else {
            alert('Error deleting account: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error deleting account:', error);
        alert('Error deleting account: ' + error.message);
    }
}

// Setup account form submission and input formatting
document.addEventListener('DOMContentLoaded', function() {
    // Setup input formatting for starting balance field
    const balanceInput = document.getElementById('account-starting-balance-input');
    if (balanceInput) {
        // Format on blur (when user leaves the field) - ensures proper formatting
        balanceInput.addEventListener('blur', function() {
            const value = parseCurrencyInput(this.value);
            this.value = formatCurrencyInput(value);
        });
        
        // Format on input (as user types) - shows $ and commas in real-time
        balanceInput.addEventListener('input', function() {
            // Get the current cursor position
            const cursorPos = this.selectionStart;
            const oldValue = this.value;
            
            // Parse the current value (removes $ and commas)
            const numericValue = parseCurrencyInput(this.value);
            
            // Format it with $ and commas
            const formatted = formatCurrencyInput(numericValue);
            
            // Update the value
            this.value = formatted;
            
            // Restore cursor position (adjust for added characters like $ and commas)
            // Simple approach: place cursor at the end if we're typing
            if (formatted.length > oldValue.length) {
                // User is typing, place cursor at end
                this.setSelectionRange(formatted.length, formatted.length);
            } else {
                // User is deleting, try to maintain relative position
                const diff = formatted.length - oldValue.length;
                const newPos = Math.max(1, Math.min(formatted.length, cursorPos + diff));
                this.setSelectionRange(newPos, newPos);
            }
        });
    }
    
    const accountForm = document.getElementById('account-form');
    if (accountForm) {
        accountForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const nameInput = document.getElementById('account-name-input');
            const typeInput = document.getElementById('account-type-input');
            const balanceInput = document.getElementById('account-starting-balance-input');
            const editId = document.getElementById('account-edit-id');
            
            if (!nameInput || !typeInput || !balanceInput || !editId) {
                return;
            }
            
            const accountName = nameInput.value.trim();
            const accountType = typeInput.value;
            const startingBalance = parseCurrencyInput(balanceInput.value);
            const id = editId.value;
            
            if (!accountName) {
                alert('Please enter an account name');
                return;
            }
            
            try {
                const url = id ? `/api/accounts/${id}` : '/api/accounts';
                const method = id ? 'PUT' : 'POST';
                
                const response = await fetch(url, {
                    method: method,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        account_name: accountName,
                        account_type: accountType,
                        starting_balance: startingBalance
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    // Reset form and hide it
                    cancelAccountForm();
                    // Reload accounts table
                    loadAccountsTable();
                    // Reload all account dropdowns
                    loadAccounts();
                    // Reload dashboard and other views that depend on accounts
                    updateBankroll();
                    loadTrades();
                    loadCostBasis(selectedTicker);
                } else {
                    alert('Error saving account: ' + (result.error || 'Unknown error'));
                }
            } catch (error) {
                console.error('Error saving account:', error);
                alert('Error saving account: ' + error.message);
            }
        });
    }
});

// ============================================================================
// UNIVERSAL CONTROL BAR FUNCTIONS
// ============================================================================

function setupUniversalControls() {
    // Setup universal ticker filter
    const universalTickerInput = document.getElementById('universal-ticker-filter');
    const universalClearButton = document.getElementById('clear-universal-ticker');
    
    if (universalTickerInput && universalClearButton) {
        setupAutocomplete('universal-ticker-filter', 'universal-ticker-suggestions', (symbol) => {
            window.symbolFilter = symbol;
            // Show/hide clear button based on whether symbol is selected
            if (symbol) {
                universalClearButton.style.display = 'inline-block';
            } else {
                universalClearButton.style.display = 'none';
            }
            // Reload all data with the ticker filter to ensure everything is in sync
            // This ensures the dashboard, trades table, and cost basis table all update
            // based on both the selected account and ticker filter
            // Run all loads in parallel to reduce delay
            Promise.all([
                loadTrades(),
                loadSummary(),
                loadCostBasis(symbol || null) // Always call loadCostBasis - it handles both ticker and null cases
            ]).catch(error => {
                console.error('Error loading data after selecting ticker:', error);
            });
        });
        
        // Show/hide clear button - use once to prevent duplicates
        const inputHandler = function() {
            universalClearButton.style.display = this.value.trim() ? 'inline-block' : 'none';
        };
        universalTickerInput.removeEventListener('input', inputHandler);
        universalTickerInput.addEventListener('input', inputHandler);
        
        // Clear button - use once to prevent duplicates
        const clearHandler = function() {
            clearUniversalTickerFilter();
        };
        universalClearButton.removeEventListener('click', clearHandler);
        universalClearButton.addEventListener('click', clearHandler);
    }
    
    // Setup universal date filters
    setupUniversalDateFilters();
    
    // Setup universal account filter
    const universalAccountFilter = document.getElementById('universal-account-filter');
    if (universalAccountFilter) {
        universalAccountFilter.addEventListener('change', function() {
            // Reload all data when account filter changes
            loadTrades();
            loadSummary();
            // Pass current ticker filter to loadCostBasis if it exists
            const currentTicker = window.symbolFilter || null;
            loadCostBasis(currentTicker);
            loadTopSymbols();
        });
    }
    
    // Setup import submenu toggle
    const importSubmenuToggle = document.getElementById('import-submenu-toggle');
    const importSubmenu = document.getElementById('import-submenu');
    if (importSubmenuToggle && importSubmenu) {
        const parent = importSubmenuToggle.closest('.dropdown-submenu');
        let closeTimeout = null;
        
        // Prevent clicks on radio buttons from closing the menu
        const importTypeTrades = document.getElementById('import-type-trades');
        const importTypeCostBasis = document.getElementById('import-type-cost-basis');
        const tradesLabel = importTypeTrades ? document.querySelector('label[for="import-type-trades"]') : null;
        const costBasisLabel = importTypeCostBasis ? document.querySelector('label[for="import-type-cost-basis"]') : null;
        
        // Add change event listeners to track radio button state changes
        if (importTypeTrades) {
            importTypeTrades.addEventListener('change', function(e) {
                console.log('Trades radio button changed - checked:', e.target.checked);
            });
        }
        if (importTypeCostBasis) {
            importTypeCostBasis.addEventListener('change', function(e) {
                console.log('Cost Basis radio button changed - checked:', e.target.checked);
            });
        }
        
        // Prevent clicks on labels/radio buttons from closing the dropdown menu
        // But allow the default behavior (checking the radio button) to work
        if (tradesLabel) {
            tradesLabel.addEventListener('click', function(e) {
                e.stopPropagation(); // Prevent dropdown from closing
                // Don't prevent default - let the label click check the radio button
            });
        }
        if (costBasisLabel) {
            costBasisLabel.addEventListener('click', function(e) {
                e.stopPropagation(); // Prevent dropdown from closing
                // Don't prevent default - let the label click check the radio button
            });
        }
        if (importTypeTrades) {
            importTypeTrades.addEventListener('click', function(e) {
                e.stopPropagation(); // Prevent dropdown from closing
                // Don't prevent default - let the radio button be checked
            });
        }
        if (importTypeCostBasis) {
            importTypeCostBasis.addEventListener('click', function(e) {
                e.stopPropagation(); // Prevent dropdown from closing
                // Don't prevent default - let the radio button be checked
            });
        }
        
        // Function to reset radio button selections - default to Trades
        function resetImportTypeSelection() {
            if (importTypeTrades) {
                importTypeTrades.checked = true; // Default to Trades
            }
            if (importTypeCostBasis) {
                importTypeCostBasis.checked = false;
            }
        }
        
        // Handle hover to keep submenu open (but don't close on mouseleave)
        if (parent) {
            // Keep submenu open when hovering over parent or submenu
            parent.addEventListener('mouseenter', function() {
                if (closeTimeout) {
                    clearTimeout(closeTimeout);
                    closeTimeout = null;
                }
                parent.classList.add('show');
            });
            
            importSubmenu.addEventListener('mouseenter', function() {
                if (closeTimeout) {
                    clearTimeout(closeTimeout);
                    closeTimeout = null;
                }
                parent.classList.add('show');
            });
            
            // Don't close on mouseleave - only close on click outside
        }
        
        importSubmenuToggle.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (parent) {
                const isOpening = !parent.classList.contains('show');
                if (isOpening) {
                    // Reset selection when opening
                    resetImportTypeSelection();
                }
                parent.classList.toggle('show');
            }
        });
        
        // Close import menu when mouse enters other hamburger menu items
        const headerMenuDropdown = document.getElementById('header-menu-dropdown');
        if (headerMenuDropdown && parent) {
            // Get all direct child <li> elements
            const allMenuItems = Array.from(headerMenuDropdown.children);
            
            allMenuItems.forEach(li => {
                // Skip the import submenu itself, dividers, and text items
                if (li.classList.contains('dropdown-submenu') || 
                    li.classList.contains('dropdown-divider') ||
                    li.classList.contains('dropdown-item-text')) {
                    return;
                }
                
                // Add mouseenter listener to the li element itself
                li.addEventListener('mouseenter', function() {
                    if (parent && parent.classList.contains('show')) {
                        parent.classList.remove('show');
                        resetImportTypeSelection(); // Reset when closing
                    }
                });
                
                // Also add to any child dropdown-item elements for extra coverage
                const childItems = li.querySelectorAll('.dropdown-item');
                childItems.forEach(item => {
                    if (item.id !== 'import-submenu-toggle') {
                        item.addEventListener('mouseenter', function() {
                            if (parent && parent.classList.contains('show')) {
                                parent.classList.remove('show');
                                resetImportTypeSelection(); // Reset when closing
                            }
                        });
                    }
                });
            });
        }
        
        // Reset selection when clicking outside the import menu
        // Use a single document click listener to avoid duplicates
        let clickOutsideHandler = function(e) {
            // Check if click is outside the import menu and its toggle
            // Don't reset if clicking on file input or its label
            const isFileInputClick = e.target.id === 'menu-excel-upload' || 
                                     e.target.closest('label[for="menu-excel-upload"]') !== null ||
                                     e.target.closest('#menu-excel-upload') !== null;
            
            if (parent && !importSubmenu.contains(e.target) && 
                !importSubmenuToggle.contains(e.target) && 
                !parent.contains(e.target) &&
                !isFileInputClick) { // Don't close/reset when clicking file input or label
                parent.classList.remove('show');
                resetImportTypeSelection(); // Reset when closing
            }
        };
        document.addEventListener('click', clickOutsideHandler);
        
        // Reset selection when main hamburger menu closes
        const headerMenuToggle = document.getElementById('header-menu-toggle');
        if (headerMenuToggle) {
            // Listen for Bootstrap dropdown hide event
            headerMenuToggle.addEventListener('hidden.bs.dropdown', function() {
                resetImportTypeSelection(); // Reset when main menu closes
            });
        }
    }
    
    // Setup menu Excel upload
    // Store the selected import type when the file input is clicked (before file dialog opens)
    let storedImportType = null;
    const menuExcelUpload = document.getElementById('menu-excel-upload');
    const menuExcelUploadLabel = document.querySelector('label[for="menu-excel-upload"]');
    
    // Store import type when file input label is clicked (before file dialog opens)
    if (menuExcelUploadLabel) {
        menuExcelUploadLabel.addEventListener('click', function(e) {
            // Store the current radio button state before file dialog opens
            const importTypeCostBasis = document.getElementById('import-type-cost-basis');
            const importTypeTrades = document.getElementById('import-type-trades');
            
            // Use querySelector to get the actual checked state
            const costBasisChecked = document.querySelector('#import-type-cost-basis:checked') !== null;
            const tradesChecked = document.querySelector('#import-type-trades:checked') !== null;
            
            if (costBasisChecked) {
                storedImportType = 'cost-basis';
                console.log('Stored import type: cost-basis (before file dialog)');
            } else if (tradesChecked) {
                storedImportType = 'trades';
                console.log('Stored import type: trades (before file dialog)');
            } else {
                storedImportType = 'trades'; // Default
                console.log('Stored import type: trades (default, before file dialog)');
            }
        });
    }
    
    if (menuExcelUpload) {
        menuExcelUpload.addEventListener('change', function(event) {
            // First check if we have a stored import type (from before file dialog opened)
            let importType = storedImportType;
            
            // If no stored type, check current DOM state
            if (!importType) {
                const importTypeTrades = document.getElementById('import-type-trades');
                const importTypeCostBasis = document.getElementById('import-type-cost-basis');
                
                // Use querySelector to check the actual DOM state - this is more reliable
                const tradesCheckedViaQuery = document.querySelector('#import-type-trades:checked') !== null;
                const costBasisCheckedViaQuery = document.querySelector('#import-type-cost-basis:checked') !== null;
                
                // Also check the element properties as fallback
                const tradesChecked = importTypeTrades?.checked;
                const costBasisChecked = importTypeCostBasis?.checked;
                
                // Use querySelector result as primary source of truth
                const isCostBasisSelected = costBasisCheckedViaQuery || costBasisChecked;
                const isTradesSelected = tradesCheckedViaQuery || tradesChecked;
                
                console.log('File upload triggered - importTypeTrades.checked:', tradesChecked, 'importTypeCostBasis.checked:', costBasisChecked);
                console.log('Via querySelector - trades:', tradesCheckedViaQuery, 'cost-basis:', costBasisCheckedViaQuery);
                console.log('Final decision - isCostBasisSelected:', isCostBasisSelected, 'isTradesSelected:', isTradesSelected);
                
                if (isCostBasisSelected) {
                    importType = 'cost-basis';
                } else if (isTradesSelected) {
                    importType = 'trades';
                } else {
                    importType = 'trades'; // Default
                }
            } else {
                console.log('Using stored import type:', importType);
            }
            
            // Clear stored type after use
            storedImportType = null;
            
            if (importType === 'cost-basis') {
                // Call cost basis import function
                console.log('Cost basis import selected, calling handleCostBasisUpload');
                handleCostBasisUpload(event);
            } else {
                // Call trades import function (existing)
                console.log('Trades import selected, calling handleExcelUpload');
                handleExcelUpload(event);
            }
            
            // Close the import menu after file is selected
            // NOTE: Don't reset radio buttons here - preserve the user's selection
            // The reset will happen when the dropdown is closed via other means
            const importSubmenuToggle = document.getElementById('import-submenu-toggle');
            const importSubmenu = document.getElementById('import-submenu');
            if (importSubmenuToggle && importSubmenu) {
                const parent = importSubmenuToggle.closest('.dropdown-submenu');
                if (parent) {
                    parent.classList.remove('show');
                    // Don't reset radio buttons here - user's selection should be preserved
                }
            }
        });
    }
}

function setUniversalTickerFilter(ticker) {
    const universalTickerInput = document.getElementById('universal-ticker-filter');
    const universalClearButton = document.getElementById('clear-universal-ticker');
    
    if (universalTickerInput) {
        // Set the input value - ensure it's set synchronously before any async operations
        universalTickerInput.value = ticker || '';
        
        // Show the clear button if ticker is set
        if (universalClearButton) {
            universalClearButton.style.display = ticker ? 'inline-block' : 'none';
        }
        
        // Set the global symbol filter to match the input value
        window.symbolFilter = ticker || '';
        
        // Show loading state for cost basis table immediately
        const costBasisContainer = document.getElementById('cost-basis-table-container');
        if (costBasisContainer && ticker) {
            // Show a minimal loading indicator
            const loadingHtml = `
                <div class="text-center text-muted py-3">
                    <i class="fas fa-spinner fa-spin me-2"></i>
                    Loading cost basis for ${ticker}...
                </div>
            `;
            costBasisContainer.innerHTML = loadingHtml;
        }
        
        // Defer trades table update to avoid blocking UI
        // Use requestAnimationFrame to batch DOM updates
        requestAnimationFrame(() => {
            // Immediate feedback: filter existing trades table instantly
            // This provides instant visual feedback while API calls happen in background
            if (trades && trades.length > 0) {
                // Filter trades array in memory for immediate display
                const filteredTrades = trades.filter(trade => 
                    trade.ticker && trade.ticker.toUpperCase() === ticker.toUpperCase()
                );
                // Temporarily update trades array for immediate table update
                const originalTrades = trades;
                trades = filteredTrades;
                updateTradesTable();
                // Restore original trades array - API call will update it properly
                trades = originalTrades;
            } else {
                // If no trades loaded yet, just update the table (it will be empty)
                updateTradesTable();
            }
        });
        
        // Reload all data with the ticker filter to ensure everything is in sync
        // This ensures the dashboard, trades table, and cost basis table all update
        // based on both the selected account and ticker filter
        // Run all loads in parallel to reduce delay
        Promise.all([
            loadTrades(),
            loadSummary(),
            loadCostBasis(ticker)
        ]).catch(error => {
            console.error('Error loading data after setting ticker filter:', error);
        });
    }
}

// Function to set universal ticker filter without triggering reload
function setUniversalTickerFilterSilent(ticker) {
    const universalTickerInput = document.getElementById('universal-ticker-filter');
    const universalClearButton = document.getElementById('clear-universal-ticker');
    
    if (universalTickerInput) {
        // Set the input value
        universalTickerInput.value = ticker || '';
        
        // Show the clear button if ticker is set
        if (universalClearButton) {
            universalClearButton.style.display = ticker ? 'inline-block' : 'none';
        }
        
        // Set the global symbol filter to match the input value
        window.symbolFilter = ticker || '';
    }
}

// Function to get the ticker currently displayed in the cost basis table
function getTickerFromCostBasisTable() {
    // Check if the cost basis table is showing details for a specific ticker
    // This happens when the table shows summary cards (isTickerSelected is true)
    const container = document.getElementById('cost-basis-table-container') || 
                      document.getElementById('cost-basis-inline-container');
    
    if (!container) return null;
    
    // Look for the header card that shows ticker name when a ticker is selected
    // The header card contains text like "TICKER - Company Name (Account)"
    const headerCard = container.querySelector('.card.bg-light h6');
    if (headerCard) {
        const headerText = headerCard.textContent.trim();
        // Extract ticker from header text (format: "TICKER - Company Name (Account)")
        const match = headerText.match(/^([A-Z]+)\s*-/);
        if (match && match[1]) {
            return match[1].trim();
        }
    }
    
    // Alternative: Check if there's a ticker in the first row of the table
    const table = container.querySelector('.table');
    if (table) {
        const firstRow = table.querySelector('tbody tr');
        if (firstRow) {
            // Try to get ticker from trade description (e.g., "BTO 2 POSH")
            const descriptionCell = firstRow.querySelector('td:nth-child(2)');
            if (descriptionCell) {
                const description = descriptionCell.textContent.trim();
                // Look for ticker pattern in description (e.g., "BTO 2 POSH" or "BTO 5 POSH")
                const tickerMatch = description.match(/\b([A-Z]{1,5})\s*$/);
                if (tickerMatch && tickerMatch[1]) {
                    return tickerMatch[1].trim();
                }
            }
        }
    }
    
    return null;
}

function clearUniversalTickerFilter() {
    const universalTickerInput = document.getElementById('universal-ticker-filter');
    const universalClearButton = document.getElementById('clear-universal-ticker');
    
    if (universalTickerInput) {
        universalTickerInput.value = '';
        if (universalClearButton) {
            universalClearButton.style.display = 'none';
        }
        window.symbolFilter = '';
        
        // Immediate restore: restore cached data if available for instant display
        // Use requestAnimationFrame to batch DOM updates and avoid blocking
        requestAnimationFrame(() => {
            // Use structuredClone for better performance, fallback to JSON for compatibility
            if (cachedTrades) {
                try {
                    trades = structuredClone ? structuredClone(cachedTrades) : JSON.parse(JSON.stringify(cachedTrades));
                } catch (e) {
                    trades = JSON.parse(JSON.stringify(cachedTrades)); // Fallback
                }
                updateTradesTable(); // Update immediately with cached data
            } else {
                // Fallback: use existing trades array (filtered)
                updateTradesTable();
            }
            
            // Restore cached cost basis if available
            if (cachedCostBasis && cachedCostBasis.length > 0) {
                showAllSymbols(cachedCostBasis); // Restore immediately with cached data
            } else {
                // Fallback: show symbols from trades data
                showAllSymbolsFromTrades();
            }
        });
        
        // Then reload all data in background to ensure everything is in sync
        // Run all loads in parallel to reduce delay
        // Use requestAnimationFrame to defer API calls until after immediate UI update
        requestAnimationFrame(() => {
            Promise.all([
                loadTrades(),
                loadSummary()
            ]).catch(error => {
                console.error('Error loading data after clearing ticker filter:', error);
            });
            
            // Refresh cost basis in background after a longer delay
            // This allows the immediate cached display to stay visible and prevents flicker
            setTimeout(() => {
                // Only refresh if user hasn't selected a new ticker
                if (!window.symbolFilter || window.symbolFilter.trim() === '') {
                    loadCostBasis(null).catch(error => {
                        console.error('Error loading cost basis after clearing ticker filter:', error);
                    });
                }
            }, 1000); // Longer delay to allow immediate display to stay visible longer
        });
    }
}

function setupUniversalDateFilters() {
    const startDateInput = document.getElementById('universal-start-date');
    const endDateInput = document.getElementById('universal-end-date');
    
    if (!startDateInput || !endDateInput) return;
    
    // Set default to empty (all time)
    startDateInput.value = '';
    endDateInput.value = '';
    
    // Update both dashboard and trades filters when changed
    startDateInput.addEventListener('change', function() {
        document.getElementById('dashboard-start-date').value = this.value;
        updateDashboardData();
    });
    
    endDateInput.addEventListener('change', function() {
        document.getElementById('dashboard-end-date').value = this.value;
        updateDashboardData();
    });
}

function setUniversalDateRange(period) {
    const startDateInput = document.getElementById('universal-start-date');
    const endDateInput = document.getElementById('universal-end-date');
    const dashboardStartDate = document.getElementById('dashboard-start-date');
    const dashboardEndDate = document.getElementById('dashboard-end-date');
    
    if (!startDateInput || !endDateInput) return;
    
    // Update button selected state
    const dateRangeButtons = document.querySelectorAll('.date-range-btn');
    dateRangeButtons.forEach(btn => {
        if (btn.dataset.period === period) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });
    
    const today = new Date();
    let startDate = null;
    let endDate = today.toISOString().split('T')[0];
    
    switch(period) {
        case 'week':
            startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
        case 'month':
            startDate = new Date(today.getFullYear(), today.getMonth() - 1, today.getDate());
            break;
        case 'year':
            startDate = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
            break;
        case 'ytd':
            startDate = new Date(today.getFullYear(), 0, 1);
            break;
    }
    
    if (startDate) {
        const startDateStr = startDate.toISOString().split('T')[0];
        startDateInput.value = startDateStr;
        if (dashboardStartDate) dashboardStartDate.value = startDateStr;
    }
    
    endDateInput.value = endDate;
    if (dashboardEndDate) dashboardEndDate.value = endDate;
    
    updateDashboardData();
}

function clearUniversalDateFilters() {
    const startDateInput = document.getElementById('universal-start-date');
    const endDateInput = document.getElementById('universal-end-date');
    const dashboardStartDate = document.getElementById('dashboard-start-date');
    const dashboardEndDate = document.getElementById('dashboard-end-date');
    
    // Remove selected state from all date range buttons
    const dateRangeButtons = document.querySelectorAll('.date-range-btn');
    dateRangeButtons.forEach(btn => {
        btn.classList.remove('selected');
    });
    
    if (startDateInput) startDateInput.value = '';
    if (endDateInput) endDateInput.value = '';
    if (dashboardStartDate) dashboardStartDate.value = '';
    if (dashboardEndDate) dashboardEndDate.value = '';
    
    updateDashboardData();
}

// Toggle Cost Basis Column
function toggleCostBasis() {
    const tradesColumn = document.getElementById('trades-column');
    const costBasisColumn = document.getElementById('cost-basis-column');
    const toggleIcon = document.getElementById('cost-basis-toggle-icon');
    const collapsedCardToggle = document.getElementById('cost-basis-collapsed-card-toggle');
    const collapsedCardIcon = document.getElementById('cost-basis-collapsed-card-icon');
    
    if (!costBasisColumn) return;
    
    // Check if trades is currently collapsed
    const tradesIsCollapsed = tradesColumn && !tradesColumn.classList.contains('show');
    
    // Toggle collapse/show classes - CSS handles the flex adjustments
    if (costBasisColumn.classList.contains('show')) {
        // If trades is collapsed, expand it first
        if (tradesIsCollapsed && tradesColumn) {
            tradesColumn.classList.remove('collapse');
            tradesColumn.classList.add('show');
            // Update trades toggle icon
            const tradesToggleIcon = document.getElementById('trades-toggle-icon');
            if (tradesToggleIcon) {
                tradesToggleIcon.classList.remove('fa-chevron-right');
                tradesToggleIcon.classList.add('fa-chevron-left');
            }
            // Update trades collapsed card icon
            const tradesCollapsedCardIcon = document.getElementById('trades-collapsed-card-icon');
            if (tradesCollapsedCardIcon) {
                tradesCollapsedCardIcon.classList.remove('fa-chevron-right');
                tradesCollapsedCardIcon.classList.add('fa-chevron-left');
            }
            // Hide trades floating toggle since it's now expanded
            
            // Update column widths to make trades full width (60/40 split since cost basis is still expanded)
            updateColumnWidths();
            
            // Wait for trades to expand and layout to update, then collapse cost basis
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        // Now hide the cost basis table
                        costBasisColumn.classList.remove('show');
                        costBasisColumn.classList.add('collapse');
                        // When collapsed, arrow points left (to expand/show)
                        if (toggleIcon) {
                            toggleIcon.classList.remove('fa-chevron-right');
                            toggleIcon.classList.add('fa-chevron-left');
                        }
                        // Update column widths after collapsing cost basis (trades becomes full width)
                        updateColumnWidths();
                        if (collapsedCardIcon) {
                            collapsedCardIcon.classList.remove('fa-chevron-right');
                            collapsedCardIcon.classList.add('fa-chevron-left');
                        }
                        // Update collapsed card visibility
                        updateCollapsedCardVisibility();
                    });
                });
            });
        } else {
            // Trades is already expanded - now hide the cost basis table
            costBasisColumn.classList.remove('show');
            costBasisColumn.classList.add('collapse');
            // When collapsed, arrow points left (to expand/show)
            if (toggleIcon) {
                toggleIcon.classList.remove('fa-chevron-right');
                toggleIcon.classList.add('fa-chevron-left');
            }
            // Update column widths after collapsing cost basis (trades becomes full width)
            updateColumnWidths();
            if (collapsedCardIcon) {
                collapsedCardIcon.classList.remove('fa-chevron-right');
                collapsedCardIcon.classList.add('fa-chevron-left');
            }
        }
    } else {
        // Expanding - show the cost basis table
        // If trades is collapsed, expand it first to 60/40 split
        if (tradesIsCollapsed && tradesColumn) {
            tradesColumn.classList.remove('collapse');
            tradesColumn.classList.add('show');
            // Update trades toggle icon
            const tradesToggleIcon = document.getElementById('trades-toggle-icon');
            if (tradesToggleIcon) {
                tradesToggleIcon.classList.remove('fa-chevron-right');
                tradesToggleIcon.classList.add('fa-chevron-left');
            }
            // Update trades collapsed card icon
            const tradesCollapsedCardIcon = document.getElementById('trades-collapsed-card-icon');
            if (tradesCollapsedCardIcon) {
                tradesCollapsedCardIcon.classList.remove('fa-chevron-right');
                tradesCollapsedCardIcon.classList.add('fa-chevron-left');
            }
            // Update column widths to make trades 60% and cost basis 40%
            updateColumnWidths();
            // Wait for trades to expand and layout to update, then expand cost basis
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        // Now expand the cost basis table
                        costBasisColumn.classList.remove('collapse');
                        costBasisColumn.classList.add('show');
                        // When expanded, arrow points right (to collapse/hide)
                        if (toggleIcon) {
                            toggleIcon.classList.remove('fa-chevron-left');
                            toggleIcon.classList.add('fa-chevron-right');
                        }
                        if (collapsedCardIcon) {
                            collapsedCardIcon.classList.remove('fa-chevron-left');
                            collapsedCardIcon.classList.add('fa-chevron-right');
                        }
                        // Update column widths after expanding cost basis
                        updateColumnWidths();
                        // Wait for layout to update completely, then recalculate position
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                requestAnimationFrame(() => {
                                    requestAnimationFrame(() => {
                                        // Recalculate position after both expand and layout is fully settled
                                        const tradesCard = document.getElementById('trades');
                                        const container = document.querySelector('.trades-cost-container');
                                        if (tradesCard && container) {
                                            const tradesHeader = tradesCard.querySelector('.card-header');
                                            if (tradesHeader) {
                                                // Get positions relative to viewport AFTER both expand and layout is settled
                                                const headerRect = tradesHeader.getBoundingClientRect();
                                                const containerRect = container.getBoundingClientRect();
                                                
                                                // Calculate position relative to container (not viewport)
                                                // Align with top of header instead of middle
                                                const headerTop = headerRect.top;
                                                const containerTop = containerRect.top;
                                                const offsetFromContainer = headerTop - containerTop;
                                                
                                                // Store the offset for future use
                                            }
                                        }
                                    });
                                });
                            });
                        });
                    });
                });
            });
        } else {
            // Trades is already expanded - just expand cost basis
            costBasisColumn.classList.remove('collapse');
            costBasisColumn.classList.add('show');
            // When expanded, arrow points right (to collapse/hide)
            if (toggleIcon) {
                toggleIcon.classList.remove('fa-chevron-left');
                toggleIcon.classList.add('fa-chevron-right');
            }
            if (collapsedCardIcon) {
                collapsedCardIcon.classList.remove('fa-chevron-left');
                collapsedCardIcon.classList.add('fa-chevron-right');
            }
            // Update column widths after expanding cost basis
            updateColumnWidths();
        }
    }
    
    // Update collapsed card visibility
    // Note: updateColumnWidths() is called inside the collapse/expand logic above
    // to ensure positions are calculated after layout changes
    updateCollapsedCardVisibility();
}


// Update position on scroll with throttling to prevent lag
// Since toggles use position: absolute relative to container, they scroll with the page
let scrollTimeout;
window.addEventListener('scroll', function() {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(function() {
        const costBasisFloatingToggle = document.getElementById('cost-basis-floating-toggle');
        const costBasisColumn = document.getElementById('cost-basis-column');
        // Only update if cost basis is collapsed and toggle is visible
        if (costBasisFloatingToggle && costBasisFloatingToggle.style.display !== 'none' && 
            costBasisColumn && !costBasisColumn.classList.contains('show')) {
            // Cost basis is collapsed - just use stored position, don't recalculate
            if (storedCostBasisHeaderPosition !== null) {
                costBasisFloatingToggle.style.top = `${storedCostBasisHeaderPosition}px`;
                costBasisFloatingToggle.style.transform = 'translateY(0)';
                costBasisFloatingToggle.style.right = '0px';
            }
        }
        // Floating toggle removed - no longer needed
    }, 16); // Throttle to ~60fps (16ms)
}, { passive: true });

// Throttle resize handler to prevent excessive updates
let resizeTimeout;
window.addEventListener('resize', function() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(function() {
        const costBasisFloatingToggle = document.getElementById('cost-basis-floating-toggle');
        const costBasisColumn = document.getElementById('cost-basis-column');
        // Only update if cost basis is collapsed and toggle is visible
        if (costBasisFloatingToggle && costBasisFloatingToggle.style.display !== 'none' && 
            costBasisColumn && !costBasisColumn.classList.contains('show')) {
            // Cost basis is collapsed - recalculate position on resize (layout might have changed)
            // But use stored position as fallback
            const tradesCard = document.getElementById('trades');
            const container = document.querySelector('.trades-cost-container');
            if (tradesCard && container) {
                const tradesHeader = tradesCard.querySelector('.card-header');
                if (tradesHeader) {
                    const headerRect = tradesHeader.getBoundingClientRect();
                    const containerRect = container.getBoundingClientRect();
                    const headerTop = headerRect.top;
                    const containerTop = containerRect.top;
                    const offsetFromContainer = headerTop - containerTop;
                    storedCostBasisHeaderPosition = offsetFromContainer;
                    costBasisFloatingToggle.style.top = `${offsetFromContainer}px`;
                    costBasisFloatingToggle.style.transform = 'translateY(0)';
                    costBasisFloatingToggle.style.right = '0px';
                } else if (storedCostBasisHeaderPosition !== null) {
                    // Fallback to stored position if header not found
                    costBasisFloatingToggle.style.top = `${storedCostBasisHeaderPosition}px`;
                    costBasisFloatingToggle.style.transform = 'translateY(0)';
                    costBasisFloatingToggle.style.right = '0px';
                }
            }
        }
        const tradesFloatingToggle = document.getElementById('trades-floating-toggle');
        const tradesColumn = document.getElementById('trades-column');
        // Floating toggle removed - no longer needed
        // Recalculate cost basis table height on window resize
        setCostBasisTableHeight();
        // Update column widths on resize
        updateColumnWidths();
        // Update collapsed card visibility
        updateCollapsedCardVisibility();
    }, 150); // Throttle to 150ms
});

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded, initializing app...');
    
    // Initialize cost basis toggle state
    const costBasisColumn = document.getElementById('cost-basis-column');
    const costBasisCollapsedCardIcon = document.getElementById('cost-basis-collapsed-card-icon');
    
    if (costBasisColumn) {
        // If cost basis is collapsed (hidden), update collapsed card icon
        if (!costBasisColumn.classList.contains('show')) {
            if (costBasisCollapsedCardIcon) {
                costBasisCollapsedCardIcon.classList.remove('fa-chevron-right');
                costBasisCollapsedCardIcon.classList.add('fa-chevron-left');
            }
        } else {
            // If cost basis is visible, update collapsed card icon
            if (costBasisCollapsedCardIcon) {
                costBasisCollapsedCardIcon.classList.remove('fa-chevron-left');
                costBasisCollapsedCardIcon.classList.add('fa-chevron-right');
            }
        }
    }
    
    // Update column widths based on visibility
    updateColumnWidths();
    updateCollapsedCardVisibility();
    
    // Load commission settings
    loadCommission();
    
    // Load accounts first, then load data with default account filter
    loadAccounts().then(() => {
        // Load initial data after accounts are loaded (so default account filter is set)
        loadTrades();
        loadSummary();
        loadCostBasis();
        loadTopSymbols();
    });
    
    // Initialize chart
    initializeChart();
    
    // Update chart with data
    updateChart();
    
    // Set up event listeners
    setupUniversalControls();  // Setup new universal control bar
    setupTradesSymbolFilter();
    setupStatusFilter();
    setupCostBasisSymbolFilter();
    setupDashboardToggle();
    // setupTradesToggle(); // Removed - now using horizontal collapse
    // setupCostBasisToggle(); // Removed - now using horizontal collapse
    setupDashboardDatePickers();
    
    
    console.log('App initialized');
    
    // Debug: Log section widths and padding/margins
    setTimeout(() => {
        const dashboard = document.getElementById('dashboard');
        const trades = document.getElementById('trades');
        const costBasis = document.getElementById('cost-basis');
        
        const dashStyle = dashboard ? window.getComputedStyle(dashboard) : null;
        const tradesStyle = trades ? window.getComputedStyle(trades) : null;
        const costStyle = costBasis ? window.getComputedStyle(costBasis) : null;
        
        console.log('Dashboard:', {
            width: dashboard ? dashboard.offsetWidth : 'N/A',
            paddingLeft: dashStyle ? dashStyle.paddingLeft : 'N/A',
            paddingRight: dashStyle ? dashStyle.paddingRight : 'N/A',
            marginLeft: dashStyle ? dashStyle.marginLeft : 'N/A',
            marginRight: dashStyle ? dashStyle.marginRight : 'N/A'
        });
        
        console.log('Trades:', {
            width: trades ? trades.offsetWidth : 'N/A',
            paddingLeft: tradesStyle ? tradesStyle.paddingLeft : 'N/A',
            paddingRight: tradesStyle ? tradesStyle.paddingRight : 'N/A',
            marginLeft: tradesStyle ? tradesStyle.marginLeft : 'N/A',
            marginRight: tradesStyle ? tradesStyle.marginRight : 'N/A'
        });
        
        console.log('Cost Basis:', {
            width: costBasis ? costBasis.offsetWidth : 'N/A',
            paddingLeft: costStyle ? costStyle.paddingLeft : 'N/A',
            paddingRight: costStyle ? costStyle.paddingRight : 'N/A',
            marginLeft: costStyle ? costStyle.marginLeft : 'N/A',
            marginRight: costStyle ? costStyle.marginRight : 'N/A'
        });
    }, 1000);
});

// ============================================================================
// CHART FUNCTIONS
// ============================================================================

function initializeChart() {
    const ctx = document.getElementById('premiumChart');
    if (!ctx) return;
    
    premiumChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Total Amount per Day',
                data: [],
                borderColor: 'rgb(75, 192, 192)',
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                tension: 0.1,
                fill: false
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

async function updateChart() {
    if (!premiumChart) return;
    
    try {
        // Get date filters from dashboard
        const startDate = document.getElementById('dashboard-start-date')?.value || null;
        const endDate = document.getElementById('dashboard-end-date')?.value || null;
        
        const params = new URLSearchParams();
        if (startDate) params.append('start_date', startDate);
        if (endDate) params.append('end_date', endDate);
        
        const response = await fetch(`/api/chart-data?${params}`);
        const data = await response.json();
        
        premiumChart.data.labels = data.map(d => d.date);
        premiumChart.data.datasets[0].data = data.map(d => d.premium);
        premiumChart.update();
    } catch (error) {
        console.error('Error updating chart:', error);
    }
}

// ============================================================================
// COMMISSION HANDLING
// ============================================================================

function toggleCommissionSettings() {
    const modal = new bootstrap.Modal(document.getElementById('commission-modal'));
    modal.show();
    
    // Load accounts and commissions when modal opens
    loadCommissionAccounts();
    loadCommissions();
}

async function loadCommissionAccounts() {
    try {
        const response = await fetch('/api/accounts');
        const accounts = await response.json();
        const select = document.getElementById('commission-account-select');
        
        if (select) {
            select.innerHTML = '<option value="">All Accounts</option>';
            accounts.forEach(account => {
                const option = document.createElement('option');
                option.value = account.id;
                option.textContent = account.account_name || `Account ${account.id}`;
                select.appendChild(option);
            });
            
            // Set default to first account if available
            if (accounts.length > 0) {
                select.value = accounts[0].id;
            }
            
            // Load commissions when account changes
            select.addEventListener('change', function() {
                loadCommissions();
            });
        }
    } catch (error) {
        console.error('Error loading accounts:', error);
    }
}

async function loadCommissions() {
    try {
        const accountSelect = document.getElementById('commission-account-select');
        const accountId = accountSelect ? accountSelect.value : '';
        
        if (!accountId) {
            document.getElementById('commissions-table-body').innerHTML = '<tr><td colspan="4" class="text-center text-muted">Please select an account</td></tr>';
            return;
        }
        
        const response = await fetch(`/api/commissions?account_id=${accountId}`);
        const commissions = await response.json();
        
        const tbody = document.getElementById('commissions-table-body');
        if (!tbody) return;
        
        if (commissions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No commission records found</td></tr>';
            return;
        }
        
        tbody.innerHTML = commissions.map(comm => {
            const effectiveDate = comm.effective_date ? new Date(comm.effective_date).toLocaleDateString() : '';
            return `
                <tr>
                    <td>${effectiveDate}</td>
                    <td>$${comm.commission_rate.toFixed(5)}</td>
                    <td>${comm.notes || ''}</td>
                    <td>
                        <button class="btn btn-sm btn-outline-primary me-1" onclick="editCommission(${comm.id}, ${comm.commission_rate}, '${comm.effective_date}', '${(comm.notes || '').replace(/'/g, "\\'")}')">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-danger" onclick="deleteCommission(${comm.id})">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        console.error('Error loading commissions:', error);
        document.getElementById('commissions-table-body').innerHTML = '<tr><td colspan="4" class="text-center text-danger">Error loading commissions</td></tr>';
    }
}

function openNewCommissionForm() {
    const formContainer = document.getElementById('commission-form-container');
    const formTitle = document.getElementById('commission-form-title');
    const editId = document.getElementById('commission-edit-id');
    const rateInput = document.getElementById('commission-rate-input');
    const dateInput = document.getElementById('commission-effective-date-input');
    const notesInput = document.getElementById('commission-notes-input');
    const saveBtn = document.getElementById('commission-save-btn');
    
    // Reset form
    editId.value = '';
    rateInput.value = '';
    notesInput.value = '';
    
    // Set default date to today
    const today = new Date().toISOString().split('T')[0];
    dateInput.value = today;
    
    // Update form title and button
    formTitle.textContent = 'New Commission';
    saveBtn.textContent = 'Save';
    
    // Show form
    formContainer.style.display = 'block';
    
    // Scroll to form
    formContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function editCommission(id, rate, effectiveDate, notes) {
    const formContainer = document.getElementById('commission-form-container');
    const formTitle = document.getElementById('commission-form-title');
    const editId = document.getElementById('commission-edit-id');
    const rateInput = document.getElementById('commission-rate-input');
    const dateInput = document.getElementById('commission-effective-date-input');
    const notesInput = document.getElementById('commission-notes-input');
    const saveBtn = document.getElementById('commission-save-btn');
    
    // Fill form with existing data
    editId.value = id;
    rateInput.value = rate;
    dateInput.value = effectiveDate;
    notesInput.value = notes || '';
    
    // Update form title and button
    formTitle.textContent = 'Edit Commission';
    saveBtn.textContent = 'Update';
    
    // Show form
    formContainer.style.display = 'block';
    
    // Scroll to form
    formContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelCommissionForm() {
    const formContainer = document.getElementById('commission-form-container');
    formContainer.style.display = 'none';
}

async function deleteCommission(id) {
    if (!confirm('Are you sure you want to delete this commission record?')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/commissions/${id}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            loadCommissions();
        } else {
            alert('Error deleting commission: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error deleting commission:', error);
        alert('Error deleting commission: ' + error.message);
    }
}

// Setup commission form submission
document.addEventListener('DOMContentLoaded', function() {
    const commissionForm = document.getElementById('commission-form');
    if (commissionForm) {
        commissionForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const accountSelect = document.getElementById('commission-account-select');
            const editId = document.getElementById('commission-edit-id');
            const rateInput = document.getElementById('commission-rate-input');
            const dateInput = document.getElementById('commission-effective-date-input');
            const notesInput = document.getElementById('commission-notes-input');
            
            const accountId = accountSelect ? accountSelect.value : '';
            if (!accountId) {
                alert('Please select an account');
                return;
            }
            
            const commissionRate = parseFloat(rateInput.value);
            const effectiveDate = dateInput.value;
            const notes = notesInput.value || '';
            const id = editId.value;
            
            try {
                const url = id ? `/api/commissions/${id}` : '/api/commissions';
                const method = id ? 'PUT' : 'POST';
                
                const response = await fetch(url, {
                    method: method,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        account_id: accountId,
                        commission_rate: commissionRate,
                        effective_date: effectiveDate,
                        notes: notes
                    })
                });
                
                const result = await response.json();
                
                if (result.success) {
                    // Reset form and hide it
                    cancelCommissionForm();
                    // Reload commissions table
                    loadCommissions();
                } else {
                    alert('Error saving commission: ' + (result.error || 'Unknown error'));
                }
            } catch (error) {
                console.error('Error saving commission:', error);
                alert('Error saving commission: ' + error.message);
            }
        });
    }
});

function toggleBankrollSettings() {
    const modal = new bootstrap.Modal(document.getElementById('commission-modal'));
    modal.show();
    // Focus on bankroll section when modal opens
    setTimeout(() => {
        const bankrollSection = document.getElementById('bankroll-beginning-date');
        if (bankrollSection) {
            bankrollSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 300);
}

function saveCommission() {
    const commissionInput = document.getElementById('commission-input');
    commission = parseFloat(commissionInput.value) || 0;
    localStorage.setItem('commission', commission.toString());
    
    const modal = bootstrap.Modal.getInstance(document.getElementById('commission-modal'));
    modal.hide();
    
    // Reload trades to update calculations
    loadTrades();
    
    // Reload cost basis to update calculations
    loadCostBasis(selectedTicker);
}

function loadCommission() {
    const savedCommission = localStorage.getItem('commission');
    if (savedCommission) {
        commission = parseFloat(savedCommission);
        const commissionInput = document.getElementById('commission-input');
        if (commissionInput) {
            commissionInput.value = commission;
        }
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function hideCostBasisTable() {
    const table = document.getElementById('cost-basis-table');
    if (table) table.style.display = 'none';
}

function updateSymbolFilter() {
    // Update symbol filter with current trades
    const uniqueSymbols = [...new Set(trades
        .filter(trade => trade.trade_type !== 'BTO' && trade.trade_type !== 'STC')
        .map(trade => trade.ticker))];
    
    // This would update the autocomplete suggestions
    // Implementation depends on your specific autocomplete setup
}

// ============================================================================
// MODAL SPECIFIC FUNCTIONS
// ============================================================================

function openBTOModal(tradeData = null) {
    console.log('openBTOModal called with tradeData:', tradeData);
    const modal = document.getElementById('btoModal');
    const form = document.getElementById('btoForm');
    
    // Reset form
    form.reset();
    
    // Set today's date as default for new trades
    if (!tradeData) {
        document.getElementById('bto-trade-date').value = getTodayInDDMMMYY();
    }
    
    // If editing, populate the form with existing data
    if (tradeData) {
        console.log('Editing BTO trade');
        
        // Update modal title and icon for edit mode
        const modalTitle = document.querySelector('#btoModal .modal-title');
        const modalIcon = document.querySelector('#btoModal .modal-title i');
        if (modalTitle) modalTitle.innerHTML = '<i class="fas fa-edit me-2"></i>Edit BTO Trade';
        
        document.getElementById('bto-trade-date').value = formatDate(tradeData.trade_date || '');
        document.getElementById('bto-underlying').value = tradeData.ticker || '';
        document.getElementById('bto-purchase-price').value = tradeData.price_per_share || '';
        document.getElementById('bto-number-shares').value = tradeData.num_of_contracts || '';
        document.getElementById('bto-total-amount').value = tradeData.total_amount || '';
        
        // Store the trade ID for updating
        form.dataset.editingTradeId = tradeData.id;
        
        // Show edit buttons, hide add buttons and cancel
        form.classList.remove('add-mode');
        form.classList.add('edit-mode');
        document.getElementById('bto-edit-buttons').style.cssText = 'display: flex !important;';
        document.getElementById('bto-add-buttons').style.cssText = 'display: none !important;';
        document.getElementById('bto-add-cancel').style.cssText = 'display: none !important;';
    } else {
        console.log('Creating new BTO trade');
        
        // Reset modal title and icon for add mode
        const modalTitle = document.querySelector('#btoModal .modal-title');
        if (modalTitle) modalTitle.innerHTML = '<i class="fas fa-plus me-2"></i>Add New BTO Trade';
        
        // Clear the trade ID for new trades
        form.removeAttribute('data-editing-trade-id');
        
        // Show add buttons, hide edit buttons
        form.classList.remove('edit-mode');
        form.classList.add('add-mode');
        document.getElementById('bto-edit-buttons').style.cssText = 'display: none !important;';
        document.getElementById('bto-add-buttons').style.cssText = 'display: flex !important;';
        document.getElementById('bto-add-cancel').style.cssText = 'display: flex !important;';
    }
    
    // Setup autocomplete
    setupAutocomplete('bto-underlying', 'bto-suggestions', (symbol, name) => {
        document.getElementById('bto-underlying').value = symbol;
    });
    
    // Show modal using Bootstrap's modal API
    const bootstrapModal = new bootstrap.Modal(modal);
    bootstrapModal.show();
    
}

function openSTCModal(tradeData = null) {
    console.log('openSTCModal called with tradeData:', tradeData);
    const modal = document.getElementById('stcModal');
    const form = document.getElementById('stcForm');
    
    // Reset form
    form.reset();
    
    // Set today's date as default for new trades
    if (!tradeData) {
        document.getElementById('stc-trade-date').value = getTodayInDDMMMYY();
    }
    
    // If editing, populate the form with existing data
    if (tradeData) {
        console.log('Editing STC trade');
        
        // Update modal title and icon for edit mode
        const modalTitle = document.querySelector('#stcModal .modal-title');
        if (modalTitle) modalTitle.innerHTML = '<i class="fas fa-edit me-2"></i>Edit STC Trade';
        
        document.getElementById('stc-trade-date').value = formatDate(tradeData.trade_date || '');
        document.getElementById('stc-underlying').value = tradeData.ticker || '';
        document.getElementById('stc-sale-price').value = tradeData.price_per_share || '';
        document.getElementById('stc-number-shares').value = tradeData.num_of_contracts || '';
        document.getElementById('stc-total-amount').value = tradeData.total_amount || '';
        
        // Store the trade ID for updating
        form.dataset.editingTradeId = tradeData.id;
        
        // Show edit buttons, hide add buttons
        form.classList.remove('add-mode');
        form.classList.add('edit-mode');
        document.getElementById('stc-edit-buttons').style.cssText = 'display: flex !important;';
        document.getElementById('stc-add-buttons').style.cssText = 'display: none !important;';
        document.getElementById('stc-add-cancel').style.cssText = 'display: none !important;';
    } else {
        console.log('Creating new STC trade');
        
        // Reset modal title and icon for add mode
        const modalTitle = document.querySelector('#stcModal .modal-title');
        if (modalTitle) modalTitle.innerHTML = '<i class="fas fa-plus me-2"></i>Add New STC Trade';
        
        // Clear the trade ID for new trades
        form.removeAttribute('data-editing-trade-id');
        
        // Show add buttons, hide edit buttons
        form.classList.remove('edit-mode');
        form.classList.add('add-mode');
        document.getElementById('stc-edit-buttons').style.cssText = 'display: none !important;';
        document.getElementById('stc-add-buttons').style.cssText = 'display: flex !important;';
        document.getElementById('stc-add-cancel').style.cssText = 'display: flex !important;';
    }
    
    // Setup autocomplete
    setupAutocomplete('stc-underlying', 'stc-suggestions', (symbol, name) => {
        document.getElementById('stc-underlying').value = symbol;
    });
    
    // Show modal using Bootstrap's modal API
    const bootstrapModal = new bootstrap.Modal(modal);
    bootstrapModal.show();
}

function openROCTCallModal(tradeData = null) {
    console.log('openROCTCallModal called with tradeData:', tradeData);
    const modal = document.getElementById('roctCallModal');
    const form = document.getElementById('roctCallForm');
    
    // Reset form
    form.reset();
    
    // Set today's date as default for new trades
    if (!tradeData) {
        document.getElementById('roct-call-trade-date').value = getTodayInDDMMMYY();
        // Set expiration date to 8 days from today
        const today = new Date();
        const expirationDate = new Date(today);
        expirationDate.setDate(today.getDate() + 8);
        document.getElementById('roct-call-expiration-date').value = formatDate(expirationDate.toISOString().split('T')[0]);
    }
    
    // If editing, populate the form with existing data
    if (tradeData) {
        console.log('Editing ROCT CALL trade');
        
        // Update modal title and icon for edit mode
        const modalTitle = document.querySelector('#roctCallModal .modal-title');
        if (modalTitle) {
            if (tradeData.trade_type === 'ROC') {
                modalTitle.innerHTML = '<i class="fas fa-edit me-2"></i>Edit ROC Trade';
            } else {
                modalTitle.innerHTML = '<i class="fas fa-edit me-2"></i>Edit ROCT CALL Trade';
            }
        }
        
        document.getElementById('roct-call-trade-date').value = formatDate(tradeData.trade_date || '');
        document.getElementById('roct-call-underlying').value = tradeData.ticker || '';
        document.getElementById('roct-call-price').value = tradeData.current_price || '';
        document.getElementById('roct-call-expiration-date').value = formatDate(tradeData.expiration_date || '');
        document.getElementById('roct-call-dte').value = tradeData.dte || '';
        document.getElementById('roct-call-strike-price').value = tradeData.strike_price || '';
        document.getElementById('roct-call-credit-debit').value = tradeData.premium || '';
        document.getElementById('roct-call-cost-basis').value = tradeData.cost_basis || '';
        
        // Calculate DTE if not provided
        if (!tradeData.dte && tradeData.trade_date && tradeData.expiration_date) {
            const dte = calculateDaysToExpiration(tradeData.expiration_date, tradeData.trade_date);
            document.getElementById('roct-call-dte').value = dte;
        }
        
        // Store the trade ID for updating
        form.dataset.editingTradeId = tradeData.id;
        
        // Show edit buttons, hide add buttons and cancel
        form.classList.remove('add-mode');
        form.classList.add('edit-mode');
    } else {
        console.log('Creating new ROCT CALL trade');
        
        // Reset modal title and icon for add mode
        const modalTitle = document.querySelector('#roctCallModal .modal-title');
        if (modalTitle) modalTitle.innerHTML = '<i class="fas fa-plus me-2"></i>Add New ROCT CALL Trade';
        
        // Clear the trade ID for new trades
        form.removeAttribute('data-editing-trade-id');
        
        // Show add buttons and cancel, hide edit buttons
        form.classList.remove('edit-mode');
        form.classList.add('add-mode');
    }
    
    // Setup autocomplete
    setupAutocomplete('roct-call-underlying', 'roct-call-underlying-suggestions', (symbol, name) => {
        document.getElementById('roct-call-underlying').value = symbol;
    });
    
    // Add event listeners for DTE calculation
    setupDTECalculation('roct-call-trade-date', 'roct-call-expiration-date', 'roct-call-dte');
    
    // Add event listeners for expiration date calculation (8 days from trade date)
    setupExpirationDateCalculation('roct-call-trade-date', 'roct-call-expiration-date');
    
    // Show modal using Bootstrap's modal API
    const bootstrapModal = new bootstrap.Modal(modal);
    bootstrapModal.show();
    
    // Ensure button visibility changes stick after modal is shown
    modal.addEventListener('shown.bs.modal', function() {
        if (tradeData) {
            // Edit mode - handled by CSS classes
        } else {
            // Add mode - handled by CSS classes
        }
    });
}

function openROCTPutModal(tradeData = null) {
    console.log('openROCTPutModal called with tradeData:', tradeData);
    
    const modal = document.getElementById('roctPutModal');
    const form = document.getElementById('roctPutForm');
    
    // Clear form
    form.reset();
    
    if (tradeData) {
        // EDIT MODE: Populate form and update UI
        console.log('EDIT MODE: Populating form with trade data');
        
        // Update modal title and icon
        const modalTitle = document.querySelector('#roctPutModalLabel');
        if (modalTitle) {
            if (tradeData.trade_type === 'ROP') {
                modalTitle.innerHTML = '<i class="fas fa-edit me-2"></i>Edit ROP Trade';
            } else {
                modalTitle.innerHTML = '<i class="fas fa-edit me-2"></i>Edit ROCT PUT Trade';
            }
        }
        
        // Populate form fields
        document.getElementById('roct-put-trade-date').value = tradeData.trade_date;
        document.getElementById('roct-put-underlying').value = tradeData.ticker;
        document.getElementById('roct-put-price').value = tradeData.price;
        document.getElementById('roct-put-expiration-date').value = tradeData.expiration_date;
        document.getElementById('roct-put-dte').value = tradeData.dte;
        document.getElementById('roct-put-strike-price').value = tradeData.strike_price;
        document.getElementById('roct-put-credit-debit').value = tradeData.credit_debit;
        document.getElementById('roct-put-quantity').value = tradeData.num_of_contracts || 1;
        
        // Set ARORC if available (database stores as percentage, e.g., 20.4 = 20.4%)
        if (tradeData.ARORC !== null && tradeData.ARORC !== undefined) {
            document.getElementById('roct-put-arorc').value = parseFloat(tradeData.ARORC).toFixed(1);
        } else {
            // Calculate ARORC if not available
            calculateROCTPutARORC();
        }
        
        // Set editing state
        form.dataset.editingTradeId = tradeData.id;
        form.dataset.editingTicker = tradeData.ticker;
        
        // Button visibility will be handled by the delayed setTimeout below
        
    } else {
        // ADD MODE: Set defaults and update UI
        console.log('ADD MODE: Setting default values');
        
        // Update modal title and icon
        const modalTitle = document.querySelector('#roctPutModalLabel');
        if (modalTitle) {
            modalTitle.innerHTML = '<i class="fas fa-plus-circle me-2"></i>Add ROCT PUT Trade';
        }
        
        // Set default values
        document.getElementById('roct-put-trade-date').value = getTodayInDDMMMYY();
        
        // Set expiration date to 8 days from today
        const today = new Date();
        const expirationDate = new Date(today);
        expirationDate.setDate(today.getDate() + 8);
        document.getElementById('roct-put-expiration-date').value = formatDate(expirationDate.toISOString().split('T')[0]);
        
        // Set default number of contracts to 1
        document.getElementById('roct-put-quantity').value = 1;
        
        // Clear editing state
        form.removeAttribute('data-editing-trade-id');
        form.removeAttribute('data-editing-ticker');
        
        // Button visibility will be handled by the delayed setTimeout below
    }
    
    // Setup DTE calculation
    setupDTECalculation('roct-put-trade-date', 'roct-put-expiration-date', 'roct-put-dte');
    
    // Add event listener to DTE field to calculate ARORC when it changes
    const dteField = document.getElementById('roct-put-dte');
    if (dteField) {
        // Use a MutationObserver or input event to detect when DTE is updated
        // Since DTE is readonly, we'll listen to the change event on the date fields
        const tradeDateField = document.getElementById('roct-put-trade-date');
        const expirationDateField = document.getElementById('roct-put-expiration-date');
        if (tradeDateField) {
            tradeDateField.addEventListener('change', function() {
                setTimeout(calculateROCTPutARORC, 100);
            });
        }
        if (expirationDateField) {
            expirationDateField.addEventListener('change', function() {
                setTimeout(calculateROCTPutARORC, 100);
            });
        }
    }
    
    // Setup autocomplete
    setupAutocomplete('roct-put-underlying', 'roct-put-underlying-suggestions');
    
    // Calculate ARORC after modal is shown
    setTimeout(() => {
        calculateROCTPutARORC();
    }, 100);
    
    
    const bootstrapModal = new bootstrap.Modal(modal);
    
    // Simple approach: show appropriate buttons based on mode
    if (tradeData) {
        // EDIT MODE: Show only Save/Cancel buttons
        form.classList.remove('add-mode');
        form.classList.add('edit-mode');
    } else {
        // ADD MODE: Show Add Another/Add and Close/Cancel buttons
        form.classList.remove('edit-mode');
        form.classList.add('add-mode');
    }
    
    bootstrapModal.show();
}

// ============================================================================
// TOP SYMBOLS FUNCTIONS
// ============================================================================

async function loadTopSymbols() {
    try {
        // Get account filter
        const accountFilter = document.getElementById('universal-account-filter')?.value || '';
        
        // Use dashboard date filters if available, otherwise use all time
        const dashboardStartDate = document.getElementById('dashboard-start-date')?.value;
        const dashboardEndDate = document.getElementById('dashboard-end-date')?.value;
        
        const params = new URLSearchParams();
        if (accountFilter) {
            params.append('account_id', accountFilter);
        }
        if (dashboardStartDate) {
            params.append('start_date', dashboardStartDate);
        }
        if (dashboardEndDate) {
            params.append('end_date', dashboardEndDate);
        }
        
        const response = await fetch(`/api/top-symbols?${params}`);
        const topSymbols = await response.json();
        
        const container = document.getElementById('top-symbols-list');
        if (!container) return;
        
        if (topSymbols.length === 0) {
            container.innerHTML = '<div class="text-center text-muted"><small>No trades found</small></div>';
            return;
        }
        
        // Determine if we're showing filtered data (30-day period) or all-time data
        const isFilteredData = dashboardStartDate || dashboardEndDate;
        
        let html = '';
        topSymbols.forEach((symbol, index) => {
            // Only use color coding for all-time data, not for filtered 30-day periods
            let colorClass = '';
            if (!isFilteredData) {
                if (symbol.has_open_trades) {
                    colorClass = 'text-success'; // Green for open trades
                } else if (symbol.is_old_assigned_expired) {
                    colorClass = 'text-warning'; // Yellow for old assigned/expired
                }
            }
            
            html += `
                <div class="d-flex justify-content-between align-items-center mb-1">
                    <span class="small ${colorClass}" onclick="filterByTopSymbol('${symbol.ticker}')" style="cursor: pointer;" title="Click to filter trades and cost basis">${index + 1}. ${symbol.ticker}</span>
                    <span class="badge bg-light text-dark small">${symbol.trade_count}</span>
                </div>
            `;
        });
        
        container.innerHTML = html;
        console.log('Top symbols loaded:', topSymbols.length, 'symbols', isFilteredData ? '(filtered data)' : '(all time data)');
    } catch (error) {
        console.error('Error loading top symbols:', error);
        const container = document.getElementById('top-symbols-list');
        if (container) {
            container.innerHTML = '<div class="text-center text-muted"><small>Error loading</small></div>';
        }
    }
}

function filterByTopSymbol(ticker) {
    // Set the symbol filter for trades table
    window.symbolFilter = ticker;
    
    // Update trades table symbol filter input
    const tradesSymbolInput = document.getElementById('symbol-filter');
    if (tradesSymbolInput) {
        tradesSymbolInput.value = ticker;
    }
    
    // Update cost basis symbol filter input
    const costBasisSymbolInput = document.getElementById('cost-basis-symbol-filter');
    if (costBasisSymbolInput) {
        costBasisSymbolInput.value = ticker;
    }
    
    // Show clear buttons (using correct IDs)
    const tradesClearBtn = document.getElementById('clear-symbol');
    const costBasisClearBtn = document.getElementById('clear-cost-basis-symbol');
    if (tradesClearBtn) tradesClearBtn.style.display = 'inline-block';
    if (costBasisClearBtn) costBasisClearBtn.style.display = 'inline-block';
    
    // Update arrow positions
    updateArrowPositions();
    
    // Update trades table
    updateTradesTable();
    
    // Update cost basis table
    loadCostBasis(ticker);
    
    // Scroll to trades table
    const tradesTable = document.getElementById('trades-table');
    if (tradesTable) {
        tradesTable.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function jumpToCostBasis() {
    // Scroll to cost basis table
    console.log('jumpToCostBasis called');
    const costBasisContainer = document.getElementById('cost-basis-table-container');
    console.log('costBasisContainer:', costBasisContainer);
    
    if (costBasisContainer) {
        // Use scrollIntoView to position the element at the top of the viewport
        costBasisContainer.scrollIntoView({ 
            behavior: 'smooth', 
            block: 'start',
            inline: 'nearest'
        });
        console.log('Scrolling to cost basis using scrollIntoView');
    } else {
        console.error('cost-basis-table-container element not found');
    }
}

function jumpToTrades() {
    // Scroll to trades table
    console.log('jumpToTrades called');
    const tradesTable = document.getElementById('trades-table');
    console.log('tradesTable:', tradesTable);
    
    if (tradesTable) {
        const elementTop = tradesTable.offsetTop;
        console.log('Trades table element top position:', elementTop);
        window.scrollTo({ 
            top: elementTop - 20, // 20px offset to ensure it's clearly visible at top
            behavior: 'smooth' 
        });
        console.log('Scrolling to trades table at position:', elementTop - 20);
    } else {
        console.error('trades-table element not found');
    }
}

function jumpToTradesTop() {
    // Scroll to the top of the trades table (showing header and search box)
    console.log('jumpToTradesTop called');
    const tradesTableContainer = document.getElementById('trades-content-container');
    console.log('tradesTableContainer:', tradesTableContainer);
    
    if (tradesTableContainer) {
        // Get the element's position relative to the document
        const elementTop = tradesTableContainer.offsetTop;
        console.log('Element top position:', elementTop);
        
        // Scroll to the element with a small offset to ensure it's at the top
        window.scrollTo({ 
            top: elementTop - 20, // 20px offset to ensure it's clearly visible at top
            behavior: 'smooth' 
        });
        
        console.log('Scrolling to trades table at position:', elementTop - 20);
    } else {
        console.error('trades-content-container element not found');
    }
}

function scrollToTop() {
    // Scroll to the very top of the page
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Dynamic positioning functions for arrow buttons
function updateArrowPositions() {
    // Update trades table arrow position
    const tradesClearBtn = document.getElementById('clear-symbol');
    const tradesArrowBtn = document.getElementById('jump-to-cost-basis');
    
    if (tradesClearBtn && tradesArrowBtn) {
        if (tradesClearBtn.style.display === 'none' || tradesClearBtn.style.display === '') {
            tradesArrowBtn.style.marginLeft = '0.5rem'; // Same position as X button
        } else {
            tradesArrowBtn.style.marginLeft = '0.25rem'; // Move right when X is visible
        }
    }
    
    // Update cost basis table arrow position
    const costBasisClearBtn = document.getElementById('clear-cost-basis-symbol');
    const costBasisArrowBtn = document.getElementById('jump-to-trades');
    
    if (costBasisClearBtn && costBasisArrowBtn) {
        if (costBasisClearBtn.style.display === 'none' || costBasisClearBtn.style.display === '') {
            costBasisArrowBtn.style.marginLeft = '0.5rem'; // Same position as X button
        } else {
            costBasisArrowBtn.style.marginLeft = '0.25rem'; // Move right when X is visible
        }
    }
}

// FORM SUBMISSION FUNCTIONS (for backward compatibility)
// ============================================================================

async function submitBTOForm(action = 'addAndClose') {
    await submitTradeForm('bto', action);
}

async function submitSTCForm(action = 'addAndClose') {
    await submitTradeForm('stc', action);
}

async function submitROCTCallForm(action = 'addAndClose') {
    await submitTradeForm('roctCall', action);
}

async function submitROCTPutForm(action = 'addAndClose') {
    await submitTradeForm('roctPut', action);
}

// ============================================================================
// EXCEL IMPORT FUNCTION
// ============================================================================

async function handleExcelUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // Get account ID and import type from menu if available
    const importAccountSelect = document.getElementById('import-account-select');
    const importTypeTrades = document.getElementById('import-type-trades');
    const importTypeCostBasis = document.getElementById('import-type-cost-basis');
    
    let accountId = null;
    let importType = 'trades'; // default
    
    // Check if this is from the menu upload
    if (event.target.id === 'menu-excel-upload') {
        if (importAccountSelect) {
            accountId = importAccountSelect.value;
            if (!accountId) {
                alert('Please select an account before importing.');
                event.target.value = '';
                return;
            }
        }
        // Check import type - prioritize cost basis if checked
        if (importTypeCostBasis && importTypeCostBasis.checked) {
            importType = 'cost-basis';
        } else if (importTypeTrades && importTypeTrades.checked) {
            importType = 'trades';
        }
    }
    
    const formData = new FormData();
    formData.append('file', file);
    if (accountId) {
        formData.append('account_id', accountId);
    }
    if (importType) {
        formData.append('import_type', importType);
    }
    
    try {
        // Determine which endpoint to use based on import type
        const endpoint = importType === 'cost-basis' ? '/api/import-cost-basis-excel' : '/api/import-excel';
        console.log('Import type:', importType, 'Using endpoint:', endpoint);
        const response = await fetch(endpoint, {
            method: 'POST',
            body: formData
        });
        
        console.log('Response status:', response.status);
        console.log('Response headers:', [...response.headers.entries()]);
        
        // Check if response is OK before reading body
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Error response body:', errorText);
            alert('Error uploading file: Server returned ' + response.status);
            return;
        }
        
        const result = await response.json();
        
        // Print to console for debugging
        console.log('Import result:', result);
        
        if (result.success) {
            let message = `Successfully imported ${result.imported} ${importType === 'cost-basis' ? 'cost basis entries' : 'trades'}.`;
            if (result.skipped > 0) {
                message += `\n${result.skipped} duplicate entries skipped.`;
            }
            if (result.errors && result.errors.length > 0) {
                console.error('Import errors:', result.errors);
                message += '\n\nErrors:\n' + result.errors.join('\n');
            }
            alert(message);
            // Reload data
            if (importType === 'cost-basis') {
                await loadCostBasis();
            } else {
                await loadTrades();
                await loadSummary();
            }
        } else {
            console.error('Import failed:', result.error);
            alert('Error importing Excel file: ' + result.error);
        }
    } catch (error) {
        console.error('Upload error:', error);
        alert('Error uploading file: ' + error.message);
    }
    
    // Reset file input
    event.target.value = '';
    
    // Close dropdown menu if from menu upload
    if (event.target.id === 'menu-excel-upload') {
        const dropdown = bootstrap.Dropdown.getInstance(document.getElementById('header-menu-toggle'));
        if (dropdown) {
            dropdown.hide();
        }
    }
}

async function handleCostBasisUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // Get account ID from menu if available
    const importAccountSelect = document.getElementById('import-account-select');
    
    let accountId = null;
    
    // Check if this is from the menu upload
    if (event.target.id === 'menu-excel-upload') {
        if (importAccountSelect) {
            accountId = importAccountSelect.value;
            if (!accountId) {
                alert('Please select an account before importing.');
                event.target.value = '';
                return;
            }
        }
    }
    
    const formData = new FormData();
    formData.append('file', file);
    if (accountId) {
        formData.append('account_id', accountId);
    }
    
    try {
        const response = await fetch('/api/import-cost-basis-excel', {
            method: 'POST',
            body: formData
        });
        
        console.log('Response status:', response.status);
        
        // Check if response is OK before reading body
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Error response body:', errorText);
            alert('Error uploading file: Server returned ' + response.status);
            return;
        }
        
        const result = await response.json();
        
        // Print to console for debugging
        console.log('Import result:', result);
        
        if (result.success) {
            let message = result.message || 'Successfully imported cost basis entries.';
            if (result.trades_imported !== undefined) {
                message += `\nTrades imported: ${result.trades_imported}`;
            }
            if (result.dividends_imported !== undefined) {
                message += `\nDividends imported: ${result.dividends_imported}`;
            }
            if (result.errors && result.errors.length > 0) {
                message += `\n\nErrors:\n${result.errors.join('\n')}`;
            }
            alert(message);
            // Reload data
            await loadCostBasis();
            await loadTrades();
            await loadSummary();
        } else {
            console.error('Import failed:', result.error);
            alert('Error importing Excel file: ' + result.error);
        }
    } catch (error) {
        console.error('Upload error:', error);
        alert('Error uploading file: ' + error.message);
    }
    
    // Reset file input
    event.target.value = '';
    
    // Close dropdown menu if from menu upload
    if (event.target.id === 'menu-excel-upload') {
        const dropdown = bootstrap.Dropdown.getInstance(document.getElementById('header-menu-toggle'));
        if (dropdown) {
            dropdown.hide();
        }
    }
}

// Add event listener for Excel upload
document.addEventListener('DOMContentLoaded', function() {
    const excelUpload = document.getElementById('excel-upload');
    if (excelUpload) {
        excelUpload.addEventListener('change', handleExcelUpload);
    }
});


