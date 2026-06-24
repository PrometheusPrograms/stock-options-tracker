let trades = [];
let cachedTrades = null; // Cache original unfiltered trades data
let cachedCostBasis = null; // Cache original unfiltered cost basis data
let currentFilter = { startDate: null, endDate: null, period: 'all' };
let statusFilter = '';
let sortColumn = 'date_trade_open'; // Default to sorting by trade date
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
// CENTRALIZED FETCH UTILITY
// ============================================================================

/**
 * Centralized fetch utility with cancellation, timeout, and unified error handling
 * @param {string} url - The URL to fetch
 * @param {Object} options - Fetch options
 * @param {string} options.method - HTTP method (default: 'GET')
 * @param {Object} options.headers - Request headers
 * @param {Object} options.body - Request body (will be JSON stringified if object)
 * @param {AbortSignal} options.signal - AbortSignal for cancellation
 * @param {number} options.timeout - Request timeout in milliseconds (default: 30000)
 * @param {number} options.retries - Number of retry attempts (default: 0)
 * @param {number} options.retryDelay - Delay between retries in milliseconds (default: 1000)
 * @param {string} options.requestId - Unique identifier for this request (for cancellation tracking)
 * @param {boolean} options.silent - If true, don't log errors (default: false)
 * @returns {Promise<Response>} - Fetch response
 */
// Track active requests for cancellation
const activeRequests = new Map();

const apiFetch = async function apiFetch(url, options = {}) {
    const {
        method = 'GET',
        headers = {},
        body = null,
        signal = null,
        timeout = 30000,
        retries = 0,
        retryDelay = 1000,
        requestId = null,
        silent = false
    } = options;
    
    // Create AbortController for timeout
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
        timeoutController.abort();
    }, timeout);
    
    // Combine signals if both provided
    let combinedSignal = timeoutController.signal;
    if (signal) {
        const combinedController = new AbortController();
        const abortHandler = () => combinedController.abort();
        signal.addEventListener('abort', abortHandler);
        timeoutController.signal.addEventListener('abort', abortHandler);
        combinedSignal = combinedController.signal;
    }
    
    // Prepare request options
    const fetchOptions = {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...headers
        },
        signal: combinedSignal
    };
    
    // Handle body - stringify if object, remove Content-Type if FormData
    if (body !== null) {
        if (body instanceof FormData) {
            delete fetchOptions.headers['Content-Type']; // Let browser set multipart boundary
            fetchOptions.body = body;
        } else if (typeof body === 'object') {
            fetchOptions.body = JSON.stringify(body);
        } else {
            fetchOptions.body = body;
        }
    }
    
    // Track request if requestId provided
    if (requestId) {
        activeRequests.set(requestId, { controller: timeoutController, url });
    }
    
    let lastError = null;
    let attempt = 0;
    
    while (attempt <= retries) {
        try {
            if (attempt > 0 && !silent) {
                console.log(`Retrying request to ${url} (attempt ${attempt + 1}/${retries + 1})`);
            }
            
            const response = await fetch(url, fetchOptions);
            
            // Clear timeout on success
            clearTimeout(timeoutId);
            
            // Remove from active requests
            if (requestId) {
                activeRequests.delete(requestId);
            }
            
            // Check if response is OK
            if (!response.ok) {
                let errorMessage = `Request failed with status ${response.status}`;
                try {
                    const errorData = await response.json();
                    if (errorData.error) {
                        errorMessage = errorData.error;
                    }
                } catch (e) {
                    // If response is not JSON, try text
                    try {
                        const errorText = await response.text();
                        if (errorText) {
                            errorMessage = errorText;
                        }
                    } catch (e2) {
                        // Ignore parsing errors
                    }
                }
                
                const error = new Error(errorMessage);
                error.status = response.status;
                error.response = response;
                
                // Don't retry on client errors (4xx) except 408, 429
                if (response.status >= 400 && response.status < 500 && 
                    response.status !== 408 && response.status !== 429) {
                    if (!silent) {
                        console.error(`API Error (${response.status}):`, errorMessage);
                    }
                    throw error;
                }
                
                // Retry on server errors (5xx) or specific client errors
                if (attempt < retries) {
                    lastError = error;
                    await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                    attempt++;
                    continue;
                }
                
                throw error;
            }
            
            return response;
            
        } catch (error) {
            // Clear timeout on error
            clearTimeout(timeoutId);
            
            // Remove from active requests
            if (requestId) {
                activeRequests.delete(requestId);
            }
            
            // Handle abort errors (timeout or manual cancellation)
            if (error.name === 'AbortError') {
                if (!silent) {
                    console.log(`Request to ${url} was aborted`);
                }
                const abortError = new Error('Request was cancelled or timed out');
                abortError.name = 'AbortError';
                abortError.aborted = true;
                throw abortError;
            }
            
            // Handle network errors
            if (error instanceof TypeError && error.message.includes('fetch')) {
                lastError = new Error('Network error: Unable to connect to server');
                lastError.originalError = error;
                
                // Retry on network errors
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                    attempt++;
                    continue;
                }
                
                if (!silent) {
                    console.error('Network error:', lastError.message);
                }
                throw lastError;
            }
            
            // Re-throw other errors
            if (attempt < retries) {
                lastError = error;
                await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                attempt++;
                continue;
            }
            
            if (!silent) {
                console.error(`Error fetching ${url}:`, error);
            }
            throw error;
        }
    }
    
    // If we exhausted retries, throw last error
    if (lastError) {
        throw lastError;
    }
};

/**
 * Cancel an active request by requestId
 * @param {string} requestId - The request ID to cancel
 */
function cancelRequest(requestId) {
    const request = activeRequests.get(requestId);
    if (request) {
        request.controller.abort();
        activeRequests.delete(requestId);
    }
}

/**
 * Cancel all active requests
 */
function cancelAllRequests() {
    activeRequests.forEach((request) => {
        request.controller.abort();
    });
    activeRequests.clear();
}

/**
 * Debounce utility function
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @param {boolean} immediate - If true, call function immediately on first invocation
 * @returns {Function} - Debounced function
 */
function debounce(func, wait, immediate = false) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            timeout = null;
            if (!immediate) func.apply(this, args);
        };
        const callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) func.apply(this, args);
    };
}

/**
 * Show loading spinner overlay
 * @param {string} message - Optional message to display
 */
function showLoadingSpinner(message = 'Loading...') {
    const spinner = document.getElementById('trade-loading-spinner');
    if (spinner) {
        const messageSpan = spinner.querySelector('span');
        if (messageSpan) {
            messageSpan.textContent = message;
        }
        spinner.classList.add('show');
    }
}

/**
 * Hide loading spinner overlay
 */
function hideLoadingSpinner() {
    const spinner = document.getElementById('trade-loading-spinner');
    if (spinner) {
        spinner.classList.remove('show');
    }
}

/**
 * Add fade-in animation to an element
 * @param {HTMLElement} element - Element to animate
 * @param {number} duration - Animation duration in milliseconds (default: 300)
 */
function fadeIn(element, duration = 300) {
    if (!element) return;
    
    element.style.opacity = '0';
    element.style.transition = `opacity ${duration}ms ease-in-out`;
    
    // Force reflow to ensure initial state is applied
    element.offsetHeight;
    
    // Trigger fade-in
    requestAnimationFrame(() => {
        element.style.opacity = '1';
    });
}

/**
 * Apply fade-in animation to multiple elements
 * @param {NodeList|Array} elements - Elements to animate
 * @param {number} duration - Animation duration in milliseconds (default: 300)
 */
function fadeInElements(elements, duration = 300) {
    if (!elements || elements.length === 0) return;
    
    Array.from(elements).forEach((element, index) => {
        // Stagger animations slightly for visual effect
        setTimeout(() => {
            fadeIn(element, duration);
        }, index * 50);
    });
}

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
        // First try the company-info endpoint which may have cached data and is faster
        const response = await apiFetch(`/api/company-info/${ticker}`, {
            silent: true
        });
        const data = await response.json();
        if (data && data.name && data.name !== ticker) {
            return data.name;
        }
        // Fallback to company-search if company-info doesn't have it
        const searchResponse = await apiFetch(`/api/company-search?q=${ticker}`, {
            silent: true
        });
        const companies = await searchResponse.json();
        return companies.find(c => c.symbol === ticker)?.name || ticker;
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('Error fetching company name:', error);
        }
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
    
    // Convert accountId to integer if present
    if (data.accountId) {
        data.accountId = parseInt(data.accountId, 10);
    }
    
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
        
        console.log('[DEBUG] submitTradeForm - sending data:', data);
        console.log('[DEBUG] submitTradeForm - accountId:', data.accountId, 'tradeDate:', data.tradeDate);
        
        const response = await apiFetch(url, {
            method: method,
            body: data
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

// Cache for ticker/company data to reduce API calls
const tickerCache = new Map(); // Map<query, companies[]>
let allTickersLoaded = false;

/**
 * Load all tickers on initial page load to populate cache
 * Uses tickers from existing trades to build initial cache
 */
async function loadAllTickers() {
    if (allTickersLoaded) return;
    
    try {
        // First, try to get tickers from existing trades (faster, no API call)
        if (trades && trades.length > 0) {
            const tickerSet = new Set();
            trades.forEach(trade => {
                if (trade.ticker) {
                    tickerSet.add(trade.ticker.toUpperCase());
                }
            });
            
            // Cache tickers from trades
            tickerSet.forEach(ticker => {
                if (!tickerCache.has(ticker)) {
                    tickerCache.set(ticker, [{
                        symbol: ticker,
                        name: ticker // Will be updated when searched
                    }]);
                }
            });
            
            console.log(`Cached ${tickerSet.size} tickers from existing trades`);
        }
        
        // Optionally load more tickers from API (commented out to avoid large initial load)
        // Uncomment if you want to preload all available tickers
        /*
        const response = await apiFetch('/api/company-search?q=', {
            silent: true
        });
        const companies = await response.json();
        
        // Cache all tickers
        companies.forEach(company => {
            const symbol = company.symbol.toUpperCase();
            if (!tickerCache.has(symbol)) {
                tickerCache.set(symbol, [company]);
            }
        });
        */
        
        allTickersLoaded = true;
    } catch (error) {
        console.error('Error loading tickers:', error);
    }
}

/**
 * Highlight matching substring in text
 * @param {string} text - Text to highlight
 * @param {string} query - Query to highlight
 * @returns {string} - HTML with highlighted substring
 */
function highlightMatch(text, query) {
    if (!query || !text) return text;
    
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
}

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
            
            // Check cache first (exact match)
            let companies = tickerCache.get(query);
            
            if (!companies) {
                // Optimized: Try to find matches from cache using efficient prefix matching
                companies = [];
                const queryLower = query.toLowerCase();
                const seen = new Set();
                
                // Search through cached tickers - optimized algorithm with early exits
                for (const [key, cachedCompanies] of tickerCache.entries()) {
                    // Early exit optimization: skip if key is shorter than query and doesn't start with query
                    if (key.length < query.length && !key.startsWith(query)) {
                        continue;
                    }
                    
                    // If query starts with key (prefix match) or key starts with query
                    if (query.startsWith(key) || key.startsWith(query)) {
                        // Filter companies that match the query
                        for (const company of cachedCompanies) {
                            if (seen.has(company.symbol)) continue;
                            
                            const symbol = company.symbol.toUpperCase();
                            const name = (company.name || '').toUpperCase();
                            
                            // Match if symbol or name contains the query (optimized: check symbol first, then startsWith for speed)
                            if (symbol.startsWith(query) || symbol.includes(query) || name.includes(queryLower)) {
                                companies.push(company);
                                seen.add(company.symbol);
                                
                                // Early exit if we have enough results
                                if (companies.length >= 20) break;
                            }
                        }
                        
                        // Early exit if we have enough results
                        if (companies.length >= 20) break;
                    }
                }
                
                // Limit results to top 20 for performance
                companies = companies.slice(0, 20);
            }
            
            // If no matches in cache, fetch from API
            if (companies.length === 0) {
                try {
                    const response = await apiFetch(`/api/company-search?q=${query}`, {
                        silent: true
                    });
                    companies = await response.json();
                    
                    // Cache the results
                    tickerCache.set(query, companies);
                    
                    // Also cache individual tickers for faster exact lookups
                    companies.forEach(company => {
                        const symbol = company.symbol.toUpperCase();
                        if (!tickerCache.has(symbol)) {
                            tickerCache.set(symbol, [company]);
                        }
                    });
                } catch (error) {
                    console.error('Error fetching suggestions:', error);
                    suggestions.style.display = 'none';
                    return;
                }
            } else {
                // Cache the filtered results for future queries if we found matches
                if (!tickerCache.has(query)) {
                    tickerCache.set(query, companies);
                }
            }
            
            if (companies.length > 0) {
                // Highlight matching substrings
                suggestions.innerHTML = companies.map(company => {
                    const symbol = company.symbol.toUpperCase();
                    const name = company.name || '';
                    const highlightedSymbol = highlightMatch(symbol, query);
                    const highlightedName = highlightMatch(name, query);
                    
                    return `<div class="suggestion-item" data-symbol="${company.symbol}" data-name="${company.name}">
                        <strong>${highlightedSymbol}</strong> - ${highlightedName}
                    </div>`;
                }).join('');
                suggestions.style.display = 'block';
            } else {
                suggestions.style.display = 'none';
            }
        }, 100); // Optimized: Reduced to 100ms for faster autocomplete
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
                // If a suggestion is selected, use it
                const symbol = current.dataset.symbol.toUpperCase();
                const name = current.dataset.name;
                input.value = symbol;
                suggestions.style.display = 'none';
                if (onSelectCallback) onSelectCallback(symbol, name);
            } else {
                // Enter-to-filter: filter by current input value even if no suggestion selected
                const query = input.value.trim().toUpperCase();
                if (query.length > 0) {
                    suggestions.style.display = 'none';
                    if (onSelectCallback) onSelectCallback(query);
                }
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

// Returns the next Friday on or after the given date (or today if no date given).
// If the given date is itself a Friday, returns the following Friday (7 days later)
// so a same-day Friday is never auto-selected as the expiration.
function getNextFriday(fromDate) {
    const d = fromDate ? new Date(fromDate) : new Date();
    // 5 = Friday in JS (0=Sun … 6=Sat)
    const dayOfWeek = d.getDay();
    const daysUntilFriday = dayOfWeek === 5 ? 7 : (5 - dayOfWeek + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilFriday);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function calculateExpirationDate(tradeDate) {
    if (!tradeDate) return '';
    return getNextFriday(new Date(tradeDate));
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
                    
                    // Default to next Friday
                    const expDateFormatted = formatDate(getNextFriday(tradeDateObj));
                    
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
        showLoadingSpinner('Loading trades...');
        
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
        // Only add account_id if a specific account is selected (not "All" which is empty string)
        if (accountFilter && accountFilter !== '' && accountFilter !== 'all') {
            params.append('account_id', accountFilter);
            console.log('[DEBUG] loadTrades - adding account_id to params:', accountFilter);
        } else {
            console.log('[DEBUG] loadTrades - "All" accounts selected, not filtering by account');
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
        
        const response = await apiFetch(`/api/trades?${params}`, {
            signal: tradesAbortController.signal,
            requestId: 'trades'
        });
        const loadedTrades = await response.json();
        
        // Ensure loadedTrades is an array
        if (!Array.isArray(loadedTrades)) {
            console.error('trades is not an array:', loadedTrades);
            trades = [];
        } else {
            // Preserve any new trades (temporary trades with IDs starting with 'new_')
            // that were added but not yet saved to the database
            const existingNewTrades = trades.filter(trade => 
                typeof trade.id === 'string' && trade.id.startsWith('new_')
            );
            
            // Combine loaded trades with new trades (avoid duplicates)
            const loadedTradeIds = new Set(loadedTrades.map(t => t.id));
            const uniqueNewTrades = existingNewTrades.filter(t => !loadedTradeIds.has(t.id));
            
            // Set trades to loaded trades plus any new trades
            trades = [...loadedTrades, ...uniqueNewTrades];
            
            console.log('[DEBUG] loadTrades - Preserved', uniqueNewTrades.length, 'new trades');
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
        
        // Populate ticker cache from loaded trades
        if (trades && trades.length > 0) {
            const tickerMap = new Map(); // Map<ticker, company_name>
            trades.forEach(trade => {
                if (trade.ticker) {
                    const ticker = trade.ticker.toUpperCase();
                    if (!tickerMap.has(ticker)) {
                        tickerMap.set(ticker, trade.company_name || ticker);
                    }
                }
            });
            
            // Cache tickers from trades
            tickerMap.forEach((companyName, ticker) => {
                if (!tickerCache.has(ticker)) {
                    tickerCache.set(ticker, [{
                        symbol: ticker,
                        name: companyName
                    }]);
                }
            });
        }
        
        updateTradesTable();
        updateSymbolFilter();
        hideLoadingSpinner();
    } catch (error) {
        // Ignore abort errors
        if (error.name === 'AbortError') {
            console.log('Trades request aborted');
            hideLoadingSpinner();
            return;
        }
        console.error('Error loading trades:', error);
        hideLoadingSpinner();
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
        showLoadingSpinner('Loading summary...');
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
        
        const response = await apiFetch(`/api/summary?${params}`, {
            signal: summaryAbortController.signal,
            requestId: 'summary'
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
        
        // Add fade-in animation to summary cards
        const summaryCards = document.querySelectorAll('#total-trades-center, #total-net-credit, #days-remaining, #days-done');
        if (summaryCards.length > 0) {
            fadeInElements(summaryCards, 200); // Optimized: Reduced from 300ms to 200ms
        }
    } catch (error) {
        // Ignore abort errors
        if (error.name === 'AbortError') {
            console.log('Summary request aborted');
            return;
        }
        console.error('Error loading summary:', error);
    } finally {
        hideLoadingSpinner();
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
        const response = await apiFetch(`/api/bankroll-summary?${params}`);
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

async function loadCostBasis(ticker = null, forceUpdate = false) {
    console.log('loadCostBasis called with ticker:', ticker, 'forceUpdate:', forceUpdate);
    try {
        // Cancel any pending cost basis request
        if (costBasisAbortController) {
            costBasisAbortController.abort();
        }
        costBasisAbortController = new AbortController();
        showLoadingSpinner('Loading cost basis...');
        
        // Set window.symbolFilter to match the ticker parameter so updateCostBasisTable knows a ticker is selected
        // Always use uppercase for consistency
        const tickerUpper = ticker ? ticker.toUpperCase() : null;
        if (tickerUpper) {
            window.symbolFilter = tickerUpper;
        } else {
            window.symbolFilter = '';
        }
        
        // Get account filter
        const accountFilter = document.getElementById('universal-account-filter')?.value || '';
        console.log('[DEBUG] loadCostBasis - accountFilter:', accountFilter, 'ticker:', tickerUpper);
        
        const params = new URLSearchParams();
        // Only add account_id if a specific account is selected (not "All" which is empty string)
        if (accountFilter && accountFilter !== '' && accountFilter !== 'all') {
            params.append('account_id', accountFilter);
            console.log('[DEBUG] loadCostBasis - adding account_id to params:', accountFilter);
        } else {
            console.log('[DEBUG] loadCostBasis - "All" accounts selected, not filtering by account');
        }
        if (tickerUpper) params.append('ticker', tickerUpper);
        params.append('commission', commission.toString());
        
        const response = await apiFetch(`/api/cost-basis?${params}`, {
            signal: costBasisAbortController.signal,
            requestId: 'cost-basis'
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
        
        if (tickerUpper) {
            // If a specific ticker is selected, show the detailed cost basis table
            if (data.length === 0) {
                console.log('No cost basis data found for ticker:', tickerUpper);
                // Show appropriate message instead of hiding completely
                const costBasisContainer = document.getElementById('cost-basis-table-container');
                const inlineContainer = document.getElementById('cost-basis-inline-container');
                const accountFilter = document.getElementById('universal-account-filter')?.value || '';
                const isAllAccounts = !accountFilter || accountFilter === '' || accountFilter === 'all';
                const accountName = !isAllAccounts && window.accounts ? 
                    (window.accounts.find(a => a.id.toString() === accountFilter.toString())?.account_name || 'selected account') : 
                    'any account';
                [costBasisContainer, inlineContainer].forEach(c => {
                    if (c) {
                        c.innerHTML = `
                            <div class="text-center text-muted py-3">
                                <i class="fas fa-info-circle me-2"></i>
                                No cost basis data for ${tickerUpper} in ${accountName}.
                            </div>
                        `;
                    }
                });
            } else {
                console.log('Updating cost basis table with data for ticker:', tickerUpper);
                updateCostBasisTable(data);
            }
        } else {
            // If no ticker is selected, show all available symbols
            // When "All" accounts is selected, always update to show data from all accounts
            const accountFilter = document.getElementById('universal-account-filter')?.value || '';
            const isAllAccounts = !accountFilter || accountFilter === '' || accountFilter === 'all';
            
            // Only skip update if a specific account is selected and symbols are already displayed
            // This prevents unnecessary updates when switching between specific accounts
            // But force update if forceUpdate flag is set (e.g., when account changes)
            if (!isAllAccounts && !forceUpdate) {
                const costBasisContainer = document.getElementById('cost-basis-table-container');
                const alreadyShowingSymbols = costBasisContainer && costBasisContainer.querySelector('.symbol-card');
                
                // If symbols are already displayed and we're not showing "All" accounts, skip update
                if (alreadyShowingSymbols) {
                    console.log('Symbols already displayed for specific account, skipping API update to prevent lag');
                    return; // Don't overwrite the immediate display
                }
            } else {
                if (forceUpdate) {
                    console.log('Force update requested, updating cost basis');
                } else {
                    console.log('"All" accounts selected, updating cost basis to show all accounts');
                }
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
            hideLoadingSpinner();
            return;
        }
        console.error('Error loading cost basis:', error);
    } finally {
        hideLoadingSpinner();
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
        const response = await apiFetch(`/api/trades/${tradeId}`, {
            method: 'PUT',
            body: { [field]: parsedDate }
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
            } else if (field === 'date_trade_open' || field === 'trade_date') {
                // When trade_date changes, we need to recalculate DTE using the current expiration_date
                // The trade object in memory should already be updated with the new trade_date
                const trade = trades.find(t => t.id === tradeId);
                if (trade && trade.expiration_date) {
                    // Use the updated trade_date from memory (which was just updated)
                    updateDTECell(tradeId, trade.expiration_date);
                }
                
                // Fetch commission when trade date changes (for new trades)
                const isNewTrade = typeof tradeId === 'string' && tradeId.startsWith('new_');
                if (isNewTrade && window._fetchAndPopulateCommissionForTrade && window._fetchAndPopulateCommissionForTrade[tradeId]) {
                    window._fetchAndPopulateCommissionForTrade[tradeId]();
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
    const tradeDate = trade.date_trade_open || trade.trade_date; // Support both old and new field names
    if (tradeDate && expirationDate) {
        const newDTE = calculateDaysToExpiration(expirationDate, tradeDate);
        
        // Update trade in memory
        trade.days_to_expiration = newDTE;
        trade.expiration_date = expirationDate;
        
        // The table is transposed: rows are fields, columns are trades
        // DTE is fieldIndex 5, so we need to find row index 5 (0-based)
        // Then find the column for this trade_id
        
        const tbody = document.getElementById('trades-table');
        if (!tbody) return;
        
        const rows = tbody.querySelectorAll('tr');
        if (rows.length <= 5) return; // DTE row doesn't exist
        
        // DTE row is at index 5 (fieldIndex 5)
        const dteRow = rows[5];
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

// Helper function to get effective expiration date for child trades
function getEffectiveExpirationDate(trade, trades) {
    /**
     * Get the effective expiration date for a trade.
     * For child trades (trades with trade_parent_id), use parent's date_trade_rolled.
     * Otherwise, use trade's own expiration_date.
     */
    const tradeParentId = trade.trade_parent_id;
    if (tradeParentId) {
        // Find parent trade
        const parentTrade = trades.find(t => t.id === tradeParentId);
        if (parentTrade && parentTrade.date_trade_rolled) {
            return parentTrade.date_trade_rolled;
        }
    }
    // Use trade's own expiration_date
    return trade.expiration_date;
}

// Helper function to calculate cumulative net credit for roll chains
function calculateCumulativeNetCredit(trade, trades) {
    /**
     * Calculate cumulative net credit for a trade by summing all ancestors.
     * For root trade: return its own net credit total.
     * For child trade: sum of all net credit totals from root through all ancestors.
     */
    const tradeParentId = trade.trade_parent_id;
    
    // Calculate net credit total for this trade
    const numOfContracts = trade.num_of_contracts || 1;
    const netCreditPerShare = trade.net_credit_per_share !== null && trade.net_credit_per_share !== undefined 
        ? trade.net_credit_per_share 
        : ((trade.credit_debit || trade.premium || 0) - (trade.commission_per_share || 0));
    
    const isStockTrade = trade.trade_type === 'BTO' || trade.trade_type === 'STC';
    const shares = isStockTrade ? (trade.num_of_shares || numOfContracts) : (numOfContracts * 100);
    const netCreditTotal = netCreditPerShare * shares;
    
    // If this trade has a parent, add parent's cumulative net credit
    if (tradeParentId) {
        const parentTrade = trades.find(t => t.id === tradeParentId);
        if (parentTrade) {
            const parentCumulative = calculateCumulativeNetCredit(parentTrade, trades);
            return parentCumulative + netCreditTotal;
        }
    }
    
    // Root trade: return its own net credit total
    return netCreditTotal;
}

function updateTradesTable() {
    console.log('updateTradesTable called with', trades.length, 'trades');
    const tbody = document.getElementById('trades-table');
    if (!tbody) {
        console.error('Trades table tbody not found');
        return;
    }
    tbody.innerHTML = '';
    
    // Filter trades by account, status, and symbol
    let filteredTrades = trades;
    
    // Filter out BTO/STC trades from the trades table
    filteredTrades = filteredTrades.filter(trade => trade.trade_type !== 'BTO' && trade.trade_type !== 'STC' && trade.trade_type !== 'ASSIGNED');
    
    // Apply account filter (always include new trades so they can be edited)
    const accountFilter = document.getElementById('universal-account-filter')?.value || '';
    const isAllAccounts = !accountFilter || accountFilter === '' || accountFilter === 'all';
    if (!isAllAccounts && accountFilter) {
        filteredTrades = filteredTrades.filter(trade => {
            // Always include new trades (they may not have the correct account set yet)
            const isNewTrade = typeof trade.id === 'string' && trade.id.startsWith('new_');
            if (isNewTrade) {
                return true; // Always show new trades
            }
            // For existing trades, filter by account
            const tradeAccountId = trade.account_id || '';
            return tradeAccountId.toString() === accountFilter.toString();
        });
    }
    
    // Apply status filter (case-insensitive)
    if (statusFilter) {
        filteredTrades = filteredTrades.filter(trade => trade.trade_status && trade.trade_status.toLowerCase() === statusFilter.toLowerCase());
    }
    
    // Apply symbol filter (case-insensitive)
    // Always include new trades (with IDs starting with 'new_') so they can be edited
    if (window.symbolFilter) {
        const filterUpper = window.symbolFilter.toUpperCase();
        filteredTrades = filteredTrades.filter(trade => {
            // Always include new trades (they may not have a ticker set yet)
            const isNewTrade = typeof trade.id === 'string' && trade.id.startsWith('new_');
            if (isNewTrade) {
                return true; // Always show new trades
            }
            // For existing trades, filter by ticker
            return trade.ticker && trade.ticker.toUpperCase() === filterUpper;
        });
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
                const aDate = new Date((a.date_trade_open || a.trade_date) || a.created_at);
                const bDate = new Date((b.date_trade_open || b.trade_date) || b.created_at);
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
            console.log(`Built chain starting from trade ${chain[0].id} (${chain[0].ticker} ${chain[0].date_trade_open || chain[0].trade_date}):`, chain.map(t => `${t.id} (${t.date_trade_open || t.trade_date})`).join(' -> '));
            // Mark all trades in the chain as processed (except the first)
            chain.slice(1).forEach(childTrade => {
                processedChildTrades.add(childTrade.id);
            });
        }
    });
    
    // Sort trades if sort column is specified
    // For child trades (with trade_parent_id), use their parent trade's date for sorting so they stay grouped
    if (sortColumn === 'date_trade_open' || sortColumn === 'trade_date') {
        filteredTrades.sort((a, b) => {
            // Check if trades are new (temporary trades with IDs starting with 'new_')
            const aIsNew = typeof a.id === 'string' && a.id.startsWith('new_');
            const bIsNew = typeof b.id === 'string' && b.id.startsWith('new_');
            
            // New trades should appear at the end (rightmost in transposed table) when sorting descending
            // or at the beginning when sorting ascending
            if (aIsNew && !bIsNew) {
                return sortDirection === 'desc' ? 1 : -1; // New trades go to end if desc, beginning if asc
            }
            if (!aIsNew && bIsNew) {
                return sortDirection === 'desc' ? -1 : 1; // Existing trades go before new if desc, after if asc
            }
            
            // If both are new or both are existing, sort normally
            // If either trade is a child trade, use its parent trade's date for sorting
            const aParentId = childToParentMap.get(a.id);
            const aTradeForSort = aParentId ? filteredTrades.find(t => t.id === aParentId) : a;
            const bParentId = childToParentMap.get(b.id);
            const bTradeForSort = bParentId ? filteredTrades.find(t => t.id === bParentId) : b;
            
            // Primary sort: trade_date (when trade was executed)
            // For new trades, use a very recent date to ensure they sort correctly
            const aTradeDate = aIsNew 
                ? new Date() // Use current date for new trades
                : new Date((aTradeForSort.date_trade_open || aTradeForSort.trade_date) || aTradeForSort.created_at || new Date());
            const bTradeDate = bIsNew 
                ? new Date() // Use current date for new trades
                : new Date((bTradeForSort.date_trade_open || bTradeForSort.trade_date) || bTradeForSort.created_at || new Date());
            
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
            // Check if trades are new (temporary trades with IDs starting with 'new_')
            const aIsNew = typeof a.id === 'string' && a.id.startsWith('new_');
            const bIsNew = typeof b.id === 'string' && b.id.startsWith('new_');
            
            // New trades should appear at the end (rightmost in transposed table)
            if (aIsNew && !bIsNew) {
                return 1; // New trades go to end
            }
            if (!aIsNew && bIsNew) {
                return -1; // Existing trades go before new
            }
            
            // If both are new or both are existing, sort normally
            // If either trade is a child trade, use its parent trade for sorting
            const aParentId = childToParentMap.get(a.id);
            const aTradeForSort = aParentId ? filteredTrades.find(t => t.id === aParentId) : a;
            const bParentId = childToParentMap.get(b.id);
            const bTradeForSort = bParentId ? filteredTrades.find(t => t.id === bParentId) : b;
            
            // Primary sort: created_at (when trade was added to system)
            // For new trades, use current timestamp to ensure they sort to the end
            const aCreated = aIsNew ? new Date() : new Date(aTradeForSort.created_at || new Date());
            const bCreated = bIsNew ? new Date() : new Date(bTradeForSort.created_at || new Date());
            
            // Secondary sort: trade_date (when trade was executed)
            const aTradeDate = new Date((aTradeForSort.date_trade_open || aTradeForSort.trade_date) || aCreated);
            const bTradeDate = new Date((bTradeForSort.date_trade_open || bTradeForSort.trade_date) || bCreated);
            
            // Sort oldest first (so newest appears rightmost in transposed table)
            if (aCreated.getTime() !== bCreated.getTime()) {
                return aCreated - bCreated;
            } else {
                return aTradeDate - bTradeDate;
            }
        });
    }
    
    // Format trade display for console log (check if trade_type already includes ticker)
    const formatTradeForLog = (trade) => {
        const ticker = trade.ticker || '';
        const tradeType = trade.trade_type || '';
        const tickerUpper = ticker.toUpperCase();
        const tradeTypeUpper = tradeType.toUpperCase();
        let displayType;
        if (tradeType && tickerUpper && tradeTypeUpper.startsWith(tickerUpper + ' ')) {
            // Trade type already includes ticker, use as-is
            displayType = tradeType;
        } else if (ticker) {
            // Trade type doesn't include ticker, append it
            displayType = `${ticker} ${tradeType}`;
        } else {
            displayType = tradeType;
        }
        return `${displayType} (${trade.created_at})`;
    };
    console.log('Sorted trades (oldest to newest):', filteredTrades.map(formatTradeForLog));
    
    // Build grouped trades array: each entry is either a single trade, a chain, or [parent, child]
    // Related trades (via trade_parent_id) will stay grouped together regardless of sort order
    const groupedTrades = [];
    
    // Create a set of all trade IDs that are part of any chain (not just the root)
    const tradesInAnyChain = new Set();
    tradeChainMap.forEach(chain => {
        chain.forEach(trade => {
            tradesInAnyChain.add(trade.id);
        });
    });
    
    filteredTrades.forEach(trade => {
        // Skip child trades (they'll be added with their parent/chain)
        if (processedChildTrades.has(trade.id)) {
            return;
        }
        
        // Check if this trade is part of any chain (as root or any member)
        // First check if it's the root of a chain
        const chain = tradeChainMap.get(trade.id);
        if (chain && chain.length > 1) {
            // Add all trades in the chain together
            groupedTrades.push({ type: 'chain', trades: chain });
        } else if (tradesInAnyChain.has(trade.id)) {
            // Trade is in a chain but not the root - skip it (already added with the chain)
            return;
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
        'Exp Date', // Expiration Date row (moved to be right under Trade Date)
        'DTE', // Days to Expiration row (moved to be right under Exp Date)
        'Price', // Trade Price row (moved after DTE)
        'Strike', // Strike Price row (BPS: Short Strike on top, Long Strike below)
        'Credit', // Premium row
        'Contracts', // Contracts (num_of_contracts)
        'Shares', // Shares row
        'Commission', // Commission per trade
        'Risk Capital', // Risk Capital = Strike - Net Credit Per Share
        'Margin Capital', // Margin Capital = Risk Capital * Shares
        'Status', // Status row (moved above Closing Debit)
        'Roll/Close Date', // Date Trade Rolled row (moved after Status)
        'Roll/Close Debit', // Closing Debit row
        'Total Debit', // Total Debit row
        'Net Credit Total', // Net Credit - Net Credit Per Share * Shares (moved above RORC)
        'RORC', // RORC = Net Credit / Risk Capital
        'ARORC', // ARORC = (365 / DTE) * RORC
        'Notes', // Notes row
        '' // Empty for actions row (no label)
    ];
    
    // Use document fragment for better performance
    const fragment = document.createDocumentFragment();
    
    // Create data rows (transposed) - no header row
    fieldNames.forEach((fieldName, fieldIndex) => {
        const row = document.createElement('tr');
        
        // Build first cell HTML
        let firstCellHTML = '';
        // Special handling for Trade Date row - make it sortable
        if (fieldIndex === 3 && fieldName === 'Trade Date') {
            const sortIcon = (sortColumn === 'date_trade_open' || sortColumn === 'trade_date') 
                ? (sortDirection === 'asc' ? '<i class="fas fa-sort-up"></i>' : '<i class="fas fa-sort-down"></i>')
                : '<i class="fas fa-sort text-muted"></i>';
            firstCellHTML = `<td class="fw-bold" style="cursor: pointer;" onclick="toggleTradeDateSort()" title="Click to sort by trade date">
                ${fieldName} ${sortIcon}
            </td>`;
        } else {
            // Only show field name if it's not empty (skip first row label)
            firstCellHTML = fieldName ? `<td class="fw-bold">${fieldName}</td>` : '<td></td>';
        }
        
        // Build cell HTML using array for better performance - include first cell
        const cellHTMLs = [firstCellHTML];
        
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
                    const aDate = new Date((a.date_trade_open || a.trade_date) || a.created_at);
                    const bDate = new Date((b.date_trade_open || b.trade_date) || b.created_at);
                    return aDate - bDate; // Oldest first
                });
            } else if (group.type === 'group') {
                tradesToRender = [group.original, group.roll];
                // Sort by trade_date within the group
                tradesToRender.sort((a, b) => {
                    const aDate = new Date((a.date_trade_open || a.trade_date) || a.created_at);
                    const bDate = new Date((b.date_trade_open || b.trade_date) || b.created_at);
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
            let textColor = '';
            
            // Check if dark mode is active
            const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
            
            if (status === 'roll') {
                bgColor = 'background-color: #FFF2CC;';
                if (isDarkMode) textColor = 'color: #212529;'; // Dark text for light yellow background
            } else if (status === 'expired' && tradeType.toLowerCase().includes('put')) {
                bgColor = 'background-color: #C6E0B4;';
                if (isDarkMode) textColor = 'color: #212529;'; // Dark text for light green background
            } else if (status === 'assigned' && tradeType.toLowerCase().includes('put')) {
                bgColor = 'background-color: #A9D08F;';
                if (isDarkMode) textColor = 'color: #212529;'; // Dark text for green background
            } else if (status === 'assigned' && tradeType.toLowerCase().includes('call')) {
                bgColor = 'background-color: #9BC2E6;';
                if (isDarkMode) textColor = 'color: #212529;'; // Dark text for light blue background
            } else if (status === 'expired' && tradeType.toLowerCase().includes('call')) {
                bgColor = 'background-color: #DEEAF7;';
                if (isDarkMode) textColor = 'color: #212529;'; // Dark text for light blue background
            }
            
            let cellContent = '';
            
            // Calculate financial metrics once for all cases that need them
            // Use commission_per_share from database (account-specific and trade-date-specific)
            const tradeCommission = trade.commission_per_share !== null && trade.commission_per_share !== undefined ? trade.commission_per_share : 0.0;
            const premium = trade.credit_debit || trade.premium;
            // Use net_credit_per_share from database if available, otherwise calculate
            const netCreditPerShare = trade.net_credit_per_share !== null && trade.net_credit_per_share !== undefined ? trade.net_credit_per_share : (premium - tradeCommission);
            
            // Calculate shares
            const isStockTrade = trade.trade_type === 'BTO' || trade.trade_type === 'STC';
            const shares = isStockTrade ? (trade.num_of_shares || trade.num_of_contracts) : (trade.num_of_contracts * 100);
            
            // Use cumulative net credit total from backend if available, otherwise calculate it
            let cumulativeNetCreditTotal = trade.cumulative_net_credit_total;
            if (cumulativeNetCreditTotal === null || cumulativeNetCreditTotal === undefined) {
                cumulativeNetCreditTotal = calculateCumulativeNetCredit(trade, trades);
            }
            
            // Net Credit Total should display cumulative for roll trades
            const netCreditTotal = cumulativeNetCreditTotal;
            
            // Use risk_capital_per_share from database if available, otherwise calculate
            const riskCapital = trade.risk_capital_per_share !== null && trade.risk_capital_per_share !== undefined ? trade.risk_capital_per_share : (trade.strike_price - netCreditPerShare); // Risk Capital = Strike - Net Credit Per Share
            // Use margin_capital from database if available, otherwise calculate
            const marginCapital = trade.margin_capital !== null && trade.margin_capital !== undefined ? trade.margin_capital : (riskCapital * shares);
            
            // Calculate cumulative net credit per share for RORC calculation (for roll trades)
            const cumulativeNetCreditPerShare = shares > 0 ? (cumulativeNetCreditTotal / shares) : netCreditPerShare;
            
            // RORC = Cumulative Net Credit Per Share / Risk Capital * 100 (for roll trades, use cumulative)
            const rorc = riskCapital !== 0 ? (cumulativeNetCreditPerShare / riskCapital) * 100 : 0;
            
            // Calculate effective expiration date for ARORC calculation (use parent's date_trade_rolled for child trades)
            const effectiveExpDate = getEffectiveExpirationDate(trade, trades);
            const tradeDateForDTE = trade.date_trade_open || trade.trade_date;
            // Always calculate DTE using effective expiration date, don't rely on database value
            let effectiveDTE = 0;
            if (effectiveExpDate && tradeDateForDTE) {
                effectiveDTE = calculateDaysToExpiration(effectiveExpDate, tradeDateForDTE);
            }
            // If calculation failed, fallback to database value only if it's > 0
            if (effectiveDTE === 0 && trade.days_to_expiration > 0) {
                effectiveDTE = trade.days_to_expiration;
            }
            
            // Calculate ARORC
            // For ROCT PUT and RULE ONE PUT trades, use: (365 / DTE) * (net_credit_per_share / (risk_capital_per_share * margin_percent))
            // For other trades, use: (365 / DTE) * RORC
            let arorc = 0;
            const isROCTPut = tradeType.includes('ROCT PUT') || tradeType.includes('RULE ONE PUT') || 
                             (tradeType.includes('PUT') && (tradeType.includes('ROCT') || tradeType.includes('RULE ONE')));
            
            if (effectiveDTE > 0) {
                if (isROCTPut) {
                    // Use cumulative net credit per share for roll trades
                    const marginPercent = trade.margin_percent !== null && trade.margin_percent !== undefined ? trade.margin_percent : 100.0;
                    const denominator = riskCapital * (marginPercent / 100.0);
                    if (denominator > 0) {
                        const arorcDecimal = (365.0 / effectiveDTE) * (cumulativeNetCreditPerShare / denominator);
                        arorc = parseFloat((arorcDecimal * 100.0).toFixed(1));
                    }
                } else {
                    // For other trades, use: (365 / DTE) * RORC
                    arorc = parseFloat(((365 / effectiveDTE) * rorc).toFixed(1));
                }
            }
            
            // Calculate today's date once for all cases
            const todayDate = new Date();
            const todayISO = todayDate.toISOString().split('T')[0];
            
            // Helper to quote trade ID if it's a string (for inline handlers)
            const tradeIdForHandler = typeof trade.id === 'string' && trade.id.startsWith('new_') 
                ? `'${trade.id}'` 
                : trade.id;
            
            switch (fieldIndex) {
                case 0: // Symbol/Type (back to first row)
                    const expirationDate = new Date(trade.expiration_date);
                    const isExpired = trade.trade_status && trade.trade_status.toLowerCase() === 'open' && todayDate > expirationDate;
                    // Use type_name from trade_types table if available, otherwise use trade.ticker + tradeType
                    // Check if tradeType already includes the ticker (backend appends it)
                    let displayType;
                    if (trade.type_name) {
                        displayType = `${trade.ticker} ${trade.type_name}`;
                    } else {
                        // Check if tradeType already starts with the ticker
                        // The backend stores trade_type as "CROX ROCT CALL" (with ticker included)
                        const tickerUpper = trade.ticker ? trade.ticker.toUpperCase() : '';
                        const tradeTypeUpper = tradeType ? tradeType.toUpperCase() : '';
                        if (tradeType && tickerUpper && tradeTypeUpper.startsWith(tickerUpper + ' ')) {
                            // Trade type already includes ticker, use as-is
                            displayType = tradeType;
                        } else if (trade.ticker) {
                            // Trade type doesn't include ticker, append it
                            displayType = `${trade.ticker} ${tradeType}`;
                        } else {
                            // Fallback: just use tradeType
                            displayType = tradeType;
                        }
                    }
                    // Debug logging for duplicate ticker issue
                    if (displayType && trade.ticker && displayType.toUpperCase().includes(trade.ticker.toUpperCase() + ' ' + trade.ticker.toUpperCase())) {
                        console.warn('[DEBUG] Duplicate ticker detected:', { tradeId: trade.id, ticker: trade.ticker, tradeType: tradeType, displayType: displayType });
                    }
                    // Check if dark mode is active - use CSS variable that changes with theme
                    const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
                    const tickerLinkColor = isDarkMode ? 'var(--primary-color-alt)' : '#000000';
                    // Escape ticker for use in onclick handler
                    const escapedTickerForClick = String(trade.ticker || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
                    const reviewBadge = trade.needs_review
                        ? `<span style="display:inline-block;font-size:0.5rem;background:#ffc107;color:#000;border-radius:3px;padding:1px 4px;margin-top:2px;cursor:pointer;" title="Schwab import — review this trade" onclick="markTradeReviewed(${trade.id})">REVIEW ✕</span>`
                        : '';
                    const assignedBadge = trade.is_assigned
                        ? `<span style="display:inline-block;font-size:0.5rem;background:#A9D08F;color:#000;border-radius:3px;padding:1px 4px;margin-top:2px;" title="Option was assigned — shares acquired at strike price">ASSIGNED</span>`
                        : '';
                    cellContent = `<div style="text-align: center; white-space: normal; word-wrap: break-word; vertical-align: top;"><strong>${isExpired ? '<i class="fas fa-exclamation-triangle text-danger me-1" title="Expired"></i>' : ''}<span class="clickable-symbol" data-symbol="${escapedTickerForClick}" style="cursor: pointer; color: ${tickerLinkColor}; text-decoration: underline;">${displayType}</span></strong>${reviewBadge ? '<br>' + reviewBadge : ''}${assignedBadge ? '<br>' + assignedBadge : ''}</div>`;
                    break;
                case 1: // Account - Editable dropdown
                    const accountName = trade.account_name || 'Unknown';
                    const accountId = trade.account_id || 9;
                    // Get accounts from window.accounts or load them
                    let accountOptions = '';
                    if (window.accounts && window.accounts.length > 0) {
                        window.accounts.forEach(account => {
                            const selected = account.id === accountId ? 'selected' : '';
                            accountOptions += `<option value="${account.id}" ${selected}>${account.account_name}</option>`;
                        });
                    } else {
                        // Fallback if accounts not loaded
                        accountOptions = `<option value="${accountId}" selected>${accountName}</option>`;
                    }
                    cellContent = `
                        <select class="form-select form-select-sm text-center" 
                                data-trade-id="${trade.id}" 
                                data-field="account_id"
                                data-field-row="1"
                                onchange="autoSaveTradeField(${trade.id}, 'account_id', this.value)"
                                style="width: 100px; font-size: 0.6125rem; padding-left: 1.5rem; padding-right: 1.5rem; padding-top: 0.1rem; padding-bottom: 0.1rem; text-align: center;">
                            ${accountOptions}
                        </select>
                    `;
                    break;
                case 2: // Ticker - Editable for all trades
                    // For new trades (IDs starting with 'new_'), don't add inline oninput handler
                    // We'll attach custom handlers that wait for blur event
                    // But we DO need tab navigation for new trades too
                    const isNewTrade = typeof trade.id === 'string' && trade.id.startsWith('new_');
                    const oninputHandler = isNewTrade 
                        ? '' 
                        : `oninput="autoSaveTradeField(${tradeIdForHandler}, 'ticker', this.value.toUpperCase())"`;
                    // Always add tab navigation handler, even for new trades
                    const onkeydownHandler = `onkeydown="return handleTabNavigation(event, ${tradeIdForHandler}, 2)"`;
                    cellContent = `
                        <input type="text" 
                               class="form-control form-control-sm text-center" 
                               value="${trade.ticker || ''}" 
                               data-trade-id="${trade.id}" 
                               data-field="ticker" 
                               data-field-row="2"
                               tabindex="0"
                               onfocus="this.select()"
                               ${onkeydownHandler}
                               ${oninputHandler}
                               style="width: 70px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem; text-transform: uppercase;">
                    `;
                    break;
                case 3: // Trade Date - Editable for all trades
                    // Make editable with auto-save using DD-MMM-YY format like quick add modal
                    // For new trades, trade_date is already in YYYY-MM-DD format, so formatDate will convert it
                    let tradeDateValue;
                    const tradeDateField = trade.date_trade_open || trade.trade_date; // Support both old and new field names
                    if (tradeDateField) {
                        // Check if it's already in DD-MMM-YY format (8 chars) or YYYY-MM-DD format (10 chars)
                        if (tradeDateField.length === 10 && tradeDateField.includes('-')) {
                            tradeDateValue = formatDate(tradeDateField);
                        } else {
                            tradeDateValue = tradeDateField;
                        }
                    } else {
                        tradeDateValue = getTodayInDDMMMYY();
                    }
                    cellContent = `
                        <input type="text" 
                               class="form-control form-control-sm text-center no-ellipsis" 
                               value="${tradeDateValue}" 
                               placeholder="DD-MMM-YY"
                               data-display-format="DD-MMM-YY"
                               data-edit-format="MM/DD/YY"
                               data-trade-id="${trade.id}" 
                               data-field="date_trade_open" 
                               data-field-row="3"
                               tabindex="0"
                               onfocus="handleDateInputFocus(this)" 
                               onkeydown="return handleTabNavigation(event, ${tradeIdForHandler}, 3)"
                               onblur="handleDateInputBlurForRollField(this, ${tradeIdForHandler})"
                               style="width: 70px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem; text-overflow: clip !important; overflow: visible !important; white-space: normal !important;">
                    `;
                    break;
                case 4: // Exp Date - Editable for all trades (moved to be right under Trade Date)
                    // Make editable with auto-save using DD-MMM-YY format like quick add modal
                    // For new trades, expiration_date is already in YYYY-MM-DD format, so formatDate will convert it
                    let expDateValue;
                    if (trade.expiration_date) {
                        // Check if it's already in DD-MMM-YY format (8 chars) or YYYY-MM-DD format (10 chars)
                        if (trade.expiration_date.length === 10 && trade.expiration_date.includes('-')) {
                            expDateValue = formatDate(trade.expiration_date);
                        } else {
                            expDateValue = trade.expiration_date;
                        }
                    } else {
                        expDateValue = getTodayInDDMMMYY();
                    }
                    cellContent = `
                        <input type="text" 
                               class="form-control form-control-sm text-center no-ellipsis" 
                               value="${expDateValue}" 
                               placeholder="DD-MMM-YY"
                               data-display-format="DD-MMM-YY"
                               data-edit-format="MM/DD/YY"
                               data-trade-id="${trade.id}" 
                               data-field="expiration_date" 
                               data-field-row="4"
                               tabindex="0"
                               onfocus="handleDateInputFocus(this)" 
                               onkeydown="return handleTabNavigation(event, ${tradeIdForHandler}, 4)"
                               onblur="handleDateInputBlurForRollField(this, ${tradeIdForHandler})"
                               style="width: 70px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem; text-overflow: clip !important; overflow: visible !important; white-space: normal !important;">
                    `;
                    break;
                case 5: // DTE - Read-only (calculated) (moved to be right under Exp Date)
                    // Always calculate DTE using effective expiration date (parent's date_trade_rolled for child trades)
                    const tradeDateForDTE = trade.date_trade_open || trade.trade_date; // Support both old and new field names
                    const effectiveExpDate = getEffectiveExpirationDate(trade, trades);
                    const expDateForDTE = effectiveExpDate || trade.expiration_date;
                    // Always calculate DTE, don't rely on database value (which might be 0 for child trades)
                    let calculatedDTE = 0;
                    if (expDateForDTE && tradeDateForDTE) {
                        calculatedDTE = calculateDaysToExpiration(expDateForDTE, tradeDateForDTE);
                    }
                    // Use calculated value if available, otherwise fallback to database value
                    const displayDTE = calculatedDTE > 0 ? calculatedDTE : (trade.days_to_expiration || 0);
                    cellContent = `<span class="text-center" data-field="dte" data-trade-id="${trade.id}">${displayDTE}</span>`;
                    break;
                case 6: // Price - Editable for all trades (moved after DTE)
                    // Make editable with auto-save for all trades
                    // For new trades, leave empty instead of defaulting to 0
                    const isNewTradePrice = typeof trade.id === 'string' && trade.id.startsWith('new_');
                    const priceValue = isNewTradePrice ? '' : (trade.current_price || trade.price ? parseFloat(trade.current_price || trade.price).toFixed(2) : '');
                    cellContent = `
                        <div style="position: relative; display: flex; align-items: center; justify-content: center;">
                            <span style="position: absolute; left: 0; top: 50%; transform: translateY(-50%); font-size: 0.6125rem;">$</span>
                            <input type="number" 
                                   class="form-control form-control-sm text-center" 
                                   value="${priceValue}" 
                                   step="0.01"
                                   min="0"
                                   data-trade-id="${trade.id}" 
                                   data-field="current_price" 
                                   data-field-row="6"
                                   tabindex="0"
                                   onfocus="this.select()"
                                   onkeydown="return handleTabNavigation(event, ${tradeIdForHandler}, 6)"
                                   oninput="limitToTwoDecimals(this); autoSaveTradeField(${tradeIdForHandler}, 'current_price', this.value)"
                                   style="width: 70px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem;">
                        </div>
                    `;
                    break;
                case 7: // Strike - Editable for all trades; BPS shows Short + Long Strike stacked
                    const isNewTradeStrike = typeof trade.id === 'string' && trade.id.startsWith('new_');
                    const strikeValue = isNewTradeStrike ? '' : (trade.strike_price ? parseFloat(trade.strike_price).toFixed(2) : '');
                    const isBPSTrade = tradeType && (tradeType.includes('BULL PUT SPREAD') || tradeType.includes('BPS'));
                    if (isBPSTrade) {
                        const longStrikeValue = isNewTradeStrike ? '' : (trade.long_strike ? parseFloat(trade.long_strike).toFixed(2) : '');
                        cellContent = `
                            <div style="display: flex; flex-direction: column; gap: 2px; align-items: center;">
                                <div style="position: relative; display: flex; align-items: center; justify-content: center;">
                                    <span style="position: absolute; left: 0; top: 50%; transform: translateY(-50%); font-size: 0.55rem; color: #666;">S$</span>
                                    <input type="number"
                                           class="form-control form-control-sm text-center"
                                           value="${strikeValue}"
                                           step="0.01" min="0"
                                           placeholder="Short"
                                           data-trade-id="${trade.id}"
                                           data-field="strike_price"
                                           data-field-row="7"
                                           tabindex="0"
                                           onfocus="this.select()"
                                           onkeydown="return handleTabNavigation(event, ${tradeIdForHandler}, 7)"
                                           oninput="limitToTwoDecimals(this); autoSaveTradeField(${tradeIdForHandler}, 'strike_price', this.value)"
                                           style="width: 70px; font-size: 0.6125rem; padding: 0.1rem 0.25rem;">
                                </div>
                                <div style="position: relative; display: flex; align-items: center; justify-content: center;">
                                    <span style="position: absolute; left: 0; top: 50%; transform: translateY(-50%); font-size: 0.55rem; color: #666;">L$</span>
                                    <input type="number"
                                           class="form-control form-control-sm text-center"
                                           value="${longStrikeValue}"
                                           step="0.01" min="0"
                                           placeholder="Long"
                                           data-trade-id="${trade.id}"
                                           data-field="long_strike"
                                           data-field-row="17"
                                           tabindex="0"
                                           onfocus="this.select()"
                                           onkeydown="return handleTabNavigation(event, ${tradeIdForHandler}, 17)"
                                           oninput="limitToTwoDecimals(this); autoSaveTradeField(${tradeIdForHandler}, 'long_strike', this.value)"
                                           style="width: 70px; font-size: 0.6125rem; padding: 0.1rem 0.25rem;">
                                </div>
                            </div>
                        `;
                    } else {
                        cellContent = `
                            <div style="position: relative; display: flex; align-items: center; justify-content: center;">
                                <span style="position: absolute; left: 0; top: 50%; transform: translateY(-50%); font-size: 0.6125rem;">$</span>
                                <input type="number" 
                                       class="form-control form-control-sm text-center" 
                                       value="${strikeValue}" 
                                       step="0.01"
                                       min="0"
                                       data-trade-id="${trade.id}" 
                                       data-field="strike_price" 
                                       data-field-row="7"
                                       tabindex="0"
                                       onfocus="this.select()"
                                       onkeydown="return handleTabNavigation(event, ${tradeIdForHandler}, 7)"
                                       oninput="limitToTwoDecimals(this); autoSaveTradeField(${tradeIdForHandler}, 'strike_price', this.value)"
                                       style="width: 70px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem;">
                            </div>
                        `;
                    }
                    break;
                case 8: // Credit - Editable for all trades
                    // Make editable with auto-save for all trades
                    // For new trades, leave empty instead of defaulting to 0
                    const isNewTradeCredit = typeof trade.id === 'string' && trade.id.startsWith('new_');
                    // For rolled trades show NET credit (STO price − parent's BTC cost)
                    const useNetCredit = trade.trade_parent_id &&
                        trade.net_credit_per_share !== null && trade.net_credit_per_share !== undefined;
                    const creditRaw = useNetCredit
                        ? trade.net_credit_per_share
                        : (trade.credit_debit || trade.premium || 0);
                    const creditValue = isNewTradeCredit ? '' : (creditRaw ? parseFloat(creditRaw).toFixed(2) : '');
                    cellContent = `
                        <div style="position: relative; display: flex; align-items: center; justify-content: center;">
                            <span style="position: absolute; left: 0; top: 50%; transform: translateY(-50%); font-size: 0.6125rem;">$</span>
                            <input type="number" 
                                   class="form-control form-control-sm text-center" 
                                   value="${creditValue}" 
                                   step="0.01"
                                   data-trade-id="${trade.id}" 
                                   data-field="credit_debit" 
                                   data-field-row="8"
                                   tabindex="0"
                                   onfocus="this.select()"
                                   onkeydown="return handleTabNavigation(event, ${tradeIdForHandler}, 8)"
                                   oninput="limitToTwoDecimals(this); autoSaveTradeField(${tradeIdForHandler}, 'credit_debit', this.value)"
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
                               tabindex="0"
                               onfocus="this.select()"
                               onkeydown="return handleTabNavigation(event, ${tradeIdForHandler}, 9)"
                               oninput="autoSaveTradeField(${tradeIdForHandler}, 'num_of_contracts', this.value)"
                               style="width: 70px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem;">
                    `;
                    break;
                case 10: // Shares - Read-only (use stored num_of_shares or calculate from num_of_contracts)
                    const shares = trade.num_of_shares !== null && trade.num_of_shares !== undefined 
                        ? trade.num_of_shares 
                        : ((trade.num_of_contracts || 0) * 100);
                    cellContent = `<span class="text-center" data-field="shares" data-trade-id="${trade.id}">${shares}</span>`;
                    break;
                case 11: // Commission - Use commission_per_share from database (account-specific and trade-date-specific)
                    const tradeCommission = trade.commission_per_share !== null && trade.commission_per_share !== undefined ? trade.commission_per_share : 0.0;
                    cellContent = `<span class="text-center">$${tradeCommission.toLocaleString('en-US', {minimumFractionDigits: 5, maximumFractionDigits: 5})}</span>`;
                    break;
                case 12: // Risk Capital = Strike - Net Credit Per Share
                    cellContent = `<span class="text-center" data-field="risk_capital" data-trade-id="${trade.id}">$${riskCapital.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>`;
                    break;
                case 13: // Margin Capital = Risk Capital * Shares
                    cellContent = `<span class="text-center" data-field="margin_capital" data-trade-id="${trade.id}">$${marginCapital.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>`;
                    break;
                case 14: // Status - Editable dropdown (case-insensitive)
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
                case 15: // Roll Date - Editable for trades with status 'roll' or 'closed' (same format as Exp Date)
                    let rollDateValue = '';
                    if (trade.date_trade_rolled) {
                        if (trade.date_trade_rolled.length === 10 && trade.date_trade_rolled.includes('-')) {
                            rollDateValue = formatDate(trade.date_trade_rolled);
                        } else {
                            rollDateValue = trade.date_trade_rolled;
                        }
                    }
                    const isRollOrClosedForRollDate = (trade.trade_status && (trade.trade_status.toLowerCase() === 'roll' || trade.trade_status.toLowerCase() === 'closed'));
                    // When disabled, match background color and remove border
                    // If bgColor is set (status-specific color), use it; otherwise use CSS variable to match table background
                    let rollDateBgColor = '';
                    if (!isRollOrClosedForRollDate) {
                        if (bgColor) {
                            // Extract the color value from bgColor (e.g., "background-color: #FFF2CC;" -> "#FFF2CC")
                            const colorMatch = bgColor.match(/background-color:\s*([^;]+)/);
                            if (colorMatch) {
                                rollDateBgColor = `background-color: ${colorMatch[1]};`;
                            }
                        } else {
                            // Use CSS variable to match table background (works in both light and dark mode)
                            rollDateBgColor = 'background-color: var(--table-bg);';
                        }
                    }
                    const rollDateDisabledStyle = isRollOrClosedForRollDate ? '' : `${rollDateBgColor} border: none; box-shadow: none;`;
                    cellContent = `
                        <input type="text" 
                               class="form-control form-control-sm text-center no-ellipsis" 
                               value="${rollDateValue}" 
                               data-display-format="DD-MMM-YY"
                               data-edit-format="MM/DD/YY"
                               data-trade-id="${trade.id}" 
                               data-field="date_trade_rolled" 
                               data-field-row="15"
                               ${isRollOrClosedForRollDate ? '' : 'disabled'}
                               tabindex="0"
                               onfocus="handleDateInputFocus(this)" 
                               onkeydown="return handleTabNavigation(event, ${tradeIdForHandler}, 15)"
                               onblur="handleDateInputBlurForRollField(this, ${tradeIdForHandler})"
                               style="width: 70px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem; text-overflow: clip !important; overflow: visible !important; white-space: normal !important; ${rollDateDisabledStyle}">
                    `;
                    break;
                case 16: // Closing Debit - Format based on status: read-only like Total Debit if not roll/closed, editable like Credit/Strike if roll/closed
                    const isRollOrClosed = (trade.trade_status && (trade.trade_status.toLowerCase() === 'roll' || trade.trade_status.toLowerCase() === 'closed'));
                    const closingDebitValue = trade.closing_debit !== null && trade.closing_debit !== undefined ? parseFloat(trade.closing_debit) : 0.0;
                    if (isRollOrClosed) {
                        // Editable format like Credit/Strike (with $ prefix)
                        cellContent = `
                            <div style="position: relative; display: flex; align-items: center; justify-content: center;">
                                <span style="position: absolute; left: 0; top: 50%; transform: translateY(-50%); font-size: 0.6125rem;">$</span>
                                <input type="number" 
                                       class="form-control form-control-sm text-center" 
                                       value="${closingDebitValue.toFixed(2)}" 
                                       step="0.01"
                                       min="0"
                                       data-trade-id="${trade.id}" 
                                       data-field="closing_debit" 
                                       data-field-row="16"
                                       tabindex="0"
                                       onfocus="this.select()"
                                       onkeydown="return handleTabNavigation(event, ${tradeIdForHandler}, 16)"
                                       oninput="limitToTwoDecimals(this); autoSaveTradeField(${tradeIdForHandler}, 'closing_debit', this.value)"
                                       style="width: 70px; display: inline-block; font-size: 0.6125rem; padding: 0.1rem 0.25rem;">
                            </div>
                        `;
                    } else {
                        // Read-only format like Total Debit (default to $0.00)
                        cellContent = `<span class="text-center" data-field="closing_debit" data-trade-id="${trade.id}">$${closingDebitValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>`;
                    }
                    break;
                case 17: // Total Debit - Calculated/display field (closing_debit * num_of_shares)
                    const totalDebit = (trade.total_debit !== null && trade.total_debit !== undefined) ? parseFloat(trade.total_debit) : 0.0;
                    cellContent = `<span class="text-center" data-field="total_debit" data-trade-id="${trade.id}">$${totalDebit.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>`;
                    break;
                case 18: // Net Credit Total = Net Credit Per Share * Shares (moved above RORC)
                    cellContent = `<strong class="text-center" data-field="net_credit_total" data-trade-id="${trade.id}">$${netCreditTotal.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</strong>`;
                    break;
                case 19: // RORC = Net Credit Per Share / Risk Capital
                    cellContent = `<span class="text-center" data-field="rorc" data-trade-id="${trade.id}">${rorc.toFixed(2)}%</span>`;
                    break;
                case 20: // ARORC - Use calculated value (which uses cumulative net credit for roll trades), fallback to database value
                    // For roll trades, always use calculated value (cumulative net credit)
                    // For non-roll trades, prefer calculated value but fallback to database value
                    const displayARORC = (arorc !== null && arorc !== undefined && !isNaN(arorc) && arorc !== 0) 
                        ? arorc 
                        : (trade.ARORC !== null && trade.ARORC !== undefined ? trade.ARORC : null);
                    if (displayARORC !== null && displayARORC !== undefined && !isNaN(displayARORC)) {
                        // ARORC is stored/calculated as percentage (e.g., 20.4 for 20.4%), display directly
                        cellContent = `<span class="text-center" data-field="arorc" data-trade-id="${trade.id}">${parseFloat(displayARORC).toFixed(1)}%</span>`;
                    } else {
                        cellContent = `<span class="text-center" data-field="arorc" data-trade-id="${trade.id}">-</span>`;
                    }
                    break;
                case 21: // Notes - Editable textarea field
                    const notesValue = trade.notes || '';
                    cellContent = `
                        <textarea 
                            class="form-control form-control-sm" 
                            data-trade-id="${trade.id}" 
                            data-field="notes" 
                            data-field-row="21"
                            rows="2"
                            onblur="autoSaveTradeField(${tradeIdForHandler}, 'notes', this.value)"
                            style="width: 100%; font-size: 0.6125rem; padding: 0.1rem 0.25rem; resize: vertical; min-height: 40px;">${notesValue}</textarea>
                    `;
                    break;
                case 22: // Actions - Delete only
                    // Quote the trade ID to handle temporary IDs like "new_1234567890"
                    const tradeIdStr = typeof trade.id === 'string' && trade.id.startsWith('new_') 
                        ? `'${trade.id}'` 
                        : trade.id;
                    cellContent = `
                        <div class="text-center">
                            <button class="btn btn-sm btn-outline-danger" onclick="deleteTrade(${tradeIdStr})" title="Delete Trade">
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
            // Top align for Symbol/Type column (fieldIndex 0), middle align for dates (1, 3), center for status (14)
            let verticalAlign = '';
            let textAlign = '';
            if (fieldIndex === 0) {
                verticalAlign = 'vertical-align: top;';
            } else if (fieldIndex === 1 || fieldIndex === 3) {
                verticalAlign = 'vertical-align: middle;';
            } else if (fieldIndex === 14) {
                // Status column - center align
                textAlign = 'text-align: center;';
                verticalAlign = 'vertical-align: middle;';
            }
            
            // Add visual demarcation after Margin Capital (fieldIndex 13)
            // Add horizontal border-top to the row starting from Status (fieldIndex 14)
            // Border thickness matches spacing between trade columns (10px)
            // Use CSS variable for theme compatibility (dark/light mode)
            if (fieldIndex === 14 && isFirstTradeInGroup) { // Status row (first row after Margin Capital)
                row.style.borderTop = '10px solid var(--border-color, #dee2e6)';
            }
            
            // Add left border to first trade in each group to visually separate groups
            const leftBorderStyle = isFirstTradeInGroup && groupIndex > 0 ? 'border-left: 2px solid #dee2e6 !important;' : '';
            
            // Combine all styles including text color for dark mode
            const cellStyle = `${bgColor} ${textColor} width: 112px; min-width: 112px; max-width: 112px; ${visibilityStyle} ${verticalAlign} ${textAlign} ${leftBorderStyle}`;
            
            cellHTMLs.push(`<td style="${cellStyle}">${cellContent}</td>`);
            
            isFirstTradeInGroup = false;
            });
        });
        
        // Build complete row HTML and set once for better performance
        row.innerHTML = cellHTMLs.join('');
        
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
            // Check if dark mode is active
            const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
            
            // Use white background in light mode (original behavior), dark in dark mode
            if (isDarkMode) {
                firstCell.style.setProperty('background-color', 'var(--table-header-bg)', 'important');
                firstCell.style.setProperty('background', 'var(--table-header-bg)', 'important');
                firstCell.style.setProperty('color', 'var(--text-color)', 'important');
                firstCell.style.setProperty('border-left', '1px solid var(--border-color)', 'important');
                firstCell.style.setProperty('border-right', '2px solid var(--border-color)', 'important');
                firstCell.style.setProperty('border-top', '1px solid var(--border-color)', 'important');
                firstCell.style.setProperty('border-bottom', '1px solid var(--border-color)', 'important');
            } else {
                // Light mode: use white background (original behavior)
                firstCell.style.setProperty('background-color', '#ffffff', 'important');
                firstCell.style.setProperty('background', '#ffffff', 'important');
                firstCell.style.setProperty('color', '#212529', 'important');
                firstCell.style.setProperty('border-left', '1px solid #dee2e6', 'important');
                firstCell.style.setProperty('border-right', '2px solid #dee2e6', 'important');
                firstCell.style.setProperty('border-top', '1px solid #dee2e6', 'important');
                firstCell.style.setProperty('border-bottom', '1px solid #dee2e6', 'important');
            }
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
            // Use CSS variable for background color to match table background
            overlay.style.backgroundColor = 'var(--table-bg)';
            overlay.style.zIndex = '101';
            overlay.style.pointerEvents = 'none';
            firstCell.appendChild(overlay);
        }
        
        fragment.appendChild(row);
    });
    
    // Use requestAnimationFrame to batch DOM updates and reduce reflows
    requestAnimationFrame(() => {
        // Append all rows at once for better performance
        tbody.appendChild(fragment);
        
        console.log('Trades table update completed. Rows:', tbody.children.length);
        
        // Set table width based on total columns (fixed width)
        setTableWidth();
        
        // Add fade-in animation to the table (optimized: reduced duration)
        fadeIn(tbody, 200); // Reduced from 300ms to 200ms for faster feel
    });
}

// Update first column styles in trades table when theme changes
function updateTradesTableFirstColumnStyles() {
    const tbody = document.getElementById('trades-table');
    if (!tbody) return;
    
    const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
    const rows = tbody.querySelectorAll('tr');
    
    rows.forEach(row => {
        const firstCell = row.querySelector('td:first-child');
        if (firstCell && firstCell.classList.contains('trades-first-column')) {
            if (isDarkMode) {
                firstCell.style.setProperty('background-color', 'var(--table-header-bg)', 'important');
                firstCell.style.setProperty('background', 'var(--table-header-bg)', 'important');
                firstCell.style.setProperty('color', 'var(--text-color)', 'important');
                firstCell.style.setProperty('border-left', '2px solid var(--border-color)', 'important');
                firstCell.style.setProperty('border-right', '2px solid var(--border-color)', 'important');
                firstCell.style.setProperty('border-top', '2px solid var(--border-color)', 'important');
                firstCell.style.setProperty('border-bottom', '1px solid var(--border-color)', 'important');
            } else {
                firstCell.style.setProperty('background-color', '#ffffff', 'important');
                firstCell.style.setProperty('background', '#ffffff', 'important');
                firstCell.style.setProperty('color', '#212529', 'important');
                firstCell.style.setProperty('border-left', '2px solid #dee2e6', 'important');
                firstCell.style.setProperty('border-right', '2px solid #dee2e6', 'important');
                firstCell.style.setProperty('border-top', '2px solid #dee2e6', 'important');
                firstCell.style.setProperty('border-bottom', '1px solid #dee2e6', 'important');
            }
            
            // Update the overlay element background color (if it exists)
            // The overlay is a direct child div with absolute positioning
            const overlay = Array.from(firstCell.children).find(child => 
                child.tagName === 'DIV' && 
                (child.style.position === 'absolute' || window.getComputedStyle(child).position === 'absolute')
            );
            if (overlay) {
                // Use CSS variable to match table background
                overlay.style.backgroundColor = 'var(--table-bg)';
            }
        }
    });
}

function toggleTradeDateSort() {
    // Toggle sort direction
    if (sortColumn === 'date_trade_open' || sortColumn === 'trade_date') {
        // If already sorting by trade_date, toggle direction
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        // If not sorting by trade_date, set to trade_date with default desc
        sortColumn = 'date_trade_open';
        sortDirection = 'desc';
    }
    
    // Re-render the table with new sort
    updateTradesTable();
    
    // Also update cost basis table to match the sort
    const selectedTicker = window.symbolFilter || document.getElementById('symbol-filter')?.value || '';
    loadCostBasis(selectedTicker);
}

function toggleCostBasisDateSort() {
    // Toggle sort direction (linked to trades table sort)
    if (sortColumn === 'date_trade_open' || sortColumn === 'trade_date') {
        // If already sorting by date_trade_open, toggle direction
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        // If not sorting by date_trade_open, set to date_trade_open with default desc
        sortColumn = 'date_trade_open';
        sortDirection = 'desc';
    }
    
    // Re-render both tables with new sort
    updateTradesTable();
    
    // Reload cost basis to apply the new sort
    const selectedTicker = window.symbolFilter || document.getElementById('symbol-filter')?.value || '';
    loadCostBasis(selectedTicker);
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
    console.log('[updateCostBasisTable] Called with data:', costBasisData);
    const container = document.getElementById('cost-basis-table-container');
    const inlineContainer = document.getElementById('cost-basis-inline-container');
    
    const targetContainers = [container, inlineContainer].filter(c => c !== null);
    console.log('[updateCostBasisTable] Target containers found:', targetContainers.length);
    
    if (!costBasisData || costBasisData.length === 0) {
        console.log('[updateCostBasisTable] No data');
        // If a ticker filter is active, hide the table completely (no ticker cards)
        // Otherwise, show empty message
        if (isTickerSelected) {
            console.log('[updateCostBasisTable] Ticker filter active with no results, hiding table');
            targetContainers.forEach(c => {
                c.innerHTML = ''; // Hide completely - no ticker cards
            });
        } else {
            console.log('[updateCostBasisTable] No ticker filter, showing empty message');
            targetContainers.forEach(c => {
                c.innerHTML = `
                    <div class="text-center text-muted">
                        <i class="fas fa-info-circle me-2"></i>
                        No cost basis data available.
                    </div>
                `;
            });
        }
        return;
    }
    
    // Use array for better performance than string concatenation
    const htmlParts = [];
    
    // Check if a ticker is selected by checking window.symbolFilter
    const isTickerSelected = window.symbolFilter && window.symbolFilter.trim() !== '';
    
    // Debug: Log all accounts in the data
    console.log('[updateCostBasisTable] Total entries:', costBasisData.length);
    if (isTickerSelected) {
        const accountIds = costBasisData.map(d => ({ account_id: d.account_id, account_name: d.account_name, ticker: d.ticker }));
        console.log('[updateCostBasisTable] Accounts in data:', accountIds);
    }
    
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
            // When ticker is selected, sort by account_id to ensure consistent order
            // Rule One (9) first, then others
            if (a.account_id === 9 && b.account_id !== 9) return -1;
            if (a.account_id !== 9 && b.account_id === 9) return 1;
            return (a.account_id || 0) - (b.account_id || 0);
        }
    });
    
    // Check if dark mode is active - use CSS variable that changes with theme
    const tickerTextColor = 'var(--ticker-card-color)';
    
    for (const tickerData of sortedCostBasisData) {
        let { ticker, company_name, account_id, account_name, total_shares, total_cost_basis, total_cost_basis_per_share, trades } = tickerData;
        console.log('[updateCostBasisTable] Processing ticker:', ticker, 'trades:', trades?.length || 0);
        
        // If company_name is missing or equals ticker, fetch it on demand (async, non-blocking)
        if ((!company_name || company_name === ticker) && ticker) {
            // Fetch company name asynchronously and update the display when it arrives
            getCompanyName(ticker).then(fetchedName => {
                if (fetchedName && fetchedName !== ticker) {
                    // Update the company name in the displayed card
                    const container = document.getElementById('cost-basis-table-container') || 
                                      document.getElementById('cost-basis-inline-container');
                    if (container) {
                        // Find the header card that contains this ticker
                        const headerCards = container.querySelectorAll('h6.mb-0.text-center');
                        for (const headerCard of headerCards) {
                            const text = headerCard.textContent.trim();
                            // Check if this card is for the current ticker (starts with ticker)
                            if (text.startsWith(ticker + ' ') || text.startsWith(ticker + ' (')) {
                                const accountDisplay = account_name ? ` (${account_name})` : '';
                                headerCard.textContent = `${ticker} - ${fetchedName}${accountDisplay}`;
                                break;
                            }
                        }
                    }
                }
            }).catch(err => {
                // Silently fail - just use ticker without company name
                console.log('[updateCostBasisTable] Could not fetch company name for', ticker, err);
            });
        }
        
        const accountDisplay = account_name ? ` (${account_name})` : '';
        const tradesCount = (trades && Array.isArray(trades) && trades.length) ? trades.length : 0;
        const tradesCountStr = String(tradesCount || 0);
        // Escape ticker for use in HTML data attribute
        const tickerStr = String(ticker || '');
        let escapedTicker = tickerStr.replace(/&/g, '&amp;');
        escapedTicker = escapedTicker.replace(/'/g, '&#39;');
        escapedTicker = escapedTicker.replace(/"/g, '&quot;');
        
        // Pre-compute formatted values to avoid nested template string parsing issues
        const currencyOptions = {minimumFractionDigits: 2, maximumFractionDigits: 2};
        const formatCurrency = (value) => {
            const absValue = Math.abs(value);
            const formatted = absValue.toLocaleString('en-US', currencyOptions);
            return value < 0 ? '(' + '$' + formatted + ')' : '$' + formatted;
        };
        const formatNumber = (value) => {
            const formatted = Math.abs(value).toLocaleString();
            return value < 0 ? '(' + formatted + ')' : formatted;
        };
        const formattedTotalCostBasis = formatCurrency(total_cost_basis);
        const formattedCostBasisPerShare = formatCurrency(total_cost_basis_per_share);
        const formattedTotalShares = formatNumber(total_shares);
        const costBasisColorStyle = total_cost_basis < 0 ? 'color: var(--danger-color);' : '';
        const costBasisPerShareColorStyle = total_cost_basis_per_share < 0 ? 'color: var(--danger-color);' : '';
        const totalSharesColorStyle = total_shares < 0 ? 'color: var(--danger-color);' : '';
        
        if (!isTickerSelected) {
            // Original layout when no ticker is selected
            htmlParts.push(`
            <div class="mb-4">
                <!-- Ticker and Summary Cards in one row when no ticker selected -->
                <div class="row mb-2 g-2 align-items-center">
                    <div style="flex: 0 0 50px !important; width: 50px !important; min-width: 50px !important; max-width: 50px !important;">
                        <div class="card cost-basis-ticker-card" style="cursor: pointer; width: 50px !important; height: 32px !important; min-width: 50px !important; max-width: 50px !important; overflow: hidden !important; box-sizing: border-box !important; background-color: var(--card-bg); border: 1px solid var(--border-color) !important; outline: 1px solid var(--border-color) !important; outline-offset: -1px !important;" data-ticker="${escapedTicker}" data-action="filter-ticker" title="Click to filter trades and cost basis">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; overflow: hidden; box-sizing: border-box; padding: 0.05rem !important;">
                                <h6 class="mb-0 cost-basis-ticker-text" style="font-size: 0.6125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0; padding: 0; width: 100%; display: block; color: ${tickerTextColor};">
                                    ${ticker}
                                </h6>
                            </div>
                        </div>
                    </div>
                    <div style="flex: 0 0 42px !important; width: 42px !important; min-width: 42px !important; max-width: 42px !important;">
                        <div class="card" style="width: 42px !important; height: 42px !important; min-width: 42px !important; max-width: 42px !important; box-sizing: border-box !important; background-color: var(--card-bg); border-color: var(--border-color);">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; overflow: hidden; box-sizing: border-box; padding: 0.2rem !important;">
                                <h6 class="card-title mb-0" style="font-size: 0.6125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); line-height: 1.0;">Total Shares</h6>
                                <p class="card-text mb-0" style="font-size: 0.6125rem; color: var(--text-color); line-height: 1.1; ${totalSharesColorStyle}">${formattedTotalShares}</p>
                            </div>
                        </div>
                    </div>
                    <div style="flex: 0 0 42px !important; width: 42px !important; min-width: 42px !important; max-width: 42px !important;">
                        <div class="card" style="width: 42px !important; height: 42px !important; min-width: 42px !important; max-width: 42px !important; box-sizing: border-box !important; background-color: var(--card-bg); border-color: var(--border-color);">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; overflow: hidden; box-sizing: border-box; padding: 0.2rem !important;">
                                <h6 class="card-title mb-0" style="font-size: 0.6125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); line-height: 1.0;">Total Cost Basis</h6>
                                <p class="card-text mb-0" style="font-size: 0.6125rem; color: var(--text-color); line-height: 1.1; ${costBasisColorStyle}">${formattedTotalCostBasis}</p>
                            </div>
                        </div>
                    </div>
                    <div style="flex: 0 0 42px !important; width: 42px !important; min-width: 42px !important; max-width: 42px !important;">
                        <div class="card" style="width: 42px !important; height: 42px !important; min-width: 42px !important; max-width: 42px !important; box-sizing: border-box !important; background-color: var(--card-bg); border-color: var(--border-color);">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; overflow: hidden; box-sizing: border-box; padding: 0.2rem !important;">
                                <h6 class="card-title mb-0" style="font-size: 0.6125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); line-height: 1.0;">Cost Basis/Share</h6>
                                <p class="card-text mb-0" style="font-size: 0.6125rem; color: var(--text-color); line-height: 1.1; ${costBasisPerShareColorStyle}">${formattedCostBasisPerShare}</p>
                            </div>
                        </div>
                    </div>
                    <div style="flex: 0 0 42px !important; width: 42px !important; min-width: 42px !important; max-width: 42px !important;">
                        <div class="card" style="width: 42px !important; height: 42px !important; min-width: 42px !important; max-width: 42px !important; box-sizing: border-box !important; background-color: var(--card-bg); border-color: var(--border-color);">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; overflow: hidden; box-sizing: border-box; padding: 0.2rem !important;">
                                <h6 class="card-title mb-0" style="font-size: 0.6125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); line-height: 1.0;">Total Trades</h6>
                                <p class="card-text mb-0" style="font-size: 0.6125rem; color: var(--text-color); line-height: 1.1;">${tradesCountStr}</p>
                            </div>
                        </div>
                    </div>
                </div>
            `);
        } else {
            // When ticker is selected, show header card and summary cards for each account
            htmlParts.push(`
            <div class="mb-4">
                <!-- First row: Ticker and Company Name card when ticker is selected -->
                <div class="row mb-2 g-2 align-items-center">
                    <div class="col-12">
                        <div class="card" style="height: 42px; background-color: var(--card-bg); border-color: var(--border-color);">
                            <div class="card-body d-flex align-items-center justify-content-center" style="padding: 0.2rem !important;">
                                <h6 class="mb-0 text-center" style="font-size: 0.875rem; font-weight: 600; color: var(--text-color);">
                                    ${ticker}${company_name && company_name !== ticker ? ' - ' + company_name : ''}${accountDisplay}
                                </h6>
                            </div>
                        </div>
                    </div>
                </div>
                <!-- Summary Cards in second row - showing totals for this account -->
                <div class="row mb-2 g-2 align-items-center">
                    <div class="col-md-4 col-sm-4 col-12">
                        <div class="card" style="height: 42px; background-color: var(--card-bg); border-color: var(--border-color);">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; padding: 0.2rem !important;">
                                <h6 class="card-title mb-0" style="font-size: 0.875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); line-height: 1.0;">Total Shares</h6>
                                <p class="card-text mb-0" style="font-size: 0.875rem; color: var(--text-color); line-height: 1.1; ${totalSharesColorStyle}">${formattedTotalShares}</p>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-4 col-sm-4 col-12">
                        <div class="card" style="height: 42px; background-color: var(--card-bg); border-color: var(--border-color);">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; padding: 0.2rem !important;">
                                <h6 class="card-title mb-0" style="font-size: 0.875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); line-height: 1.0;">Total Cost Basis</h6>
                                <p class="card-text mb-0" style="font-size: 0.875rem; color: var(--text-color); line-height: 1.1; ${costBasisColorStyle}">${formattedTotalCostBasis}</p>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-4 col-sm-4 col-12">
                        <div class="card" style="height: 42px; background-color: var(--card-bg); border-color: var(--border-color);">
                            <div class="card-body text-center d-flex flex-column justify-content-center" style="height: 100%; padding: 0.2rem !important;">
                                <h6 class="card-title mb-0" style="font-size: 0.875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); line-height: 1.0;">Cost Basis/Share</h6>
                                <p class="card-text mb-0" style="font-size: 0.875rem; color: var(--text-color); line-height: 1.1; ${costBasisPerShareColorStyle}">${formattedCostBasisPerShare}</p>
                            </div>
                        </div>
                    </div>
                </div>
            `);
        }
        
        // Render transactions table for each ticker data entry (each account separately)
        const tableTrades = trades || [];
        htmlParts.push(`
                
                <!-- Transactions Table -->
                <div class="table-responsive">
                    <table class="table table-sm table-striped">
                        <thead class="table-dark">
                            <tr>
                                <th class="text-center align-middle" style="width: 8%; cursor: pointer;" onclick="toggleCostBasisDateSort()" title="Click to sort by trade date">
                                    Trade Date
                                    ${(sortColumn === 'date_trade_open' || sortColumn === 'trade_date') ? (sortDirection === 'asc' ? ' <i class="fas fa-sort-up"></i>' : ' <i class="fas fa-sort-down"></i>') : ' <i class="fas fa-sort" style="opacity: 0.3;"></i>'}
                                </th>
                                <th class="text-start align-middle" style="width: 25%;">Trade Description</th>
                                <th class="text-end align-middle">Shares</th>
                                <th class="text-end align-middle">Cost</th>
                                <th class="text-end align-middle">Amount</th>
                                <th class="text-end align-middle">Basis</th>
                                <th class="text-end align-middle">Basis/Share</th>
                            </tr>
                        </thead>
                        <tbody>
            `);
            
            // Sort trades by transaction_date based on sortColumn and sortDirection from trades table
            // By default, link to the same sort as trades table
            const sortedTableTrades = Array.isArray(tableTrades) ? [...tableTrades].sort((a, b) => {
                const aDate = new Date(a.transaction_date || a.date_trade_open || a.trade_date || '');
                const bDate = new Date(b.transaction_date || b.date_trade_open || b.trade_date || '');
                
                // Use the same sort state as trades table
                if (sortColumn === 'date_trade_open' || sortColumn === 'trade_date') {
                    if (sortDirection === 'asc') {
                        return aDate - bDate;
                    } else {
                        return bDate - aDate;
                    }
                } else {
                    // Default: sort by transaction_date ascending (oldest first) for running totals
                    return aDate - bDate;
                }
            }) : [];
            
            // Add each trade as a row
            if (sortedTableTrades.length === 0) {
                htmlParts.push('<tr><td colspan="7" class="text-center text-muted">No trades found</td></tr>');
            } else {
                sortedTableTrades.forEach(trade => {
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
                let textColor = '';
                
                // Check if dark mode is active
                const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';

                if (trade.is_closing_debit) {
                    // Rolling debit rows: orange tint to stand out as a cost entry
                    bgColor = isDarkMode ? 'background-color: #5a3e1b;' : 'background-color: #FEE8CC;';
                } else if (trade.is_diagonal) {
                    // DIAGONAL roll rows: light blue/teal to distinguish from regular STO
                    bgColor = isDarkMode ? 'background-color: #1b3a4b;' : 'background-color: #D9EDF7;';
                } else if (trade.is_assignment) {
                    // Assignment rows: distinct green to highlight share acquisition
                    bgColor = isDarkMode ? 'background-color: #1a3d2b;' : 'background-color: #C6E0B4;';
                } else if (status === 'roll') {
                    bgColor = 'background-color: #FFF2CC;';
                    if (isDarkMode) textColor = 'color: #212529;'; // Dark text for light yellow background
                } else if (status === 'expired' && tradeType.toLowerCase().includes('put')) {
                    bgColor = 'background-color: #C6E0B4;';
                    if (isDarkMode) textColor = 'color: #212529;'; // Dark text for light green background
                } else if (status === 'assigned' && tradeType.toLowerCase().includes('put')) {
                    bgColor = 'background-color: #A9D08F;';
                    if (isDarkMode) textColor = 'color: #212529;'; // Dark text for green background
                } else if (status === 'assigned' && tradeType.toLowerCase().includes('call')) {
                    bgColor = 'background-color: #9BC2E6;';
                    if (isDarkMode) textColor = 'color: #212529;'; // Dark text for light blue background
                } else if (status === 'expired' && tradeType.toLowerCase().includes('call')) {
                    bgColor = 'background-color: #DEEAF7;';
                    if (isDarkMode) textColor = 'color: #212529;'; // Dark text for light blue background
                }
                
                const rowStyle = bgColor || textColor ? `style="${bgColor} ${textColor}"` : '';

                // Clean up description for closing debit rows
                let displayDescription = trade.trade_description || '';
                if (trade.is_closing_debit && !trade.is_diagonal) {
                    displayDescription = '↩ ' + displayDescription.replace(/^BTC \S+ \S+ closing debit$/i, 'Rolling debit (BTC)');
                }
                
                htmlParts.push(`
                    <tr ${rowStyle}>
                        <td class="text-center align-middle" style="white-space: nowrap; padding: 0.35rem 0.525rem;">${formatDate(trade.transaction_date || trade.date_trade_open || trade.trade_date)}</td>
                        <td class="text-start align-middle" style="width: 25%; word-wrap: break-word; overflow-wrap: break-word; padding: 0.35rem 0.525rem;">${displayDescription}</td>
                        <td class="text-end align-middle ${sharesClass}" style="${isSharesZero ? 'color: transparent;' : ''}">${formatShares(trade.shares || 0)}</td>
                        <td class="text-end align-middle ${costClass}" style="${isCostZero ? 'color: transparent;' : ''}">${formatNumber(trade.cost_per_share || 0)}</td>
                        <td class="text-end align-middle ${amountClass}" style="${isAmountZero ? 'color: transparent;' : ''}">${formatNumber(trade.amount || 0)}</td>
                        <td class="text-end align-middle ${runningBasisClass}">${formatNumber(trade.running_basis)}</td>
                        <td class="text-end align-middle ${runningBasisPerShareClass}">${formatNumber(trade.running_basis_per_share)}</td>
                    </tr>
                `);
                });
            }
        
        htmlParts.push(`
                        </tbody>
                    </table>
                </div>
            </div>
        `);
    }
    
    // Join all HTML parts at once for better performance
    const html = htmlParts.join('');
    
    // Set HTML for both containers - use requestAnimationFrame for smoother rendering
    console.log('[updateCostBasisTable] Setting HTML, length:', html.length);
    
    // Use requestAnimationFrame to ensure DOM updates happen in a single batch
    requestAnimationFrame(() => {
        targetContainers.forEach(c => {
            // Batch DOM operations: set HTML in one operation (clears and sets)
            // Use DocumentFragment for better performance when possible, but for large HTML strings, innerHTML is faster
            c.innerHTML = html;
            console.log('[updateCostBasisTable] HTML set for container:', c.id);
            
            // Add event delegation for ticker filter clicks and hover effects
            c.addEventListener('click', (e) => {
                const card = e.target.closest('[data-action="filter-ticker"]');
                if (card) {
                    const ticker = card.getAttribute('data-ticker');
                    if (ticker) {
                        setUniversalTickerFilter(ticker);
                    }
                }
            });
            
            // Add hover effects for ticker cards
            c.addEventListener('mouseover', (e) => {
                const card = e.target.closest('[data-action="filter-ticker"]');
                if (card) {
                    card.style.backgroundColor = 'var(--light-color-alt)';
                }
            });
            
            c.addEventListener('mouseout', (e) => {
                const card = e.target.closest('[data-action="filter-ticker"]');
                if (card) {
                    card.style.backgroundColor = 'var(--card-bg)';
                }
            });
            
            // Add fade-in animation to cards after a brief delay to ensure DOM is ready
            requestAnimationFrame(() => {
                const cards = c.querySelectorAll('.card');
                if (cards.length > 0) {
                    fadeInElements(cards, 200); // Optimized: Reduced from 300ms to 200ms
                } else {
                    // If no cards, fade in the container itself
                    fadeIn(c, 200); // Optimized: Reduced from 300ms to 200ms
                }
            });
        });
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

// Event delegation handler for clickable-symbol elements
function handleSymbolClick(e) {
    const symbolElement = e.target.closest('.clickable-symbol');
    if (symbolElement) {
        const symbol = symbolElement.getAttribute('data-symbol');
        if (symbol) {
            filterBySymbol(symbol);
            return;
        }
    }
    
    // Handle cost basis symbol selection
    const costBasisSymbol = e.target.closest('[data-action="select-cost-basis-symbol"]');
    if (costBasisSymbol) {
        const symbol = costBasisSymbol.getAttribute('data-symbol');
        if (symbol) {
            selectCostBasisSymbol(symbol);
            return;
        }
    }
    
    // Handle top symbol links
    const topSymbolLink = e.target.closest('.top-symbol-link');
    if (topSymbolLink) {
        const symbol = topSymbolLink.getAttribute('data-symbol');
        if (symbol) {
            filterByTopSymbol(symbol);
            return;
        }
    }
}

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
    
    // Check if dark mode is active - use CSS variable that changes with theme
    const tickerTextColor = 'var(--ticker-card-color)';
    
    // Calculate width for 4-character ticker (condensed layout)
    // Using 50px to accommodate padding and ensure 4 characters fit comfortably
    const cardWidth = '50px';
    const cardHeight = '32px';
    
    // Use flexbox with wrap for responsive layout
    let symbolsHtml = `<div style="display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: flex-start;">`;
    allTickers.forEach(ticker => {
        // Escape ticker for use in data attribute
        const tickerStr = String(ticker || '');
        const escapedTickerForSymbol = tickerStr.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
        symbolsHtml += `
            <div class="card symbol-card" data-symbol="${escapedTickerForSymbol}" data-action="select-cost-basis-symbol" 
                 style="cursor: pointer; 
                        width: ${cardWidth} !important; 
                        min-width: ${cardWidth} !important; 
                        max-width: ${cardWidth} !important;
                        height: ${cardHeight} !important;
                        min-height: ${cardHeight} !important;
                        box-sizing: border-box !important;
                        background-color: var(--card-bg); 
                        border: 1px solid var(--border-color) !important;
                        outline: 1px solid var(--border-color) !important;
                        outline-offset: -1px !important;"
                 title="Click to filter trades and cost basis by ${ticker}">
                <div class="card-body text-center d-flex align-items-center justify-content-center" 
                     style="padding: 0.05rem !important; height: 100%; box-sizing: border-box;">
                    <h6 class="card-title mb-0" style="font-size: 0.6125rem; white-space: nowrap; margin: 0; color: ${tickerTextColor}; overflow: hidden; text-overflow: ellipsis;">${ticker}</h6>
                </div>
            </div>
        `;
    });
    symbolsHtml += '</div>';
    
    // Set HTML for both containers and add event delegation
    targetContainers.forEach(c => {
        c.innerHTML = symbolsHtml;
        
        // Add event delegation for symbol card clicks and hover effects
        c.addEventListener('click', (e) => {
            const symbolCard = e.target.closest('[data-action="select-cost-basis-symbol"]');
            if (symbolCard) {
                const symbol = symbolCard.getAttribute('data-symbol');
                if (symbol) {
                    selectCostBasisSymbol(symbol);
                }
            }
        });
        
        // Add hover effects for symbol cards
        c.addEventListener('mouseover', (e) => {
            const card = e.target.closest('[data-action="select-cost-basis-symbol"]');
            if (card) {
                card.style.backgroundColor = 'var(--light-color-alt)';
            }
        });
        
        c.addEventListener('mouseout', (e) => {
            const card = e.target.closest('[data-action="select-cost-basis-symbol"]');
            if (card) {
                card.style.backgroundColor = 'var(--card-bg)';
            }
        });
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
        const response = await apiFetch(`/api/trades/${tradeId}`);
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
    
    // Check if this is a temporary (unsaved) trade
    const tradeIdStr = String(tradeId);
    if (tradeIdStr.startsWith('new_')) {
        // Remove temporary trade from the trades array
        const index = trades.findIndex(t => String(t.id) === tradeIdStr);
        if (index !== -1) {
            trades.splice(index, 1);
            console.log('[DEBUG] Removed temporary trade from array:', tradeIdStr);
            
            // Remove from trade creation flags
            if (window.tradeCreationFlags && window.tradeCreationFlags[tradeIdStr]) {
                delete window.tradeCreationFlags[tradeIdStr];
            }
            
            // Remove from ticker handlers
            if (window._attachTickerHandlersForTrade && window._attachTickerHandlersForTrade[tradeIdStr]) {
                delete window._attachTickerHandlersForTrade[tradeIdStr];
            }
            
            // Re-render the table
            updateTradesTable();
            
            // Preserve ticker filter when reloading cost basis after deletion
            const selectedTicker = window.symbolFilter || document.getElementById('symbol-filter')?.value || '';
            await loadCostBasis(selectedTicker || null);
        } else {
            console.warn('[DEBUG] Temporary trade not found in array:', tradeIdStr);
        }
        return;
    }
    
    // For saved trades, call the backend API
    try {
        const response = await apiFetch(`/api/trades/${tradeId}`, { 
            method: 'DELETE' 
        });
        const result = await response.json();
        
        if (result.success) {
            await loadTrades();
            loadSummary();
            // Preserve ticker filter when reloading cost basis after deletion
            const selectedTicker = window.symbolFilter || document.getElementById('symbol-filter')?.value || '';
            await loadCostBasis(selectedTicker || null);
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
        const response = await apiFetch(`/api/trades/${tradeId}/status`, {
            method: 'PUT',
            body: { status: newStatus }
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Update the trade object in memory
            const trade = trades.find(t => t.id === tradeId);
            if (trade) {
                trade.trade_status = newStatus;
            }
            
            // Update roll date and closing debit fields immediately based on new status
            // (The backend already sets closing_debit to 0.00 when status is not roll/closed)
            const tbody = document.getElementById('trades-table');
            if (tbody) {
                const rows = tbody.querySelectorAll('tr');
                const isRollOrClosed = newStatus.toLowerCase() === 'roll' || newStatus.toLowerCase() === 'closed';
                
                // Today in DD-MMM-YY format (same as trade date display)
                const todayISO = new Date().toISOString().split('T')[0];
                const todayFormatted = formatDate(todayISO);

                rows.forEach(row => {
                    // Find roll date input (fieldIndex 15)
                    const rollDateInput = row.querySelector(`input[data-field="date_trade_rolled"][data-trade-id="${tradeId}"]`);
                    if (rollDateInput) {
                        rollDateInput.disabled = !isRollOrClosed;
                        // Pre-fill today's date when enabling; clear when disabling
                        if (isRollOrClosed && !rollDateInput.value) {
                            rollDateInput.value = todayFormatted;
                        } else if (!isRollOrClosed) {
                            rollDateInput.value = '';
                        }
                    }
                    
                    // Find closing debit field (fieldIndex 16) - may be input or span
                    const closingDebitInput = row.querySelector(`input[data-field="closing_debit"][data-trade-id="${tradeId}"]`);
                    if (closingDebitInput) {
                        closingDebitInput.disabled = !isRollOrClosed;
                    }
                });
            }
            
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
            // Restore cursor position (adjust if needed) - only for text inputs
            if (input.type === 'text') {
                const newCursorPos = Math.min(cursorPos - 1, formatted.length);
                try {
                    input.setSelectionRange(newCursorPos, newCursorPos);
                } catch (e) {
                    // Ignore errors for number inputs
                }
            }
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
    // Skip API calls for new trades (trades with IDs starting with 'new_')
    // These are temporary trades that haven't been saved to the database yet
    const isNewTrade = typeof tradeId === 'string' && tradeId.startsWith('new_');
    
    if (isNewTrade) {
        // For new trades, just update the trade object in memory
        const trade = trades.find(t => t.id === tradeId);
        if (trade) {
            // Track if we need to recalculate DTE
            let needsDTERecalc = false;
            let needsTableRefresh = false;
            
            // Update the field in memory
            if (field === 'ticker') {
                trade.ticker = value.toUpperCase();
            } else if (field === 'date_trade_open' || field === 'trade_date') {
                trade.date_trade_open = value;
                // Keep trade_date for backward compatibility during transition
                if (trade.trade_date !== undefined) {
                    trade.trade_date = value;
                }
                needsDTERecalc = true;
                needsTableRefresh = true;
            } else if (field === 'expiration_date') {
                trade.expiration_date = value;
                needsDTERecalc = true;
                needsTableRefresh = true;
            } else if (field === 'current_price') {
                trade.current_price = parseFloat(value) || 0;
            } else if (field === 'strike_price') {
                trade.strike_price = parseFloat(value) || 0;
                needsTableRefresh = true; // Affects risk capital, margin capital, RORC, ARORC
            } else if (field === 'credit_debit') {
                trade.credit_debit = parseFloat(value) || 0;
                needsTableRefresh = true; // Affects net credit, risk capital, margin capital, RORC, ARORC
            } else if (field === 'num_of_contracts') {
                trade.num_of_contracts = parseInt(value) || 1;
                // Update num_of_shares for options trades
                const tradeType = trade.trade_type || '';
                const baseTradeType = tradeType.includes(' ') ? tradeType.split(' ', 1)[1] : tradeType;
                if (baseTradeType !== 'BTO' && baseTradeType !== 'STC') {
                    trade.num_of_shares = trade.num_of_contracts * 100;
                }
                needsTableRefresh = true; // Affects net credit total, margin capital, shares
            } else if (field === 'account_id') {
                trade.account_id = parseInt(value) || 9;
            } else if (field === 'closing_debit') {
                trade.closing_debit = parseFloat(value) || 0;
                // Calculate total_debit = closing_debit * num_of_shares
                const numOfShares = trade.num_of_shares || (trade.num_of_contracts * 100);
                trade.total_debit = trade.closing_debit * numOfShares;
                needsTableRefresh = true; // Affects total_debit display
            } else if (field === 'date_trade_rolled') {
                trade.date_trade_rolled = value;
                needsTableRefresh = true; // May affect child trade calculations
            } else if (field === 'notes') {
                trade.notes = value;
            }
            
            // Recalculate DTE if needed
            if (needsDTERecalc && trade.expiration_date && trade.date_trade_open) {
                trade.days_to_expiration = calculateDaysToExpiration(trade.expiration_date, trade.date_trade_open);
            }
            
            // Refresh table to update calculated fields (net credit total, margin capital, ARORC)
            if (needsTableRefresh) {
                // Use setTimeout to debounce rapid field updates
                const refreshKey = `refresh_${tradeId}`;
                if (autoSaveTimeouts[refreshKey]) {
                    clearTimeout(autoSaveTimeouts[refreshKey]);
                }
                autoSaveTimeouts[refreshKey] = setTimeout(() => {
                    updateTradesTable();
                    delete autoSaveTimeouts[refreshKey];
                }, 300);
            }
            
            // If ticker changed, just update in memory
            // Don't trigger filter/display update here - wait for blur event
            // The blur event will call updateTickerDisplay which handles filtering
        }
        return; // Don't make API call for new trades
    }
    
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
        const response = await apiFetch(`/api/trades/${tradeId}/field`, {
            method: 'PUT',
            body: { field: field, value: value }
        });
        
        const result = await response.json();
        
        if (result.success) {
            if (reloadTable) {
                await loadTrades();
                loadSummary();
                // Reload cost basis with the selected ticker if one is set
                const selectedTicker = window.symbolFilter || document.getElementById('symbol-filter')?.value || '';
                await loadCostBasis(selectedTicker);
                // Note: cash_flows are automatically updated in the backend when trade fields change
            } else {
                // Just update the trade in memory without reloading the table
                const tradeIndex = trades.findIndex(t => t.id === tradeId);
                if (tradeIndex !== -1) {
                    // Update the trade object
                    if (field === 'expiration_date') {
                        trades[tradeIndex].expiration_date = value;
                        // Recalculate DTE
                        const tradeDateForDTE = trades[tradeIndex].date_trade_open || trades[tradeIndex].trade_date;
                        if (tradeDateForDTE) {
                            const newDTE = calculateDaysToExpiration(value, tradeDateForDTE);
                            trades[tradeIndex].days_to_expiration = newDTE;
                            // Update DTE cell in the table
                            updateDTECell(tradeId, value);
                        }
                    } else if (field === 'date_trade_open' || field === 'trade_date') {
                        trades[tradeIndex].date_trade_open = value;
                        // Keep trade_date for backward compatibility during transition
                        if (trades[tradeIndex].trade_date !== undefined) {
                            trades[tradeIndex].trade_date = value;
                        }
                        // Recalculate DTE
                        if (trades[tradeIndex].expiration_date) {
                            const newDTE = calculateDaysToExpiration(trades[tradeIndex].expiration_date, value);
                            trades[tradeIndex].days_to_expiration = newDTE;
                            // Update DTE cell in the table
                            updateDTECell(tradeId, trades[tradeIndex].expiration_date);
                        }
                        // Trade date affects ARORC (since ARORC = (365 / DTE) * RORC)
                        // Update ARORC cell after DTE is recalculated
                        updateTradeCell(tradeId, field, value, trades[tradeIndex]);
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
                        // Strike price affects risk capital, margin capital, RORC, ARORC
                        // These will be updated in updateTradeCell
                    } else if (field === 'credit_debit') {
                        trades[tradeIndex].credit_debit = parseFloat(value) || 0;
                        // Credit/debit affects net credit, risk capital, margin capital, RORC, ARORC
                        // These will be updated in updateTradeCell
                    } else if (field === 'current_price') {
                        trades[tradeIndex].current_price = parseFloat(value) || 0;
                    } else if (field === 'num_of_contracts') {
                        trades[tradeIndex].num_of_contracts = parseInt(value) || 1;
                        // Contracts change affects shares, net credit total, and margin capital
                        // These will be updated in updateTradeCell
                    } else if (field === 'date_trade_rolled') {
                        trades[tradeIndex].date_trade_rolled = value;
                        // When parent's date_trade_rolled changes, recalculate all child trades' DTE and ARORC
                        const childTrades = trades.filter(t => t.trade_parent_id === tradeId);
                        childTrades.forEach(childTrade => {
                            // Recalculate DTE for child trade using parent's date_trade_rolled
                            const childTradeDate = childTrade.date_trade_open || childTrade.trade_date;
                            if (childTradeDate && value) {
                                const newDTE = calculateDaysToExpiration(value, childTradeDate);
                                childTrade.days_to_expiration = newDTE;
                                // Update DTE cell
                                const dteCell = document.querySelector(`[data-field="dte"][data-trade-id="${childTrade.id}"]`);
                                if (dteCell) {
                                    dteCell.textContent = newDTE.toString();
                                }
                                // Recalculate ARORC for child trade
                                updateTradeCell(childTrade.id, 'date_trade_rolled', value, childTrade);
                            }
                        });
                    }
                    // Update the table cell without full reload
                    // This will also update dependent calculated fields (shares, net credit total, margin capital, RORC, ARORC)
                    // Pass the updated trade object to ensure calculations use latest values
                    updateTradeCell(tradeId, field, value, trades[tradeIndex]);
                    
                    // Always reload cost_basis to reflect backend updates to cash_flows and cost_basis
                    // Use await to ensure it completes before continuing
                    const selectedTicker = window.symbolFilter || document.getElementById('symbol-filter')?.value || '';
                    await loadCostBasis(selectedTicker);
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
function updateTradeCell(tradeId, field, value, updatedTrade = null) {
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
        } else if (field === 'date_trade_open' || field === 'trade_date') {
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
                // Use the updated date_trade_open from memory (which was just updated)
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
            // Strike price affects risk capital, margin capital, RORC, ARORC
        } else if (field === 'credit_debit') {
            // Update credit input
            if (cell.tagName === 'INPUT' && cell.type === 'number') {
                cell.value = parseFloat(value).toFixed(2);
            }
            // Credit/debit affects net credit, risk capital, margin capital, RORC, ARORC
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
    
    // Update calculated fields when contracts, strike_price, credit_debit, expiration_date, or closing_debit change
    // Use updatedTrade if provided (from updateTradeField), otherwise find from trades array
    const trade = updatedTrade || trades.find(t => t.id === tradeId);
    
    // Check if this field affects calculated values
    const affectsCalculations = field === 'num_of_contracts' || field === 'strike_price' || 
                                 field === 'credit_debit' || field === 'expiration_date' || 
                                 field === 'date_trade_open' || field === 'trade_date' ||
                                 field === 'closing_debit';
    
    // Handle closing_debit update separately
    if (trade && field === 'closing_debit') {
        const closingDebit = parseFloat(value) || 0;
        const numOfShares = trade.num_of_shares || (trade.num_of_contracts * 100);
        const totalDebit = closingDebit * numOfShares;
        
        // Update total_debit cell
        const tbody = document.getElementById('trades-table');
        if (tbody) {
            const tradeIdStr = String(tradeId);
            const totalDebitCell = tbody.querySelector(`[data-field="total_debit"][data-trade-id="${tradeIdStr}"]`);
            if (totalDebitCell) {
                totalDebitCell.textContent = '$' + totalDebit.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
            }
        }
    }
    
    if (trade && affectsCalculations) {
        // Use the updated value from the parameter, not the trade object (which might not be updated yet)
        let updatedContracts = trade.num_of_contracts || 1;
        let updatedStrike = trade.strike_price || 0;
        let updatedCredit = trade.credit_debit || trade.premium || 0;
        
        if (field === 'num_of_contracts') {
            updatedContracts = parseInt(value) || 1;
            // Update num_of_shares for options trades
            const tradeType = trade.trade_type || '';
            const baseTradeType = tradeType.includes(' ') ? tradeType.split(' ', 1)[1] : tradeType;
            if (baseTradeType !== 'BTO' && baseTradeType !== 'STC') {
                trade.num_of_shares = updatedContracts * 100;
            }
        } else if (field === 'strike_price') {
            updatedStrike = parseFloat(value) || 0;
        } else if (field === 'credit_debit') {
            updatedCredit = parseFloat(value) || 0;
        }
        
        // Recalculate all dependent fields using the same formulas as updateTradesTable
        const tradeCommission = trade.commission_per_share !== null && trade.commission_per_share !== undefined ? trade.commission_per_share : 0.0;
        const premium = updatedCredit;
        
        // Always recalculate net_credit_per_share when credit_debit changes, otherwise use database value
        let netCreditPerShare;
        if (field === 'credit_debit') {
            netCreditPerShare = premium - tradeCommission;
        } else {
            // Use database value if available, otherwise calculate
            netCreditPerShare = trade.net_credit_per_share !== null && trade.net_credit_per_share !== undefined 
                ? trade.net_credit_per_share 
                : (premium - tradeCommission);
        }
        
        // Use stored num_of_shares if available, otherwise calculate
        const shares = trade.num_of_shares !== null && trade.num_of_shares !== undefined 
            ? trade.num_of_shares 
            : (updatedContracts * 100);
        
        // Calculate cumulative net credit total for roll trades
        // First, update the trade object with the new values for accurate calculation
        const tempTrade = {...trade};
        if (field === 'num_of_contracts') {
            tempTrade.num_of_contracts = updatedContracts;
        } else if (field === 'strike_price') {
            tempTrade.strike_price = updatedStrike;
        } else if (field === 'credit_debit') {
            tempTrade.credit_debit = updatedCredit;
            tempTrade.net_credit_per_share = netCreditPerShare;
        }
        const cumulativeNetCreditTotal = calculateCumulativeNetCredit(tempTrade, trades);
        const netCreditTotal = cumulativeNetCreditTotal;
        
        // Always recalculate risk_capital when strike_price or credit_debit changes
        // Risk Capital = Strike Price - Net Credit Per Share
        let riskCapital;
        if (field === 'strike_price' || field === 'credit_debit') {
            riskCapital = updatedStrike - netCreditPerShare;
        } else {
            // Use database value if available, otherwise calculate
            riskCapital = trade.risk_capital_per_share !== null && trade.risk_capital_per_share !== undefined 
                ? trade.risk_capital_per_share 
                : (updatedStrike - netCreditPerShare);
        }
        
        // Always recalculate margin_capital when contracts, strike_price, or credit_debit changes
        // Margin Capital = Risk Capital * Shares
        const marginCapital = riskCapital * shares;
        
        // Calculate cumulative net credit per share for RORC calculation (for roll trades)
        const cumulativeNetCreditPerShare = shares > 0 ? (cumulativeNetCreditTotal / shares) : netCreditPerShare;
        
        // Calculate RORC: (Cumulative Net Credit Per Share / Risk Capital) * 100
        // RORC is a percentage (use cumulative for roll trades)
        let rorc = 0;
        if (field === 'expiration_date' || field === 'date_trade_open' || field === 'trade_date' || 
            field === 'strike_price' || field === 'credit_debit' || field === 'num_of_contracts') {
            rorc = riskCapital !== 0 && riskCapital > 0 ? (cumulativeNetCreditPerShare / riskCapital) * 100 : 0;
        } else {
            // For other changes, we can use existing RORC from trade or calculate it
            rorc = riskCapital !== 0 && riskCapital > 0 ? (cumulativeNetCreditPerShare / riskCapital) * 100 : 0;
        }
        
        // Always recalculate DTE using effective expiration date (parent's date_trade_rolled for child trades)
        const tradeDateForDTE = (field === 'date_trade_open' || field === 'trade_date') 
            ? value 
            : (trade.date_trade_open || trade.trade_date);
        // For child trades, use effective expiration date (parent's date_trade_rolled)
        const effectiveExpDate = getEffectiveExpirationDate(trade, trades);
        const expDateForDTE = effectiveExpDate || ((field === 'expiration_date') 
            ? value 
            : trade.expiration_date);
        let updatedDTE = 0;
        if (tradeDateForDTE && expDateForDTE) {
            updatedDTE = calculateDaysToExpiration(expDateForDTE, tradeDateForDTE);
        }
        
        // Calculate ARORC
        // For ROCT PUT and RULE ONE PUT trades, use: (365 / DTE) * (net_credit_per_share / (risk_capital_per_share * margin_percent))
        // For other trades, use: (365 / DTE) * RORC
        let arorc = 0;
        const tradeType = trade.trade_type || '';
        const isROCTPut = tradeType.includes('ROCT PUT') || tradeType.includes('RULE ONE PUT') || 
                         (tradeType.includes('PUT') && (tradeType.includes('ROCT') || tradeType.includes('RULE ONE')));
        
        if (updatedDTE > 0) {
            if (isROCTPut) {
                // Use cumulative net credit per share for roll trades
                const marginPercent = trade.margin_percent !== null && trade.margin_percent !== undefined ? trade.margin_percent : 100.0;
                const denominator = riskCapital * (marginPercent / 100.0);
                if (denominator > 0) {
                    const arorcDecimal = (365.0 / updatedDTE) * (cumulativeNetCreditPerShare / denominator);
                    arorc = parseFloat((arorcDecimal * 100.0).toFixed(1));
                }
            } else {
                // For other trades, use: (365 / DTE) * RORC
                arorc = parseFloat(((365 / updatedDTE) * rorc).toFixed(1));
            }
        }
        
        // Find cells by data attributes (more reliable than row/column indices)
        const tbody = document.getElementById('trades-table');
        if (!tbody) {
            console.warn('[updateTradeCell] tbody not found');
            return;
        }
        
        // Convert tradeId to string for consistent matching
        const tradeIdStr = String(tradeId);
        
        // Helper function to find cell by data attributes
        const findCell = (fieldName) => {
            // Try exact match first
            let cell = tbody.querySelector(`[data-field="${fieldName}"][data-trade-id="${tradeIdStr}"]`);
            if (!cell) {
                // Try finding by tradeId only and checking parent/child
                const allCells = tbody.querySelectorAll(`[data-trade-id="${tradeIdStr}"]`);
                for (let c of allCells) {
                    if (c.getAttribute('data-field') === fieldName || 
                        c.querySelector(`[data-field="${fieldName}"]`)) {
                        cell = c.getAttribute('data-field') === fieldName ? c : c.querySelector(`[data-field="${fieldName}"]`);
                        break;
                    }
                }
            }
            return cell;
        };
        
        // Update shares cell (only when contracts change)
        if (field === 'num_of_contracts') {
            const sharesCell = findCell('shares');
            if (sharesCell) {
                sharesCell.textContent = shares.toString();
            } else {
                console.warn(`[updateTradeCell] Could not find shares cell for trade ${tradeIdStr}`);
            }
        }
        
        // Update net credit total cell (only when contracts, strike_price, or credit_debit change)
        if (field === 'num_of_contracts' || field === 'strike_price' || field === 'credit_debit') {
            const netCreditTotalCell = findCell('net_credit_total');
            if (netCreditTotalCell) {
                // Handle both direct text content and nested strong tags
                if (netCreditTotalCell.tagName === 'STRONG') {
                    netCreditTotalCell.textContent = '$' + netCreditTotal.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
                } else {
                    const strongTag = netCreditTotalCell.querySelector('strong');
                    if (strongTag) {
                        strongTag.textContent = '$' + netCreditTotal.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
                    } else {
                        netCreditTotalCell.textContent = '$' + netCreditTotal.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
                    }
                }
            } else {
                console.warn(`[updateTradeCell] Could not find net credit total cell for trade ${tradeIdStr}`);
            }
        }
        
        // Update risk capital cell (only when strike_price or credit_debit change)
        if (field === 'strike_price' || field === 'credit_debit') {
            const riskCapitalCell = findCell('risk_capital');
            if (riskCapitalCell) {
                riskCapitalCell.textContent = '$' + riskCapital.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
            } else {
                console.warn(`[updateTradeCell] Could not find risk capital cell for trade ${tradeIdStr}`);
            }
        }
        
        // Update margin capital cell (only when contracts, strike_price, or credit_debit change)
        if (field === 'num_of_contracts' || field === 'strike_price' || field === 'credit_debit') {
            const marginCapitalCell = findCell('margin_capital');
            if (marginCapitalCell) {
                marginCapitalCell.textContent = '$' + marginCapital.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
            } else {
                console.warn(`[updateTradeCell] Could not find margin capital cell for trade ${tradeIdStr}`);
            }
        }
        
        // Update DTE cell when expiration_date or date_trade_open changes
        if (field === 'expiration_date' || field === 'date_trade_open' || field === 'trade_date') {
            const dteCell = findCell('dte');
            if (dteCell) {
                dteCell.textContent = updatedDTE.toString();
            } else {
                console.warn(`[updateTradeCell] Could not find DTE cell for trade ${tradeIdStr}`);
            }
        }
        
        // Update RORC cell (only when strike_price or credit_debit change, or when expiration_date changes and we need to recalculate ARORC)
        if (field === 'strike_price' || field === 'credit_debit' || field === 'expiration_date' || field === 'date_trade_open' || field === 'trade_date') {
            const rorcCell = findCell('rorc');
            if (rorcCell) {
                rorcCell.textContent = rorc.toFixed(2) + '%';
            } else {
                console.warn(`[updateTradeCell] Could not find RORC cell for trade ${tradeIdStr}`);
            }
        }
        
        // Update ARORC cell - always update when expiration_date, date_trade_open, strike_price, or credit_debit change
        if (field === 'expiration_date' || field === 'date_trade_open' || field === 'trade_date' || 
            field === 'strike_price' || field === 'credit_debit' || field === 'num_of_contracts') {
            const arorcCell = findCell('arorc');
            if (arorcCell) {
                // When fields change, always use the recalculated value
                if (arorc !== null && arorc !== undefined && !isNaN(arorc) && arorc !== 0) {
                    arorcCell.textContent = arorc.toFixed(1) + '%';
                } else {
                    // Fallback to database value if calculation is invalid
                    const dbARORC = trade.ARORC !== null && trade.ARORC !== undefined ? trade.ARORC : null;
                    if (dbARORC !== null && dbARORC !== undefined && !isNaN(dbARORC)) {
                        arorcCell.textContent = parseFloat(dbARORC).toFixed(1) + '%';
                    } else {
                        arorcCell.textContent = '-';
                    }
                }
            } else {
                console.warn(`[updateTradeCell] Could not find ARORC cell for trade ${tradeIdStr}`);
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

// Handle Tab key navigation - move down to next row (next field in same trade) instead of across columns
function handleTabNavigation(event, tradeId, currentFieldIndex) {
    // Check for Tab key (both key and keyCode for compatibility)
    if (event.key === 'Tab' || event.keyCode === 9) {
        // Prevent default tab behavior immediately
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (event.cancelable) {
            event.cancelBubble = true;
        }
        
        const tbody = document.getElementById('trades-table');
        if (!tbody) {
            return false;
        }
        
        // Find the current input element to determine its column index
        const currentInput = event.target;
        if (!currentInput) {
            return false;
        }
        
        // Find which column (cell index) this input is in
        const currentCell = currentInput.closest('td');
        if (!currentCell) {
            return false;
        }
        
        const currentRow = currentCell.closest('tr');
        if (!currentRow) {
            return false;
        }
        
        // Get all cells in the current row to find the column index
        const cells = currentRow.querySelectorAll('td');
        let currentColumnIndex = -1;
        for (let i = 0; i < cells.length; i++) {
            if (cells[i] === currentCell) {
                currentColumnIndex = i;
                break;
            }
        }
        
        if (currentColumnIndex === -1) {
            return false;
        }
        
        // Define the order of editable fields (field indices) - these are the row indices
        const editableFieldOrder = [2, 3, 4, 6, 7, 17, 8, 9]; // Ticker, Trade Date, Exp Date, Price, Short Strike, Long Strike (BPS), Credit, Contracts
        
        // Find current position in the order
        const currentIndex = editableFieldOrder.indexOf(currentFieldIndex);
        
        // Determine next/previous field (move down/up in the same column)
        let nextFieldIndex;
        if (currentIndex === -1) {
            // If current field is not in the editable list, find the next editable field in the same column
            const rows = tbody.querySelectorAll('tr');
            
            // Start from the current row and go down
            for (let i = currentFieldIndex + 1; i < rows.length; i++) {
                const row = rows[i];
                const rowCells = row.querySelectorAll('td');
                
                // Check if this column has an editable input
                if (rowCells[currentColumnIndex]) {
                    const cell = rowCells[currentColumnIndex];
                    const input = cell.querySelector('input, select');
                    if (input) {
                        const inputTradeId = input.getAttribute('data-trade-id');
                        if (inputTradeId && (inputTradeId === String(tradeId) || inputTradeId === tradeId)) {
                            // Use requestAnimationFrame to ensure focus happens after event is fully processed
                            requestAnimationFrame(() => {
                                input.focus();
                                if (input.select) {
                                    input.select();
                                }
                            });
                            return false;
                        }
                    }
                }
            }
            return false;
        }
        
        let nextIndex;
        if (event.shiftKey) {
            // Shift+Tab: move up (previous field in same trade)
            nextIndex = currentIndex > 0 ? currentIndex - 1 : editableFieldOrder.length - 1;
        } else {
            // Tab: move down (next field in same trade)
            nextIndex = currentIndex < editableFieldOrder.length - 1 ? currentIndex + 1 : 0;
        }
        
        nextFieldIndex = editableFieldOrder[nextIndex];
        
        // Find the next row and the same column
        const rows = tbody.querySelectorAll('tr');
        if (rows[nextFieldIndex]) {
            const nextRow = rows[nextFieldIndex];
            const nextRowCells = nextRow.querySelectorAll('td');
            
            // Check if this column has an editable input
            if (nextRowCells[currentColumnIndex]) {
                const cell = nextRowCells[currentColumnIndex];
                const input = cell.querySelector('input, select');
                if (input) {
                    const inputTradeId = input.getAttribute('data-trade-id');
                    if (inputTradeId && (inputTradeId === String(tradeId) || inputTradeId === tradeId)) {
                        // Use requestAnimationFrame to ensure focus happens after event is fully processed
                        requestAnimationFrame(() => {
                            input.focus();
                            if (input.select) {
                                input.select();
                            }
                        });
                        return false;
                    }
                }
            }
        }
        
        return false;
    }
    return true; // Allow other keys to work normally
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
    const toggleIcon = document.getElementById('trades-toggle-icon');
    const floatingExpand = document.getElementById('trades-floating-expand');
    
    if (!tradesColumn) return;
    
    // Toggle collapse/show classes - CSS handles the flex adjustments
    if (tradesColumn.classList.contains('show')) {
        // Collapsing - hide the trades table
        tradesColumn.classList.remove('show');
        tradesColumn.classList.add('collapse');
    } else {
        // Expanding - show the trades table
        tradesColumn.classList.remove('collapse');
        tradesColumn.classList.add('show');
        // When expanded, arrow in header points left (to collapse/hide)
        if (toggleIcon) {
            toggleIcon.classList.remove('fa-chevron-right');
            toggleIcon.classList.add('fa-chevron-left');
        }
    }
    
    // Update column widths first, then update floating arrow positions after layout settles
    updateColumnWidths();
    // Use double requestAnimationFrame to ensure layout has fully settled before positioning arrows
    // This ensures the cost basis card has fully expanded to its new width before we calculate arrow position
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            updateFloatingArrows();
        });
    });
}


function updateColumnWidths() {
    const tradesColumn = document.getElementById('trades-column');
    const costBasisColumn = document.getElementById('cost-basis-column');
    
    if (!tradesColumn || !costBasisColumn) return;
    
    const tradesIsVisible = tradesColumn.classList.contains('show');
    const costBasisIsVisible = costBasisColumn.classList.contains('show');
    
    if (tradesIsVisible && costBasisIsVisible) {
        // Both expanded: trades 60%, cost basis 40%
        tradesColumn.style.width = '60%';
        tradesColumn.style.flex = '0 0 60%';
        tradesColumn.style.minWidth = '';
        tradesColumn.style.maxWidth = '';
        costBasisColumn.style.width = '40%';
        costBasisColumn.style.flex = '0 0 40%';
        costBasisColumn.style.minWidth = '';
        costBasisColumn.style.maxWidth = '';
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
        // Both collapsed
        tradesColumn.style.width = '0';
        tradesColumn.style.flex = '0 0 0';
        tradesColumn.style.minWidth = '0';
        costBasisColumn.style.width = '0';
        costBasisColumn.style.flex = '0 0 0';
        costBasisColumn.style.minWidth = '0';
    }
}

function updateFloatingArrows() {
    const tradesColumn = document.getElementById('trades-column');
    const costBasisColumn = document.getElementById('cost-basis-column');
    const tradesFloatingExpand = document.getElementById('trades-floating-expand');
    const costBasisFloatingExpand = document.getElementById('cost-basis-floating-expand');
    const container = document.querySelector('.trades-cost-container');
    
    if (!tradesColumn || !costBasisColumn || !container) return;
    
    const tradesIsVisible = tradesColumn.classList.contains('show');
    const costBasisIsVisible = costBasisColumn.classList.contains('show');
    
    // Position floating arrows based on which sections are visible
    // Arrows are positioned relative to the trades-cost-container, vertically centered on headers
    // Use requestAnimationFrame to ensure DOM is ready before calculating positions
    requestAnimationFrame(() => {
        const containerRect = container.getBoundingClientRect();
        
        if (!tradesIsVisible && costBasisIsVisible) {
            // Trades collapsed, cost basis visible - show arrow on left edge of cost basis
            if (tradesFloatingExpand) {
                const costBasisCard = costBasisColumn.querySelector('.card');
                if (costBasisCard) {
                    const cardHeader = costBasisCard.querySelector('.card-header');
                    if (cardHeader) {
                        // Force a reflow to ensure layout is settled before getting bounding rects
                        void costBasisCard.offsetHeight;
                        const headerRect = cardHeader.getBoundingClientRect();
                        const cardRect = costBasisCard.getBoundingClientRect();
                        // Calculate vertical center of header
                        const headerTop = headerRect.top;
                        const headerHeight = headerRect.height;
                        const headerCenter = headerTop + (headerHeight / 2);
                        const containerTop = containerRect.top;
                        // Position arrow vertically centered on header (arrow is 50px tall, so center - 25px)
                        const arrowTop = headerCenter - containerTop - 25;
                        // Position on left edge of cost basis card
                        tradesFloatingExpand.style.display = 'block';
                        tradesFloatingExpand.style.left = `${cardRect.left - containerRect.left - 25}px`; // Half outside
                        tradesFloatingExpand.style.top = `${arrowTop}px`; // Vertically centered on header
                    }
                }
            }
            // Hide cost basis arrow
            if (costBasisFloatingExpand) {
                costBasisFloatingExpand.style.display = 'none';
            }
        } else if (!costBasisIsVisible && tradesIsVisible) {
            // Cost basis collapsed, trades visible - show arrow on right edge of trades
            // When cost basis is collapsed, trades expands to 100% of container width
            // Use container width directly to avoid transition timing issues
            if (costBasisFloatingExpand) {
                const tradesCard = tradesColumn.querySelector('.card');
                if (tradesCard) {
                    const cardHeader = tradesCard.querySelector('.card-header');
                    if (cardHeader) {
                        // Force a reflow to ensure layout is settled before getting bounding rects
                        void tradesCard.offsetHeight;
                        void container.offsetHeight;
                        const headerRect = cardHeader.getBoundingClientRect();
                        // Calculate vertical center of header (same calculation as trades)
                        const headerTop = headerRect.top;
                        const headerHeight = headerRect.height;
                        const headerCenter = headerTop + (headerHeight / 2);
                        const containerTop = containerRect.top;
                        // Position arrow vertically centered on header (arrow is 50px tall, so center - 25px)
                        const arrowTop = headerCenter - containerTop - 25;
                        // Position on right edge of container (trades is 100% width when cost basis is collapsed)
                        // Use container's right edge instead of card's right edge to avoid transition timing issues
                        const containerRight = containerRect.right;
                        costBasisFloatingExpand.style.display = 'block';
                        costBasisFloatingExpand.style.left = `${containerRight - containerRect.left - 25}px`; // Half outside
                        costBasisFloatingExpand.style.top = `${arrowTop}px`; // Vertically centered on header
                    }
                }
            }
            // Hide trades arrow
            if (tradesFloatingExpand) {
                tradesFloatingExpand.style.display = 'none';
            }
        } else if (!tradesIsVisible && !costBasisIsVisible) {
            // Both collapsed - show both arrows on the sides
            // For trades arrow, position on left side of container
            if (tradesFloatingExpand) {
                // Use a default position when both are collapsed (center vertically in container)
                const containerHeight = containerRect.height;
                const containerTop = containerRect.top;
                const defaultTop = (containerHeight / 2) - 25; // Center minus half arrow height
                tradesFloatingExpand.style.display = 'block';
                tradesFloatingExpand.style.left = '-25px'; // Half outside on left
                tradesFloatingExpand.style.top = `${defaultTop}px`;
            }
            // For cost basis arrow, position on right side of container
            if (costBasisFloatingExpand) {
                // Use a default position when both are collapsed (center vertically in container)
                const containerHeight = containerRect.height;
                const containerTop = containerRect.top;
                const defaultTop = (containerHeight / 2) - 25; // Center minus half arrow height
                const containerWidth = containerRect.width;
                costBasisFloatingExpand.style.display = 'block';
                costBasisFloatingExpand.style.left = `${containerWidth - 25}px`; // Half outside on right
                costBasisFloatingExpand.style.top = `${defaultTop}px`;
            }
        } else {
            // Both visible - hide both arrows
            if (tradesFloatingExpand) {
                tradesFloatingExpand.style.display = 'none';
            }
            if (costBasisFloatingExpand) {
                costBasisFloatingExpand.style.display = 'none';
            }
        }
    });
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
    // Debounced update functions (500ms delay for date changes)
    const debouncedUpdateDashboard = debounce(() => {
        updateDashboardData();
        updateChart();
    }, 500);
    
    startDateInput.addEventListener('change', function() {
        console.log('Dashboard start date changed to:', this.value);
        debouncedUpdateDashboard();
    });
    
    endDateInput.addEventListener('change', function() {
        console.log('Dashboard end date changed to:', this.value);
        debouncedUpdateDashboard();
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
        const response = await apiFetch('/api/accounts');
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
        
        // Store accounts globally for use in other functions
        window.accounts = sortedAccounts;
        
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
        const response = await apiFetch('/api/accounts');
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
        const response = await apiFetch(`/api/accounts/${accountId}/set-default`, {
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
        const response = await apiFetch(`/api/accounts/${id}`, {
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
    // Show environment banner for non-production environments
    fetch('/api/env')
        .then(r => r.json())
        .then(d => {
            if (!d.is_production) {
                const banner = document.getElementById('env-banner');
                if (banner) {
                    banner.style.display = 'block';
                    banner.textContent = d.env === 'test'
                        ? '⚠ TEST ENVIRONMENT — data may be reset at any time'
                        : `⚠ ${d.env.toUpperCase()} ENVIRONMENT`;
                }
            }
        })
        .catch(() => {});

    // Load all tickers into cache on page load (non-blocking)
    loadAllTickers();
    
    // Add event delegation for clickable-symbol elements
    document.addEventListener('click', handleSymbolClick);
    
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
                
                const response = await apiFetch(url, {
                    method: method,
                    body: {
                        account_name: accountName,
                        account_type: accountType,
                        starting_balance: startingBalance
                    }
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

function setupThemeToggle() {
    const themeToggle = document.getElementById('theme-toggle');
    const themeIcon = document.getElementById('theme-icon');
    const html = document.documentElement;
    
    // Get saved theme preference or default to dark
    const savedTheme = localStorage.getItem('theme') || 'dark';
    
    // Apply saved theme on page load
    if (savedTheme === 'dark') {
        html.setAttribute('data-theme', 'dark');
        if (themeIcon) {
            themeIcon.classList.remove('fa-moon');
            themeIcon.classList.add('fa-sun');
        }
    } else {
        html.removeAttribute('data-theme');
        if (themeIcon) {
            themeIcon.classList.remove('fa-sun');
            themeIcon.classList.add('fa-moon');
        }
    }
    
    // No longer needed - CSS variables handle transitions automatically
    // Removing inline style updates allows CSS transitions to work smoothly
    
    // Toggle theme on button click
    if (themeToggle) {
        themeToggle.addEventListener('click', function() {
            const currentTheme = html.getAttribute('data-theme');
            
            if (currentTheme === 'dark') {
                // Switch to light mode
                html.removeAttribute('data-theme');
                localStorage.setItem('theme', 'light');
                if (themeIcon) {
                    themeIcon.classList.remove('fa-sun');
                    themeIcon.classList.add('fa-moon');
                }
            } else {
                // Switch to dark mode
                html.setAttribute('data-theme', 'dark');
                localStorage.setItem('theme', 'dark');
                if (themeIcon) {
                    themeIcon.classList.remove('fa-moon');
                    themeIcon.classList.add('fa-sun');
                }
            }
            
            // Update cost basis table to reflect theme change (for ticker card colors)
            if (window.symbolFilter) {
                loadCostBasis(window.symbolFilter);
            } else {
                loadCostBasis();
            }
            
            // Update first column cells in trades table to reflect theme change
            updateTradesTableFirstColumnStyles();
            
            // CSS variables handle transitions automatically - no JavaScript needed
        });
    }
}

function setupUniversalControls() {
    // Setup universal ticker filter
    const universalTickerInput = document.getElementById('universal-ticker-filter');
    const universalClearButton = document.getElementById('clear-universal-ticker');
    
    if (universalTickerInput && universalClearButton) {
        // Debounced data loading function (optimized for faster updates)
        const debouncedLoadTickerData = debounce((symbol) => {
            // Reload data with the ticker filter - skip loadSummary() for filtering operations
            // loadSummary() is expensive and not needed when just filtering by ticker
            // Run loads in parallel to reduce delay
            Promise.all([
                loadTrades(),
                loadCostBasis(symbol || null) // Always call loadCostBasis - it handles both ticker and null cases
            ]).catch(error => {
                console.error('Error loading data after selecting ticker:', error);
            });
        }, 100); // Optimized: Reduced to 100ms for faster data loading
        
        setupAutocomplete('universal-ticker-filter', 'universal-ticker-suggestions', (symbol) => {
            // Ensure symbol is uppercase
            const symbolUpper = symbol ? symbol.toUpperCase() : '';
            window.symbolFilter = symbolUpper;
            // Update input value to match (in case autocomplete was used)
            if (universalTickerInput && symbolUpper) {
                universalTickerInput.value = symbolUpper;
            }
            // Show/hide clear button based on whether symbol is selected
            if (symbolUpper) {
                universalClearButton.style.display = 'inline-block';
            } else {
                universalClearButton.style.display = 'none';
            }
            // Trigger data reload immediately when autocomplete selection is made (no debounce)
            // This provides instant feedback when user selects from dropdown
            // Skip loadSummary() for filtering operations - it's expensive and not needed
            Promise.all([
                loadTrades(),
                loadCostBasis(symbolUpper || null)
            ]).catch(error => {
                console.error('Error loading data after selecting ticker:', error);
            });
        });
        
        // Show/hide clear button and sync window.symbolFilter with input value
        // Use debounce to avoid too many API calls while typing, but trigger data reload
        const debouncedInputHandler = debounce(function(value) {
            // Get the current input value if value parameter is not provided
            const inputValue = value !== undefined ? value : (universalTickerInput ? universalTickerInput.value.trim() : '');
            const tickerValue = inputValue.toUpperCase();
            if (tickerValue) {
                // Trigger full data reload when user stops typing (after debounce)
                // This ensures cost basis table also updates
                console.log('[DEBUG] debouncedInputHandler - triggering data reload for:', tickerValue);
                debouncedLoadTickerData(tickerValue);
            } else {
                // If value is empty, clear the filter
                window.symbolFilter = '';
                updateTradesTable();
                loadCostBasis(null);
            }
        }, 100); // Optimized: Reduced to 100ms for faster updates after clearing
        
        const inputHandler = function() {
            let value = this.value.trim();
            // Convert to uppercase as user types for consistency
            if (value) {
                value = value.toUpperCase();
                // Update input value to uppercase (only if it changed to avoid cursor jumping)
                if (this.value !== value) {
                    const cursorPos = this.selectionStart;
                    this.value = value;
                    // Restore cursor position
                    this.setSelectionRange(cursorPos, cursorPos);
                }
            }
            universalClearButton.style.display = value ? 'inline-block' : 'none';
            // Sync window.symbolFilter immediately for instant feedback (uppercase for consistency)
            window.symbolFilter = value || '';
            // Update trades table immediately
            if (trades && trades.length > 0) {
                updateTradesTable();
            }
            // Update cost basis table immediately (similar to trades table)
            if (value) {
                // Filter cached cost basis data immediately for instant feedback
                if (cachedCostBasis && cachedCostBasis.length > 0) {
                    const matchingTickerGroups = cachedCostBasis.filter(group => 
                        group.ticker && group.ticker.toUpperCase() === value.toUpperCase()
                    );
                    if (matchingTickerGroups.length > 0) {
                        updateCostBasisTable(matchingTickerGroups);
                    } else {
                        // No matching results, hide the table (no ticker cards)
                        const costBasisContainer = document.getElementById('cost-basis-table-container');
                        const inlineContainer = document.getElementById('cost-basis-inline-container');
                        [costBasisContainer, inlineContainer].forEach(c => {
                            if (c) c.innerHTML = '';
                        });
                    }
                } else {
                    // Show loading state if no cached data
                    const costBasisContainer = document.getElementById('cost-basis-table-container');
                    if (costBasisContainer) {
                        costBasisContainer.innerHTML = `
                            <div class="text-center text-muted py-3">
                                <i class="fas fa-spinner fa-spin me-2"></i>
                                Loading cost basis for ${value}...
                            </div>
                        `;
                    }
                }
            } else {
                // If value is empty, show all symbols from cached data
                if (cachedCostBasis && cachedCostBasis.length > 0) {
                    showAllSymbols(cachedCostBasis);
                } else if (trades && trades.length > 0) {
                    showAllSymbolsFromTrades();
                }
            }
            // Trigger debounced handler for data reload (including cost basis)
            // Pass the value directly to avoid issues with 'this' context
            debouncedInputHandler(value);
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
    
    // Setup universal account filter with debounce
    const universalAccountFilter = document.getElementById('universal-account-filter');
    if (universalAccountFilter) {
        // Immediate UI update (no debounce)
        const handleAccountChangeImmediate = function() {
            // Update any new trades (trades with IDs starting with 'new_') to use the selected account
            const accountValue = this.value || '';
            const isAllAccounts = !accountValue || accountValue === '' || accountValue === 'all';
            const selectedAccountId = accountValue ? parseInt(accountValue) : null;
            
            // Immediately filter trades table from cached data for instant feedback
            if (cachedTrades && cachedTrades.length > 0) {
                try {
                    // Clone cached trades to avoid mutating the cache
                    const filteredTrades = structuredClone ? structuredClone(cachedTrades) : JSON.parse(JSON.stringify(cachedTrades));
                    
                    // Filter by account if a specific account is selected
                    let accountFilteredTrades = filteredTrades;
                    if (!isAllAccounts && selectedAccountId) {
                        accountFilteredTrades = filteredTrades.filter(trade => {
                            const tradeAccountId = trade.account_id || '';
                            return tradeAccountId.toString() === accountValue.toString();
                        });
                    }
                    
                    // Apply ticker filter if present
                    // Always include new trades (with IDs starting with 'new_') so they can be edited
                    if (window.symbolFilter) {
                        const filterUpper = window.symbolFilter.toUpperCase();
                        accountFilteredTrades = accountFilteredTrades.filter(trade => {
                            // Always include new trades (they may not have a ticker set yet)
                            const isNewTrade = typeof trade.id === 'string' && trade.id.startsWith('new_');
                            if (isNewTrade) {
                                return true; // Always show new trades
                            }
                            // For existing trades, filter by ticker
                            return trade.ticker && trade.ticker.toUpperCase() === filterUpper;
                        });
                    }
                    
                    // Preserve any new trades that might not be in cachedTrades
                    const newTrades = trades.filter(trade => 
                        typeof trade.id === 'string' && trade.id.startsWith('new_')
                    );
                    
                    // Combine filtered trades with new trades (avoid duplicates)
                    const newTradeIds = new Set(newTrades.map(t => t.id));
                    const filteredWithoutNew = accountFilteredTrades.filter(t => 
                        !(typeof t.id === 'string' && t.id.startsWith('new_'))
                    );
                    const combinedTrades = [...filteredWithoutNew, ...newTrades];
                    
            // Update trades and table immediately using requestAnimationFrame for better performance
            trades = combinedTrades;
            requestAnimationFrame(() => {
                updateTradesTable();
            });
                    
                    // Also immediately filter cost basis table from cached data for instant feedback
                    const currentTicker = window.symbolFilter || null;
                    if (currentTicker && cachedCostBasis && cachedCostBasis.length > 0) {
                        // If ticker is filtered, filter cached data by both ticker and account
                        const matchingTickerGroups = cachedCostBasis.filter(group => {
                            const tickerMatch = group.ticker && group.ticker.toUpperCase() === currentTicker.toUpperCase();
                            if (!tickerMatch) return false;
                            
                            if (isAllAccounts) return true;
                            
                            // Check if any trade in this group matches the account
                            return group.trades && group.trades.some(trade => {
                                const tradeAccountId = trade.account_id || '';
                                return tradeAccountId.toString() === accountValue.toString();
                            });
                        });
                        
                        if (matchingTickerGroups.length > 0) {
                            updateCostBasisTable(matchingTickerGroups);
                        } else {
                            // No data found for this ticker+account combination - show message
                            const costBasisContainer = document.getElementById('cost-basis-table-container');
                            const inlineContainer = document.getElementById('cost-basis-inline-container');
                            const accountName = window.accounts && selectedAccountId ? 
                                (window.accounts.find(a => a.id === selectedAccountId)?.account_name || 'selected account') : 
                                'selected account';
                            [costBasisContainer, inlineContainer].forEach(c => {
                                if (c) {
                                    c.innerHTML = `
                                        <div class="text-center text-muted py-3">
                                            <i class="fas fa-info-circle me-2"></i>
                                            No cost basis data for ${currentTicker} in ${accountName}.
                                        </div>
                                    `;
                                }
                            });
                        }
                    } else if (!currentTicker && cachedCostBasis && cachedCostBasis.length > 0) {
                        // If no ticker filter, filter cached data by account for immediate display
                        const filteredData = isAllAccounts 
                            ? cachedCostBasis 
                            : cachedCostBasis.filter(group => {
                                // Check if any trade in this group matches the account
                                return group.trades && group.trades.some(trade => {
                                    const tradeAccountId = trade.account_id || '';
                                    return tradeAccountId.toString() === accountValue.toString();
                                });
                            });
                        
                        if (filteredData.length > 0) {
                            showAllSymbols(filteredData);
                        } else {
                            // Show loading state
                            const costBasisContainer = document.getElementById('cost-basis-table-container');
                            const inlineContainer = document.getElementById('cost-basis-inline-container');
                            [costBasisContainer, inlineContainer].forEach(c => {
                                if (c) {
                                    c.innerHTML = `
                                        <div class="text-center text-muted py-3">
                                            <i class="fas fa-spinner fa-spin me-2"></i>
                                            Loading cost basis...
                                        </div>
                                    `;
                                }
                            });
                        }
                    }
                } catch (e) {
                    console.error('Error filtering trades from cache:', e);
                    // Fallback: just update new trades
                    if (trades && trades.length > 0) {
                        const accounts = window.accounts || [];
                        const selectedAccount = selectedAccountId ? accounts.find(a => a.id === selectedAccountId) : null;
                        if (selectedAccount) {
                            trades.forEach(trade => {
                                if (typeof trade.id === 'string' && trade.id.startsWith('new_')) {
                                    trade.account_id = selectedAccountId;
                                    trade.account_name = selectedAccount.account_name;
                                    
                                    // Update the account dropdown in the table if it exists
                                    const tbody = document.getElementById('trades-table');
                                    if (tbody) {
                                        const tradeColumnIndex = findColumnIndexForTrade(trade.id);
                                        if (tradeColumnIndex !== -1) {
                                            const accountRow = tbody.children[1];
                                            if (accountRow && accountRow.children[tradeColumnIndex]) {
                                                const accountCell = accountRow.children[tradeColumnIndex];
                                                const accountSelect = accountCell.querySelector('select[data-trade-id="' + trade.id + '"]');
                                                if (accountSelect) {
                                                    accountSelect.value = selectedAccountId;
                                                }
                                            }
                                        }
                                    }
                                    
                                    // Fetch commission for the new account
                                    if (window._fetchAndPopulateCommissionForTrade && window._fetchAndPopulateCommissionForTrade[trade.id]) {
                                        window._fetchAndPopulateCommissionForTrade[trade.id]();
                                    }
                                }
                            });
                            requestAnimationFrame(() => {
                                updateTradesTable();
                            });
                        }
                    }
                }
            } else if (trades && trades.length > 0 && selectedAccountId) {
                // Fallback: update new trades if no cache
                const accounts = window.accounts || [];
                const selectedAccount = accounts.find(a => a.id === selectedAccountId);
                if (selectedAccount) {
                    trades.forEach(trade => {
                        if (typeof trade.id === 'string' && trade.id.startsWith('new_')) {
                            trade.account_id = selectedAccountId;
                            trade.account_name = selectedAccount.account_name;
                            
                            // Update the account dropdown in the table if it exists
                            const tbody = document.getElementById('trades-table');
                            if (tbody) {
                                const tradeColumnIndex = findColumnIndexForTrade(trade.id);
                                if (tradeColumnIndex !== -1) {
                                    const accountRow = tbody.children[1];
                                    if (accountRow && accountRow.children[tradeColumnIndex]) {
                                        const accountCell = accountRow.children[tradeColumnIndex];
                                        const accountSelect = accountCell.querySelector('select[data-trade-id="' + trade.id + '"]');
                                        if (accountSelect) {
                                            accountSelect.value = selectedAccountId;
                                        }
                                    }
                                }
                            }
                            
                            // Fetch commission for the new account
                            if (window._fetchAndPopulateCommissionForTrade && window._fetchAndPopulateCommissionForTrade[trade.id]) {
                                window._fetchAndPopulateCommissionForTrade[trade.id]();
                            }
                        }
                    });
                    updateTradesTable();
                }
            }
        };
        
        // Debounced API calls (optimized for faster updates)
        const handleAccountChangeDebounced = debounce(function() {
            // Reload all data when account filter changes
            // Check if "All" accounts is selected (empty string or 'all')
            const accountValue = this.value || '';
            const isAllAccounts = !accountValue || accountValue === '' || accountValue === 'all';
            console.log('[DEBUG] Account filter changed - value:', accountValue, 'isAllAccounts:', isAllAccounts);
            
            // Get current ticker filter
            const currentTicker = window.symbolFilter || null;
            
            // If no ticker filter, immediately filter cost basis from cached data for instant feedback
            if (!currentTicker && cachedCostBasis && cachedCostBasis.length > 0) {
                // Filter cached data by account for immediate display
                const accountFilter = accountValue || '';
                const filteredData = isAllAccounts 
                    ? cachedCostBasis 
                    : cachedCostBasis.filter(group => {
                        // Check if any trade in this group matches the account
                        return group.trades && group.trades.some(trade => {
                            const tradeAccountId = trade.account_id || '';
                            return tradeAccountId.toString() === accountFilter.toString();
                        });
                    });
                
                if (filteredData.length > 0) {
                    showAllSymbols(filteredData);
                } else {
                    // Show loading state
                    const costBasisContainer = document.getElementById('cost-basis-table-container');
                    if (costBasisContainer) {
                        costBasisContainer.innerHTML = `
                            <div class="text-center text-muted py-3">
                                <i class="fas fa-spinner fa-spin me-2"></i>
                                Loading cost basis...
                            </div>
                        `;
                    }
                }
            } else if (currentTicker && cachedCostBasis && cachedCostBasis.length > 0) {
                // If ticker is filtered, filter cached data by both ticker and account
                const accountFilter = accountValue || '';
                const matchingTickerGroups = cachedCostBasis.filter(group => {
                    const tickerMatch = group.ticker && group.ticker.toUpperCase() === currentTicker.toUpperCase();
                    if (!tickerMatch) return false;
                    
                    if (isAllAccounts) return true;
                    
                    // Check if any trade in this group matches the account
                    return group.trades && group.trades.some(trade => {
                        const tradeAccountId = trade.account_id || '';
                        return tradeAccountId.toString() === accountFilter.toString();
                    });
                });
                
                if (matchingTickerGroups.length > 0) {
                    updateCostBasisTable(matchingTickerGroups);
                } else {
                    // No data found for this ticker+account combination - show message
                    const costBasisContainer = document.getElementById('cost-basis-table-container');
                    const inlineContainer = document.getElementById('cost-basis-inline-container');
                    const accountName = !isAllAccounts && window.accounts ? 
                        (window.accounts.find(a => a.id.toString() === accountFilter.toString())?.account_name || 'selected account') : 
                        'any account';
                    [costBasisContainer, inlineContainer].forEach(c => {
                        if (c) {
                            c.innerHTML = `
                                <div class="text-center text-muted py-3">
                                    <i class="fas fa-info-circle me-2"></i>
                                    No cost basis data for ${currentTicker} in ${accountName}.
                                </div>
                            `;
                        }
                    });
                }
            }
            
            // Always reload data to ensure "All" accounts shows all data
            // Force update cost basis to bypass optimization when account changes
            // Skip loadSummary() and loadTopSymbols() for account filtering - they're expensive and not needed
            Promise.all([
                loadTrades(),
                loadCostBasis(currentTicker, true) // Force update when account changes
            ]).catch(error => {
                console.error('Error loading data after account change:', error);
            });
        }, 100); // Optimized: Reduced to 100ms for faster account filter updates
        
        universalAccountFilter.addEventListener('change', function() {
            const accountValue = this.value || '';
            handleAccountChangeImmediate.call(this);
            // Call debounced handler with proper context
            handleAccountChangeDebounced.call(this);
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
        
        // Immediate feedback: filter existing trades table instantly using requestAnimationFrame
        // This provides instant visual feedback while API calls happen in background
        requestAnimationFrame(() => {
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
        
        // Also immediately filter cost basis table if we have cached data
        // Show cached data immediately for better responsiveness, even if "All" accounts is selected
        // The API call will update it with fresh data shortly
        if (cachedCostBasis && cachedCostBasis.length > 0) {
            // Find all matching ticker groups (could be multiple if "All" accounts was cached)
            const matchingTickerGroups = cachedCostBasis.filter(group => 
                group.ticker && group.ticker.toUpperCase() === ticker.toUpperCase()
            );
            if (matchingTickerGroups.length > 0) {
                // updateCostBasisTable expects grouped structure: [{ticker, company_name, trades: [...]}, ...]
                // Show cached data immediately for instant feedback
                updateCostBasisTable(matchingTickerGroups);
            } else {
                // No matching results in cache, hide the table (no ticker cards)
                const costBasisContainer = document.getElementById('cost-basis-table-container');
                const inlineContainer = document.getElementById('cost-basis-inline-container');
                [costBasisContainer, inlineContainer].forEach(c => {
                    if (c) c.innerHTML = '';
                });
            }
        } else {
            // No cached data, hide the table (no ticker cards)
            const costBasisContainer = document.getElementById('cost-basis-table-container');
            const inlineContainer = document.getElementById('cost-basis-inline-container');
            [costBasisContainer, inlineContainer].forEach(c => {
                if (c) c.innerHTML = '';
            });
        }
        
        // Load data immediately when ticker is clicked (no debounce for better responsiveness)
        // Reload data with the ticker filter in parallel (without blocking UI)
        // Skip loadSummary() as it's not needed for ticker filtering and adds unnecessary delay
        Promise.all([
            loadTrades(),
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
        // Immediate UI update - no delays
        universalTickerInput.value = '';
        if (universalClearButton) {
            universalClearButton.style.display = 'none';
        }
        window.symbolFilter = '';
        
        // Update table immediately with current data (filter is now empty, so shows all)
        // This provides instant visual feedback
        updateTradesTable();
        
        // Restore cached data and update tables asynchronously to avoid blocking UI
        // Use setTimeout(0) to defer heavy operations until after UI update
        setTimeout(() => {
            // Get current account filter
            const accountFilter = document.getElementById('universal-account-filter')?.value || '';
            const isAllAccounts = !accountFilter || accountFilter === '' || accountFilter === 'all';
            
            // Restore cached trades if available, applying account filter if needed
            if (cachedTrades) {
                try {
                    let restoredTrades = structuredClone ? structuredClone(cachedTrades) : JSON.parse(JSON.stringify(cachedTrades));
                    
                    // Apply account filter if a specific account is selected
                    if (!isAllAccounts && accountFilter) {
                        restoredTrades = restoredTrades.filter(trade => {
                            const tradeAccountId = trade.account_id || '';
                            return tradeAccountId.toString() === accountFilter.toString();
                        });
                    }
                    
                    // Preserve any new trades that might not be in cachedTrades
                    const newTrades = trades.filter(trade => 
                        typeof trade.id === 'string' && trade.id.startsWith('new_')
                    );
                    
                    // Combine restored trades with new trades (avoid duplicates)
                    const newTradeIds = new Set(newTrades.map(t => t.id));
                    const restoredWithoutNew = restoredTrades.filter(t => 
                        !(typeof t.id === 'string' && t.id.startsWith('new_'))
                    );
                    trades = [...restoredWithoutNew, ...newTrades];
                } catch (e) {
                    // Fallback: just restore from cache without filtering
                    trades = JSON.parse(JSON.stringify(cachedTrades));
                }
                updateTradesTable();
            }
            
            // Restore cached cost basis if available, applying account filter if needed
            if (cachedCostBasis && cachedCostBasis.length > 0) {
                if (isAllAccounts) {
                    showAllSymbols(cachedCostBasis);
                } else {
                    // Filter cost basis by account
                    const filteredCostBasis = cachedCostBasis.filter(group => {
                        return group.trades && group.trades.some(trade => {
                            const tradeAccountId = trade.account_id || '';
                            return tradeAccountId.toString() === accountFilter.toString();
                        });
                    });
                    if (filteredCostBasis.length > 0) {
                        showAllSymbols(filteredCostBasis);
                    } else {
                        showAllSymbolsFromTrades();
                    }
                }
            } else {
                showAllSymbolsFromTrades();
            }
        }, 0);
        
        // Then reload all data in background to ensure everything is in sync
        // Run all loads in parallel to reduce delay - no debounce for clearing
        // Skip loadSummary() for clearing filter - it's expensive and not needed
        Promise.all([
            loadTrades(),
            loadCostBasis(null) // Load immediately, no delay
        ]).catch(error => {
            console.error('Error loading data after clearing ticker filter:', error);
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
    
    // Debounced update function (500ms delay for date changes)
    const debouncedUpdateDashboard = debounce(updateDashboardData, 500);
    
    // Update both dashboard and trades filters when changed
    startDateInput.addEventListener('change', function() {
        document.getElementById('dashboard-start-date').value = this.value;
        debouncedUpdateDashboard();
    });
    
    endDateInput.addEventListener('change', function() {
        document.getElementById('dashboard-end-date').value = this.value;
        debouncedUpdateDashboard();
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
    const costBasisColumn = document.getElementById('cost-basis-column');
    const toggleIcon = document.getElementById('cost-basis-toggle-icon');
    const floatingExpand = document.getElementById('cost-basis-floating-expand');
    
    if (!costBasisColumn) return;
    
    // Toggle collapse/show classes - CSS handles the flex adjustments
    // Same logic as toggleTrades() for consistency
    if (costBasisColumn.classList.contains('show')) {
        // Collapsing - hide the cost basis table
        costBasisColumn.classList.remove('show');
        costBasisColumn.classList.add('collapse');
        // When collapsed, icon state doesn't matter (column is hidden)
    } else {
        // Expanding - show the cost basis table
        costBasisColumn.classList.remove('collapse');
        costBasisColumn.classList.add('show');
        // When expanded, arrow in header points right (to collapse/hide) - same as trades but opposite direction
        if (toggleIcon) {
            toggleIcon.classList.remove('fa-chevron-left');
            toggleIcon.classList.add('fa-chevron-right');
        }
    }
    
    // Update column widths first, then update floating arrow positions after layout settles
    updateColumnWidths();
    // Wait for CSS transition to complete (300ms) plus a small buffer before positioning arrows
    // This ensures the trades card has fully expanded to 100% width before we calculate arrow position
    setTimeout(() => {
        updateFloatingArrows();
    }, 350); // 300ms transition + 50ms buffer
}


// Update floating arrow positions on scroll
let scrollTimeout;
window.addEventListener('scroll', function() {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(function() {
        updateFloatingArrows();
    }, 16); // Throttle to ~60fps (16ms)
}, { passive: true });

// Throttle resize handler to prevent excessive updates
let resizeTimeout;
window.addEventListener('resize', function() {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(function() {
        // Recalculate cost basis table height on window resize
        setCostBasisTableHeight();
        // Update column widths on resize
        updateColumnWidths();
        // Update floating arrow positions (same as trades)
        updateFloatingArrows();
    }, 150); // Throttle to 150ms
});

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded, initializing app...');
    
    // Initialize floating arrows
    updateFloatingArrows();
    
    // Set up event listeners first (before any data loading)
    setupThemeToggle();  // Setup dark mode toggle - must be called early
    
    // Update column widths based on visibility (after DOM is ready)
    setTimeout(() => {
        updateColumnWidths();
    }, 0);
    
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
    
    // Set up remaining event listeners
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
        
        const response = await apiFetch(`/api/chart-data?${params}`);
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
    
    // Load accounts for the form dropdown and all commissions when modal opens
    loadCommissionAccounts();
    loadCommissions();
}

async function loadCommissionAccounts() {
    try {
        const response = await apiFetch('/api/accounts');
        const accounts = await response.json();
        const select = document.getElementById('commission-account-select');
        
        if (select) {
            select.innerHTML = '<option value="">Select an account...</option>';
            accounts.forEach(account => {
                const option = document.createElement('option');
                option.value = account.id;
                option.textContent = account.account_name || `Account ${account.id}`;
                select.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading accounts:', error);
    }
}

async function loadCommissions() {
    try {
        // Load all commissions for all accounts
        const response = await apiFetch('/api/commissions');
        const commissions = await response.json();
        
        const container = document.getElementById('commissions-table-container');
        if (!container) return;
        
        if (commissions.length === 0) {
            container.innerHTML = '<div class="text-center text-muted">No commission records found</div>';
            return;
        }
        
        // Group commissions by account
        const commissionsByAccount = {};
        commissions.forEach(comm => {
            const accountId = comm.account_id;
            const accountName = comm.account_name || `Account ${accountId}`;
            
            if (!commissionsByAccount[accountId]) {
                commissionsByAccount[accountId] = {
                    accountId: accountId,
                    accountName: accountName,
                    commissions: []
                };
            }
            commissionsByAccount[accountId].commissions.push(comm);
        });
        
        // Sort accounts by name
        const sortedAccounts = Object.values(commissionsByAccount).sort((a, b) => 
            a.accountName.localeCompare(b.accountName)
        );
        
        // Build HTML with one table per account
        let html = '';
        sortedAccounts.forEach(accountData => {
            const { accountId, accountName, commissions } = accountData;
            
            // Sort commissions by effective date (descending)
            commissions.sort((a, b) => {
                const dateA = new Date(a.effective_date);
                const dateB = new Date(b.effective_date);
                return dateB - dateA;
            });
            
            html += `
                <div class="mb-4">
                    <h6 class="mb-2" style="font-weight: 600; color: var(--text-color);">${accountName}</h6>
                    <div class="table-responsive">
                        <table class="table table-sm table-striped">
                            <thead class="table-light sticky-top">
                                <tr>
                                    <th>Effective Date</th>
                                    <th>Commission Rate ($)</th>
                                    <th>Notes</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${commissions.map(comm => {
                                    const effectiveDate = comm.effective_date ? new Date(comm.effective_date).toLocaleDateString() : '';
                                    const escapedNotes = (comm.notes || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
                                    return `
                                        <tr>
                                            <td>${effectiveDate}</td>
                                            <td>$${comm.commission_rate.toFixed(5)}</td>
                                            <td>${comm.notes || ''}</td>
                                            <td>
                                                <button class="btn btn-sm btn-outline-primary me-1" onclick="editCommission(${comm.id}, ${comm.account_id}, ${comm.commission_rate}, '${comm.effective_date}', '${escapedNotes}')">
                                                    <i class="fas fa-edit"></i>
                                                </button>
                                                <button class="btn btn-sm btn-outline-danger" onclick="deleteCommission(${comm.id})">
                                                    <i class="fas fa-trash"></i>
                                                </button>
                                            </td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        });
        
        container.innerHTML = html;
    } catch (error) {
        console.error('Error loading commissions:', error);
        const container = document.getElementById('commissions-table-container');
        if (container) {
            container.innerHTML = '<div class="text-center text-danger">Error loading commissions</div>';
        }
    }
}

function openNewCommissionForm() {
    const formContainer = document.getElementById('commission-form-container');
    const formTitle = document.getElementById('commission-form-title');
    const editId = document.getElementById('commission-edit-id');
    const accountSelect = document.getElementById('commission-account-select');
    const rateInput = document.getElementById('commission-rate-input');
    const dateInput = document.getElementById('commission-effective-date-input');
    const notesInput = document.getElementById('commission-notes-input');
    const saveBtn = document.getElementById('commission-save-btn');
    
    // Reset form
    editId.value = '';
    if (accountSelect) {
        accountSelect.value = '';
        accountSelect.disabled = false; // Enable account selection for new commissions
    }
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

function editCommission(id, accountId, rate, effectiveDate, notes) {
    const formContainer = document.getElementById('commission-form-container');
    const formTitle = document.getElementById('commission-form-title');
    const editId = document.getElementById('commission-edit-id');
    const accountSelect = document.getElementById('commission-account-select');
    const rateInput = document.getElementById('commission-rate-input');
    const dateInput = document.getElementById('commission-effective-date-input');
    const notesInput = document.getElementById('commission-notes-input');
    const saveBtn = document.getElementById('commission-save-btn');
    
    // Fill form with existing data
    editId.value = id;
    if (accountSelect) {
        accountSelect.value = accountId;
        // Disable account selection when editing (account cannot be changed)
        accountSelect.disabled = true;
    }
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
    const accountSelect = document.getElementById('commission-account-select');
    formContainer.style.display = 'none';
    // Re-enable account select in case it was disabled during edit
    if (accountSelect) {
        accountSelect.disabled = false;
    }
}

async function deleteCommission(id) {
    if (!confirm('Are you sure you want to delete this commission record?')) {
        return;
    }
    
    try {
        const response = await apiFetch(`/api/commissions/${id}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            // Reload commissions table
            loadCommissions();
            // Reload trades and cost basis to reflect updated commission rates after deletion
            console.log(`Commission deleted. ${result.trades_updated || 0} trades updated in database.`);
            Promise.all([
                loadTrades(),
                loadCostBasis(window.symbolFilter || null)
            ]).then(() => {
                // Update trades table with fresh data
                updateTradesTable();
                // Also update cost basis table if a ticker is selected
                if (window.symbolFilter) {
                    const currentTicker = window.symbolFilter;
                    loadCostBasis(currentTicker);
                }
            }).catch(error => {
                console.error('Error reloading data after commission deletion:', error);
            });
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
                
                const response = await apiFetch(url, {
                    method: method,
                    body: {
                        account_id: accountId,
                        commission_rate: commissionRate,
                        effective_date: effectiveDate,
                        notes: notes
                    }
                });
                
                const result = await response.json();
                
                if (result.success) {
                    // Reset form and hide it
                    cancelCommissionForm();
                    // Reload commissions table
                    loadCommissions();
                    // Always reload trades and cost basis to reflect updated commission rates
                    // The backend updates all affected trades, so we need to refresh the display
                    console.log(`Commission ${id ? 'updated' : 'created'}. ${result.trades_updated || 0} trades updated in database.`);
                    // Reload trades and cost basis to reflect updated commission rates
                    Promise.all([
                        loadTrades(),
                        loadCostBasis(window.symbolFilter || null)
                    ]).then(() => {
                        // Update trades table with fresh data
                        updateTradesTable();
                        // Also update cost basis table if a ticker is selected
                        if (window.symbolFilter) {
                            const currentTicker = window.symbolFilter;
                            loadCostBasis(currentTicker);
                        }
                    }).catch(error => {
                        console.error('Error reloading data after commission update:', error);
                    });
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
        
        document.getElementById('bto-trade-date').value = formatDate(tradeData.date_trade_open || tradeData.trade_date || '');
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
        
        document.getElementById('stc-trade-date').value = formatDate(tradeData.date_trade_open || tradeData.trade_date || '');
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
            document.getElementById('roct-call-expiration-date').value = formatDate(getNextFriday());
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
        
        document.getElementById('roct-call-trade-date').value = formatDate(tradeData.date_trade_open || tradeData.trade_date || '');
        document.getElementById('roct-call-underlying').value = tradeData.ticker || '';
        document.getElementById('roct-call-price').value = tradeData.current_price || '';
        document.getElementById('roct-call-expiration-date').value = formatDate(tradeData.expiration_date || '');
        document.getElementById('roct-call-dte').value = tradeData.dte || '';
        document.getElementById('roct-call-strike-price').value = tradeData.strike_price || '';
        document.getElementById('roct-call-credit-debit').value = tradeData.premium || '';
        document.getElementById('roct-call-cost-basis').value = tradeData.cost_basis || '';
        
        // Calculate DTE if not provided
        const tradeDateForDTE = tradeData.date_trade_open || tradeData.trade_date;
        if (!tradeData.dte && tradeDateForDTE && tradeData.expiration_date) {
            const dte = calculateDaysToExpiration(tradeData.expiration_date, tradeDateForDTE);
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

// Helper function to scroll to and focus on a newly created trade
function scrollToNewTrade(tradeId) {
    setTimeout(() => {
        const tbody = document.getElementById('trades-table');
        if (!tbody) return;
        
        // Find the column index for the new trade
        let newColumnIndex = -1;
        const rows = tbody.querySelectorAll('tr');
        for (let i = 0; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            for (let j = 1; j < cells.length; j++) {
                const input = cells[j].querySelector(`input[data-trade-id="${tradeId}"], select[data-trade-id="${tradeId}"]`);
                if (input) {
                    newColumnIndex = j;
                    break;
                }
            }
            if (newColumnIndex !== -1) break;
        }
        
        if (newColumnIndex !== -1) {
            // Scroll to the column
            const firstRow = rows[0];
            if (firstRow && firstRow.children[newColumnIndex]) {
                firstRow.children[newColumnIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            }
            
            // Focus on the ticker input field (row 2, typically)
            if (rows.length > 2) {
                const tickerRow = rows[2];
                if (tickerRow && tickerRow.children[newColumnIndex]) {
                    const tickerInput = tickerRow.children[newColumnIndex].querySelector(`input[data-trade-id="${tradeId}"]`);
                    if (tickerInput) {
                        setTimeout(() => tickerInput.focus(), 300);
                    }
                }
            }
        }
    }, 500);
}

// Add new ROCT CALL column to trades table
async function addNewROCTCallColumn() {
    console.log('addNewROCTCallColumn called');
    
    try {
        // Get accounts
        const response = await apiFetch('/api/accounts');
        const accounts = await response.json();
        
        // Get selected account from control bar dropdown, or fall back to default
        const universalAccountFilter = document.getElementById('universal-account-filter');
        const selectedAccountId = universalAccountFilter && universalAccountFilter.value ? parseInt(universalAccountFilter.value) : null;
        
        let accountId;
        if (selectedAccountId) {
            const selectedAccount = accounts.find(acc => acc.id === selectedAccountId);
            accountId = selectedAccount ? selectedAccount.id : null;
        }
        
        // Fall back to default account if no account selected in dropdown
        if (!accountId) {
            const defaultAccount = accounts.find(acc => acc.is_default === 1 || acc.is_default === true);
            accountId = defaultAccount ? defaultAccount.id : (accounts.find(acc => acc.id === 9) ? 9 : (accounts.length > 0 ? accounts[0].id : null));
        }
        
        // Check if there's an active ticker filter
        const activeTicker = window.symbolFilter ? window.symbolFilter.trim().toUpperCase() : '';
        
        // Call quick-add API
        const quickAddResponse = await apiFetch('/api/trades/quick-add', {
            method: 'POST',
            body: {
                tradeType: 'ROCT CALL',
                accountId: accountId,
                ticker: activeTicker || ''
            }
        });
        
        const result = await quickAddResponse.json();
        
        if (result.success && result.new_trade_id) {
            // Reload trades from database
            await loadTrades();
            
            // Scroll to and focus on the new trade
            scrollToNewTrade(result.new_trade_id);
        } else {
            alert('Failed to create trade: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error creating ROCT CALL trade:', error);
        alert('Error creating trade: ' + error.message);
    }
}

// Add new ROCT PUT column to trades table
async function addNewROCTPutColumn() {
    console.log('addNewROCTPutColumn called');
    
    try {
        // Get accounts
        const response = await apiFetch('/api/accounts');
        const accounts = await response.json();
        
        // Get selected account from control bar dropdown, or fall back to default
        const universalAccountFilter = document.getElementById('universal-account-filter');
        const selectedAccountId = universalAccountFilter && universalAccountFilter.value ? parseInt(universalAccountFilter.value) : null;
        
        let accountId;
        if (selectedAccountId) {
            const selectedAccount = accounts.find(acc => acc.id === selectedAccountId);
            accountId = selectedAccount ? selectedAccount.id : null;
        }
        
        // Fall back to default account if no account selected in dropdown
        if (!accountId) {
            const defaultAccount = accounts.find(acc => acc.is_default === 1 || acc.is_default === true);
            accountId = defaultAccount ? defaultAccount.id : (accounts.find(acc => acc.id === 9) ? 9 : (accounts.length > 0 ? accounts[0].id : null));
        }
        
        // Check if there's an active ticker filter
        const activeTicker = window.symbolFilter ? window.symbolFilter.trim().toUpperCase() : '';
        
        // Call quick-add API
        const quickAddResponse = await apiFetch('/api/trades/quick-add', {
            method: 'POST',
            body: {
                tradeType: 'ROCT PUT',
                accountId: accountId,
                ticker: activeTicker || ''
            }
        });
        
        const result = await quickAddResponse.json();
        
        if (result.success && result.new_trade_id) {
            // Reload trades from database
            await loadTrades();
            
            // Scroll to and focus on the new trade
            scrollToNewTrade(result.new_trade_id);
        } else {
            alert('Failed to create trade: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error creating ROCT PUT trade:', error);
        alert('Error creating trade: ' + error.message);
    }
}

// Add new ROCS BULL PUT SPREAD column to trades table
async function markTradeReviewed(tradeId) {
    try {
        await apiFetch(`/api/trades/${tradeId}/field`, {
            method: 'PUT',
            body: { field: 'needs_review', value: 0 }
        });
        await loadTrades();
    } catch(e) {
        console.error('markTradeReviewed error:', e);
    }
}

async function addNewROCSBullPutSpreadColumn() {
    console.log('addNewROCSBullPutSpreadColumn called');
    
    try {
        const response = await apiFetch('/api/accounts');
        const accounts = await response.json();
        
        const universalAccountFilter = document.getElementById('universal-account-filter');
        const selectedAccountId = universalAccountFilter && universalAccountFilter.value ? parseInt(universalAccountFilter.value) : null;
        
        let accountId;
        if (selectedAccountId) {
            const selectedAccount = accounts.find(acc => acc.id === selectedAccountId);
            accountId = selectedAccount ? selectedAccount.id : null;
        }
        
        if (!accountId) {
            const defaultAccount = accounts.find(acc => acc.is_default === 1 || acc.is_default === true);
            accountId = defaultAccount ? defaultAccount.id : (accounts.find(acc => acc.id === 9) ? 9 : (accounts.length > 0 ? accounts[0].id : null));
        }
        
        const activeTicker = window.symbolFilter ? window.symbolFilter.trim().toUpperCase() : '';
        
        const quickAddResponse = await apiFetch('/api/trades/quick-add', {
            method: 'POST',
            body: {
                tradeType: 'ROCS BULL PUT SPREAD',
                accountId: accountId,
                ticker: activeTicker || ''
            }
        });
        
        const result = await quickAddResponse.json();
        
        if (result.success && result.new_trade_id) {
            await loadTrades();
            scrollToNewTrade(result.new_trade_id);
        } else {
            alert('Failed to create trade: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error creating ROCS BULL PUT SPREAD trade:', error);
        alert('Error creating trade: ' + error.message);
    }
}

// Add new ROC column to trades table
async function addNewROCColumn() {
    console.log('addNewROCColumn called');
    
    try {
        // Get accounts
        const response = await apiFetch('/api/accounts');
        const accounts = await response.json();
        
        // Get selected account from control bar dropdown, or fall back to default
        const universalAccountFilter = document.getElementById('universal-account-filter');
        const selectedAccountId = universalAccountFilter && universalAccountFilter.value ? parseInt(universalAccountFilter.value) : null;
        
        let accountId;
        if (selectedAccountId) {
            const selectedAccount = accounts.find(acc => acc.id === selectedAccountId);
            accountId = selectedAccount ? selectedAccount.id : null;
        }
        
        // Fall back to default account if no account selected in dropdown
        if (!accountId) {
            const defaultAccount = accounts.find(acc => acc.is_default === 1 || acc.is_default === true);
            accountId = defaultAccount ? defaultAccount.id : (accounts.find(acc => acc.id === 9) ? 9 : (accounts.length > 0 ? accounts[0].id : null));
        }
        
        // Check if there's an active ticker filter
        const activeTicker = window.symbolFilter ? window.symbolFilter.trim().toUpperCase() : '';
        
        // Call quick-add API
        const quickAddResponse = await apiFetch('/api/trades/quick-add', {
            method: 'POST',
            body: {
                tradeType: 'ROC',
                accountId: accountId,
                ticker: activeTicker || ''
            }
        });
        
        const result = await quickAddResponse.json();
        
        if (result.success && result.new_trade_id) {
            // Reload trades from database
            await loadTrades();
            
            // Scroll to and focus on the new trade
            scrollToNewTrade(result.new_trade_id);
        } else {
            alert('Failed to create trade: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error creating ROC trade:', error);
        alert('Error creating trade: ' + error.message);
    }
}

// Add new ROP column to trades table
async function addNewROPColumn() {
    console.log('addNewROPColumn called');
    
    try {
        // Get accounts
        const response = await apiFetch('/api/accounts');
        const accounts = await response.json();
        
        // Get selected account from control bar dropdown, or fall back to default
        const universalAccountFilter = document.getElementById('universal-account-filter');
        const selectedAccountId = universalAccountFilter && universalAccountFilter.value ? parseInt(universalAccountFilter.value) : null;
        
        let accountId;
        if (selectedAccountId) {
            const selectedAccount = accounts.find(acc => acc.id === selectedAccountId);
            accountId = selectedAccount ? selectedAccount.id : null;
        }
        
        // Fall back to default account if no account selected in dropdown
        if (!accountId) {
            const defaultAccount = accounts.find(acc => acc.is_default === 1 || acc.is_default === true);
            accountId = defaultAccount ? defaultAccount.id : (accounts.find(acc => acc.id === 9) ? 9 : (accounts.length > 0 ? accounts[0].id : null));
        }
        
        // Check if there's an active ticker filter
        const activeTicker = window.symbolFilter ? window.symbolFilter.trim().toUpperCase() : '';
        
        // Call quick-add API
        const quickAddResponse = await apiFetch('/api/trades/quick-add', {
            method: 'POST',
            body: {
                tradeType: 'ROP',
                accountId: accountId,
                ticker: activeTicker || ''
            }
        });
        
        const result = await quickAddResponse.json();
        
        if (result.success && result.new_trade_id) {
            // Reload trades from database
            await loadTrades();
            
            // Scroll to and focus on the new trade
            scrollToNewTrade(result.new_trade_id);
        } else {
            alert('Failed to create trade: ' + (result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error creating ROP trade:', error);
        alert('Error creating trade: ' + error.message);
    }
}

// Update account for new trade
function updateNewTradeAccount(tradeId, accountId) {
    const trade = trades.find(t => t.id === tradeId);
    if (trade) {
        const accounts = window.accounts || [];
        const account = accounts.find(a => a.id == accountId);
        trade.account_id = parseInt(accountId);
        trade.account_name = account ? account.account_name : 'Unknown';
        
        // Update the universal account filter in the control bar
        const universalAccountFilter = document.getElementById('universal-account-filter');
        if (universalAccountFilter && accountId) {
            universalAccountFilter.value = accountId;
            // Trigger change event to update filters and reload data
            universalAccountFilter.dispatchEvent(new Event('change'));
        }
        
        // Fetch commission for the new account
        if (window._fetchAndPopulateCommissionForTrade && window._fetchAndPopulateCommissionForTrade[tradeId]) {
            window._fetchAndPopulateCommissionForTrade[tradeId]();
        }
    }
}

// Helper function to find column index by searching DOM for data-trade-id
function findColumnIndexForTrade(tradeId) {
    const tbody = document.getElementById('trades-table');
    if (!tbody) return -1;
    
    const rows = tbody.querySelectorAll('tr');
    for (let i = 0; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll('td');
        // Skip the first cell (field name) and check data cells
        for (let j = 1; j < cells.length; j++) {
            const input = cells[j].querySelector(`input[data-trade-id="${tradeId}"], select[data-trade-id="${tradeId}"]`);
            if (input) {
                return j; // j is already the correct index (includes field name column)
            }
        }
    }
    return -1;
}

// Global flags to prevent duplicate trade creation (stored per tradeId)
// This ensures flags persist across multiple calls to setupNewTradeCreation
if (!window.tradeCreationFlags) {
    window.tradeCreationFlags = {};
}

// Setup new trade creation when all fields are filled
function setupNewTradeCreation(tradeId) {
    console.log('[DEBUG] setupNewTradeCreation called for tradeId:', tradeId);
    const trade = trades.find(t => t.id === tradeId);
    if (!trade) {
        console.log('[DEBUG] setupNewTradeCreation - Trade not found:', tradeId);
        return;
    }
    console.log('[DEBUG] setupNewTradeCreation - Trade found:', trade);
    
    // Initialize flags for this tradeId if they don't exist
    if (!window.tradeCreationFlags[tradeId]) {
        window.tradeCreationFlags[tradeId] = {
            isCreating: false,
            hasBeenCreated: false
        };
    }
    
    // Get flags for this tradeId (shared across all calls to setupNewTradeCreation for this trade)
    const flags = window.tradeCreationFlags[tradeId];
    const isCreating = flags.isCreating;
    const hasBeenCreated = flags.hasBeenCreated;
    
    // Check if all required fields are filled and create trade
    // This function should only be called when the user exits the contracts field (blur event)
    const checkAndCreateTrade = () => {
        // Prevent duplicate creation (check global flags)
        if (flags.isCreating || flags.hasBeenCreated) {
            console.log('[DEBUG] checkAndCreateTrade - Already creating or created, skipping. Flags:', flags);
            return;
        }
        
        console.log('[DEBUG] checkAndCreateTrade called for tradeId:', tradeId, '- User exited contracts field');
        console.log('[DEBUG] checkAndCreateTrade - Flags state:', { isCreating: flags.isCreating, hasBeenCreated: flags.hasBeenCreated });
        const tbody = document.getElementById('trades-table');
        if (!tbody) {
            console.log('[DEBUG] checkAndCreateTrade - tbody not found');
            return;
        }
        
        const newColumnIndex = findColumnIndexForTrade(tradeId);
        if (newColumnIndex === -1) {
            console.log('[DEBUG] checkAndCreateTrade - Column index not found for tradeId:', tradeId);
            return;
        }
        console.log('[DEBUG] checkAndCreateTrade - Column index found:', newColumnIndex);
        
        // Get all field values
        const accountRow = tbody.children[1];
        const tickerRow = tbody.children[2];
        const tradeDateRow = tbody.children[3];
        const priceRow = tbody.children[4];
        const expDateRow = tbody.children[5];
        const strikeRow = tbody.children[7];
        const creditRow = tbody.children[8];
        const contractsRow = tbody.children[9];
        
        if (!accountRow || !tickerRow || !tradeDateRow || !priceRow || !expDateRow || !strikeRow || !creditRow || !contractsRow) return;
        
        const accountCell = accountRow.children[newColumnIndex];
        const tickerCell = tickerRow.children[newColumnIndex];
        const tradeDateCell = tradeDateRow.children[newColumnIndex];
        const priceCell = priceRow.children[newColumnIndex];
        const expDateCell = expDateRow.children[newColumnIndex];
        const strikeCell = strikeRow.children[newColumnIndex];
        const creditCell = creditRow.children[newColumnIndex];
        const contractsCell = contractsRow.children[newColumnIndex];
        
        if (!accountCell || !tickerCell || !tradeDateCell || !priceCell || !expDateCell || !strikeCell || !creditCell || !contractsCell) return;
        
        const accountSelect = accountCell.querySelector('select');
        const tickerInput = tickerCell.querySelector('input');
        const tradeDateInput = tradeDateCell.querySelector('input');
        const priceInput = priceCell.querySelector('input');
        const expDateInput = expDateCell.querySelector('input');
        const strikeInput = strikeCell.querySelector('input');
        const creditInput = creditCell.querySelector('input');
        const contractsInput = contractsCell.querySelector('input');
        
        if (!accountSelect || !tickerInput || !tradeDateInput || !priceInput || !expDateInput || !strikeInput || !creditInput || !contractsInput) return;
        
        // Get accountId from dropdown, with fallback to trade object
        let accountId = accountSelect.value;
        if (!accountId) {
            // Fallback to trade object's account_id if dropdown value is empty
            const trade = trades.find(t => t.id === tradeId);
            if (trade && trade.account_id) {
                accountId = trade.account_id.toString();
            }
        }
        
        const ticker = tickerInput.value.trim().toUpperCase();
        const tradeDate = tradeDateInput.value.trim();
        const price = priceInput.value.trim();
        const expDate = expDateInput.value.trim();
        const strike = strikeInput.value.trim();
        const credit = creditInput.value.trim();
        const contracts = contractsInput.value.trim();
        
        // Check if all required fields are filled
        console.log('[DEBUG] checkAndCreateTrade - Raw field values:', {
            accountId, ticker, tradeDate, price, expDate, strike, credit, contracts
        });
        console.log('[DEBUG] checkAndCreateTrade - Input elements:', {
            strikeInput: strikeInput ? { value: strikeInput.value, type: strikeInput.type } : null,
            creditInput: creditInput ? { value: creditInput.value, type: creditInput.type } : null,
            priceInput: priceInput ? { value: priceInput.value, type: priceInput.type } : null
        });
        // Check if all required fields are filled (including non-empty numeric values)
        // For number inputs, empty string or "0" should be considered invalid
        const hasValidStrike = strike && strike !== '0' && strike !== '0.0' && strike !== '0.00';
        const hasValidCredit = credit && credit !== '0' && credit !== '0.0' && credit !== '0.00';
        const hasValidPrice = price && price !== '0' && price !== '0.0' && price !== '0.00';
        const hasValidContracts = contracts && contracts !== '0';
        
        console.log('[DEBUG] checkAndCreateTrade - Field validation:', {
            accountId: accountId ? '✓' : '✗',
            ticker: ticker ? '✓' : '✗',
            tradeDate: tradeDate ? '✓' : '✗',
            expDate: expDate ? '✓' : '✗',
            hasValidPrice: hasValidPrice ? '✓' : '✗',
            hasValidStrike: hasValidStrike ? '✓' : '✗',
            hasValidCredit: hasValidCredit ? '✓' : '✗',
            hasValidContracts: hasValidContracts ? '✓' : '✗',
            price: price,
            strike: strike,
            credit: credit,
            contracts: contracts
        });
        
        if (accountId && ticker && tradeDate && hasValidPrice && expDate && hasValidStrike && hasValidCredit && hasValidContracts) {
            console.log('[DEBUG] checkAndCreateTrade - All fields filled with valid values!');
            // Convert dates to YYYY-MM-DD format
            let tradeDateObj = parseDateToYYYYMMDD(tradeDate);
            let expDateObj = parseDateToYYYYMMDD(expDate);
            
            // If parseDateToYYYYMMDD returns null, try parseDisplayDate as fallback
            if (!tradeDateObj && tradeDate) {
                tradeDateObj = parseDisplayDate(tradeDate);
            }
            if (!expDateObj && expDate) {
                expDateObj = parseDisplayDate(expDate);
            }
            
            // If still no date, check if it's already in YYYY-MM-DD format
            if (!tradeDateObj && /^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
                tradeDateObj = tradeDate;
            }
            if (!expDateObj && /^\d{4}-\d{2}-\d{2}$/.test(expDate)) {
                expDateObj = expDate;
            }
            
            if (tradeDateObj && expDateObj) {
                // Set flag to prevent duplicate creation (check global flags)
                if (flags.isCreating || flags.hasBeenCreated) {
                    console.log('[DEBUG] checkAndCreateTrade - Trade already being created or created, skipping. Flags:', flags);
                    return;
                }
                
                // Validate numeric values
                const strikePrice = parseFloat(strike);
                const premium = parseFloat(credit);
                const currentPrice = parseFloat(price);
                const numContracts = parseInt(contracts);
                
                console.log('[DEBUG] checkAndCreateTrade - Parsed numeric values:', {
                    strike: strike, strikePrice: strikePrice,
                    credit: credit, premium: premium,
                    price: price, currentPrice: currentPrice,
                    contracts: contracts, numContracts: numContracts
                });
                
                if (isNaN(strikePrice) || isNaN(premium) || isNaN(currentPrice) || isNaN(numContracts)) {
                    console.error('[DEBUG] checkAndCreateTrade - Invalid numeric values:', {
                        strike: strike, strikePrice: strikePrice,
                        credit: credit, premium: premium,
                        price: price, currentPrice: currentPrice,
                        contracts: contracts, numContracts: numContracts
                    });
                    alert('Please enter valid numeric values for Strike, Credit, Price, and Contracts');
                    return;
                }
                
                // Additional validation: ensure values are not 0 (except for contracts which can be 1)
                if (strikePrice === 0 || premium === 0 || currentPrice === 0 || numContracts === 0) {
                    console.error('[DEBUG] checkAndCreateTrade - Zero values detected:', {
                        strikePrice, premium, currentPrice, numContracts
                    });
                    alert('Please enter non-zero values for Strike, Credit, Price, and Contracts');
                    return;
                }
                
                // Get the trade type from the trade object (should be set when column was created)
                // Use the trade's actual trade_type, not a hardcoded default
                const tradeType = trade.trade_type || trade.type_name;
                
                if (!tradeType) {
                    console.error('[DEBUG] checkAndCreateTrade - No trade type found for trade:', trade);
                    alert('Error: Trade type not found. Please refresh the page and try again.');
                    flags.isCreating = false;
                    return;
                }
                
                // Update global flags
                flags.isCreating = true;
                console.log('[DEBUG] setupNewTradeCreation - All fields filled, creating trade:', {
                    accountId: parseInt(accountId),
                    ticker: ticker,
                    tradeDate: tradeDateObj,
                    expirationDate: expDateObj,
                    currentPrice: currentPrice,
                    strikePrice: strikePrice,
                    premium: premium,
                    num_of_contracts: numContracts,
                    tradeType: tradeType
                });
                
                // Create the trade
                createNewTradeFromColumn(tradeId, {
                    accountId: parseInt(accountId),
                    ticker: ticker,
                    tradeDate: tradeDateObj,
                    expirationDate: expDateObj,
                    currentPrice: currentPrice,
                    strikePrice: strikePrice,
                    premium: premium,
                    num_of_contracts: numContracts,
                    tradeType: tradeType
                }).then(() => {
                    flags.hasBeenCreated = true;
                    flags.isCreating = false;
                }).catch((error) => {
                    console.error('[DEBUG] checkAndCreateTrade - Error creating trade:', error);
                    flags.isCreating = false;
                });
            } else {
                console.log('[DEBUG] setupNewTradeCreation - Date parsing failed:', {
                    tradeDate: tradeDate,
                    tradeDateObj: tradeDateObj,
                    expDate: expDate,
                    expDateObj: expDateObj
                });
            }
        }
    };
    
    // Add event listeners to all input fields
    const tbody = document.getElementById('trades-table');
    if (!tbody) {
        console.log('[DEBUG] setupNewTradeCreation - tbody not found');
        return;
    }
    
    const newColumnIndex = findColumnIndexForTrade(tradeId);
    if (newColumnIndex === -1) {
        console.log('[DEBUG] setupNewTradeCreation - Column index not found for tradeId:', tradeId);
        return;
    }
    console.log('[DEBUG] setupNewTradeCreation - Column index found:', newColumnIndex);
    
    // Only attach blur listener to the contracts field (row 9) - this is the last field
    // The trade will only be created when the user exits the contracts field after filling all fields
    // Use a more robust approach: try multiple times with delays to ensure the element exists
    const attachContractsBlurListener = () => {
        const contractsRow = tbody.children[9];
        if (contractsRow) {
            const contractsCell = contractsRow.children[newColumnIndex];
            if (contractsCell) {
                const contractsInput = contractsCell.querySelector('input[data-trade-id="' + tradeId + '"]');
                if (contractsInput) {
                    // Store the handler function on the element itself so we can remove it later
                    const blurHandler = () => {
                        console.log('[DEBUG] Contracts field blur event fired for tradeId:', tradeId);
                        checkAndCreateTrade();
                    };
                    
                    // Remove any existing handler
                    if (contractsInput._blurHandler) {
                        contractsInput.removeEventListener('blur', contractsInput._blurHandler);
                    }
                    
                    // Store and attach new handler
                    contractsInput._blurHandler = blurHandler;
                    contractsInput.addEventListener('blur', blurHandler);
                    console.log('[DEBUG] setupNewTradeCreation - Attached blur listener to contracts field (row 9) for tradeId:', tradeId, 'input:', contractsInput);
                    return true;
                } else {
                    console.log('[DEBUG] setupNewTradeCreation - Contracts input not found in cell for tradeId:', tradeId);
                }
            } else {
                console.log('[DEBUG] setupNewTradeCreation - Contracts cell not found at column index:', newColumnIndex);
            }
        } else {
            console.log('[DEBUG] setupNewTradeCreation - Contracts row (row 9) not found');
        }
        return false;
    };
    
    // Try immediately
    if (!attachContractsBlurListener()) {
        // If it fails, try again after a short delay (table might still be rendering)
        setTimeout(() => {
            if (!attachContractsBlurListener()) {
                // Try one more time after a longer delay
                setTimeout(attachContractsBlurListener, 200);
            }
        }, 50);
    }
    
    // Also check on account change (but don't create trade, just update the trade object in memory)
    const accountRow = tbody.children[1];
    if (accountRow) {
        const accountCell = accountRow.children[newColumnIndex];
        if (accountCell) {
            const select = accountCell.querySelector('select');
            if (select) {
                select.addEventListener('change', function() {
                    // Update the trade object in memory but don't create the trade yet
                    const trade = trades.find(t => t.id === tradeId);
                    if (trade) {
                        trade.account_id = parseInt(this.value);
                        const accounts = window.accounts || [];
                        const account = accounts.find(a => a.id == trade.account_id);
                        if (account) {
                            trade.account_name = account.account_name;
                        }
                    }
                    
                    // Update the universal account filter in the control bar
                    const universalAccountFilter = document.getElementById('universal-account-filter');
                    if (universalAccountFilter && this.value) {
                        universalAccountFilter.value = this.value;
                        // Trigger change event to update filters and reload data
                        universalAccountFilter.dispatchEvent(new Event('change'));
                    }
                    
                    // Fetch commission for the new account
                    if (window._fetchAndPopulateCommissionForTrade && window._fetchAndPopulateCommissionForTrade[tradeId]) {
                        window._fetchAndPopulateCommissionForTrade[tradeId]();
                    }
                    
                    console.log('[DEBUG] setupNewTradeCreation - Account changed, updated trade in memory and universal filter');
                });
            }
        }
    }
}

// Parse date from DD-MMM-YY or MM/DD/YY to YYYY-MM-DD
function parseDateToYYYYMMDD(dateStr) {
    if (!dateStr) return null;
    
    // Try DD-MMM-YY format first
    const ddmmyyMatch = dateStr.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
    if (ddmmyyMatch) {
        const day = parseInt(ddmmyyMatch[1]);
        const monthStr = ddmmyyMatch[2];
        const year = parseInt('20' + ddmmyyMatch[3]);
        
        const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        const month = months.indexOf(monthStr.toUpperCase());
        if (month === -1) return null;
        
        return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    
    // Try MM/DD/YY format
    const mmddyyMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
    if (mmddyyMatch) {
        const month = parseInt(mmddyyMatch[1]);
        const day = parseInt(mmddyyMatch[2]);
        const year = parseInt('20' + mmddyyMatch[3]);
        
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    
    return null;
}

// Create new trade from column data
async function createNewTradeFromColumn(tradeId, tradeData) {
    try {
        console.log('[DEBUG] createNewTradeFromColumn - Creating new trade:', tradeData);
        
        // Remove the temporary trade from the array
        const tempIndex = trades.findIndex(t => t.id === tradeId);
        if (tempIndex !== -1) {
            trades.splice(tempIndex, 1);
        }
        
        // Prepare the request body
        const requestBody = {
            ticker: tradeData.ticker,
            tradeDate: tradeData.tradeDate,
            expirationDate: tradeData.expirationDate,
            currentPrice: tradeData.currentPrice,
            strikePrice: tradeData.strikePrice,
            premium: tradeData.premium,
            num_of_contracts: tradeData.num_of_contracts,
            tradeType: tradeData.tradeType,
            accountId: tradeData.accountId
        };
        
        console.log('[DEBUG] createNewTradeFromColumn - Sending request:', requestBody);
        console.log('[DEBUG] createNewTradeFromColumn - accountId type:', typeof requestBody.accountId, 'value:', requestBody.accountId);
        
        // Create the trade via API
        const response = await apiFetch('/api/trades', {
            method: 'POST',
            body: requestBody
        });
        
        const result = await response.json();
        console.log('[DEBUG] createNewTradeFromColumn - Response:', result);
        console.log('[DEBUG] createNewTradeFromColumn - Response success:', result.success, 'error:', result.error);
        
        if (result.success) {
            console.log('[DEBUG] createNewTradeFromColumn - Trade created successfully, reloading...');
            
            // Ensure the temporary trade is removed from the array before reloading
            // This prevents duplicate display after loadTrades()
            const tempIndex = trades.findIndex(t => t.id === tradeId);
            if (tempIndex !== -1) {
                trades.splice(tempIndex, 1);
                console.log('[DEBUG] createNewTradeFromColumn - Removed temporary trade from array before reload');
            }
            
            // Reload trades and update table
            await loadTrades();
            updateTradesTable();
            
            // Reload cost basis if ticker filter is set
            if (window.symbolFilter === tradeData.ticker) {
                loadCostBasis(tradeData.ticker);
            }
            return Promise.resolve();
        } else {
            console.error('[DEBUG] createNewTradeFromColumn - Failed to create trade:', result.error);
            alert('Failed to create trade: ' + (result.error || 'Unknown error'));
            // Re-add the temporary trade
            trades.push({
                id: tradeId,
                ...tradeData
            });
            updateTradesTable();
            return Promise.reject(new Error(result.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('[DEBUG] createNewTradeFromColumn - Error creating trade:', error);
        alert('Error creating trade: ' + error.message);
        // Re-add the temporary trade
        trades.push({
            id: tradeId,
            ...tradeData
        });
        updateTradesTable();
        return Promise.reject(error);
    }
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
        document.getElementById('roct-put-trade-date').value = tradeData.date_trade_open || tradeData.trade_date || '';
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
        
        document.getElementById('roct-put-expiration-date').value = formatDate(getNextFriday());
        
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
        
        const response = await apiFetch(`/api/top-symbols?${params}`);
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
                    <span class="small ${colorClass} top-symbol-link" data-symbol="${String(symbol.ticker || '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;')}" style="cursor: pointer;" title="Click to filter trades and cost basis">${index + 1}. ${symbol.ticker}</span>
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
        showLoadingSpinner(`Importing ${importType === 'cost-basis' ? 'cost basis' : 'trades'}...`);
        
        // Determine which endpoint to use based on import type
        const endpoint = importType === 'cost-basis' ? '/api/import-cost-basis-excel' : '/api/import-excel';
        console.log('Import type:', importType, 'Using endpoint:', endpoint);
        const response = await apiFetch(endpoint, {
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
            if (result.imported === 0 && result.diagnostic) {
                // Show diagnostic information when 0 trades imported
                message = `No trades were imported.\n\n`;
                if (result.diagnostic.diagnostic) {
                    message += result.diagnostic.diagnostic + '\n\n';
                }
                if (result.diagnostic.checks && Array.isArray(result.diagnostic.checks)) {
                    message += result.diagnostic.checks.join('\n');
                }
            }
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
    } finally {
        hideLoadingSpinner();
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
        showLoadingSpinner('Importing cost basis...');
        
        const response = await apiFetch('/api/import-cost-basis-excel', {
            method: 'POST',
            body: formData
        });
        
        console.log('Response status:', response.status);
        
        // Check if response is OK before reading body
        if (!response.ok) {
            const errorText = await response.text();
            console.error('Error response body:', errorText);
            let errorMessage = 'Error uploading file: Server returned ' + response.status;
            try {
                const errorJson = JSON.parse(errorText);
                if (errorJson.error) {
                    errorMessage += '\n\n' + errorJson.error;
                    console.error('Parsed error:', errorJson.error);
                }
            } catch (e) {
                // If not JSON, use the raw text
                if (errorText) {
                    errorMessage += '\n\n' + errorText;
                    console.error('Raw error text:', errorText);
                }
            }
            console.error('Full error details:', {
                status: response.status,
                statusText: response.statusText,
                errorText: errorText
            });
            alert(errorMessage);
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
                const errorsText = result.errors.join('\n');
                message += `\n\nErrors (${result.errors.length}):\n${errorsText}`;
                // Also log errors to console for easy inspection
                console.error('Import errors:', result.errors);
                console.error('Full error details:', result.errors);
            }
            console.log('Import success message:', message);
            alert(message);
            // Reload data
            await loadCostBasis();
            await loadTrades();
            await loadSummary();
        } else {
            const errorMsg = result.error || 'Unknown error occurred';
            console.error('Import failed:', errorMsg);
            console.error('Full error result:', result);
            alert('Error importing Excel file:\n\n' + errorMsg);
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

// ============================================================================
// SCHWAB API INTEGRATION
// ============================================================================

// ---------------------------------------------------------------------------
// Schwab BTO auto-sync (toolbar button)
// ---------------------------------------------------------------------------
let _schwabStatusInterval = null;

async function triggerSchwabSync() {
    const btn = document.getElementById('schwab-sync-btn');
    const icon = document.getElementById('schwab-sync-icon');
    if (!btn) return;

    btn.disabled = true;
    icon.classList.add('fa-spin');

    try {
        const resp = await apiFetch('/api/schwab/sync-trades', { method: 'POST', body: {} });
        const result = await resp.json();
        if (result.success) {
            if (result.imported > 0) {
                showToast(`Schwab: imported ${result.imported} new BTO trade(s)`, 'success');
                await loadTrades();
                loadSummary();
            } else {
                showToast('Schwab: no new trades', 'info');
            }
            _updateSchwabLastSyncLabel(result.last_sync);
        } else {
            showToast('Schwab sync failed: ' + (result.error || 'unknown error'), 'danger');
        }
    } catch (err) {
        showToast('Schwab sync error: ' + err.message, 'danger');
    } finally {
        btn.disabled = false;
        icon.classList.remove('fa-spin');
    }
}

function _updateSchwabLastSyncLabel(isoString) {
    const label = document.getElementById('schwab-last-sync-label');
    if (!label || !isoString) return;
    try {
        const d = new Date(isoString);
        const hh = d.getHours().toString().padStart(2,'0');
        const mm = d.getMinutes().toString().padStart(2,'0');
        label.textContent = `${hh}:${mm}`;
        label.title = 'Last Schwab sync: ' + d.toLocaleString();
    } catch(e) { label.textContent = ''; }
}

async function refreshSchwabSyncStatus() {
    try {
        const resp = await apiFetch('/api/schwab/sync-status');
        const data = await resp.json();
        const dot = document.getElementById('schwab-poll-dot');
        const btn = document.getElementById('schwab-sync-btn');
        if (dot) dot.style.display = data.polling_active ? 'inline-block' : 'none';
        if (btn) btn.title = data.authenticated
            ? (data.polling_active ? 'Auto-syncing every 60s — click to sync now' : 'Click to sync BTO trades from Schwab')
            : 'Schwab not authenticated';
        if (data.last_sync) _updateSchwabLastSyncLabel(data.last_sync);
        // If authenticated and not yet polling from frontend perspective, start polling
        if (data.authenticated && !_schwabStatusInterval) {
            _schwabStatusInterval = setInterval(refreshSchwabSyncStatus, 65000); // refresh status every 65s
        }
    } catch(e) { /* silently ignore */ }
}

// Kick off status refresh after page load
document.addEventListener('DOMContentLoaded', () => setTimeout(refreshSchwabSyncStatus, 2000));

function showToast(message, type='info') {
    // Reuse existing toast infrastructure or fall back to console
    if (typeof window.showNotification === 'function') {
        window.showNotification(message, type);
        return;
    }
    const container = document.getElementById('toast-container') || (() => {
        const el = document.createElement('div');
        el.id = 'toast-container';
        el.style.cssText = 'position:fixed;top:1rem;right:1rem;z-index:9999;display:flex;flex-direction:column;gap:0.5rem;';
        document.body.appendChild(el);
        return el;
    })();
    const colors = { success:'#198754', danger:'#dc3545', info:'#0dcaf0', warning:'#ffc107' };
    const toast = document.createElement('div');
    toast.style.cssText = `background:${colors[type]||colors.info};color:#fff;padding:0.6rem 1rem;border-radius:6px;font-size:0.85rem;box-shadow:0 2px 8px rgba(0,0,0,.25);max-width:320px;`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

async function openSchwabSyncModal() {
    const modal = new bootstrap.Modal(document.getElementById('schwabSyncModal'));
    modal.show();
    
    // Check Schwab API status
    await checkSchwabStatus();
}

async function checkSchwabStatus() {
    const statusDiv = document.getElementById('schwab-status');
    const syncForm = document.getElementById('schwab-sync-form');
    const syncBtn = document.getElementById('schwab-sync-btn');
    
    try {
        const response = await apiFetch('/api/schwab/status');
        const data = await response.json();
        
        if (!data.available) {
            statusDiv.className = 'alert alert-warning';
            statusDiv.innerHTML = `
                <i class="fas fa-exclamation-triangle me-2"></i>
                <strong>Schwab API not available:</strong> ${data.message || 'Library not installed'}
            `;
            syncForm.style.display = 'none';
            syncBtn.style.display = 'none';
            return;
        }
        
        if (!data.authenticated) {
            statusDiv.className = 'alert alert-warning';
            statusDiv.innerHTML = `
                <i class="fas fa-exclamation-triangle me-2"></i>
                <strong>Not Authenticated:</strong> ${data.message || 'Please configure Schwab API credentials in .env file'}
                <br><br>
                <button class="btn btn-primary btn-sm" onclick="authenticateSchwab()">
                    <i class="fas fa-key me-2"></i>Authenticate with Schwab
                </button>
            `;
            syncForm.style.display = 'none';
            syncBtn.style.display = 'none';
            return;
        }
        
        // API is available and authenticated
        statusDiv.className = 'alert alert-success';
        statusDiv.innerHTML = `
            <i class="fas fa-check-circle me-2"></i>
            <strong>Schwab API Connected</strong>
        `;
        syncForm.style.display = 'block';
        syncBtn.style.display = 'block';
        
        // Load accounts
        await loadSchwabAccounts();
        await loadLocalAccounts();
        
        // Set default dates (last 30 days)
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
        
        document.getElementById('schwab-start-date').value = startDate.toISOString().split('T')[0];
        document.getElementById('schwab-end-date').value = endDate.toISOString().split('T')[0];
        
    } catch (error) {
        statusDiv.className = 'alert alert-danger';
        statusDiv.innerHTML = `
            <i class="fas fa-times-circle me-2"></i>
            <strong>Error:</strong> ${error.message}
        `;
        syncForm.style.display = 'none';
        syncBtn.style.display = 'none';
    }
}

async function loadSchwabAccounts() {
    try {
        const response = await apiFetch('/api/schwab/accounts');
        const data = await response.json();
        
        const select = document.getElementById('schwab-account-select');
        select.innerHTML = '<option value="">All Accounts</option>';
        
        if (data.success && data.accounts) {
            data.accounts.forEach(account => {
                const option = document.createElement('option');
                option.value = account.account_number;
                option.textContent = `${account.account_name} (${account.account_number})`;
                select.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading Schwab accounts:', error);
    }
}

async function loadLocalAccounts() {
    try {
        const response = await apiFetch('/api/accounts');
        const accounts = await response.json();
        
        const select = document.getElementById('schwab-local-account');
        select.innerHTML = '<option value="">Select account...</option>';
        
        if (Array.isArray(accounts)) {
            accounts.forEach(account => {
                const option = document.createElement('option');
                option.value = account.id;
                option.textContent = account.account_name;
                select.appendChild(option);
            });
        }
    } catch (error) {
        console.error('Error loading local accounts:', error);
    }
}

async function syncSchwabTrades() {
    const syncBtn = document.getElementById('schwab-sync-btn');
    const resultsDiv = document.getElementById('schwab-sync-results');
    const statsDiv = document.getElementById('schwab-sync-stats');
    
    // Get form data
    const accountNumber = document.getElementById('schwab-account-select').value;
    const startDate = document.getElementById('schwab-start-date').value;
    const endDate = document.getElementById('schwab-end-date').value;
    const accountId = document.getElementById('schwab-local-account').value;
    
    if (!accountId) {
        alert('Please select a local account to map trades to');
        return;
    }
    
    // Disable button and show loading
    syncBtn.disabled = true;
    syncBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>Syncing...';
    
    try {
        const response = await apiFetch('/api/schwab/sync-trades', {
            method: 'POST',
            body: {
                account_number: accountNumber || null,
                start_date: startDate,
                end_date: endDate,
                account_id: parseInt(accountId)
            }
        });
        
        const data = await response.json();
        
        if (data.success) {
            statsDiv.innerHTML = `
                <ul class="mb-0 mt-2">
                    <li>Imported: ${data.imported} trade(s)</li>
                    <li>Skipped: ${data.skipped} duplicate(s)</li>
                    ${data.errors && data.errors.length > 0 ? `<li class="text-warning">Errors: ${data.errors.length}</li>` : ''}
                </ul>
            `;
            
            if (data.errors && data.errors.length > 0) {
                console.warn('Sync errors:', data.errors);
            }
            
            resultsDiv.style.display = 'block';
            
            // Reload trades table
            await loadTrades();
            loadSummary();
            
            // Hide form
            document.getElementById('schwab-sync-form').style.display = 'none';
            
        } else {
            alert('Sync failed: ' + (data.error || 'Unknown error'));
        }
        
    } catch (error) {
        alert('Error syncing trades: ' + error.message);
    } finally {
        syncBtn.disabled = false;
        syncBtn.innerHTML = '<i class="fas fa-sync me-2"></i>Sync Trades';
    }
}

// Function to get real-time quotes from Schwab
async function getSchwabQuotes(symbols) {
    try {
        const symbolsStr = Array.isArray(symbols) ? symbols.join(',') : symbols;
        const response = await apiFetch(`/api/schwab/quotes?symbols=${encodeURIComponent(symbolsStr)}`);
        const data = await response.json();
        
        if (data.success) {
            return data.quotes;
        }
        return null;
    } catch (error) {
        console.error('Error fetching Schwab quotes:', error);
        return null;
    }
}

// Function to authenticate with Schwab API
async function authenticateSchwab() {
    const statusDiv = document.getElementById('schwab-status');
    
    // Show loading state
    statusDiv.className = 'alert alert-info';
    statusDiv.innerHTML = `
        <i class="fas fa-spinner fa-spin me-2"></i>
        <strong>Authenticating...</strong> Please wait...
    `;
    
    try {
        const response = await apiFetch('/api/schwab/authenticate', {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success && data.authenticated) {
            statusDiv.className = 'alert alert-success';
            statusDiv.innerHTML = `
                <i class="fas fa-check-circle me-2"></i>
                <strong>Authentication Successful!</strong> ${data.message || ''}
            `;
            
            // Re-check status to show the sync form
            setTimeout(() => {
                checkSchwabStatus();
            }, 1000);
        } else if (data.auth_url) {
            // Need to redirect to authorization URL
            statusDiv.className = 'alert alert-info';
            statusDiv.innerHTML = `
                <i class="fas fa-info-circle me-2"></i>
                <strong>Authorization Required</strong>
                <br><br>
                <p>Please click the button below to authorize this application with Schwab.</p>
                <a href="${data.auth_url}" target="_blank" class="btn btn-primary btn-sm">
                    <i class="fas fa-external-link-alt me-2"></i>Authorize with Schwab
                </a>
                <br><br>
                <small>After authorizing, you'll be redirected back. Then click "Check Status" below.</small>
                <br><br>
                <button class="btn btn-secondary btn-sm mt-2" onclick="checkSchwabStatus()">
                    <i class="fas fa-sync me-2"></i>Check Status
                </button>
            `;
        } else {
            statusDiv.className = 'alert alert-danger';
            statusDiv.innerHTML = `
                <i class="fas fa-times-circle me-2"></i>
                <strong>Authentication Failed:</strong> ${data.message || data.error || 'Unknown error'}
                <br><br>
                <small>Make sure your Schwab API credentials are correct in your .env file.</small>
                <br><br>
                <button class="btn btn-primary btn-sm" onclick="authenticateSchwab()">
                    <i class="fas fa-key me-2"></i>Try Again
                </button>
            `;
        }
    } catch (error) {
        statusDiv.className = 'alert alert-danger';
        statusDiv.innerHTML = `
            <i class="fas fa-times-circle me-2"></i>
            <strong>Error:</strong> ${error.message}
            <br><br>
            <button class="btn btn-primary btn-sm" onclick="authenticateSchwab()">
                <i class="fas fa-key me-2"></i>Try Again
            </button>
        `;
    }
}

// Function to get historical data from Schwab
async function getSchwabHistorical(symbol, startDate, endDate) {
    try {
        const startStr = startDate instanceof Date ? startDate.toISOString().split('T')[0] : startDate;
        const endStr = endDate instanceof Date ? endDate.toISOString().split('T')[0] : endDate;
        
        const response = await apiFetch(
            `/api/schwab/historical?symbol=${encodeURIComponent(symbol)}&start_date=${startStr}&end_date=${endStr}`
        );
        const data = await response.json();
        
        if (data.success) {
            return data.data;
        }
        return null;
    } catch (error) {
        console.error('Error fetching Schwab historical data:', error);
        return null;
    }
}


