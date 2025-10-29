let trades = [];
let currentFilter = { startDate: null, endDate: null, period: 'all' };
let statusFilter = '';
let sortColumn = '';
let sortDirection = 'asc';
let commission = 0.0;
let statusMonitorInterval = null;
let lastTradeCount = 0;
let selectedTicker = null;
let premiumChart = null;

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
        data.ticker = data.underlying || data.ticker;
        data.premium = data.creditDebit || data.premium;
        data.currentPrice = data.price || data.currentPrice;
        data.tradeType = formType.toUpperCase();
        
        // Convert dates from display format to YYYY-MM-DD format
        if (data.tradeDate) {
            data.tradeDate = parseDisplayDate(data.tradeDate);
        }
        
        if (data.expirationDate) {
            data.expirationDate = parseDisplayDate(data.expirationDate);
        }
    } else if (formType === 'bto' || formType === 'stc') {
        // Map BTO/STC fields to backend expected format
        data.ticker = data.underlying || data.ticker;
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
            
            // Reload data
            await loadTrades();
            loadSummary();
            
            if (wasFromCostBasis) {
                const editingTicker = modal.dataset.editingTicker || selectedTicker;
                await loadCostBasis(editingTicker);
            } else {
                await loadCostBasis();
            }
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

function setupAutocomplete(inputId, suggestionsId, onSelectCallback) {
    const input = document.getElementById(inputId);
    const suggestions = document.getElementById(suggestionsId);
    
    if (!input || !suggestions) return;
    
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
            const symbol = item.dataset.symbol;
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
                const symbol = current.dataset.symbol;
                const name = current.dataset.name;
                input.value = symbol;
                suggestions.style.display = 'none';
                if (onSelectCallback) onSelectCallback(symbol, name);
            }
        } else if (e.key === 'Escape') {
            suggestions.style.display = 'none';
        }
    });
    
    // Hide suggestions when clicking outside
    document.addEventListener('click', function(e) {
        if (!input.contains(e.target) && !suggestions.contains(e.target)) {
            suggestions.style.display = 'none';
        }
    });
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
    
    const expDate = new Date(expirationDate);
    const tradeDateObj = new Date(tradeDate);
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

// ============================================================================
// DATA LOADING FUNCTIONS
// ============================================================================

async function loadTrades() {
    try {
        console.log('Loading trades...');
        
        // Use dashboard date filters if available, otherwise use current filter
        const dashboardStartDate = document.getElementById('dashboard-start-date')?.value;
        const dashboardEndDate = document.getElementById('dashboard-end-date')?.value;
        
        const params = new URLSearchParams();
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
        
        const response = await fetch(`/api/trades?${params}`);
        trades = await response.json();
        
        // Ensure trades is an array
        if (!Array.isArray(trades)) {
            console.error('trades is not an array:', trades);
            trades = [];
        }
        
        lastTradeCount = trades.length;
        console.log('Trades loaded:', trades.length, 'trades');
        console.log('Sample trade:', trades[0]);
        
        updateTradesTable();
        updateSymbolFilter();
    } catch (error) {
        console.error('Error loading trades:', error);
    }
}

async function loadSummary() {
    try {
        console.log('Loading summary...');
        const params = new URLSearchParams();
        
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
        
        const response = await fetch(`/api/summary?${params}`);
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
        const params = new URLSearchParams();
        if (ticker) params.append('ticker', ticker);
        params.append('commission', commission.toString());
        
        const response = await fetch(`/api/cost-basis?${params}`);
        const data = await response.json();
        console.log('Cost basis API response:', data);
        
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
            if (data.length === 0) {
                hideCostBasisTable();
            } else {
                showAllSymbols(data);
            }
        }
    } catch (error) {
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
        'Contracts', // New row - Contracts (num_of_contracts)
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
    
    // Use document fragment for better performance
    const fragment = document.createDocumentFragment();
    
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
            const premium = trade.credit_debit || trade.premium;
            const netCreditPerShare = premium - commission; // Net Credit Per Share = Credit - Commission
            const netCreditTotal = netCreditPerShare * (trade.num_of_contracts * 100); // Net Credit Total = Net Credit Per Share * Shares
            const riskCapital = trade.strike_price - netCreditPerShare; // Risk Capital = Strike - Net Credit Per Share
            const marginCapital = riskCapital * (trade.num_of_contracts * 100);
            const rorc = riskCapital !== 0 ? (netCreditPerShare / riskCapital) * 100 : 0; // RORC = Net Credit Per Share / Risk Capital
            const arorc = trade.days_to_expiration > 0 ? (365 / trade.days_to_expiration) * rorc : 0;
            
            switch (fieldIndex) {
                case 0: // Symbol/Type (back to first row)
                    const today = new Date();
                    const expirationDate = new Date(trade.expiration_date);
                    const isExpired = trade.trade_status && trade.trade_status.toLowerCase() === 'open' && today > expirationDate;
                    // Use type_name from trade_types table if available, otherwise use trade.ticker + tradeType
                    const displayType = trade.type_name ? `${trade.ticker} ${trade.type_name}` : `${trade.ticker} ${tradeType}`;
                    cellContent = `<div style="text-align: center; white-space: normal; word-wrap: break-word; vertical-align: top;"><strong>${isExpired ? '<i class="fas fa-exclamation-triangle text-danger me-1" title="Expired"></i>' : ''}<span class="clickable-symbol" onclick="filterBySymbol('${trade.ticker}')" style="cursor: pointer; color: #007bff; text-decoration: underline;">${displayType}</span></strong></div>`;
                    break;
                case 1: // Trade Date - Read-only
                    const tradeDateDisplay = formatDate(trade.trade_date || trade.created_at);
                    cellContent = `<span class="text-center">${tradeDateDisplay}</span>`;
                    break;
                case 2: // Price - Read-only
                    cellContent = `<span class="text-center">$${parseFloat(trade.current_price || trade.price || 0).toFixed(2)}</span>`;
                    break;
                case 3: // Exp Date - Read-only
                    const expDateDisplay = formatDate(trade.expiration_date);
                    cellContent = `<span class="text-center">${expDateDisplay}</span>`;
                    break;
                case 4: // DTE (was Days to Exp) - Read-only (calculated)
                    cellContent = `<span class="text-center">${trade.days_to_expiration || calculateDaysToExpiration(trade.expiration_date, trade.trade_date)}</span>`;
                    break;
                case 5: // Strike - Read-only
                    cellContent = `<span class="text-center">$${parseFloat(trade.strike_price || 0).toFixed(2)}</span>`;
                    break;
                case 6: // Credit - Read-only
                    cellContent = `<span class="text-center">$${parseFloat(trade.credit_debit || trade.premium).toFixed(2)}</span>`;
                    break;
                case 7: // Contracts - Editable
                    cellContent = `
                        <input type="number" 
                               class="form-control form-control-sm text-center" 
                               value="${trade.num_of_contracts}" 
                               step="1"
                               min="1"
                               data-trade-id="${trade.id}" 
                               data-field="num_of_contracts" 
                               onchange="updateTradeField(${trade.id}, 'num_of_contracts', this.value)"
                               style="width: 60px; display: inline-block;">
                    `;
                    break;
                case 8: // Shares - Read-only (calculated from num_of_contracts)
                    cellContent = `<span class="text-center">${trade.num_of_contracts * 100}</span>`;
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
                case 15: // Status - Editable dropdown (case-insensitive)
                    const tradeStatusLower = trade.trade_status ? trade.trade_status.toLowerCase() : 'open';
                    cellContent = `
                        <div class="text-center">
                            <select class="form-select form-select-sm status-select" data-trade-id="${trade.id}" onchange="updateTradeStatus(${trade.id}, this.value)">
                                <option value="open" ${tradeStatusLower === 'open' ? 'selected' : ''}>Open</option>
                                <option value="closed" ${tradeStatusLower === 'closed' ? 'selected' : ''}>Closed</option>
                                <option value="assigned" ${tradeStatusLower === 'assigned' ? 'selected' : ''}>Assigned</option>
                                <option value="expired" ${tradeStatusLower === 'expired' ? 'selected' : ''}>Expired</option>
                                <option value="roll" ${tradeStatusLower === 'roll' ? 'selected' : ''}>Roll</option>
                            </select>
                        </div>
                    `;
                    break;
                case 16: // Actions - Delete only
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
            
            // Apply fixed column width to data cells - 160px with visibility control
            const visibilityStyle = isVisible ? '' : 'display: none;';
            // Top align for Symbol/Type column (fieldIndex 0), middle align for dates (1, 3)
            let verticalAlign = '';
            if (fieldIndex === 0) {
                verticalAlign = 'vertical-align: top;';
            } else if (fieldIndex === 1 || fieldIndex === 3) {
                verticalAlign = 'vertical-align: middle;';
            }
            row.innerHTML += `<td style="${bgColor}; width: 160px; min-width: 160px; max-width: 160px; ${visibilityStyle} ${verticalAlign}">${cellContent}</td>`;
        });
        
        fragment.appendChild(row);
    });
    
    // Append all rows at once for better performance
    tbody.appendChild(fragment);
    
    console.log('Trades table update completed. Rows:', tbody.children.length);
    
    // Set table width based on total columns (fixed width)
    setTableWidth();
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
    
    // Calculate total width: 150px (field column) + (total columns × 160px)
    const totalWidth = 150 + (totalColumns * 160);
    table.style.width = `${totalWidth}px`;
}

function updateCostBasisTable(costBasisData) {
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
        const { ticker, company_name, total_shares, total_cost_basis, total_cost_basis_per_share, trades } = tickerData;
        
        html += `
            <div class="mb-4">
                <div class="d-flex justify-content-between align-items-center mb-3">
                    <h6 class="text-primary mb-0">
                        <i class="fas fa-chart-line me-2"></i>${ticker} - ${company_name || ticker}
                    </h6>
                </div>
                
                <!-- Summary Cards -->
                <div class="row mb-2 g-2">
                    <div class="col-md-2">
                        <div class="card bg-light">
                            <div class="card-body text-center p-2">
                                <h6 class="card-title mb-1" style="font-size: 0.75rem;">Total Shares</h6>
                                <p class="card-text mb-0" style="font-size: 1.1rem; ${total_shares < 0 ? 'color: red;' : ''}">${total_shares < 0 ? `(${Math.abs(total_shares).toLocaleString()})` : total_shares.toLocaleString()}</p>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-2">
                        <div class="card bg-light">
                            <div class="card-body text-center p-2">
                                <h6 class="card-title mb-1" style="font-size: 0.75rem;">Total Cost Basis</h6>
                                <p class="card-text mb-0" style="font-size: 1.1rem; ${total_cost_basis < 0 ? 'color: red;' : ''}">${total_cost_basis < 0 ? `($${Math.abs(total_cost_basis).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})})` : `$${total_cost_basis.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</p>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-2">
                        <div class="card bg-light">
                            <div class="card-body text-center p-2">
                                <h6 class="card-title mb-1" style="font-size: 0.75rem;">Cost Basis/Share</h6>
                                <p class="card-text mb-0" style="font-size: 1.1rem; ${total_cost_basis_per_share < 0 ? 'color: red;' : ''}">${total_cost_basis_per_share < 0 ? `($${Math.abs(total_cost_basis_per_share).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})})` : `$${total_cost_basis_per_share.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</p>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-2">
                        <div class="card bg-light">
                            <div class="card-body text-center p-2">
                                <h6 class="card-title mb-1" style="font-size: 0.75rem;">Total Trades</h6>
                                <p class="card-text mb-0" style="font-size: 1.1rem;">${trades.length}</p>
                            </div>
                        </div>
                    </div>
                </div>
                
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
        trades.forEach(trade => {
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
            
            // Apply color coding based on status and trade type (from backup)
            const tradeType = trade.trade_description || '';
            const status = trade.trade_status || 'open';
            let bgColor = '';
            
            // Check if this is an expired or assigned trade from the description
            const isAssignedDescription = tradeType.toUpperCase().includes('ASSIGNED');
            const isExpired = status === 'expired' || (tradeType.toUpperCase().includes('EXPIRED') && !isAssignedDescription);
            const isAssigned = status === 'assigned' && !isAssignedDescription;  // Only highlight if it's from trade status, not description
            const isPut = tradeType.toLowerCase().includes('put') || tradeType.toLowerCase().includes('bought');
            const isCall = tradeType.toLowerCase().includes('call') || tradeType.toLowerCase().includes('sold');
            
            // Color code for roll, expired, and assigned trades (from backup)
            // Don't color code entries with "ASSIGNED" in the description (those are the cost basis entries we created)
            if (!isAssignedDescription) {
                if (status === 'roll' || tradeType.toUpperCase().includes('ROLL')) {
                    bgColor = 'background-color: #FFF2CC;';
                } else if (isExpired && isPut) {
                    bgColor = 'background-color: #C6E0B4;';
                } else if (isAssigned && isPut) {
                    bgColor = 'background-color: #A9D08F;';
                } else if (isAssigned && isCall) {
                    bgColor = 'background-color: #9BC2E6;';
                } else if (isExpired && isCall) {
                    bgColor = 'background-color: #DEEAF7;';
                }
            }
            
            const rowStyle = bgColor ? `style="${bgColor}"` : '';
            
            html += `
                <tr ${rowStyle}>
                    <td class="text-center align-middle">${formatDate(trade.trade_date)}</td>
                    <td class="text-start align-middle" style="width: 25%; word-wrap: break-word; overflow-wrap: break-word;">${trade.trade_description || ''}</td>
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
    
    container.innerHTML = html;
}

// ============================================================================
// SYMBOL FILTERING FUNCTIONS
// ============================================================================

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
    
    // Show down arrow button
    const jumpToCostBasisBtn = document.getElementById('jump-to-cost-basis');
    if (jumpToCostBasisBtn) {
        jumpToCostBasisBtn.style.display = 'inline-block';
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
    
    // Show up arrow button
    const jumpToTradesBtn = document.getElementById('jump-to-trades');
    if (jumpToTradesBtn) {
        jumpToTradesBtn.style.display = 'inline-block';
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

function selectSymbol(symbol) {
    filterBySymbol(symbol);
}

function selectCostBasisSymbol(symbol) {
    console.log('selectCostBasisSymbol called with:', symbol);
    selectedTicker = symbol;
    
    // Update trades table symbol filter
    window.symbolFilter = symbol;
    const symbolFilterInput = document.getElementById('symbol-filter');
    const clearButton = document.getElementById('clear-symbol');
    
    if (symbolFilterInput) {
        symbolFilterInput.value = symbol;
    }
    
    if (clearButton) {
        clearButton.style.display = 'inline-block';
    }
    
    // Update cost basis symbol filter
    const costBasisSymbolFilter = document.getElementById('cost-basis-symbol-filter');
    const costBasisClearButton = document.getElementById('clear-cost-basis-symbol');
    
    if (costBasisSymbolFilter) {
        costBasisSymbolFilter.value = symbol;
    }
    
    if (costBasisClearButton) {
        costBasisClearButton.style.display = 'inline-block';
    }
    
    console.log('Updating trades table...');
    updateTradesTable();
    console.log('Loading cost basis for symbol:', symbol);
    loadCostBasis(symbol);
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
    updateTradesTable();
    showAllSymbolsFromTrades(); // Show symbols instantly without API call
}

function showAllSymbols(data = null) {
    const costBasisContainer = document.getElementById('cost-basis-table-container');
    if (!costBasisContainer) return;
    
    // Get all unique tickers from trades data - we already have this loaded!
    const allTickers = [...new Set(trades.map(trade => trade.ticker))].filter(ticker => ticker && ticker.trim() !== '');
    
    if (allTickers.length === 0) {
        costBasisContainer.innerHTML = `
            <div class="text-center text-muted">
                <i class="fas fa-info-circle me-2"></i>
                No trades found. Add some trades to see symbols here.
            </div>
        `;
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
            <div class="col-md-1 col-sm-2 col-3 mb-2">
                <div class="card h-100 symbol-card" onclick="selectCostBasisSymbol('${ticker}')" style="cursor: pointer;">
                    <div class="card-body text-center p-1">
                        <h6 class="card-title text-primary mb-0" style="font-size: 0.8rem;">${ticker}</h6>
                    </div>
                </div>
            </div>
        `;
    });
    symbolsHtml += '</div>';
    
    costBasisContainer.innerHTML = symbolsHtml;
}

// Optimized version that skips API call when clearing filters
function showAllSymbolsFromTrades() {
    console.log('Showing all symbols from trades data (no API call)');
    showAllSymbols(null);
}

function hideCostBasisTable() {
    const container = document.getElementById('cost-basis-table-container');
    if (container) {
        container.innerHTML = '';
    }
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
            await loadTrades();
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

async function updateTradeField(tradeId, field, value) {
    try {
        const response = await fetch(`/api/trades/${tradeId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value })
        });
        
        const result = await response.json();
        
        if (result.success) {
            await loadTrades();
            loadSummary();
            // Reload cost basis with the selected ticker if one is set
            const selectedTicker = window.symbolFilter || document.getElementById('symbol-filter')?.value || '';
            await loadCostBasis(selectedTicker);
        } else {
            alert('Failed to update trade field: ' + result.error);
        }
    } catch (error) {
        console.error('Error updating trade field:', error);
        alert('Error updating trade field: ' + error.message);
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

function setupTradesToggle() {
    const tradesCollapse = document.getElementById('tradesCollapse');
    const tradesToggleIcon = document.getElementById('tradesToggleIcon');
    
    if (!tradesCollapse || !tradesToggleIcon) {
        console.error('Trades collapse elements not found');
        return;
    }
    
    // Set initial icon state (expanded = chevron-down)
    tradesToggleIcon.className = 'fas fa-chevron-down section-toggle-icon';
    
    // Listen for collapse events
    tradesCollapse.addEventListener('show.bs.collapse', function() {
        tradesToggleIcon.className = 'fas fa-chevron-down section-toggle-icon';
    });
    
    tradesCollapse.addEventListener('hide.bs.collapse', function() {
        tradesToggleIcon.className = 'fas fa-chevron-right section-toggle-icon';
    });
    
    console.log('Trades toggle setup complete');
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
        
        // Populate all account dropdowns
        const accountSelects = document.querySelectorAll('[id$="-account"], [id$="-account-id"]');
        accountSelects.forEach(select => {
            select.innerHTML = '';
            // Sort accounts so Rule One appears first
            const sortedAccounts = [...accounts].sort((a, b) => {
                if (a.id === 9) return -1;
                if (b.id === 9) return 1;
                return a.account_name.localeCompare(b.account_name);
            });
            
            sortedAccounts.forEach((account, index) => {
                const option = document.createElement('option');
                option.value = account.id;
                option.textContent = account.account_name;
                // Set Rule One (id=9) as default
                if (account.id === 9) {
                    option.selected = true;
                }
                select.appendChild(option);
            });
        });
    } catch (error) {
        console.error('Error loading accounts:', error);
    }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded, initializing app...');
    
    // Load commission settings
    loadCommission();
    
    // Load accounts
    loadAccounts();
    
    // Load initial data
    loadTrades();
    loadSummary();
    loadCostBasis();
    loadTopSymbols();
    
    // Initialize chart
    initializeChart();
    
    // Update chart with data
    updateChart();
    
    // Set up event listeners
    setupTradesSymbolFilter();
    setupStatusFilter();
    setupCostBasisSymbolFilter();
    setupDashboardToggle();
    setupTradesToggle();
    setupCostBasisToggle();
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
        
        // Clear editing state
        form.removeAttribute('data-editing-trade-id');
        form.removeAttribute('data-editing-ticker');
        
        // Button visibility will be handled by the delayed setTimeout below
    }
    
    // Setup DTE calculation
    setupDTECalculation('roct-put-trade-date', 'roct-put-expiration-date', 'roct-put-dte');
    
    // Setup autocomplete
    setupAutocomplete('roct-put-underlying', 'roct-put-underlying-suggestions');
    
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
        // Use dashboard date filters if available, otherwise use all time
        const dashboardStartDate = document.getElementById('dashboard-start-date')?.value;
        const dashboardEndDate = document.getElementById('dashboard-end-date')?.value;
        
        const params = new URLSearchParams();
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
    
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        const response = await fetch('/api/import-excel', {
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
            let message = `Successfully imported ${result.imported} trades.`;
            if (result.skipped > 0) {
                message += `\n${result.skipped} duplicate trades skipped.`;
            }
            if (result.errors && result.errors.length > 0) {
                console.error('Import errors:', result.errors);
                message += '\n\nErrors:\n' + result.errors.join('\n');
            }
            alert(message);
            // Reload trades table
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
}

// Add event listener for Excel upload
document.addEventListener('DOMContentLoaded', function() {
    const excelUpload = document.getElementById('excel-upload');
    if (excelUpload) {
        excelUpload.addEventListener('change', handleExcelUpload);
    }
});

