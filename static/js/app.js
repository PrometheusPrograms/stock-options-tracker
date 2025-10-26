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

function formatDate(dateString) {
    if (!dateString) return '';
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
    // Fallback for unexpected format
    const date = new Date(dateString);
    const day = date.getDate().toString().padStart(2, '0');
    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const month = monthNames[date.getMonth()];
    const year = date.getFullYear().toString().slice(-2);
    return `${day}-${month}-${year}`;
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
        
        // Convert dates from DD-MMM-YY to YYYY-MM-DD format
        if (data.tradeDate) {
            try {
                const dateParts = data.tradeDate.split('-');
                if (dateParts.length === 3) {
                    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
                    const monthIndex = monthNames.indexOf(dateParts[1].toUpperCase());
                    if (monthIndex !== -1) {
                        const year = 2000 + parseInt(dateParts[2]);
                        const month = (monthIndex + 1).toString().padStart(2, '0');
                        const day = dateParts[0].padStart(2, '0');
                        data.tradeDate = `${year}-${month}-${day}`;
                    }
                }
            } catch (e) {
                console.error('Error parsing tradeDate:', e);
            }
        }
        
        if (data.expirationDate) {
            try {
                const dateParts = data.expirationDate.split('-');
                if (dateParts.length === 3) {
                    const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
                    const monthIndex = monthNames.indexOf(dateParts[1].toUpperCase());
                    if (monthIndex !== -1) {
                        const year = 2000 + parseInt(dateParts[2]);
                        const month = (monthIndex + 1).toString().padStart(2, '0');
                        const day = dateParts[0].padStart(2, '0');
                        data.expirationDate = `${year}-${month}-${day}`;
                    }
                }
            } catch (e) {
                console.error('Error parsing expirationDate:', e);
            }
        }
    } else if (formType === 'STC') {
        data.tradeType = 'STC';
    } else if (formType === 'BTO') {
        data.tradeType = 'BTO';
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
    
    // Add event listeners
    tradeDateField.addEventListener('change', calculateDTE);
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
    
    // Create SVG
    const svg = d3.select(container)
        .append("svg")
        .attr("width", width)
        .attr("height", height);
    
    const g = svg.append("g")
        .attr("transform", `translate(${width/2},${height/2})`);
    
    // Calculate unused bankroll (total minus used)
    const unusedBankroll = totalBankroll - usedBankroll;
    
    // Create children for "Used" segment - if we have breakdown data
    let usedChildren = [{ name: "Used", value: usedBankroll }];
    
    // If breakdown data is available, create hierarchical structure for "Used"
    if (breakdown && Object.keys(breakdown).length > 0) {
        const breakdownChildren = Object.keys(breakdown).map(tradeType => ({
            name: tradeType,
            value: Math.abs(breakdown[tradeType].margin_capital)
        }));
        
        if (breakdownChildren.length > 0) {
            usedChildren = [{
                name: "Used",
                children: breakdownChildren
            }];
        }
    }
    
    // Create data for bankroll with hierarchical segments
    const data = {
        name: "Bankroll",
        children: [
            ...usedChildren,
            { name: "Available", value: availableBankroll },
            { name: "Unused", value: unusedBankroll }
        ]
    };
    
    // Create partition layout - adjust for hierarchical display
    const partition = d3.partition()
        .size([2 * Math.PI, radius])
        .padding(0.05); // Add padding between segments
    
    // Create hierarchy
    const root = d3.hierarchy(data)
        .sum(d => d.value);
    
    partition(root);
    
    // Dynamic color scale based on breakdown
    const colors = {
        "Used": "#dc3545",
        "Available": "#28a745",
        "Unused": "#6c757d",
        "AAPL ROCT PUT": "#ff6384",
        "RIVN ROCT PUT": "#ff9f40",
        "TSLA ROCT CALL": "#ffcd56",
        "MSFT ROCT PUT": "#4bc0c0",
        "NVDA ROCT PUT": "#9966ff",
        "META ROCT PUT": "#ff6384"
    };
    
    const color = d => colors[d.data.name] || "#6c757d";
    
    // Create arcs
    const arc = d3.arc()
        .startAngle(d => d.x0)
        .endAngle(d => d.x1)
        .innerRadius(d => d.y0)
        .outerRadius(d => d.y1);
    
    // Add arcs to chart
    const paths = g.selectAll("path")
        .data(root.descendants())
        .enter()
        .append("path")
        .attr("d", arc)
        .style("fill", d => d.depth === 0 ? "#6c757d" : color(d))
        .style("stroke", "#fff")
        .style("stroke-width", d => d.depth === 0 ? 0 : 1.5)
        .style("opacity", d => d.depth === 1 ? 1 : 0.9)
        .style("cursor", "pointer")
        .attr("class", d => `bankroll-segment depth-${d.depth}`)
        .attr("title", d => `${d.data.name}: $${formatCurrency(d.value)}`);
    
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
    // Convert DD-MMM-YY to MM/DD/YY for editing
    const currentValue = inputElement.value;
    if (currentValue && currentValue.includes('-') && currentValue.length === 8) {
        // Parse DD-MMM-YY format
        const parts = currentValue.split('-');
        if (parts.length === 3) {
            const day = parts[0];
            const month = parts[1];
            const year = parts[2];
            
            // Convert month name to number
            const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 
                              'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
            const monthNum = monthNames.indexOf(month.toUpperCase());
            if (monthNum !== -1) {
                const monthStr = (monthNum + 1).toString().padStart(2, '0');
                inputElement.value = `${monthStr}/${day}/${year}`;
                inputElement.placeholder = 'MM/DD/YY';
            }
        }
    }
    // Select all text for easy editing
    inputElement.select();
}

function handleDateInputBlur(inputElement) {
    // Convert MM/DD/YY back to DD-MMM-YY for display
    const currentValue = inputElement.value;
    if (currentValue && currentValue.includes('/') && currentValue.length === 8) {
        // Parse MM/DD/YY format
        const parts = currentValue.split('/');
        if (parts.length === 3) {
            const month = parts[0];
            const day = parts[1];
            const year = parts[2];
            
            // Convert month number to name
            const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 
                              'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
            const monthIndex = parseInt(month) - 1;
            if (monthIndex >= 0 && monthIndex < 12) {
                const monthName = monthNames[monthIndex];
                inputElement.value = `${day}-${monthName}-${year}`;
                inputElement.placeholder = 'DD-MMM-YY';
            }
        }
    } else if (!currentValue) {
        // If empty, set to today's date in DD-MMM-YY format
        const today = new Date();
        const day = today.getDate().toString().padStart(2, '0');
        const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 
                          'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        const month = monthNames[today.getMonth()];
        const year = today.getFullYear().toString().slice(-2);
        inputElement.value = `${day}-${month}-${year}`;
        inputElement.placeholder = 'DD-MMM-YY';
    }
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
            const netCreditTotal = netCreditPerShare * (trade.num_of_contracts * 100); // Net Credit Total = Net Credit Per Share * Shares
            const riskCapital = trade.strike_price - netCreditPerShare; // Risk Capital = Strike - Net Credit Per Share
            const marginCapital = riskCapital * (trade.num_of_contracts * 100);
            const rorc = riskCapital !== 0 ? (netCreditPerShare / riskCapital) * 100 : 0; // RORC = Net Credit Per Share / Risk Capital
            const arorc = trade.days_to_expiration > 0 ? (365 / trade.days_to_expiration) * rorc : 0;
            
            switch (fieldIndex) {
                case 0: // Symbol/Type (back to first row)
                    const today = new Date();
                    const expirationDate = new Date(trade.expiration_date);
                    const isExpired = trade.status === 'open' && today > expirationDate;
                    cellContent = `<div style="text-align: center; white-space: normal; word-wrap: break-word; vertical-align: top;"><strong>${isExpired ? '<i class="fas fa-exclamation-triangle text-danger me-1" title="Expired"></i>' : ''}<span class="clickable-symbol" onclick="filterBySymbol('${trade.ticker}')" style="cursor: pointer; color: #007bff; text-decoration: underline;">${trade.ticker}</span> ${tradeType}</strong></div>`;
                    break;
                case 1: // Trade Date (moved to second row) - Custom date input
                    const tradeDateDisplay = formatDate(trade.trade_date || trade.created_at);
                    cellContent = `
                        <div class="text-center">
                            <input type="text" 
                                   class="form-control form-control-sm text-center d-inline-block" 
                                   placeholder="DD-MMM-YY" 
                                   value="${tradeDateDisplay}" 
                                   data-trade-id="${trade.id}" 
                                   data-field="trade_date" 
                                   data-display-format="DD-MMM-YY"
                                   data-edit-format="MM/DD/YY"
                                   onfocus="handleDateInputFocus(this)"
                                   onblur="handleDateInputBlur(this)"
                                   onchange="updateTradeDate(${trade.id}, 'trade_date', this.value)"
                                   style="width: 100px;">
                        </div>
                    `;
                    break;
                case 2: // Price (was Trade Price) - Editable
                    cellContent = `<div class="text-center d-flex justify-content-center align-items-center"><span class="text-muted me-1">$</span><input type="text" class="form-control form-control-sm text-center" value="${parseFloat(trade.current_price || trade.price || 0).toFixed(2)}" data-trade-id="${trade.id}" data-field="current_price" onchange="updateTradeField(${trade.id}, 'current_price', this.value)" style="width: 80px;"></div>`;
                    break;
                case 3: // Exp Date (was Expiration) - Custom date input
                    const expDateDisplay = formatDate(trade.expiration_date);
                    cellContent = `
                        <div class="text-center">
                            <input type="text" 
                                   class="form-control form-control-sm text-center d-inline-block" 
                                   placeholder="DD-MMM-YY" 
                                   value="${expDateDisplay}" 
                                   data-trade-id="${trade.id}" 
                                   data-field="expiration_date" 
                                   data-display-format="DD-MMM-YY"
                                   data-edit-format="MM/DD/YY"
                                   onfocus="handleDateInputFocus(this)"
                                   onblur="handleDateInputBlur(this)"
                                   onchange="updateTradeDate(${trade.id}, 'expiration_date', this.value)"
                                   style="width: 100px;">
                        </div>
                    `;
                    break;
                case 4: // DTE (was Days to Exp) - Read-only (calculated)
                    cellContent = `<span class="text-center">${trade.days_to_expiration || calculateDaysToExpiration(trade.expiration_date, trade.trade_date)}</span>`;
                    break;
                case 5: // Strike (was Strike Price) - Editable
                    cellContent = `<div class="text-center d-flex justify-content-center align-items-center"><span class="text-muted me-1">$</span><input type="text" class="form-control form-control-sm text-center" value="${parseFloat(trade.strike_price || 0).toFixed(2)}" data-trade-id="${trade.id}" data-field="strike_price" onchange="updateTradeField(${trade.id}, 'strike_price', this.value)" style="width: 80px;"></div>`;
                    break;
                case 6: // Credit (was Premium) - Editable
                    cellContent = `<div class="text-center d-flex justify-content-center align-items-center"><span class="text-muted me-1">$</span><input type="text" class="form-control form-control-sm text-center" value="${parseFloat(trade.premium).toFixed(2)}" data-trade-id="${trade.id}" data-field="premium" onchange="updateTradeField(${trade.id}, 'premium', this.value)" style="width: 80px;"></div>`;
                    break;
                case 7: // Contracts - Editable (num_of_contracts)
                    cellContent = `<div class="text-center"><input type="number" class="form-control form-control-sm text-center d-inline-block" value="${trade.num_of_contracts}" step="1" data-trade-id="${trade.id}" data-field="num_of_contracts" onchange="updateTradeField(${trade.id}, 'num_of_contracts', this.value)" style="width: 80px;"></div>`;
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
            // Top align for Symbol/Type column (fieldIndex 0), middle align for dates (1, 3)
            let verticalAlign = '';
            if (fieldIndex === 0) {
                verticalAlign = 'vertical-align: top;';
            } else if (fieldIndex === 1 || fieldIndex === 3) {
                verticalAlign = 'vertical-align: middle;';
            }
            row.innerHTML += `<td style="${bgColor}; width: 160px; min-width: 160px; max-width: 160px; ${visibilityStyle} ${verticalAlign}">${cellContent}</td>`;
        });
        
        tbody.appendChild(row);
    });
    
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
                
                <!-- Transactions Table -->
                <div class="table-responsive">
                    <table class="table table-sm table-striped">
                        <thead class="table-dark">
                            <tr>
                                <th>Trade Description</th>
                                <th class="text-end">Trade Date</th>
                                <th class="text-end">Shares</th>
                                <th class="text-end">Cost</th>
                                <th class="text-end">Amount</th>
                                <th class="text-end">Basis</th>
                                <th class="text-end">Basis/Share</th>
                            </tr>
                        </thead>
                        <tbody>
        `;
        
        // Add each trade as a row
        trades.forEach(trade => {
            // Check if this is an assigned trade
            const isAssigned = trade.trade_description && trade.trade_description.toUpperCase().includes('ASSIGNED');
            const rowStyle = isAssigned ? 'style="background-color: #fff3cd;"' : '';
            
            html += `
                <tr ${rowStyle}>
                    <td ${isAssigned ? 'style="font-weight: bold; color: #856404;"' : ''}>${trade.trade_description || ''}</td>
                    <td class="text-end">${formatDate(trade.trade_date)}</td>
                    <td class="text-end ${trade.shares < 0 ? 'text-danger' : ''}">${trade.shares < 0 ? `(${Math.abs(trade.shares).toLocaleString()})` : trade.shares.toLocaleString()}</td>
                    <td class="text-end">${trade.cost_per_share ? `$${trade.cost_per_share.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : ''}</td>
                    <td class="text-end ${trade.amount < 0 ? 'text-danger' : ''}">${trade.amount < 0 ? `($${Math.abs(trade.amount).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})})` : `$${trade.amount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</td>
                    <td class="text-end ${trade.running_basis < 0 ? 'text-danger' : ''}">${trade.running_basis < 0 ? `($${Math.abs(trade.running_basis).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})})` : `$${trade.running_basis.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</td>
                    <td class="text-end ${trade.running_basis_per_share < 0 ? 'text-danger' : ''}">${trade.running_basis_per_share < 0 ? `($${Math.abs(trade.running_basis_per_share).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})})` : `$${trade.running_basis_per_share.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</td>
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
    
    // Update both tables
    updateTradesTable();
    loadCostBasis(); // Load all symbols
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
    
    // Update both tables
    updateTradesTable();
    loadCostBasis(); // Load all symbols
}

function showAllSymbols(data) {
    const costBasisContainer = document.getElementById('cost-basis-table-container');
    if (!costBasisContainer) return;
    
    // Get all unique tickers from trades data, not just cost basis data
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
    
    // Group cost basis data by ticker for counting entries
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
        const costBasisData = costBasisGroups[ticker];
        const tradeCount = costBasisData ? costBasisData.count : 0;
        
        symbolsHtml += `
            <div class="col-md-3 col-sm-4 col-6 mb-3">
                <div class="card h-100 symbol-card" onclick="selectCostBasisSymbol('${ticker}')" style="cursor: pointer;">
                    <div class="card-body text-center">
                        <h5 class="card-title text-primary">${ticker}</h5>
                        <p class="card-text text-muted">${tradeCount} entry${tradeCount !== 1 ? 'ies' : ''}</p>
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
                Available Stock Symbols (${allTickers.length})
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
    if (container) {
        container.innerHTML = `
            <div class="text-center text-muted">
                <i class="fas fa-info-circle me-2"></i>
                Click on a stock symbol above to view its cost basis
            </div>
        `;
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
            await loadCostBasis();
        } else {
            alert('Failed to update trade status: ' + result.error);
        }
    } catch (error) {
        console.error('Error updating trade status:', error);
        alert('Error updating trade status: ' + error.message);
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
            loadCostBasis();
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
                label: 'Daily Premium',
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

// Debug function to log section widths with detailed info
function logDetailedSectionInfo() {
    const dashboard = document.getElementById('dashboard');
    const trades = document.getElementById('trades');
    const costBasis = document.getElementById('cost-basis');

    console.log('=== SECTION WIDTH COMPARISON ===');
    if (dashboard) {
        const dashStyle = window.getComputedStyle(dashboard);
        console.log('Dashboard:', {
            width: dashboard.offsetWidth,
            paddingLeft: dashStyle.paddingLeft,
            paddingRight: dashStyle.paddingRight,
            marginLeft: dashStyle.marginLeft,
            marginRight: dashStyle.marginRight,
            boxSizing: dashStyle.boxSizing
        });
    }
    if (trades) {
        const tradesStyle = window.getComputedStyle(trades);
        console.log('Trades:', {
            width: trades.offsetWidth,
            paddingLeft: tradesStyle.paddingLeft,
            paddingRight: tradesStyle.paddingRight,
            marginLeft: tradesStyle.marginLeft,
            marginRight: tradesStyle.marginRight,
            boxSizing: tradesStyle.boxSizing
        });
        
        // Check child elements
        const tradesCardBody = trades.querySelector('.card-body');
        const tradesContentContainer = trades.querySelector('.dashboard-content-container');
        if (tradesCardBody) {
            const bodyStyle = window.getComputedStyle(tradesCardBody);
            console.log('Trades .card-body:', {
                width: tradesCardBody.offsetWidth,
                paddingLeft: bodyStyle.paddingLeft,
                paddingRight: bodyStyle.paddingRight
            });
        }
        if (tradesContentContainer) {
            const contStyle = window.getComputedStyle(tradesContentContainer);
            console.log('Trades .dashboard-content-container:', {
                width: tradesContentContainer.offsetWidth,
                paddingLeft: contStyle.paddingLeft,
                paddingRight: contStyle.paddingRight
            });
        }
    }
    if (costBasis) {
        const costStyle = window.getComputedStyle(costBasis);
        console.log('Cost Basis:', {
            width: costBasis.offsetWidth,
            paddingLeft: costStyle.paddingLeft,
            paddingRight: costStyle.paddingRight,
            marginLeft: costStyle.marginLeft,
            marginRight: costStyle.marginRight,
            boxSizing: costStyle.boxSizing
        });
        
        // Check child elements
        const costCardBody = costBasis.querySelector('.card-body');
        const costContentContainer = costBasis.querySelector('.dashboard-content-container');
        if (costCardBody) {
            const bodyStyle = window.getComputedStyle(costCardBody);
            console.log('Cost Basis .card-body:', {
                width: costCardBody.offsetWidth,
                paddingLeft: bodyStyle.paddingLeft,
                paddingRight: bodyStyle.paddingRight
            });
        }
        if (costContentContainer) {
            const contStyle = window.getComputedStyle(costContentContainer);
            console.log('Cost Basis .dashboard-content-container:', {
                width: costContentContainer.offsetWidth,
                paddingLeft: contStyle.paddingLeft,
                paddingRight: contStyle.paddingRight
            });
        }
        
        const costRow = costBasis.querySelector('.dashboard-content-container .row');
        if (costRow) {
            const rowStyle = window.getComputedStyle(costRow);
            console.log('Cost Basis .row:', {
                width: costRow.offsetWidth,
                marginLeft: rowStyle.marginLeft,
                marginRight: rowStyle.marginRight,
                paddingLeft: rowStyle.paddingLeft,
                paddingRight: rowStyle.paddingRight
            });
        }
        
        // Also check dashboard-content-container
        if (costContentContainer) {
            const contStyle = window.getComputedStyle(costContentContainer);
            console.log('Cost Basis .dashboard-content-container:', {
                width: costContentContainer.offsetWidth,
                maxWidth: contStyle.maxWidth,
                paddingLeft: contStyle.paddingLeft,
                paddingRight: contStyle.paddingRight,
                marginLeft: contStyle.marginLeft,
                marginRight: contStyle.marginRight
            });
        }
        
        const costCol12 = costBasis.querySelector('.col-12');
        if (costCol12) {
            const colStyle = window.getComputedStyle(costCol12);
            console.log('Cost Basis .col-12:', {
                width: costCol12.offsetWidth,
                paddingLeft: colStyle.paddingLeft,
                paddingRight: colStyle.paddingRight
            });
        }
        
        // Check the parent .col-12 of the main card
        const costBasisCard = costBasis;
        const costBasisParent = costBasisCard.parentElement;
        if (costBasisParent && costBasisParent.classList.contains('col-12')) {
            const parentStyle = window.getComputedStyle(costBasisParent);
            console.log('Cost Basis parent .col-12:', {
                width: costBasisParent.offsetWidth,
                paddingLeft: parentStyle.paddingLeft,
                paddingRight: parentStyle.paddingRight
            });
        }
    }
    
    // Also check trades parent
    if (trades) {
        const tradesCard = trades;
        const tradesParent = tradesCard.parentElement;
        if (tradesParent && tradesParent.classList.contains('col-12')) {
            const parentStyle = window.getComputedStyle(tradesParent);
            console.log('Trades parent .col-12:', {
                width: tradesParent.offsetWidth,
                paddingLeft: parentStyle.paddingLeft,
                paddingRight: parentStyle.paddingRight
            });
        }
    }
    
    console.log('================================');
}

window.addEventListener('load', function() {
    setTimeout(logDetailedSectionInfo, 1000);
});
