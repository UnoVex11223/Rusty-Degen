// main.js - Rust Jackpot Frontend Logic

// Establish Socket.IO connection
const socket = io();

// --- Configuration Constants ---
const CONFIG = {
    ROUND_DURATION: 99, // Timer duration in seconds
    MAX_ITEMS_PER_DEPOSIT: 20, // Max selectable items per deposit action
    MAX_DISPLAY_DEPOSITS: 10, // Max vertical deposit blocks shown visually
    MAX_PARTICIPANTS_DISPLAY: 20, // Max participants allowed (should match backend)
    MAX_ITEMS_PER_POT_FRONTEND: 200, // Max items in pot (should match backend)
    ROULETTE_REPETITIONS: 20, // How many times the participant pool is repeated visually in roulette
    SPIN_DURATION_SECONDS: 6.5, // Duration of the main roulette spin animation
    WINNER_DISPLAY_DURATION: 7000, // How long winner info is shown (ms)
    CONFETTI_COUNT: 150, // Number of confetti pieces
    // Roulette Animation Physics (Adjust for feel)
    EASE_OUT_POWER: 5, // Higher value = faster initial speed, slower end
    BOUNCE_ENABLED: false, // Enable/disable landing bounce effect
    BOUNCE_OVERSHOOT_FACTOR: 0.07, // How much it overshoots before bouncing back (if enabled)
    BOUNCE_DAMPING: 0.35, // How quickly the bounce settles (if enabled)
    BOUNCE_FREQUENCY: 3.5, // How many bounces occur (if enabled)
    LANDING_POSITION_VARIATION: 0.60, // Randomness in landing position (0 to 1, fraction of item width)
    AGE_VERIFICATION_KEY: 'userHasVerifiedAge', // Key for localStorage age check
    // CSRF Protection
    CSRF_TOKEN: document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '',
    NOTIFICATION_DURATION: 5000, // Default notification duration in ms
    MAX_PENDING_TRADE_DISPLAY: 5, // Maximum number of pending trades to display in history
};

// User Color Palette (20 distinct colors)
const COLOR_PALETTE = [
    '#00bcd4', '#ff5722', '#9c27b0', '#4caf50', '#ffeb3b', '#2196f3', '#f44336', '#ff9800',
    '#e91e63', '#8bc34a', '#3f51b5', '#009688', '#cddc39', '#795548', '#607d8b', '#673ab7',
    '#ffc107', '#03a9f4', '#9e9e9e', '#8d6e63'
];

// --- DOM Element References ---
// Grouping DOM elements for better organization
const DOMElements = {
    // Navigation
    nav: {
        homeLink: document.getElementById('home-link'), // Assuming jackpot tab is home
        aboutLink: document.getElementById('about-link'),
        tosLink: document.getElementById('tos-link'),
        faqLink: document.getElementById('faq-link'),
        fairLink: document.getElementById('fair-link'),
    },
    pages: {
        homePage: document.getElementById('home-page'),
        aboutPage: document.getElementById('about-page'),
        tosPage: document.getElementById('tos-page'),
        faqPage: document.getElementById('faq-page'),
        fairPage: document.getElementById('fair-page'),
    },
    // User Authentication / Profile
    user: {
        loginButton: document.getElementById('loginButton'),
        userProfile: document.getElementById('userProfile'),      // The clickable avatar+name element in header
        userAvatar: document.getElementById('userAvatar'),        // Avatar within #userProfile
        userName: document.getElementById('userName'),            // Name within #userProfile
        userDropdownMenu: document.getElementById('userDropdownMenu'), // The dropdown menu itself
        profileDropdownButton: document.getElementById('profileDropdownButton'), // "Profile" button inside dropdown
        tradeHistoryButton: document.getElementById('tradeHistoryButton'), // "Trade History" button inside dropdown
        logoutButton: document.getElementById('logoutButton'),     // The logout button inside the dropdown
        pendingOfferIndicator: document.getElementById('pending-offer-indicator'), // Indicator for pending offers
    },
    // Profile Modal Elements
    profileModal: {
        modal: document.getElementById('profileModal'),
        avatar: document.getElementById('profileModalAvatar'),
        name: document.getElementById('profileModalName'),
        deposited: document.getElementById('profileModalDeposited'), // Total deposited
        won: document.getElementById('profileModalWon'), // Added for total won
        tradeUrlInput: document.getElementById('profileModalTradeUrl'),
        saveBtn: document.getElementById('profileModalSaveBtn'),
        closeBtn: document.getElementById('profileModalCloseBtn'),
        cancelBtn: document.getElementById('profileModalCancelBtn'),
        pendingOfferStatus: document.getElementById('profile-pending-offer-status'), // Display pending offer details here
    },
    // Trade History Modal Elements
    tradeHistory: {
        modal: document.getElementById('tradeHistoryModal'),
        closeBtn: document.getElementById('closeTradeHistoryModal'),
        closeBtnFooter: document.getElementById('closeTradeHistoryBtn'),
        loading: document.getElementById('tradeHistoryLoading'),
        table: document.getElementById('tradeHistoryTable'),
        tableBody: document.getElementById('tradeHistoryTableBody'),
        emptyMessage: document.getElementById('emptyTradeHistory'),
        pendingSection: document.getElementById('pendingTradesSection'),
        pendingList: document.getElementById('pendingTradesList'),
    },
    // Jackpot Display
    jackpot: {
        potValue: document.getElementById('potValue'),
        timerValue: document.getElementById('timerValue'),
        timerForeground: document.querySelector('.timer-foreground'), // SVG Circle
        participantCount: document.getElementById('participantCount'),
        participantsContainer: document.getElementById('itemsContainer'), // Vertical list container
        emptyPotMessage: document.getElementById('emptyPotMessage'),
        jackpotHeader: document.getElementById('jackpotHeader'), // Container for value/timer/stats
    },
    // Deposit Modal & Inventory
    deposit: {
        showDepositModalButton: document.getElementById('showDepositModal'),
        depositModal: document.getElementById('depositModal'),
        closeDepositModalButton: document.getElementById('closeDepositModal'),
        depositButton: document.getElementById('depositButton'), // The actual "Request Deposit Offer" button inside modal
        inventoryItemsContainer: document.getElementById('inventory-items'),
        selectedItemsContainer: document.getElementById('selectedItems'),
        totalValueDisplay: document.getElementById('totalValue'),
        inventoryLoadingIndicator: document.getElementById('inventory-loading'),
        acceptDepositOfferBtn: document.getElementById('acceptDepositOfferBtn'), // Button to link to Steam offer
        depositStatusText: document.getElementById('depositStatusText'), // Text to show status/errors/offer link prompt
    },
    // Roulette Animation Elements
    roulette: {
        inlineRouletteContainer: document.getElementById('inlineRoulette'), // Main container shown during spin
        rouletteTrack: document.getElementById('rouletteTrack'), // The horizontally scrolling element
        winnerInfoBox: document.getElementById('winnerInfo'), // Box showing winner details after spin
        winnerAvatar: document.getElementById('winnerAvatar'),
        winnerName: document.getElementById('winnerName'),
        winnerDeposit: document.getElementById('winnerDeposit'), // Displays winner's deposited value
        winnerChance: document.getElementById('winnerChance'), // Displays winner's chance
        returnToJackpotButton: document.getElementById('returnToJackpot'), // Optional button
        confettiContainer: document.getElementById('confettiContainer'), // For confetti effect
    },
    // Audio Elements
    audio: {
        spinSound: document.getElementById('spinSound'),
        depositSound: document.getElementById('depositSound')
    },
    // Provably Fair Elements
    provablyFair: {
        verifyButton: document.getElementById('verify-btn'),
        roundsTableBody: document.getElementById('rounds-table-body'),
        roundsPagination: document.getElementById('rounds-pagination'),
        roundIdInput: document.getElementById('round-id'),
        serverSeedInput: document.getElementById('server-seed'),
        clientSeedInput: document.getElementById('client-seed'),
        verificationResultDisplay: document.getElementById('verification-result'),
        verificationSection: document.getElementById('provably-fair-verification'), // Section for scrolling
    },
    // Age Verification Modal
    ageVerification: {
        modal: document.getElementById('ageVerificationModal'),
        checkbox: document.getElementById('agreeCheckbox'),
        agreeButton: document.getElementById('agreeButton'),
    },
    // General UI
    notificationBar: document.getElementById('notification-bar'), // Add this div to your HTML for notifications
};

// --- Application State ---
let currentUser = null; // Stores logged-in user data
let currentRound = null; // Stores data about the current jackpot round
let selectedItemsList = []; // Items selected in the deposit modal
let userInventory = []; // User's inventory items fetched from backend
let isSpinning = false; // Tracks if the roulette animation is currently active
let timerActive = false; // Tracks if the client-side countdown interval is running
let roundTimer = null; // Holds the interval ID for the client-side timer
let animationFrameId = null; // Holds the ID for the roulette animation frame request
let userColorMap = new Map(); // Maps userId to a color from the palette for consistency
let notificationTimeout = null; // Timeout ID for hiding the notification bar
let spinStartTime = 0; // Tracks start of spin animation
let currentDepositOfferURL = null; // Store the URL for the accept button
let tradeHistory = []; // Store the user's trade history locally
let pendingTrades = []; // Store pending trades separately for quick accessRetryIcontinueEditLet me continue with the main.js file:
javascript// --- Helper Functions ---

/**
 * Displays a modal dialog.
 * @param {HTMLElement} modalElement - The modal element to show.
 */
function showModal(modalElement) {
    if (modalElement) modalElement.style.display = 'flex';
}

/**
 * Hides a modal dialog.
 * @param {HTMLElement} modalElement - The modal element to hide.
 */
function hideModal(modalElement) {
    if (modalElement) modalElement.style.display = 'none';
    // Reset deposit modal state when hiding
    if (modalElement === DOMElements.deposit.depositModal) {
        resetDepositModalUI();
    }
}

/**
 * Shows a specific page section and hides others. Updates navigation link styles.
 * @param {HTMLElement|string} pageElement - The page element or ID to display.
 */
function showPage(pageElement) {
    // Allow passing either element or ID string
    const pageToShow = typeof pageElement === 'string' 
        ? document.getElementById(pageElement) 
        : pageElement;
        
    if (!pageToShow) {
        console.error(`Page element not found:`, pageElement);
        return;
    }

    const pageId = pageToShow.id;

    // Hide all page containers
    Object.values(DOMElements.pages).forEach(page => {
        if (page) page.style.display = 'none';
    });

    // Show the selected page container
    pageToShow.style.display = 'block';

    // Update active state on navigation links
    document.querySelectorAll('.main-nav a, .secondary-nav a, .primary-nav a')
        .forEach(link => link?.classList.remove('active'));

    // Find the corresponding link element to activate
    let activeLink = null;
    switch (pageId) {
        case 'home-page': activeLink = DOMElements.nav.homeLink; break;
        case 'about-page': activeLink = DOMElements.nav.aboutLink; break;
        case 'tos-page': activeLink = DOMElements.nav.tosLink; break;
        case 'faq-page': activeLink = DOMElements.nav.faqLink; break;
        case 'fair-page': activeLink = DOMElements.nav.fairLink; break;
    }
    if (activeLink) activeLink.classList.add('active');

    // Load round history if navigating to the Provably Fair page
    if (pageId === 'fair-page') {
        loadPastRounds(1); // Always start with page 1 when navigating to this page
    }
}

/**
 * Assigns and retrieves a consistent color for a given user ID.
 * Cycles through the COLOR_PALETTE.
 * @param {string} userId - The ID of the user.
 * @returns {string} The hex color code for the user.
 */
function getUserColor(userId) {
    if (!userId) return '#cccccc'; // Return fallback if no ID
    if (!userColorMap.has(userId)) {
        const colorIndex = userColorMap.size % COLOR_PALETTE.length;
        userColorMap.set(userId, COLOR_PALETTE[colorIndex]);
    }
    return userColorMap.get(userId);
}

/**
 * Displays a non-blocking notification message.
 * Uses the notificationBar element defined in DOMElements.
 * Allows HTML content for links (sanitized on backend).
 * @param {string} message - The message to display (can be HTML).
 * @param {string} type - 'success', 'error', 'warning' or 'info'. Default 'info'.
 * @param {number} duration - How long to show the message (ms). Default from CONFIG.
 */
function showNotification(message, type = 'info', duration = CONFIG.NOTIFICATION_DURATION) {
    if (!DOMElements.notificationBar) {
        console.warn("Notification bar element (#notification-bar) not found. Using console.log as fallback.");
        console.log(`[${type.toUpperCase()}] ${message}`);
        return;
    }

    const bar = DOMElements.notificationBar;
    // Clear any existing timeout to prevent premature hiding
    if (notificationTimeout) {
        clearTimeout(notificationTimeout);
        notificationTimeout = null;
    }

    // Sanitize message if contains HTML (basic client-side protection)
    const sanitizedMessage = message.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    bar.innerHTML = sanitizedMessage;
    
    // Remove previous type classes and add the new one
    bar.className = 'notification-bar'; // Reset classes
    bar.classList.add(type); // Add the type class for styling
    bar.classList.add('show'); // Add 'show' class to trigger CSS transition/animation

    // Set a timeout to hide the notification
    if (duration > 0) {
        notificationTimeout = setTimeout(() => {
            bar.classList.remove('show');
            notificationTimeout = null;
        }, duration);
    }
}

/**
 * Shuffles an array in place using the Fisher-Yates algorithm.
 * @param {Array} array - The array to shuffle.
 * @returns {Array} The shuffled array.
 */
function shuffleArray(array) {
    let currentIndex = array.length, randomIndex;
    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
}

/**
 * Safely parses a value as a number, returning a default if invalid.
 * @param {*} value - The value to parse
 * @param {number} defaultValue - The default value to return if parsing fails
 * @returns {number} The parsed number or default value
 */
function safeParseNumber(value, defaultValue = 0) {
    if (value === null || value === undefined || value === '') return defaultValue;
    const num = Number(value);
    return isNaN(num) ? defaultValue : num;
}

/**
 * Formats a number as currency with fixed decimal places.
 * @param {number} value - The value to format
 * @param {number} decimals - Number of decimal places (default 2)
 * @returns {string} Formatted currency string
 */
function formatCurrency(value, decimals = 2) {
    const num = safeParseNumber(value, 0);
    return `$${num.toFixed(decimals)}`;
}

/**
 * Sanitizes and encodes HTML content for safe insertion.
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized string
 */
function sanitizeHTML(str) {
    if (!str) return '';
    return str
        .toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// --- Animation Easing Functions ---
function easeOutAnimation(t) {
    const clampedT = Math.max(0, Math.min(1, t));
    return 1 - Math.pow(1 - clampedT, CONFIG.EASE_OUT_POWER);
}

function calculateBounce(t) {
    if (!CONFIG.BOUNCE_ENABLED) return 0;
    const clampedT = Math.max(0, Math.min(1, t));
    const decay = Math.exp(-clampedT / CONFIG.BOUNCE_DAMPING);
    const oscillations = Math.sin(clampedT * Math.PI * 2 * CONFIG.BOUNCE_FREQUENCY);
    return -decay * oscillations;
}

// --- Color Utility Functions --- (Used for Confetti and Visual Elements)
function getComplementaryColor(hex) {
    hex = String(hex).replace('#', '');
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);
    r = 255 - r; g = 255 - g; b = 255 - b;
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function lightenColor(hex, percent) {
    hex = String(hex).replace('#', '');
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);
    r = Math.min(255, Math.floor(r + (255 - r) * (percent / 100)));
    g = Math.min(255, Math.floor(g + (255 - g) * (percent / 100)));
    b = Math.min(255, Math.floor(b + (255 - b) * (percent / 100)));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function darkenColor(hex, percent) {
    hex = String(hex).replace('#', '');
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);
    r = Math.max(0, Math.floor(r * (1 - percent / 100)));
    g = Math.max(0, Math.floor(g * (1 - percent / 100)));
    b = Math.max(0, Math.floor(b * (1 - percent / 100)));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// --- Date Format Utility Function ---
/**
 * Formats a date string or timestamp into a readable format
 * @param {string|number|Date} dateInput - Date string, timestamp, or Date object
 * @returns {string} Formatted date string
 */
function formatDate(dateInput) {
    if (!dateInput) return 'N/A';

    try {
        const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
        if (isNaN(date.getTime())) return 'Invalid Date';

        return date.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
    } catch (e) {
        console.error("Date formatting error:", e);
        return 'Error';
    }
}

/**
 * Safe fetch wrapper with error handling, timeouts, and CSRF protection.
 * @param {string} url - The URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} [timeout=10000] - Timeout in milliseconds
 * @returns {Promise} - Resolves with response or rejects with error
 */
async function safeFetch(url, options = {}, timeout = 10000) {
    // Initialize default headers if not provided
    options.headers = options.headers || {};
    
    // Add CSRF token for non-GET requests if available
    if (options.method && options.method !== 'GET' && CONFIG.CSRF_TOKEN) {
        options.headers['X-CSRF-Token'] = CONFIG.CSRF_TOKEN;
    }
    
    // Add default content type for JSON requests
    if (options.body && !options.headers['Content-Type'] && 
        (typeof options.body === 'object' || options.body.startsWith('{'))) {
        options.headers['Content-Type'] = 'application/json';
    }

    // Set up timeout controller
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    options.signal = controller.signal;

    try {
        const response = await fetch(url, options);
        clearTimeout(timeoutId);
        
        // Check for HTTP errors
        if (!response.ok) {
            const contentType = response.headers.get('content-type');
            let errorMessage = `HTTP error ${response.status}`;
            
            // Try to parse JSON error if available
            if (contentType && contentType.includes('application/json')) {
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.error || errorMessage;
                } catch (e) {
                    // Fall back to status text if JSON parsing fails
                    errorMessage = response.statusText || errorMessage;
                }
            }
            
            throw new Error(errorMessage);
        }
        
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        
        // Customize abort error message
        if (error.name === 'AbortError') {
            throw new Error(`Request to ${url} timed out after ${timeout}ms`);
        }
        
        throw error;
    }
}

// --- Logout Function ---
/**
 * Handles the user logout process by calling the backend.
 */
async function handleLogout() {
    console.log("Attempting logout...");
    
    try {
        const response = await safeFetch('/logout', {
            method: 'POST',
        });

        const result = await response.json();
        
        if (!result.success) {
            throw new Error(result.error || 'Logout unsuccessful according to server.');
        }

        console.log('Logout successful.');
        currentUser = null; // Clear local user state
        pendingTrades = []; // Clear pending trades
        tradeHistory = []; // Clear trade history
        updateUserUI(); // Update header to show login button
        updateDepositButtonState(); // Update deposit button state
        showNotification('You have been successfully signed out.', 'success');
    } catch (error) {
        console.error('Logout Error:', error);
        showNotification(`Logout failed: ${error.message}`, 'error');
    } finally {
        // Ensure dropdown is closed after attempt
        const { userDropdownMenu, userProfile } = DOMElements.user;
        if (userDropdownMenu) {
            userDropdownMenu.style.display = 'none';
            userProfile?.setAttribute('aria-expanded', 'false');
            userProfile?.classList.remove('open');
        }
    }
}

/** Resets the deposit modal UI to its initial state */
function resetDepositModalUI() {
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit;
    if (depositButton) {
        depositButton.disabled = selectedItemsList.length === 0; // Re-enable based on selection
        depositButton.style.display = 'inline-block';
        depositButton.textContent = 'Request Deposit Offer';
    }
    if (acceptDepositOfferBtn) {
        acceptDepositOfferBtn.style.display = 'none';
        acceptDepositOfferBtn.disabled = true; // Disable until URL is confirmed
    }
    if (depositStatusText) {
        depositStatusText.textContent = ''; // Clear status text
        depositStatusText.className = 'deposit-status-text'; // Reset class
    }
    currentDepositOfferURL = null; // Clear state variable
}
Let me continue with the trade history and user interface functionality:
javascript// --- Trade History Functions ---

/**
 * Fetches the user's trade history from the backend
 */
async function loadTradeHistory() {
    const { loading, table, tableBody, emptyMessage, modal, pendingSection, pendingList } = DOMElements.tradeHistory;

    if (!loading || !table || !tableBody || !emptyMessage || !modal) {
        console.error("Trade history DOM elements missing");
        return;
    }

    if (!currentUser) {
        console.warn("No user logged in to fetch trade history");
        showNotification("Please log in to view trade history", "error");
        hideModal(modal);
        return;
    }

    // Reset and show loading state
    tableBody.innerHTML = '';
    emptyMessage.style.display = 'none';
    table.style.display = 'none';
    if (pendingSection) pendingSection.style.display = 'none';
    loading.style.display = 'flex';

    try {
        // Endpoint could be /api/trades or /api/user/trades
        const response = await safeFetch('/api/trades', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        // Hide loading spinner
        loading.style.display = 'none';

        if (!data.trades || !Array.isArray(data.trades)) {
            throw new Error("Invalid trade history data received from server.");
        }

        if (data.trades.length === 0) {
            // Show empty message
            emptyMessage.style.display = 'block';
            tradeHistory = []; // Ensure local copy is empty
            pendingTrades = []; // Clear pending trades
            return;
        }

        // Store trade history in memory
        tradeHistory = data.trades;
        
        // Filter out pending winnings trades for quick access
        pendingTrades = tradeHistory.filter(trade => 
            trade.status === 'pending' && 
            trade.type === 'winnings'
        );

        // Show main history table
        table.style.display = 'table';
        populateTradeHistoryTable(tradeHistory);
        
        // Display pending trades section if we have any
        if (pendingTrades.length > 0 && pendingSection && pendingList) {
            pendingSection.style.display = 'block';
            populatePendingTradesList(pendingTrades);
        }

    } catch (error) {
        loading.style.display = 'none';
        console.error("Failed to load trade history:", error);
        showNotification(`Error loading trade history: ${error.message}`, "error");

        // Show an error message in the table body
        tableBody.innerHTML = `
            <tr>
                <td colspan="7" class="error-message">
                    Failed to load trade history. Please try again later.
                </td>
            </tr>
        `;
        table.style.display = 'table'; // Show table even with error message
    }
}

/**
 * Populates the trade history table with data
 * @param {Array} trades - Array of trade objects
 */
function populateTradeHistoryTable(trades) {
    const tableBody = DOMElements.tradeHistory.tableBody;
    if (!tableBody) return;

    tableBody.innerHTML = ''; // Clear existing rows

    if (!trades || trades.length === 0) {
        // If trades array is empty after attempting to populate, show empty message
        if (DOMElements.tradeHistory.table) DOMElements.tradeHistory.table.style.display = 'none';
        if (DOMElements.tradeHistory.emptyMessage) DOMElements.tradeHistory.emptyMessage.style.display = 'block';
        return;
    }

    // Ensure table is visible and empty message is hidden if we have trades
    if (DOMElements.tradeHistory.table) DOMElements.tradeHistory.table.style.display = 'table';
    if (DOMElements.tradeHistory.emptyMessage) DOMElements.tradeHistory.emptyMessage.style.display = 'none';

    trades.forEach(trade => {
        const row = document.createElement('tr');

        // Get status class for styling
        const statusClass = getTradeStatusClass(trade.status);

        // Format items count and value
        const itemsText = trade.items ? `${trade.items.length} item${trade.items.length !== 1 ? 's' : ''}` : 'N/A';
        const valueText = typeof trade.totalValue === 'number' ? formatCurrency(trade.totalValue) : 'N/A';

        row.innerHTML = `
            <td>${formatDate(trade.createdAt)}</td>
            <td>${trade.roundId ? '#' + trade.roundId : 'N/A'}</td>
            <td>${sanitizeHTML(trade.type === 'deposit' ? 'Deposit' : trade.type === 'winnings' ? 'Winnings' : (trade.type || 'N/A'))}</td>
            <td>${itemsText}</td>
            <td>${valueText}</td>
            <td><span class="status-badge status-${statusClass}">${formatTradeStatus(trade.status)}</span></td>
            <td class="trade-actions">
                ${trade.offerId && trade.status === 'pending' ?
                    `<button class="btn btn-small btn-accept-offer" data-offer-id="${sanitizeHTML(trade.offerId)}">View Offer</button>` :
                    trade.status === 'accepted' ? `<span class="trade-history-status success">Completed</span>` : ''}
            </td>
        `;

        // Add event listeners to action buttons
        const viewOfferBtn = row.querySelector('.btn-accept-offer');
        if (viewOfferBtn) {
            viewOfferBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const offerId = viewOfferBtn.dataset.offerId;
                openSteamTradeOffer(offerId);
            });
        }

        tableBody.appendChild(row);
    });
}

/**
 * Opens a Steam trade offer URL in a new tab
 * @param {string} offerId - The trade offer ID
 */
function openSteamTradeOffer(offerId) {
    if (!offerId) {
        console.error("Cannot open trade offer: Missing offer ID");
        return;
    }
    
    const offerUrl = `https://steamcommunity.com/tradeoffer/${offerId}/`;
    window.open(offerUrl, '_blank', 'noopener,noreferrer');
    
    // Optionally show a notification
    showNotification(`Opening Steam trade offer #${offerId} in a new tab`, 'info', 3000);
}

/**
 * Populates the pending trades section with pending winning trades
 * @param {Array} pendingTrades - Array of pending winning trade objects
 */
function populatePendingTradesList(pendingTrades) {
    const container = DOMElements.tradeHistory.pendingList;
    if (!container) return;
    
    container.innerHTML = ''; // Clear existing content
    
    // Limit the number of trades displayed
    const tradesToShow = pendingTrades.slice(0, CONFIG.MAX_PENDING_TRADE_DISPLAY);
    
    if (tradesToShow.length === 0) {
        container.innerHTML = '<p class="empty-trades-message">No pending winning offers.</p>';
        return;
    }
    
    tradesToShow.forEach(trade => {
        const tradeEl = document.createElement('div');
        tradeEl.className = 'pending-trade-item';
        
        const roundText = trade.roundId ? `Round #${trade.roundId}` : 'Unknown Round';
        const valueText = typeof trade.totalValue === 'number' ? formatCurrency(trade.totalValue) : 'N/A';
        const dateText = formatDate(trade.createdAt);
        
        tradeEl.innerHTML = `
            <div class="pending-trade-info">
                <div class="pending-trade-title">${sanitizeHTML(roundText)} Winnings</div>
                <div class="pending-trade-details">
                    <span class="pending-trade-value">${valueText}</span>
                    <span class="pending-trade-date">${dateText}</span>
                </div>
            </div>
            <button class="btn btn-success btn-accept-pending" data-offer-id="${sanitizeHTML(trade.offerId)}">
                Accept on Steam
            </button>
        `;
        
        // Add event listener to accept button
        const acceptBtn = tradeEl.querySelector('.btn-accept-pending');
        if (acceptBtn) {
            acceptBtn.addEventListener('click', (e) => {
                e.preventDefault();
                openSteamTradeOffer(trade.offerId);
            });
        }
        
        container.appendChild(tradeEl);
    });
    
    // If there are more trades than we're showing, add a message
    if (pendingTrades.length > CONFIG.MAX_PENDING_TRADE_DISPLAY) {
        const moreTradesEl = document.createElement('div');
        moreTradesEl.className = 'more-trades-info';
        moreTradesEl.textContent = `+ ${pendingTrades.length - CONFIG.MAX_PENDING_TRADE_DISPLAY} more pending offers`;
        container.appendChild(moreTradesEl);
    }
}

/**
 * Returns appropriate CSS class for trade status
 * @param {string} status - Trade status
 * @returns {string} CSS class
 */
function getTradeStatusClass(status) {
    if (!status) return 'info';
    
    switch (status.toLowerCase()) {
        case 'pending':
        case 'sent':
            return 'pending';
        case 'accepted':
        case 'complete':
            return 'accepted';
        case 'declined':
        case 'canceled':
            return 'declined';
        case 'expired':
            return 'expired';
        case 'error':
            return 'error';
        default:
            return 'info';
    }
}

/**
 * Formats trade status text for display
 * @param {string} status - Trade status
 * @returns {string} Formatted status text
 */
function formatTradeStatus(status) {
    if (!status) return 'N/A';
    
    switch (status.toLowerCase()) {
        case 'pending': return 'Pending';
        case 'sent': return 'Sent';
        case 'accepted': return 'Accepted';
        case 'complete': return 'Complete';
        case 'declined': return 'Declined';
        case 'expired': return 'Expired';
        case 'canceled': return 'Canceled';
        case 'error': return 'Error';
        default: 
            // Capitalize first letter of unknown status
            return status.charAt(0).toUpperCase() + status.slice(1);
    }
}

/**
 * Updates the trade status in the local trade history
 * @param {string} offerId - The trade offer ID
 * @param {string} newStatus - The new status
 */
function updateTradeStatus(offerId, newStatus) {
    if (!offerId || !newStatus) return false;
    
    let updated = false;
    
    // Update in main trade history
    const tradeIndex = tradeHistory.findIndex(t => t.offerId === offerId);
    if (tradeIndex !== -1) {
        tradeHistory[tradeIndex].status = newStatus;
        tradeHistory[tradeIndex].updatedAt = new Date().toISOString();
        updated = true;
    }
    
    // Update in pending trades if applicable
    if (newStatus !== 'pending') {
        // Remove from pending trades if status changed from pending
        pendingTrades = pendingTrades.filter(t => t.offerId !== offerId);
    }
    
    return updated;
}RetryIcontinueEditLet me continue with the main.js file focusing on the core application logic:
javascript// --- Core Application Logic ---

/**
 * Updates the enabled/disabled state and tooltip of the main deposit button
 * based on current user status, round status, limits, and timer.
 */
function updateDepositButtonState() {
    const button = DOMElements.deposit.showDepositModalButton;
    if (!button) return;

    let disabled = false;
    let title = 'Deposit Rust skins into the pot'; // Default tooltip

    if (!currentUser) {
        disabled = true;
        title = 'Log in to deposit';
    } else if (currentUser.pendingDepositOfferId) { // Check for pending offer
        disabled = true;
        title = `Accept or cancel your pending deposit offer first (Offer ID: ${currentUser.pendingDepositOfferId}). Check profile or Steam.`;
    } else if (!currentUser.tradeUrl) { // Check if trade URL is set
        disabled = true;
        title = 'Set your Steam Trade URL in your profile to deposit';
    } else if (isSpinning) {
        disabled = true;
        title = 'Deposits closed during winner selection';
    } else if (!currentRound || currentRound.status !== 'active') {
        disabled = true;
        title = 'Deposits are currently closed';
        if (currentRound) {
            switch (currentRound.status) {
                case 'rolling': title = 'Deposits closed during winner selection'; break;
                case 'completed':
                case 'error': title = 'Deposits closed (Round ended)'; break;
                case 'pending': title = 'Deposits closed (Waiting for round)'; break;
            }
        }
    } else if (currentRound.participants && currentRound.participants.length >= CONFIG.MAX_PARTICIPANTS_DISPLAY) {
        disabled = true;
        title = `Participant limit (${CONFIG.MAX_PARTICIPANTS_DISPLAY}) reached`;
    } else if (currentRound.items && currentRound.items.length >= CONFIG.MAX_ITEMS_PER_POT_FRONTEND) {
        disabled = true;
        title = `Pot item limit (${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}) reached`;
    } else if (timerActive && currentRound.timeLeft !== undefined && currentRound.timeLeft <= 0) {
        disabled = true;
        title = 'Deposits closed (Round ending)';
    }

    button.disabled = disabled;
    button.title = title;
    button.classList.toggle('deposit-disabled', disabled); // Class for styling
}

/**
 * Fetches the user's login status from the backend API.
 */
async function checkLoginStatus() {
    try {
        const response = await safeFetch('/api/user');
        
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                currentUser = null; // Not logged in
                console.log('User not logged in.');
            } else {
                const errorData = await response.json().catch(() => ({ error: `Server error fetching user: ${response.status}` }));
                throw new Error(errorData.error);
            }
        } else {
            currentUser = await response.json();
            if (!currentUser || typeof currentUser !== 'object') {
                throw new Error("Invalid user data received from server.");
            }
            // Ensure essential fields exist
            if (!currentUser._id || !currentUser.username) {
                throw new Error("Essential user data (_id, username) missing.");
            }
            console.log('User logged in:', currentUser?.username);
            
            // Update trade history if the modal happens to be open after login
            if (DOMElements.tradeHistory.modal.style.display === 'flex') {
                loadTradeHistory();
            }
        }
    } catch (error) {
        console.error('Error checking login status:', error);
        currentUser = null;
        // Don't show notification on initial load failure, just log
    } finally {
        updateUserUI(); // Update profile/login button visibility and dropdown content
        updateDepositButtonState(); // Update deposit button based on login status
    }
}

/**
 * Updates the user profile UI (header, dropdown) and pending offer indicators.
 */
function updateUserUI() {
    // Destructure elements needed for header display and dropdown control
    const { loginButton, userProfile, userAvatar, userName, userDropdownMenu, pendingOfferIndicator } = DOMElements.user;

    if (!loginButton || !userProfile) return; // Essential elements must exist

    if (currentUser) {
        // --- Header Elements (Simplified View) ---
        if (userAvatar) userAvatar.src = currentUser.avatar || '/img/default-avatar.png';
        if (userName) userName.textContent = currentUser.username || 'User';

        loginButton.style.display = 'none';
        userProfile.style.display = 'flex'; // Show the avatar+name element
        userProfile.setAttribute('aria-disabled', 'false'); // Enable profile trigger

        // Show/hide pending offer indicator in header
        if (pendingOfferIndicator) {
            const hasPending = !!currentUser.pendingDepositOfferId || pendingTrades.length > 0;
            pendingOfferIndicator.style.display = hasPending ? 'inline-block' : 'none';
            
            if (hasPending) {
                // Update title based on what type of pending offers exist
                let titleText = '';
                if (currentUser.pendingDepositOfferId) {
                    titleText = `You have a pending deposit offer (#${currentUser.pendingDepositOfferId})! `;
                }
                if (pendingTrades.length > 0) {
                    titleText += `You have ${pendingTrades.length} pending winning offer${pendingTrades.length !== 1 ? 's' : ''}! `;
                }
                titleText += 'Click your profile to see details.';
                
                pendingOfferIndicator.title = titleText;
                pendingOfferIndicator.classList.add('pulse');
            } else {
                pendingOfferIndicator.classList.remove('pulse');
            }
        }
    } else {
        // --- User Logged Out ---
        loginButton.style.display = 'flex'; // Show login button
        userProfile.style.display = 'none'; // Hide avatar+name element
        userProfile.setAttribute('aria-disabled', 'true'); // Disable profile trigger

        // Ensure dropdown is hidden if user logs out while it's open
        if (userDropdownMenu) userDropdownMenu.style.display = 'none';
        userProfile.setAttribute('aria-expanded', 'false');
        userProfile.classList.remove('open');
        
        if (pendingOfferIndicator) {
            pendingOfferIndicator.style.display = 'none'; // Hide indicator if logged out
            pendingOfferIndicator.classList.remove('pulse');
        }
    }
}

/**
 * Fetches the user's inventory from the backend API and displays it in the deposit modal.
 */
async function loadUserInventory() {
    const { inventoryItemsContainer, selectedItemsContainer, inventoryLoadingIndicator, totalValueDisplay, depositModal } = DOMElements.deposit;
    if (!inventoryItemsContainer || !selectedItemsContainer || !inventoryLoadingIndicator || !totalValueDisplay || !depositModal) {
        console.error("Inventory DOM elements missing.");
        return;
    }

    resetDepositModalUI(); // Ensure buttons/status reset on load

    // Reset selection state
    selectedItemsList = [];
    selectedItemsContainer.innerHTML = '';
    updateTotalValue(); // Resets value display and deposit button state

    inventoryLoadingIndicator.style.display = 'flex';
    inventoryItemsContainer.innerHTML = ''; // Clear previous items

    try {
        const response = await safeFetch('/api/inventory', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        userInventory = await response.json();
        inventoryLoadingIndicator.style.display = 'none';

        if (!Array.isArray(userInventory)) {
            throw new Error('Invalid inventory data received.');
        }

        if (userInventory.length === 0) {
            inventoryItemsContainer.innerHTML = '<p class="empty-inventory-message">Inventory empty or unavailable. Ensure it\'s public on Steam.</p>';
            return;
        }

        displayInventoryItems(); // Display the fetched items
    } catch (error) {
        inventoryLoadingIndicator.style.display = 'none';
        inventoryItemsContainer.innerHTML = `<p class="error-message">Error loading inventory: ${error.message}</p>`;
        console.error('Error loading inventory:', error);
        // Error is shown within the modal, no need for separate notification
    }
}

/**
 * Renders the user's inventory items in the deposit modal.
 */
function displayInventoryItems() {
    const container = DOMElements.deposit.inventoryItemsContainer;
    if (!container) return;
    container.innerHTML = ''; // Clear previous items

    // Sort inventory by price (highest first)
    const sortedInventory = [...userInventory].sort((a, b) => 
        (b.price || 0) - (a.price || 0)
    );

    sortedInventory.forEach(item => {
        // Basic validation of item structure
        if (!item || typeof item.price !== 'number' || isNaN(item.price) ||
            !item.assetId || !item.name || !item.image) {
            console.warn("Skipping invalid inventory item:", item);
            return; // Skip this item
        }

        const itemElement = document.createElement('div');
        itemElement.className = 'inventory-item';
        itemElement.dataset.assetId = item.assetId;
        itemElement.dataset.name = sanitizeHTML(item.name);
        itemElement.dataset.image = item.image;
        itemElement.dataset.price = item.price.toFixed(2);

        itemElement.innerHTML = `
            <img src="${item.image}" alt="${sanitizeHTML(item.name)}" loading="lazy"
                 onerror="this.onerror=null; this.src='/img/default-item.png';">
            <div class="item-details">
                <div class="item-name" title="${sanitizeHTML(item.name)}">${sanitizeHTML(item.name)}</div>
                <div class="item-value">${formatCurrency(item.price)}</div>
            </div>`;

        // Check if item is already selected (e.g., if modal was reopened)
        if (selectedItemsList.some(selected => selected.assetId === item.assetId)) {
            itemElement.classList.add('selected');
        }

        // Add click listener to toggle selection
        itemElement.addEventListener('click', () => toggleItemSelection(itemElement, item));
        container.appendChild(itemElement);
    });
}

/**
 * Toggles the selection state of an inventory item.
 * @param {HTMLElement} element - The DOM element of the item clicked.
 * @param {object} item - The inventory item data object.
 */
function toggleItemSelection(element, item) {
    // Validate item price again before selection
    if (typeof item.price !== 'number' || isNaN(item.price)) {
        console.error("Attempted to select item with invalid price:", item);
        showNotification('Selection Error: Cannot select item with invalid price.', 'error');
        return;
    }

    const assetId = item.assetId;
    const index = selectedItemsList.findIndex(i => i.assetId === assetId);

    if (index === -1) { // If not selected, add it
        // Check selection limit
        if (selectedItemsList.length >= CONFIG.MAX_ITEMS_PER_DEPOSIT) {
            showNotification(`Selection Limit: You can select a maximum of ${CONFIG.MAX_ITEMS_PER_DEPOSIT} items per deposit.`, 'info');
            return;
        }
        selectedItemsList.push(item);
        element.classList.add('selected');
        addSelectedItemElement(item); // Add to the visual selected list
    } else { // If already selected, remove it
        selectedItemsList.splice(index, 1);
        element.classList.remove('selected');
        removeSelectedItemElement(assetId); // Remove from the visual selected list
    }

    updateTotalValue(); // Update total value display
    resetDepositModalUI(); // Reset footer buttons/text when selection changes
}

/**
 * Adds a visual representation of a selected item to the "Selected Items" area.
 * @param {object} item - The item data object.
 */
function addSelectedItemElement(item) {
    const container = DOMElements.deposit.selectedItemsContainer;
    if (!container) return;

    // Validate price
    if (typeof item.price !== 'number' || isNaN(item.price)) {
        console.error("Cannot add selected item element, invalid price:", item);
        return;
    }

    const selectedElement = document.createElement('div');
    // Use the class defined in CSS
    selectedElement.className = 'selected-item-display';
    selectedElement.dataset.assetId = item.assetId;
    selectedElement.innerHTML = `
        <img src="${item.image}" alt="${sanitizeHTML(item.name)}" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-item.png';">
        <div class="item-name" title="${sanitizeHTML(item.name)}">${sanitizeHTML(item.name)}</div>
        <div class="item-value">${formatCurrency(item.price)}</div>
        <button class="remove-item-btn" title="Remove ${sanitizeHTML(item.name)}" data-asset-id="${item.assetId}" aria-label="Remove ${sanitizeHTML(item.name)}">&times;</button>
        `;

    // Add listener to remove button
    selectedElement.querySelector('.remove-item-btn')?.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent event bubbling
        const assetIdToRemove = e.target.dataset.assetId;
        if (assetIdToRemove) {
            removeSelectedItem(assetIdToRemove); // Use helper to remove from logic and UI
            updateTotalValue();
            resetDepositModalUI(); // Reset footer when item is manually removed from selection
        }
    });

    // Add listener to the item itself to allow deselecting by clicking it here too
    selectedElement.addEventListener('click', () => {
        removeSelectedItem(item.assetId);
        updateTotalValue();
        resetDepositModalUI(); // Reset footer when item is manually removed from selection
    });

    container.appendChild(selectedElement);
}

/**
 * Removes the visual representation of an item from the "Selected Items" area.
 * @param {string} assetId - The asset ID of the item to remove.
 */
function removeSelectedItemElement(assetId) {
    const container = DOMElements.deposit.selectedItemsContainer;
    const selectedElement = container?.querySelector(`.selected-item-display[data-asset-id="${assetId}"]`);
    if (selectedElement) selectedElement.remove();
}

/**
 * Removes an item from the selectedItemsList array and updates UI.
 * Called when removing without direct element interaction (e.g., from remove button).
 * @param {string} assetId - The asset ID of the item to remove.
 */
function removeSelectedItem(assetId) {
    selectedItemsList = selectedItemsList.filter(item => item.assetId !== assetId);

    // Deselect in the main inventory view if visible
    const inventoryElement = DOMElements.deposit.inventoryItemsContainer?.querySelector(`.inventory-item[data-asset-id="${assetId}"]`);
    if (inventoryElement) inventoryElement.classList.remove('selected');

    // Remove from the selected items display area
    removeSelectedItemElement(assetId);
}

/**
 * Updates the total value display in the deposit modal and deposit button state.
 */
function updateTotalValue() {
    const { totalValueDisplay, depositButton } = DOMElements.deposit;
    if (!totalValueDisplay) return;

    const total = selectedItemsList.reduce((sum, item) => {
        // Ensure price is valid before adding
        const price = typeof item.price === 'number' && !isNaN(item.price) ? item.price : 0;
        return sum + price;
    }, 0);

    totalValueDisplay.textContent = formatCurrency(total);

    // Update deposit button state (inside modal)
    if (depositButton) {
        depositButton.disabled = selectedItemsList.length === 0;
    }
}
Let me continue with more of the deposit handling and round display functionality:
javascript/**
 * Handles the initial deposit request. Sends selected asset IDs to the backend,
 * expects an offer URL back, and updates the modal UI.
 */
async function requestDepositOffer() {
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit;
    if (!depositButton || !acceptDepositOfferBtn || !depositStatusText) return;

    if (selectedItemsList.length === 0) {
        showNotification('No Items Selected: Please select items first.', 'info');
        return;
    }

    // --- Client-side Pre-checks ---
    let preCheckError = null;
    if (!currentUser) preCheckError = 'Deposit Error: You are not logged in.';
    else if (!currentUser.tradeUrl) preCheckError = 'Deposit Error: Please set your Steam Trade URL in your profile first.';
    else if (currentUser.pendingDepositOfferId) preCheckError = `Deposit Error: You already have a pending offer (#${currentUser.pendingDepositOfferId}). Check your profile or Steam.`;
    else if (!currentRound || currentRound.status !== 'active' || isSpinning) preCheckError = 'Deposit Error: Deposits are currently closed.';
    else {
        const participantsLength = currentRound.participants?.length || 0;
        const isNewParticipant = !currentRound.participants?.some(p => p.user?._id === currentUser?._id);
        if (isNewParticipant && participantsLength >= CONFIG.MAX_PARTICIPANTS_DISPLAY) {
            preCheckError = `Deposit Error: Participant limit (${CONFIG.MAX_PARTICIPANTS_DISPLAY}) reached.`;
        } else {
            const itemsInPot = currentRound.items?.length || 0;
            if (itemsInPot + selectedItemsList.length > CONFIG.MAX_ITEMS_PER_POT_FRONTEND) { 
                const slotsLeft = CONFIG.MAX_ITEMS_PER_POT_FRONTEND - itemsInPot; 
                preCheckError = `Deposit Error: Pot item limit would be exceeded (Max ${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}). Only ${slotsLeft} slot${slotsLeft !== 1 ? 's' : ''} left.`; 
            }
        }
    }

    if (preCheckError) {
        showNotification(preCheckError, 'error', 6000);
        if (preCheckError.includes('pending offer') && DOMElements.profileModal.modal) { 
            populateProfileModal(); 
            showModal(DOMElements.profileModal.modal); 
        }
        return;
    }
    // --- End Pre-checks ---

    depositButton.disabled = true;
    depositButton.textContent = 'Requesting...';
    acceptDepositOfferBtn.style.display = 'none';
    depositStatusText.textContent = 'Creating deposit offer... Please wait.';
    depositStatusText.className = 'deposit-status-text info';

    try {
        const assetIds = selectedItemsList.map(item => item.assetId);
        console.log("Requesting deposit offer for assetIds:", assetIds);

        const response = await safeFetch('/api/deposit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetIds }),
        });

        const result = await response.json();

        if (!response.ok) {
            // Handle specific 409 conflict (pending offer exists) gracefully
            if (response.status === 409 && result.offerURL && result.offerId) {
                console.warn("User already has a pending offer (backend confirmed):", result.offerId);
                depositStatusText.textContent = `You already have a pending offer! Click 'Accept on Steam' to view it.`;
                depositStatusText.className = 'deposit-status-text warning';
                currentDepositOfferURL = result.offerURL; // Store URL for the button
                acceptDepositOfferBtn.style.display = 'inline-block';
                acceptDepositOfferBtn.disabled = false;
                depositButton.style.display = 'none';
                // Update user state and UI indicators if they were somehow out of sync
                if (currentUser && currentUser.pendingDepositOfferId !== result.offerId) { 
                    currentUser.pendingDepositOfferId = result.offerId; 
                    updateUserUI(); 
                    updateDepositButtonState(); 
                }
                return; // Exit successfully, showing the existing offer button
            } else {
                // Throw other errors
                throw new Error(result.error || `Failed to create offer (${response.status})`);
            }
        }

        // Check success response structure
        if (!result.success || !result.offerURL || !result.offerId) {
            throw new Error(result.error || 'Backend did not return a valid offer URL and ID.');
        }

        // --- Success ---
        console.log("Deposit offer created:", result.offerId);
        depositStatusText.textContent = "Offer created! Click 'Accept on Steam' below to complete. The offer will appear shortly.";
        depositStatusText.className = 'deposit-status-text success';
        currentDepositOfferURL = result.offerURL; // Store URL for the button
        depositButton.style.display = 'none'; // Hide request button
        acceptDepositOfferBtn.style.display = 'inline-block'; // Show accept button
        acceptDepositOfferBtn.disabled = false;
        
        if(currentUser) { 
            currentUser.pendingDepositOfferId = result.offerId; 
            updateUserUI(); 
            updateDepositButtonState(); 
        } // Update user state and global UI

        // Add this pending trade to local trade history (optimistic update)
        const newTrade = {
            offerId: result.offerId,
            type: 'deposit',
            items: [...selectedItemsList], // Store a copy of the items
            totalValue: selectedItemsList.reduce((sum, item) => sum + (item.price || 0), 0),
            status: 'pending', // Initial status
            roundId: currentRound?.roundId,
            createdAt: new Date().toISOString()
        };
        
        tradeHistory.unshift(newTrade); // Add to beginning of array
        
        // If trade history modal is open, refresh it
        if (DOMElements.tradeHistory.modal.style.display === 'flex') {
            populateTradeHistoryTable(tradeHistory);
        }

    } catch (error) {
        console.error('Error requesting deposit offer:', error);
        depositStatusText.textContent = `Error: ${error.message}`;
        depositStatusText.className = 'deposit-status-text error';
        resetDepositModalUI();
        
        // Ensure pending offer ID is cleared locally if an error occurred
        if (currentUser && currentUser.pendingDepositOfferId) {
            console.log("Clearing potentially stale pending offer ID due to error.");
            currentUser.pendingDepositOfferId = null; 
            updateUserUI(); 
            updateDepositButtonState();
        }
    }
}

/**
 * Updates the main jackpot header UI elements (Pot Value, Timer Display, Participant Count).
 */
function updateRoundUI() {
    const { potValue, participantCount } = DOMElements.jackpot;
    if (!potValue || !participantCount) {
        console.warn("Pot value or participant count element missing.");
        return; // Exit if elements aren't found
    }

    // Use currentRound state, default to 0 if undefined/null
    const currentTotalValue = currentRound?.totalValue ?? 0;
    const participantNum = currentRound?.participants?.length ?? 0;

    potValue.textContent = formatCurrency(currentTotalValue);
    participantCount.textContent = `${participantNum}/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;

    // Update timer display separately only if timer is NOT already active client-side
    // This prevents overwriting the countdown with potentially stale server data
    if (!timerActive) {
        const timeLeftFromServer = currentRound?.timeLeft ?? CONFIG.ROUND_DURATION;
        updateTimerUI(timeLeftFromServer);
    }
}

/**
 * Updates the timer text display and the SVG circle progress.
 * @param {number} timeLeft - The remaining time in seconds.
 */
function updateTimerUI(timeLeft) {
    const { timerValue, timerForeground } = DOMElements.jackpot;
    if (!timerValue || !timerForeground) return;

    const timeToShow = Math.max(0, Math.round(timeLeft));
    let displayValue = timeToShow.toString();

    // Determine display text based on round status and timer state
    if (isSpinning || (currentRound && currentRound.status === 'rolling')) {
        displayValue = "Rolling";
    } else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'error')) {
        displayValue = "Ended";
    } else if (currentRound && currentRound.status === 'pending') {
        displayValue = "Waiting";
    } else if (currentRound && currentRound.status === 'active') {
        if (currentRound.participants?.length > 0 || timerActive) {
            // Show countdown if participants or timer active
            displayValue = timeToShow.toString();
        } else {
            // No participants and timer not started -> show full duration
            displayValue = CONFIG.ROUND_DURATION.toString();
        }
    } else if (!currentRound) {
        displayValue = "--"; // Default if no round data yet
    } else {
        // Fallback to timeToShow if status is unexpected but time is valid
        displayValue = timeToShow.toString();
    }

    timerValue.textContent = displayValue;
    updateTimerCircle(timeToShow, CONFIG.ROUND_DURATION);

    // Update pulse animation based on ACTIVE timer countdown
    if (timerElement) {
        if (timerActive && timeToShow <= 10 && timeToShow > 0) {
            timerElement.classList.add('urgent-pulse');
            timerElement.classList.remove('timer-pulse');
        } else {
            timerElement.classList.remove('urgent-pulse');
            if (timerActive && timeToShow > 10) {
                timerElement.classList.add('timer-pulse');
            } else {
                timerElement.classList.remove('timer-pulse');
            }
        }
    }
}

/**
 * Updates the stroke-dashoffset of the timer's SVG circle foreground.
 * @param {number} timeLeft - Current time left in seconds.
 * @param {number} totalTime - The total duration of the timer in seconds.
 */
function updateTimerCircle(timeLeft, totalTime) {
    const circle = DOMElements.jackpot.timerForeground;
    if (!circle) return;

    // Check if it's an SVG circle element and has the 'r' attribute
    if (circle instanceof SVGCircleElement && circle.r?.baseVal?.value) {
        const radius = circle.r.baseVal.value;
        const circumference = 2 * Math.PI * radius;
        // Calculate progress, ensure totalTime is not zero to avoid division by zero
        const effectiveTotalTime = Math.max(1, totalTime); // Ensure totalTime is at least 1
        const progress = Math.min(1, Math.max(0, timeLeft / effectiveTotalTime));
        const offset = circumference * (1 - progress);

        circle.style.strokeDasharray = `${circumference}`;
        circle.style.strokeDashoffset = `${Math.max(0, offset)}`; // Ensure offset is non-negative
    }
}

/**
 * Updates the percentage chance display for all participant blocks.
 */
function updateAllParticipantPercentages() {
    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) {
        return; // No participants or round data
    }

    const container = DOMElements.jackpot.participantsContainer;
    if (!container) return;

    const depositBlocks = container.querySelectorAll('.player-deposit-container');
    // Use the definitive total value from the round state
    const currentTotalPotValue = Math.max(0.01, currentRound.totalValue || 0.01);

    depositBlocks.forEach(block => {
        const userId = block.dataset.userId;
        if (!userId) return; // Skip block if no userId found

        // Find the participant data from the currentRound state
        // Use the participant's total value for the round (itemsValue)
        const participantData = currentRound.participants.find(p => 
            p.user?._id === userId || p.user === userId
        ); // Handle potential string ID

        if (!participantData) return; // Skip if participant data not found

        const cumulativeValue = participantData.itemsValue || 0;
        // Calculate percentage based on the participant's cumulative value and the current round total
        const percentage = ((cumulativeValue / currentTotalPotValue) * 100).toFixed(1); // Use 1 decimal place

        // Find the element to update within this block
        const valueElement = block.querySelector('.player-deposit-value');
        if (valueElement) {
            // Determine color
            const userColor = getUserColor(userId); // Get consistent color
            // Update text content and title attribute
            valueElement.textContent = `${formatCurrency(cumulativeValue)} | ${percentage}%`;
            valueElement.title = `Deposited: ${formatCurrency(cumulativeValue)} | Chance: ${percentage}%`;
            valueElement.style.color = userColor; // Apply user color
        }
    });
}RetryIcontinueEditLet me continue with implementing the display of deposits and winner animation functionality:
javascript/**
 * Displays the latest deposit as a new block at the TOP of the participants container.
 * Calculates and includes the initial percentage chance based on the latest round state.
 * @param {object} data - Participant update data { userId, username, avatar, itemsValue, depositedItems }.
 */
function displayLatestDeposit(data) {
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (!container) return;

    // --- Input Data Validation ---
    const userId = data.userId || data.user?._id; // Prefer direct userId if available
    if (!userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue)) {
        console.error("Invalid data passed to displayLatestDeposit:", data);
        return;
    }
    const username = data.username || data.user?.username || 'Unknown User';
    const avatar = data.avatar || data.user?.avatar || '/img/default-avatar.png';
    const valueThisDeposit = data.itemsValue; // Value of *this* specific deposit
    const items = data.depositedItems || []; // Items in *this* deposit
    const userColor = getUserColor(userId);
    // --- End Validation ---

    // --->>> Play Deposit Sound <<<---
    const depositSfx = DOMElements.audio.depositSound;
    if (depositSfx) {
        depositSfx.volume = 0.6; // Adjust volume (0.0 to 1.0) as needed
        depositSfx.currentTime = 0; // Ensure it plays from the start if triggered quickly
        depositSfx.play().catch(e => console.warn("Deposit sound play interrupted or failed:", e)); // Use warn for potential overlaps
    }
    // --->>> End Deposit Sound <<<---

    // --- Calculate Percentage for Display ---
    // Find the participant's LATEST cumulative data from currentRound state
    const participantData = currentRound?.participants?.find(p => (p.user?._id === userId || p.user === userId));
    // Use the LATEST cumulative value for this participant from the round state
    const cumulativeValue = participantData ? (participantData.itemsValue || 0) : valueThisDeposit;
    const currentTotalPotValue = Math.max(0.01, currentRound?.totalValue || 0.01); // Use current round total
    const percentage = ((cumulativeValue / currentTotalPotValue) * 100).toFixed(1); // Calculate percentage
    // --- End Percentage Calculation ---

    const depositContainer = document.createElement('div');
    depositContainer.dataset.userId = userId;
    depositContainer.className = 'player-deposit-container player-deposit-new'; // Add class for entry animation

    const depositHeader = document.createElement('div');
    depositHeader.className = 'player-deposit-header';
    // Display the participant's *cumulative* value and calculated percentage
    depositHeader.innerHTML = `
        <img src="${avatar}" alt="${sanitizeHTML(username)}" class="player-avatar" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-avatar.png';" style="border-color: ${userColor};">
        <div class="player-info">
            <div class="player-name" title="${sanitizeHTML(username)}">${sanitizeHTML(username)}</div>
            <div class="player-deposit-value" style="color: ${userColor}" title="Deposited: ${formatCurrency(cumulativeValue)} | Chance: ${percentage}%">
                ${formatCurrency(cumulativeValue)} | ${percentage}%
            </div>
        </div>`;

    const itemsGrid = document.createElement('div');
    itemsGrid.className = 'player-items-grid';

    // Display items from *this* specific deposit
    if (items.length > 0) {
        // Sort items within this deposit by value, descending
        const sortedItems = [...items].sort((a, b) => (b.price || 0) - (a.price || 0));
        // Display up to the configured limit
        const displayItems = sortedItems.slice(0, CONFIG.MAX_ITEMS_PER_DEPOSIT);

        displayItems.forEach(item => {
            // Validate item before displaying
            if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.name || !item.image) {
                console.warn("Skipping invalid item in deposit display:", item);
                return;
            }

            const itemElement = document.createElement('div');
            itemElement.className = 'player-deposit-item';
            itemElement.title = `${sanitizeHTML(item.name)} (${formatCurrency(item.price)})`;
            itemElement.style.borderColor = userColor; // Use the same user color for item border
            // Apply user color to item value as well
            itemElement.innerHTML = `
                <img src="${item.image}" alt="${sanitizeHTML(item.name)}" class="player-deposit-item-image" loading="lazy"
                     onerror="this.onerror=null; this.src='/img/default-item.png';">
                <div class="player-deposit-item-info">
                    <div class="player-deposit-item-name" title="${sanitizeHTML(item.name)}">${sanitizeHTML(item.name)}</div>
                    <div class="player-deposit-item-value" style="color: ${userColor}">${formatCurrency(item.price)}</div>
                </div>`;
            itemsGrid.appendChild(itemElement);
        });

        // Show "+X more" if applicable for this specific deposit
        if (items.length > CONFIG.MAX_ITEMS_PER_DEPOSIT) {
            const moreItems = document.createElement('div');
            moreItems.className = 'player-deposit-item-more';
            moreItems.style.color = userColor; // Apply user color
            moreItems.textContent = `+${items.length - CONFIG.MAX_ITEMS_PER_DEPOSIT} more`;
            itemsGrid.appendChild(moreItems);
        }
    }

    depositContainer.appendChild(depositHeader);
    depositContainer.appendChild(itemsGrid);

    // Insert new deposit block at the top
    if (container.firstChild) {
        container.insertBefore(depositContainer, container.firstChild);
    } else {
        container.appendChild(depositContainer);
    }

    if (emptyMsg) emptyMsg.style.display = 'none'; // Hide empty message

    // Fade-in animation trigger (remove class after short delay)
    setTimeout(() => {
        depositContainer.classList.remove('player-deposit-new');
    }, 100); // Shorter delay, CSS handles the transition time

    // Limit total displayed deposit blocks visually
    const currentDepositBlocks = container.querySelectorAll('.player-deposit-container');
    if (currentDepositBlocks.length > CONFIG.MAX_DISPLAY_DEPOSITS) {
        const blocksToRemoveCount = currentDepositBlocks.length - CONFIG.MAX_DISPLAY_DEPOSITS;
        for (let i = 0; i < blocksToRemoveCount; i++) {
            const oldestBlock = container.querySelector('.player-deposit-container:last-child');
            if (oldestBlock && oldestBlock !== depositContainer) { // Don't remove the one just added
                oldestBlock.style.transition = 'opacity 0.3s ease-out, transform 0.3s ease-out'; // Add transform for slide-out?
                oldestBlock.style.opacity = '0';
                // oldestBlock.style.transform = 'translateX(-20px)'; // Optional slide-out effect
                setTimeout(() => {
                    // Check parentNode before removing, in case structure changed rapidly
                    if (oldestBlock.parentNode === container) {
                        oldestBlock.remove();
                    }
                }, 300); // Remove after fade
            }
        }
    }
}

/**
 * Processes participant updates from the server (when a deposit is confirmed backend-side).
 * Updates the local `currentRound` state FIRST, then calls UI update functions.
 * @param {object} data - Data received from the 'participantUpdated' socket event.
 * Expected: { roundId, userId, username, avatar, itemsValue (value of this deposit),
 * totalValue (new pot total), tickets (user's new total tickets), depositedItems }
 */
function handleNewDeposit(data) {
    // --- Basic data validation ---
    if (!data || !data.roundId || !data.userId ||
        typeof data.itemsValue !== 'number' || isNaN(data.itemsValue) ||
        data.totalValue === undefined || data.tickets === undefined) {
        console.error("Invalid participant update data received:", data);
        return;
    }
    if (!data.depositedItems) data.depositedItems = []; // Ensure depositedItems array exists
    // --- End Validation ---

    // --- Initialize or Check Round State ---
    if (!currentRound) {
        // If we get an update but have no local round, request full data instead of trying to patch.
        console.warn("Handling deposit for non-existent local round. Requesting full data.");
        socket.emit('requestRoundData');
        return;
    } else if (currentRound.roundId !== data.roundId) {
        // Ignore updates for a previous round
        console.warn(`Deposit received for wrong round (${data.roundId}). Current is ${currentRound.roundId}. Ignoring.`);
        return;
    }
    // Ensure arrays exist (should be initialized by 'roundCreated' or 'roundData')
    if (!currentRound.participants) currentRound.participants = [];
    if (!currentRound.items) currentRound.items = [];
    // --- End Round State Check ---

    // --- Check for User's Own Deposit Confirmation ---
    if (currentUser && currentUser._id === data.userId && currentUser.pendingDepositOfferId) {
        console.log(`Deposit processed for user ${currentUser.username}, clearing local pending offer flag.`);
        const confirmedOfferId = currentUser.pendingDepositOfferId; // Store before clearing
        currentUser.pendingDepositOfferId = null; // Clear local flag
        updateUserUI(); // Update header indicator
        updateDepositButtonState(); // Re-enable main deposit button if appropriate

        // Update trade history status if this deposit matches a pending trade offer ID
        if (tradeHistory.length > 0) {
            const tradeIndex = tradeHistory.findIndex(t => t.offerId === confirmedOfferId && t.type === 'deposit');
            if (tradeIndex !== -1) {
                tradeHistory[tradeIndex].status = 'accepted'; // Update status
                // Update items/value if backend didn't provide them initially
                if (!tradeHistory[tradeIndex].items || tradeHistory[tradeIndex].items.length === 0) {
                    tradeHistory[tradeIndex].items = data.depositedItems;
                }
                if (!tradeHistory[tradeIndex].totalValue || tradeHistory[tradeIndex].totalValue === 0) {
                    tradeHistory[tradeIndex].totalValue = data.itemsValue; // Use value from this specific deposit confirmation
                }
                // If trade history modal is open, refresh it
                if (DOMElements.tradeHistory.modal.style.display === 'flex') {
                    populateTradeHistoryTable(tradeHistory);
                }
            }
        }

        // Reset deposit modal if it's open (clear selection, etc.)
        if (DOMElements.deposit.depositModal?.style.display === 'flex') {
            resetDepositModalUI();
            // Clear selection list (logical and visual) as items are now deposited
            selectedItemsList = [];
            if(DOMElements.deposit.selectedItemsContainer) DOMElements.deposit.selectedItemsContainer.innerHTML = '';
            updateTotalValue(); // Reset total value display
            // Deselect items in inventory view
            data.depositedItems.forEach(item => {
                const invItem = DOMElements.deposit.inventoryItemsContainer?.querySelector(`.inventory-item[data-asset-id="${item.assetId}"]`);
                invItem?.classList.remove('selected');
            });
            // Optionally close modal after successful deposit confirmation from backend
            // hideModal(DOMElements.deposit.depositModal);
        }
    }
    // --- End User Deposit Confirmation ---

    // --- Update Local Round State ---
    let participantIndex = currentRound.participants.findIndex(p => 
        p.user?._id === data.userId || p.user === data.userId
    );

    if (participantIndex !== -1) {
        // Update existing participant's total value and tickets
        // Ensure itemsValue is additive based on this deposit's value
        currentRound.participants[participantIndex].itemsValue = 
            (currentRound.participants[participantIndex].itemsValue || 0) + data.itemsValue;
        currentRound.participants[participantIndex].tickets = data.tickets; // Update tickets based on server calculation
        // Update user details if they changed (unlikely but possible)
        currentRound.participants[participantIndex].user = {
            _id: data.userId,
            username: data.username || currentRound.participants[participantIndex].user.username || 'Unknown',
            avatar: data.avatar || currentRound.participants[participantIndex].user.avatar || '/img/default-avatar.png'
        };
    } else {
        // Add new participant
        currentRound.participants.push({
            user: { // Store user info nested
                _id: data.userId,
                username: data.username || 'Unknown User',
                avatar: data.avatar || '/img/default-avatar.png'
            },
            itemsValue: data.itemsValue, // Initial cumulative value for this participant IS this deposit's value
            tickets: data.tickets // Initial tickets for this participant
        });
    }

    // Update the total pot value definitively from the server message
    currentRound.totalValue = data.totalValue;

    // Add the newly deposited items to the round's master item list
    data.depositedItems.forEach(item => {
        if (item && typeof item.price === 'number' && !isNaN(item.price)) {
            currentRound.items.push({ ...item, owner: data.userId }); // Include owner info
        } else {
            console.warn("Skipping invalid item while adding to round master list:", item);
        }
    });
    // --- End Update Local Round State ---

    // --- Update UI Elements (using the updated currentRound state) ---
    updateRoundUI(); // Update header (pot value, participant count)
    displayLatestDeposit(data); // Display the new deposit block (will show calculated percentage based on *updated* state)
    updateAllParticipantPercentages(); // Update percentages for all visible blocks based on *updated* state
    updateDepositButtonState(); // Update deposit button availability

    // Start timer visually if this is the first participant AND round is active
    if (currentRound.status === 'active' &&
        currentRound.participants.length === 1 &&
        !timerActive) {
        console.log("First participant joined. Starting client timer visually.");
        // Use timeLeft from currentRound if available (sync), otherwise default
        startClientTimer(currentRound.timeLeft ?? CONFIG.ROUND_DURATION);
    }
}

/**
 * Updates the participant count display and visibility of the empty pot message.
 * Called primarily after a full state sync or reset.
 */
function updateParticipantsUI() {
    const { participantCount } = DOMElements.jackpot;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    const container = DOMElements.jackpot.participantsContainer;

    if (!participantCount || !emptyMsg || !container) {
        console.error("Participants count/empty message/container elements missing.");
        return;
    }

    const participantNum = currentRound?.participants?.length || 0;
    participantCount.textContent = `${participantNum}/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;

    const hasDepositBlocks = container.querySelector('.player-deposit-container') !== null;

    if (participantNum === 0 && !hasDepositBlocks) {
        emptyMsg.style.display = 'block';
    } else {
        emptyMsg.style.display = 'none';
    }
}

/**
 * Starts the client-side countdown timer interval.
 * @param {number} [initialTime=CONFIG.ROUND_DURATION] - The time to start counting down from (in seconds).
 */
function startClientTimer(initialTime = CONFIG.ROUND_DURATION) {
    const timerDisplay = DOMElements.jackpot.timerValue;
    if (!timerDisplay) return;

    if (roundTimer) clearInterval(roundTimer); // Clear existing timer if any

    let timeLeft = Math.max(0, initialTime);
    console.log(`Starting/Syncing client timer from ${timeLeft}s`);
    timerActive = true;
    updateTimerUI(timeLeft); // Initial UI update
    updateDepositButtonState(); // Update button state

    roundTimer = setInterval(() => {
        if (!timerActive) { // Check if timer should stop (e.g., round rolled)
            clearInterval(roundTimer);
            roundTimer = null;
            console.log("Client timer interval stopped (timerActive is false).");
            return;
        }

        timeLeft--; // Decrement time

        // Update local state optimistically (server is source of truth, but helps UI feel responsive)
        if (currentRound) currentRound.timeLeft = timeLeft;

        updateTimerUI(timeLeft); // Update UI display
        updateDepositButtonState(); // Update button state (might disable when timer is low)

        if (timeLeft <= 0) { // Timer reached zero client-side
            clearInterval(roundTimer);
            roundTimer = null;
            timerActive = false;
            console.log("Client timer reached zero.");
            if (timerDisplay) timerDisplay.textContent = "0"; // Ensure display shows 0
            updateDepositButtonState(); // Update button state (deposits definitely closed)
            // Server should send 'roundRolling' event shortly after this point
        }
    }, 1000);
}
Now let's implement the roulette animation and winner display functionality:
javascript// --- Roulette/Winner Animation Functions ---

/**
 * Creates the visual items (player avatars) for the roulette animation track.
 * Builds a weighted list based on participant tickets or value as fallback.
 */
function createRouletteItems() {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer;
    if (!track || !container) {
        console.error("Roulette track or inline roulette element missing.");
        return;
    }

    track.innerHTML = ''; // Clear previous items
    track.style.transition = 'none';
    track.style.transform = 'translateX(0)'; // Reset position

    // Check for participant data
    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) {
        console.error('No participants data available to create roulette items.');
        track.innerHTML = '<div class="roulette-message">Waiting for participants...</div>';
        return;
    }

    // --- Build the ticket pool for visual representation ---
    let visualPool = [];
    const totalTicketsInRound = currentRound.participants.reduce((sum, p) => sum + (p.tickets || 0), 0);
    const totalValueNonZero = Math.max(0.01, currentRound.totalValue || 0.01);
    const targetVisualBlocks = 150; // Approx number of visual blocks desired

    currentRound.participants.forEach(p => {
        if (!p.user || !p.user._id) {
            console.warn("Skipping participant with missing user data in roulette creation:", p);
            return;
        }

        let blocksForUser = 0;
        if (totalTicketsInRound > 0 && p.tickets > 0) {
            // Normal case: Use ticket percentage
            blocksForUser = Math.max(1, Math.round((p.tickets / totalTicketsInRound) * targetVisualBlocks));
        } else {
            // Fallback: Use value percentage if tickets are zero/invalid
            blocksForUser = Math.max(1, Math.round(((p.itemsValue || 0) / totalValueNonZero) * targetVisualBlocks));
        }
        for (let i = 0; i < blocksForUser; i++) {
            // Push the *full participant object* for easy access later
            visualPool.push(p);
        }
    });
    // --- End Build Visual Pool ---

    if (visualPool.length === 0) {
        console.error("Visual pool calculation resulted in zero items for roulette.");
        track.innerHTML = '<div class="roulette-message">Error building roulette items.</div>';
        return;
    }

    // Shuffle the pool for visual randomness
    visualPool = shuffleArray([...visualPool]);

    // Calculate how many items are needed based on container width and desired spin length
    const rouletteContainer = container.querySelector('.roulette-container'); // Inner container if exists
    const containerWidth = rouletteContainer?.offsetWidth || container.offsetWidth || 1000; // Estimate if needed
    const itemWidthWithMargin = 60 + 10; // Item width (60px) + L/R margin (5px*2) from CSS
    const itemsInView = Math.ceil(containerWidth / itemWidthWithMargin);
    const itemsForSpin = 400; // Number of items to spin past (adjust for speed/duration)
    const totalItemsNeeded = itemsForSpin + (itemsInView * 2); // Ensure enough items for wrap-around feel
    const itemsToCreate = Math.max(totalItemsNeeded, visualPool.length * CONFIG.ROULETTE_REPETITIONS, 500); // Ensure sufficient items

    console.log(`Targeting ${itemsToCreate} roulette items (from ${visualPool.length} base items).`);

    // Create DOM elements
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < itemsToCreate; i++) {
        const participant = visualPool[i % visualPool.length]; // Cycle through shuffled pool
        // Participant object should have user._id, user.avatar, user.username
        if (!participant?.user?._id) {
            console.warn(`Skipping roulette item creation at index ${i} due to invalid participant data.`);
            continue;
        }

        const userId = participant.user._id;
        const userColor = getUserColor(userId);
        const avatar = participant.user.avatar || '/img/default-avatar.png';
        const username = participant.user.username || 'Unknown User'; // Alt text

        const itemElement = document.createElement('div');
        itemElement.className = 'roulette-item';
        itemElement.dataset.userId = userId; // Store ID for lookup
        itemElement.style.borderColor = userColor; // Set border color immediately

        itemElement.innerHTML = `
            <img class="roulette-avatar" src="${avatar}" alt="${sanitizeHTML(username)}" loading="lazy"
                 onerror="this.onerror=null; this.src='/img/default-avatar.png';">`;

        fragment.appendChild(itemElement);
    }

    track.appendChild(fragment);
    console.log(`Created ${track.children.length} DOM items for roulette animation.`);
}

/**
 * Handles the 'roundWinner' or 'roundData' event (if winner known) from the server.
 * Switches view and starts the animation process.
 * @param {object} data - Event data. Should contain { winner: { _id/id, username, avatar }, roundId }
 */
function handleWinnerAnnouncement(data) {
    if (isSpinning) {
        console.warn("Received winner announcement but animation is already spinning.");
        return;
    }

    // Extract winner details and ID robustly
    const winnerDetails = data.winner || currentRound?.winner; // Use event data or stored data
    const winnerId = winnerDetails?.id || winnerDetails?._id; // Allow 'id' or '_id'

    if (!winnerId) {
        console.error("Invalid or missing winner data in announcement:", data);
        resetToJackpotView(); // Reset if winner info is bad
        return;
    }

    // Ensure participant data is available locally before starting spin
    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) {
        console.error("Missing participant data for winner announcement. Cannot start spin immediately.");
        // Optionally request data and retry, but might be too late
        showNotification("Error: Missing data to start winner animation.", "error");
        resetToJackpotView();
        return;
    }

    console.log(`Winner announced: ID ${winnerId}. Preparing roulette...`);

    // Stop client timer if it's running
    if (timerActive) {
        timerActive = false;
        clearInterval(roundTimer);
        roundTimer = null;
        console.log("Stopped client timer due to winner announcement.");
    }
    if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Rolling"; // Update display immediately

    // Switch UI to roulette view
    switchToRouletteView();

    // Start the animation after a short delay to allow UI transition/rendering
    // Pass the full winner object structure expected by startRouletteAnimation
    setTimeout(() => {
        startRouletteAnimation({ winner: winnerDetails, offerId: data.offerId }); // Include offerId if present
    }, 500);

    // Add winning trade to local history if it's the current user and offerId is provided
    if (currentUser && winnerId === currentUser._id && data.offerId) {
        const existingTradeIndex = tradeHistory.findIndex(t => t.offerId === data.offerId);
        if (existingTradeIndex === -1) { // Only add if not already present
            const newTrade = {
                offerId: data.offerId,
                type: 'winnings',
                status: 'pending', // Winnings offers start as pending
                roundId: currentRound?.roundId || data.roundId,
                totalValue: currentRound?.totalValue || 0, // Approximate value
                items: [], // Item details usually unknown until accepted/queried
                createdAt: new Date().toISOString()
            };
            tradeHistory.unshift(newTrade); // Add to beginning of array
            pendingTrades.unshift(newTrade); // Also add to pending trades for quick access
            console.log("Added pending winning trade to local history:", newTrade);

            // If trade history modal is open, refresh it
            if (DOMElements.tradeHistory.modal.style.display === 'flex') {
                populateTradeHistoryTable(tradeHistory);
                populatePendingTradesList(pendingTrades);
            }
            
            // Update pending offer indicator in UI
            updateUserUI();
        } else {
            console.log("Winning trade offer already exists in local history.");
        }
    }
}

/**
 * Switches the UI from the main jackpot display to the roulette animation view.
 */
function switchToRouletteView() {
    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer;
    if (!header || !rouletteContainer) {
        console.error("Missing roulette UI elements for view switch.");
        return;
    }

    header.classList.add('roulette-mode'); // Add class first for layout changes
    rouletteContainer.style.display = 'flex'; // Show roulette container
    rouletteContainer.style.opacity = '0';
    rouletteContainer.style.transform = 'translateY(20px)'; // Start slightly down for fade-in effect

    // Start fade-in transition for roulette container
    requestAnimationFrame(() => { // Use rAF for smoother start
        rouletteContainer.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
        rouletteContainer.style.opacity = '1';
        rouletteContainer.style.transform = 'translateY(0)';
    });

    if (DOMElements.roulette.returnToJackpotButton) {
        DOMElements.roulette.returnToJackpotButton.style.display = 'none'; // Ensure hidden initially
    }
}

/**
 * Starts the roulette spinning animation after items are created.
 * @param {object} data - Object containing { winner: { _id/id, username, avatar } }.
 */
function startRouletteAnimation(data) {
    const winnerDetails = data.winner;
    if (!winnerDetails || (!winnerDetails._id && !winnerDetails.id)) { // Check for ID
        console.error("Invalid winner data passed to startRouletteAnimation.");
        resetToJackpotView();
        return;
    }
    const winnerId = winnerDetails.id || winnerDetails._id; // Use consistent ID

    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
        console.log("Cancelled previous animation frame.");
    }

    isSpinning = true;
    updateDepositButtonState(); // Disable deposit button during spin
    spinStartTime = 0; // Reset spin start time tracker

    if (DOMElements.roulette.winnerInfoBox) DOMElements.roulette.winnerInfoBox.style.display = 'none'; // Hide previous winner info

    clearConfetti(); // Clear any leftover confetti
    createRouletteItems(); // Build the items in the track

    // Find the full participant data for the winner (includes value/percentage)
    const winnerParticipantData = findWinnerFromData(data); // Pass the original data object
    if (!winnerParticipantData) {
        console.error('Could not find full winner details in startRouletteAnimation using ID:', winnerId);
        isSpinning = false;
        updateDepositButtonState();
        resetToJackpotView();
        return;
    }

    console.log('Starting animation for Winner:', winnerParticipantData.user.username);

    // Start Spin Sound
    const sound = DOMElements.audio.spinSound;
    if (sound) {
        sound.volume = 0.7;
        sound.currentTime = 0;
        sound.playbackRate = 1.0;
        sound.play().catch(e => console.error('Error playing spin sound:', e));
    } else {
        console.warn("Spin sound element not found.");
    }

    // Delay slightly to allow items to render before selecting winner element
    setTimeout(() => {
        const track = DOMElements.roulette.rouletteTrack;
        const items = track?.querySelectorAll('.roulette-item');
        if (!track || !items || items.length === 0) {
            console.error('Cannot spin, no items rendered.');
            isSpinning = false;
            updateDepositButtonState();
            resetToJackpotView();
            return;
        }

        // --- Select Winning Element ---
        // Try to pick a winning element from the latter part of the track for visual effect
        const minIndexPercent = 0.65; // Start search 65% of the way through
        const maxIndexPercent = 0.90; // End search 90% of the way through
        const minIndex = Math.max(0, Math.floor(items.length * minIndexPercent));
        const maxIndex = Math.min(items.length - 1, Math.floor(items.length * maxIndexPercent));

        let winnerItemsIndices = [];
        for (let i = minIndex; i <= maxIndex; i++) {
            // Compare dataset userId with the determined winnerId
            if (items[i]?.dataset?.userId === winnerId) {
                winnerItemsIndices.push(i);
            }
        }

        // Fallback: If no winner found in the preferred range, search the entire track
        if (winnerItemsIndices.length === 0) {
            console.warn(`No winner items found in preferred range [${minIndex}-${maxIndex}].         // Fallback: If no winner found in the preferred range, search the entire track
        if (winnerItemsIndices.length === 0) {
            console.warn(`No winner items found in preferred range [${minIndex}-${maxIndex}]. Expanding search.`);
            for (let i = 0; i < items.length; i++) {
                if (items[i]?.dataset?.userId === winnerId) {
                    winnerItemsIndices.push(i);
                }
            }
        }

        let winningElement, targetIndex;
        if (winnerItemsIndices.length === 0) {
            // Critical Fallback: No element matches winner ID anywhere!
            console.error(`FATAL: No items found matching winner ID ${winnerId}. Cannot determine target. Resetting.`);
            targetIndex = Math.max(0, Math.min(items.length - 1, Math.floor(items.length * 0.75))); // Pick arbitrary element near end
            winningElement = items[targetIndex];
            if (!winningElement) { // If even the fallback is invalid, abort
                console.error('Fallback winning element selection failed!');
                isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
            }
            // Use the data associated with the *actual* winner, even if landing on wrong element visually
            // The backend determined the winner; frontend animation is just visual flair.
            console.warn("Landing animation on fallback element, but winner data is still correct.");
        } else {
            // Select a random index from the matching winner indices
            targetIndex = winnerItemsIndices[Math.floor(Math.random() * winnerItemsIndices.length)];
            winningElement = items[targetIndex];
            if (!winningElement) {
                console.error(`Selected winning element at index ${targetIndex} is invalid! Resetting.`);
                isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
            }
        }
        // --- End Select Winning Element ---

        console.log(`Selected winning element visual target at index ${targetIndex} of ${items.length} total items`);

        // Initiate the animation towards the selected element
        // Pass the correctly identified winner participant data, regardless of visual landing spot
        handleRouletteSpinAnimation(winningElement, winnerParticipantData);
    }, 100); // Small delay for rendering
}

/**
 * Handles the core requestAnimationFrame loop for the roulette spin.
 * Calculates the target position (with adjusted variation) and animates towards it.
 * @param {HTMLElement} winningElement - The target DOM element (for visual landing).
 * @param {object} winner - The actual winner data { user, value, percentage }.
 */
function handleRouletteSpinAnimation(winningElement, winner) {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer?.querySelector('.roulette-container');
    const sound = DOMElements.audio.spinSound;

    if (!winningElement || !track || !container || !winner) { // Added winner check
        console.error("Missing elements or winner data for roulette animation loop.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const containerWidth = container.offsetWidth;
    const itemWidth = winningElement.offsetWidth || 60; // Use actual or default width
    const itemOffsetLeft = winningElement.offsetLeft; // Position relative to track parent

    // Calculate the offset needed to perfectly center the item under the ticker marker
    const centerOffset = (containerWidth / 2) - (itemWidth / 2);
    const perfectCenterScrollPosition = -(itemOffsetLeft - centerOffset);

    // --- ADJUSTED VARIATION LOGIC ---
    // Add a random variation to the landing position for visual interest
    const maxVariationPixels = itemWidth * CONFIG.LANDING_POSITION_VARIATION;
    const variation = (Math.random() * 2 - 1) * maxVariationPixels;

    // Calculate the final target position including the variation
    const targetScrollPosition = perfectCenterScrollPosition + variation;
    // --- END VARIATION LOGIC ---

    const finalTargetPosition = targetScrollPosition; // This is the definitive end point

    // Animation parameters
    const startPosition = parseFloat(track.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1] || '0'); // Get current position
    const duration = CONFIG.SPIN_DURATION_SECONDS * 1000;
    const bounceDuration = CONFIG.BOUNCE_ENABLED ? 1200 : 0; // Duration for bounce effect
    const totalAnimationTime = duration + bounceDuration;
    const totalDistance = finalTargetPosition - startPosition;
    const overshootAmount = totalDistance * CONFIG.BOUNCE_OVERSHOOT_FACTOR; // How much to overshoot if bouncing

    let startTime = performance.now();
    spinStartTime = startTime; // Store start time if needed elsewhere
    let lastPosition = startPosition;
    let lastTimestamp = startTime;

    track.style.transition = 'none'; // Ensure direct transform manipulation via JS

    // Animation loop function using requestAnimationFrame
    function animateRoulette(timestamp) {
        if (!isSpinning) { // Allow stopping the animation externally
            console.log("Animation loop stopped: isSpinning false.");
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
            return;
        }

        const elapsed = timestamp - startTime;
        let currentPosition;
        let animationFinished = false;

        // Main easing phase
        if (elapsed <= duration) {
            const animationPhaseProgress = elapsed / duration;
            const easedProgress = easeOutAnimation(animationPhaseProgress); // Apply easing function
            currentPosition = startPosition + totalDistance * easedProgress;
            
            // Adjust spin sound playback rate for a more engaging effect
            if (sound && !sound.paused) {
                // Start at normal speed, gradually slow down
                const soundRate = 1.0 - (easedProgress * 0.5); // 1.0 to 0.5
                sound.playbackRate = Math.max(0.5, soundRate);
            }
        }
        // Optional bounce phase
        else if (CONFIG.BOUNCE_ENABLED && elapsed <= totalAnimationTime) {
            const bouncePhaseProgress = (elapsed - duration) / bounceDuration;
            const bounceDisplacementFactor = calculateBounce(bouncePhaseProgress); // Apply bounce calculation
            currentPosition = finalTargetPosition - (overshootAmount * bounceDisplacementFactor);
            
            // Completely slow down sound during bounce
            if (sound && !sound.paused) {
                sound.playbackRate = 0.5;
                sound.volume = Math.max(0.1, 0.7 - (bouncePhaseProgress * 0.6)); // Fade out volume
            }
        }
        // Animation complete
        else {
            currentPosition = finalTargetPosition; // Snap to final position
            animationFinished = true;
            
            // Stop sound if still playing
            if (sound && !sound.paused) {
                // Fade out instead of abrupt stop
                const fadeOut = () => {
                    if (sound.volume > 0.05) {
                        sound.volume -= 0.05;
                        setTimeout(fadeOut, 50);
                    } else {
                        sound.pause();
                        sound.volume = 0.7; // Reset for next time
                    }
                };
                fadeOut();
            }
        }

        // Apply the calculated position
        track.style.transform = `translateX(${currentPosition}px)`;

        lastPosition = currentPosition;
        lastTimestamp = timestamp;

        // Continue animation or finalize
        if (!animationFinished) {
            animationFrameId = requestAnimationFrame(animateRoulette);
        } else {
            console.log("Animation finished naturally in loop.");
            animationFrameId = null;
            // IMPORTANT: Pass the *actual* winner data, not data derived from the visual element
            finalizeSpin(winningElement, winner);
        }
    }

    // Start the animation loop
    if (animationFrameId) cancelAnimationFrame(animationFrameId); // Clear any previous frame
    animationFrameId = requestAnimationFrame(animateRoulette);
}

/**
 * Called when the roulette animation physically stops. Applies winner highlighting.
 * @param {HTMLElement} winningElement - The element that the animation landed on.
 * @param {object} winner - The actual winner data { user, value, percentage }.
 */
function finalizeSpin(winningElement, winner) {
    // Prevent double execution or running with invalid data
    if ((!isSpinning && winningElement?.classList.contains('winner-highlight')) || !winningElement || !winner?.user) {
        console.log("FinalizeSpin called, but seems already finalized or data invalid.");
        if (isSpinning) { isSpinning = false; updateDepositButtonState(); /* Don't reset view here, let handleSpinEnd do it */ }
        return;
    }

    console.log("Finalizing spin: Applying highlight to visual target.");
    const winnerId = winner.user.id || winner.user._id; // Get actual winner ID
    const userColor = getUserColor(winnerId); // Use actual winner's color

    // Add highlight class to the element the animation *landed* on
    winningElement.classList.add('winner-highlight');

    // Inject dynamic CSS for the pulse animation using the winner's color
    const styleId = 'winner-pulse-style';
    document.getElementById(styleId)?.remove(); // Remove previous style if exists

    const style = document.createElement('style');
    style.id = styleId;
    // Use CSS variables for cleaner animation definition
    style.textContent = `
        @keyframes winnerPulse {
            0%, 100% { box-shadow: 0 0 15px var(--winner-color); transform: scale(1.05); }
            50% { box-shadow: 0 0 25px var(--winner-color), 0 0 10px var(--winner-color); transform: scale(1.1); }
        }
        .winner-highlight {
            z-index: 5;
            border-width: 3px;
            border-color: ${userColor}; /* Direct border color */
            animation: winnerPulse 1.5s infinite;
            --winner-color: ${userColor}; /* Set CSS variable */
            transform: scale(1.05); /* Initial scale */
        }`;
    document.head.appendChild(style);

    // Short delay before showing winner info box (allows highlight to appear)
    setTimeout(() => {
        // Pass the actual winner data to the final display function
        handleSpinEnd(winningElement, winner);
    }, 300);
}

/**
 * Handles the final actions after the spin animation ends. Displays winner info and triggers confetti.
 * Uses the *actual* winner data passed to it.
 * @param {HTMLElement} winningElement - The visual element that won (for context, maybe not used directly).
 * @param {object} winner - Actual winner data { user: { _id/id, username, avatar }, value, percentage }.
 */
function handleSpinEnd(winningElement, winner) {
    if (!winner?.user) { // Check for valid winner user object
        console.error("handleSpinEnd called with invalid winner data.");
        if (!isSpinning) return; // Already stopped
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; } // Ensure animation frame is stopped

    console.log("Handling spin end: Displaying winner info for:", winner.user.username);

    const { winnerInfoBox, winnerAvatar, winnerName, winnerDeposit, winnerChance } = DOMElements.roulette;

    // Check if all necessary winner display elements exist
    if (winnerInfoBox && winnerAvatar && winnerName && winnerDeposit && winnerChance) {
        const winnerId = winner.user.id || winner.user._id; // Get actual winner ID
        const userColor = getUserColor(winnerId); // Use actual winner's color

        // --- Populate Winner Details ---
        winnerAvatar.src = winner.user.avatar || '/img/default-avatar.png';
        winnerAvatar.alt = winner.user.username || 'Winner';
        winnerAvatar.style.borderColor = userColor;
        winnerAvatar.style.boxShadow = `0 0 15px ${userColor}`; // Add glow effect

        winnerName.textContent = winner.user.username || 'Winner';
        winnerName.style.color = userColor;

        // Use value and percentage from the passed winner object
        const depositValueStr = formatCurrency(winner.value || 0);
        const chanceValueStr = `${(winner.percentage || 0).toFixed(2)}%`;

        winnerDeposit.textContent = depositValueStr; // Set directly, remove typing effect for simplicity/reliability
        winnerChance.textContent = chanceValueStr;

        // Display and animate winner box entry
        winnerInfoBox.style.display = 'flex';
        winnerInfoBox.style.opacity = '0';
        winnerInfoBox.style.animation = 'fadeInUp 0.5s ease forwards'; // Use fadeInUp animation

        // --- Trigger Confetti & Reset ---
        // Short delay before confetti to let box animate in
        setTimeout(() => {
            launchConfetti(userColor); // Launch confetti using actual winner's color
            isSpinning = false; // Officially mark as not spinning *after* visual effects start
            updateDepositButtonState();
            console.log("isSpinning set to false after winner display/confetti.");
            // Schedule reset back to jackpot view after display duration
            setTimeout(resetToJackpotView, CONFIG.WINNER_DISPLAY_DURATION);
        }, 500); // Delay matches fadeInUp animation duration

    } else {
        console.error("Winner info display elements missing.");
        isSpinning = false; // Still mark as not spinning
        updateDepositButtonState();
        resetToJackpotView(); // Reset view immediately if UI elements are broken
    }
}

/**
 * Creates and launches confetti elements using the winner's color scheme.
 * @param {string} [mainColor='#00e676'] - Base confetti color.
 */
function launchConfetti(mainColor = '#00e676') {
    const container = DOMElements.roulette.confettiContainer;
    if (!container) return;
    clearConfetti(); // Clear previous first

    const baseColor = mainColor;
    const complementaryColor = getComplementaryColor(baseColor);
    const lighterColor = lightenColor(baseColor, 30);
    const darkerColor = darkenColor(baseColor, 30);
    const colors = [baseColor, lighterColor, darkerColor, complementaryColor, '#ffffff', lightenColor(complementaryColor, 20)];

    for (let i = 0; i < CONFIG.CONFETTI_COUNT; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'confetti-piece'; // Use class defined in CSS

        // Set properties for CSS animation
        confetti.style.left = `${Math.random() * 100}%`;
        const animDuration = 2 + Math.random() * 3;
        const animDelay = Math.random() * 1.5;
        confetti.style.setProperty('--duration', `${animDuration}s`);
        confetti.style.setProperty('--delay', `${animDelay}s`);
        const color = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.setProperty('--color', color);
        const size = Math.random() * 8 + 4;
        confetti.style.width = `${size}px`;
        confetti.style.height = `${size}px`;
        const rotationStart = Math.random() * 360;
        const rotationEnd = rotationStart + (Math.random() - 0.5) * 720;
        const fallX = (Math.random() - 0.5) * 100;
        confetti.style.setProperty('--fall-x', `${fallX}px`);
        confetti.style.setProperty('--rotation-start', `${rotationStart}deg`);
        confetti.style.setProperty('--rotation-end', `${rotationEnd}deg`);
        if (Math.random() < 0.5) confetti.style.borderRadius = '50%'; // Randomly make some circular

        container.appendChild(confetti);
    }
}

/**
 * Clears confetti elements and removes winner highlighting styles.
 */
function clearConfetti() {
    if (DOMElements.roulette.confettiContainer) DOMElements.roulette.confettiContainer.innerHTML = '';
    document.getElementById('winner-pulse-style')?.remove(); // Remove injected style
    // Remove highlight class and reset styles from any previously highlighted item
    document.querySelectorAll('.roulette-item.winner-highlight').forEach(el => {
        el.classList.remove('winner-highlight');
        el.style.transform = ''; // Reset transform
        el.style.animation = ''; // Remove animation reference
        el.style.borderColor = el.dataset?.userId ? getUserColor(el.dataset.userId) : 'transparent'; // Reset border
    });
}

/**
 * Resets the UI back to the main jackpot view after a round ends.
 */
function resetToJackpotView() {
    console.log("Resetting to jackpot view...");

    // --- Clear Timers & Intervals ---
    if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null;
    if (roundTimer) clearInterval(roundTimer); roundTimer = null;
    timerActive = false; // Ensure timer state is reset
    // --- End Clear Timers ---

    isSpinning = false; // Ensure spinning state is definitively false
    spinStartTime = 0;

    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer;
    const winnerInfoBox = DOMElements.roulette.winnerInfoBox;
    const track = DOMElements.roulette.rouletteTrack;
    if (!header || !rouletteContainer || !winnerInfoBox || !track) {
        console.error("Missing elements for resetToJackpotView.");
        return; // Cannot proceed with reset if elements are missing
    }

    // Reset sound properties if sound exists
    const sound = DOMElements.audio.spinSound;
    if (sound) {
        sound.pause();
        sound.currentTime = 0;
        sound.volume = 0.7;
        sound.playbackRate = 1.0;
    }

    // --- Animate UI Transition ---
    // 1. Fade out Roulette elements
    rouletteContainer.style.transition = 'opacity 0.5s ease';
    rouletteContainer.style.opacity = '0';
    if (winnerInfoBox.style.display !== 'none') { // Only fade if visible
        winnerInfoBox.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        winnerInfoBox.style.opacity = '0';
        winnerInfoBox.style.transform = 'translateY(10px)'; // Add slight move down effect
    }
    clearConfetti(); // Clear confetti and highlights immediately

    // 2. After fade out, reset layout and state, then fade in jackpot header elements
    setTimeout(() => {
        // Reset Roulette elements fully
        header.classList.remove('roulette-mode'); // Restore header style
        track.style.transition = 'none'; // Remove transition before resetting transform
        track.style.transform = 'translateX(0)';
        track.innerHTML = ''; // Clear roulette items from DOM
        rouletteContainer.style.display = 'none'; // Hide container
        winnerInfoBox.style.display = 'none'; // Hide winner box
        winnerInfoBox.style.opacity = ''; // Reset opacity
        winnerInfoBox.style.animation = ''; // Reset animation
        winnerInfoBox.style.transform = ''; // Reset transform

        // Perform the visual reset for the next round (clears participants, resets timer display)
        initiateNewRoundVisualReset();

        // Fade in Jackpot Header elements (Value, Timer, Stats)
        const headerElements = header.querySelectorAll('.jackpot-value, .jackpot-timer, .jackpot-stats');
        headerElements.forEach((el, index) => {
            if (el) {
                el.style.display = ''; // Restore display (CSS should handle flex/block)
                el.style.opacity = '0'; // Start transparent
                // Stagger fade-in using rAF for timing
                requestAnimationFrame(() => {
                    el.style.transition = 'opacity 0.5s ease ' + (index * 0.05) + 's'; // Add stagger delay
                    el.style.opacity = '1';
                });
            }
        });

        updateDepositButtonState(); // Update button state AFTER resetting UI

        // Request fresh round data from server to ensure sync for the next round
        if (socket?.connected) {
            console.log("Requesting fresh round data after reset.");
            socket.emit('requestRoundData');
        } else {
            console.warn("Socket not connected, skipping requestRoundData after reset.");
        }

    }, 500); // Delay matches the longest fade-out duration (rouletteContainer)
}
Let me continue with the profile modal and verification functions:
javascript/**
 * Performs the visual reset needed when a new round starts or view is reset.
 * Clears participant blocks, resets timer display, pot value display.
 */
function initiateNewRoundVisualReset() {
    console.log("Initiating visual reset for new round display");

    // Reset Timer UI Display
    updateTimerUI(CONFIG.ROUND_DURATION); // Show full duration initially
    if (DOMElements.jackpot.timerValue) {
        DOMElements.jackpot.timerValue.classList.remove('urgent-pulse', 'timer-pulse');
    }

    // Reset Participants List Display
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (container) {
        container.innerHTML = ''; // Clear existing blocks
        if (emptyMsg) {
            // Ensure empty message is visible
            emptyMsg.style.display = 'block';
        }
    }

    // Reset Pot Value and Participant Count Display in Header
    if (DOMElements.jackpot.potValue) DOMElements.jackpot.potValue.textContent = formatCurrency(0);
    updateParticipantsUI(); // Update count display (will show 0/MAX)

    userColorMap.clear(); // Clear user color mappings for the new round
}

/**
 * Helper function to find winner details from local round data using the winner ID.
 * @param {object} winnerData - Data containing winner object { winner: { _id/id, ... } }.
 * @returns {object|null} Object with { user, value, percentage } or null if not found/invalid.
 */
function findWinnerFromData(winnerData) {
    const winnerDetails = winnerData?.winner;
    const winnerId = winnerDetails?.id || winnerDetails?._id; // Get ID

    if (!winnerId) {
        console.error("Missing winner ID in findWinnerFromData:", winnerData);
        return null;
    }

    if (!currentRound || !currentRound.participants) {
        console.warn("Missing currentRound or participants data for findWinnerFromData.");
        // Attempt to return basic info directly from winnerData if possible
        return winnerDetails ? { user: { ...winnerDetails }, percentage: 0, value: 0 } : null;
    }

    // Find the participant whose user ID matches
    const winnerParticipant = currentRound.participants.find(p => 
        p.user?._id === winnerId || p.user === winnerId
    );

    if (!winnerParticipant) {
        console.warn(`Winner ID ${winnerId} not found in local participants list.`);
        // Attempt to return basic info directly from winnerData if possible
        return winnerDetails ? { user: { ...winnerDetails }, percentage: 0, value: 0 } : null;
    }

    // Calculate percentage based on the current round's total value
    const totalValue = Math.max(0.01, currentRound.totalValue || 0.01);
    const participantValue = winnerParticipant.itemsValue || 0;
    const percentage = (participantValue / totalValue) * 100;

    // Return a structured object with full user details, value, and percentage
    return {
        user: { ...(winnerParticipant.user) }, // Return a copy of the user object
        percentage: isNaN(percentage) ? 0 : percentage, // Handle NaN case
        value: participantValue
    };
}

/** Populates the profile modal with current user data. */
function populateProfileModal() {
    const { modal, avatar, name, deposited, won, tradeUrlInput, pendingOfferStatus } = DOMElements.profileModal;
    if (!modal || !currentUser) {
        console.warn("Cannot populate profile modal: Element missing or user not logged in.");
        return;
    }

    console.log("Populating profile modal for:", currentUser.username);

    if (avatar) avatar.src = currentUser.avatar || '/img/default-avatar.png';
    if (name) name.textContent = currentUser.username || 'User';
    if (deposited) deposited.textContent = formatCurrency(currentUser.totalDeposited || 0);
    if (won) won.textContent = formatCurrency(currentUser.totalWon || 0);
    if (tradeUrlInput) tradeUrlInput.value = currentUser.tradeUrl || '';

    // Display pending offer status
    if (pendingOfferStatus) {
        // Check for pending deposit offer
        if (currentUser.pendingDepositOfferId) {
            const offerLink = `https://steamcommunity.com/tradeoffer/${currentUser.pendingDepositOfferId}/`;
            pendingOfferStatus.innerHTML = `
                <p class="warning-text">
                    <strong>Pending Deposit Offer:</strong> #${currentUser.pendingDepositOfferId}<br>
                    <a href="${offerLink}" target="_blank" rel="noopener noreferrer">Accept/View on Steam</a>
                </p>`;
            pendingOfferStatus.style.display = 'block';
        } 
        // Check for pending winnings
        else if (pendingTrades.length > 0) {
            const pendingWinningsCount = pendingTrades.length;
            const latestOffer = pendingTrades[0];
            const offerLink = latestOffer.offerId ? 
                `https://steamcommunity.com/tradeoffer/${latestOffer.offerId}/` : 
                null;
                
            let content = `<p class="warning-text">
                <strong>Pending Winnings:</strong> You have ${pendingWinningsCount} pending winning offer${pendingWinningsCount !== 1 ? 's' : ''}!<br>`;
                
            if (offerLink) {
                content += `<a href="${offerLink}" target="_blank" rel="noopener noreferrer">View Latest Offer</a> | `;
            }
            
            content += `<a href="#" id="viewTradeHistoryLink">View All in Trade History</a>
                </p>`;
                
            pendingOfferStatus.innerHTML = content;
            pendingOfferStatus.style.display = 'block';
            
            // Add event listener to the trade history link
            document.getElementById('viewTradeHistoryLink')?.addEventListener('click', (e) => {
                e.preventDefault();
                hideModal(modal); // Close profile modal
                loadTradeHistory(); // Load latest trade history
                showModal(DOMElements.tradeHistory.modal); // Show trade history modal
            });
        } else {
            pendingOfferStatus.innerHTML = '<p>No pending offers.</p>';
            pendingOfferStatus.style.display = 'none';
        }
    }

    showModal(modal); // Show the modal after populating
}

/** Saves the user's profile data (e.g., trade URL). */
async function saveProfile() {
    const { tradeUrlInput, modal } = DOMElements.profileModal;
    if (!tradeUrlInput || !currentUser) {
        console.error("Cannot save profile: Input element missing or user not logged in.");
        return;
    }

    const newTradeUrl = tradeUrlInput.value.trim();
    // Basic validation (consider more robust validation)
    if (newTradeUrl && !newTradeUrl.includes('steamcommunity.com/tradeoffer/new/')) {
        showNotification('Invalid Trade URL format. Please use the link from Steam.', 'error');
        return;
    }

    console.log("Saving trade URL:", newTradeUrl);
    showNotification('Saving profile...', 'info', 2000);

    try {
        const response = await safeFetch('/api/user/tradeurl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tradeUrl: newTradeUrl }),
        });

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.error || "Save failed on server.");
        }

        // Update local user state with potentially updated data from server response
        if (result.tradeUrl !== undefined) {
            currentUser.tradeUrl = result.tradeUrl; // Update just the trade URL
        }

        showNotification('Profile saved successfully!', 'success');
        updateUserUI(); // Update main header UI if needed
        updateDepositButtonState(); // Re-check deposit button status
        hideModal(modal); // Close modal on successful save

    } catch (error) {
        console.error("Error saving profile:", error);
        showNotification(`Error saving profile: ${error.message}`, 'error');
        // Do not close modal on error
    }
}

/**
 * Sends data to the backend API to verify a past round's fairness.
 */
async function verifyRound() {
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationResultDisplay } = DOMElements.provablyFair;

    if (!roundIdInput || !serverSeedInput || !clientSeedInput || !verificationResultDisplay) {
        console.error("Verify form elements missing.");
        return;
    }

    const roundId = roundIdInput.value.trim();
    const serverSeed = serverSeedInput.value.trim();
    const clientSeed = clientSeedInput.value.trim();
    const resultEl = verificationResultDisplay;

    // Frontend validation
    let validationError = null;
    if (!roundId || !serverSeed || !clientSeed) {
        validationError = 'Please fill in all fields (Round ID, Server Seed, Client Seed).';
    } else if (serverSeed.length !== 64 || !/^[a-f0-9]{64}$/i.test(serverSeed)) {
        validationError = 'Invalid Server Seed format (should be 64 hexadecimal characters).';
    } else if (clientSeed.length === 0) {
        validationError = 'Client Seed cannot be empty.';
    }

    if (validationError) {
        resultEl.style.display = 'block';
        resultEl.className = 'result-panel error';
        resultEl.innerHTML = `<h3>Verification Error</h3><p>${validationError}</p>`;
        return;
    }

    try {
        resultEl.style.display = 'block';
        resultEl.className = 'result-panel loading';
        resultEl.innerHTML = '<h3>VerifyingRetryClaude hit the max length for a message and has paused its response. You can write Continue to keep the chat going.IContinueEditLet me continue with the verification UI implementation:
javascript    try {
        resultEl.style.display = 'block';
        resultEl.className = 'result-panel loading';
        resultEl.innerHTML = '<h3>Verifying round fairness...</h3><div class="loading-spinner"></div>';

        const response = await safeFetch('/api/fair/verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                roundId,
                serverSeed,
                clientSeed
            })
        });

        const data = await response.json();

        if (!data.success) {
            throw new Error(data.error || 'Verification failed on server.');
        }

        // Format the result based on verification response
        const isVerified = data.isVerified === true;
        resultEl.className = `result-panel ${isVerified ? 'success' : 'error'}`;
        
        let resultHTML = `<h3>Verification ${isVerified ? 'Successful' : 'Failed'}</h3>`;
        
        // Add winner details if available
        if (data.winner) {
            const { winnerName, winnerId, winnerTicket, totalTickets } = data;
            const percentage = totalTickets > 0 ? 
                ((winnerTicket / totalTickets) * 100).toFixed(2) : 
                'N/A';
                
            resultHTML += `
                <div class="verification-result-details">
                    <p><strong>Winner:</strong> ${sanitizeHTML(winnerName || 'Unknown')}</p>
                    <p><strong>Winning Ticket:</strong> ${winnerTicket || 'N/A'} / ${totalTickets || 'N/A'} (${percentage}%)</p>
                    <p><strong>Server Seed Hash:</strong> ${sanitizeHTML(data.serverSeedHash || 'N/A')}</p>
                    <p><strong>HMAC:</strong> ${sanitizeHTML(data.hmac || 'N/A')}</p>
                </div>`;
        }
        
        // Add verification steps if provided
        if (data.steps && Array.isArray(data.steps)) {
            resultHTML += `<div class="verification-steps">
                <h4>Verification Steps:</h4>
                <ol>`;
            
            data.steps.forEach(step => {
                resultHTML += `<li>${sanitizeHTML(step)}</li>`;
            });
            
            resultHTML += `</ol></div>`;
        }
        
        if (isVerified) {
            resultHTML += `<p class="verification-conclusion success-text">
                The outcome of this round has been verified as fair and cannot be manipulated.
            </p>`;
        } else {
            resultHTML += `<p class="verification-conclusion error-text">
                Verification failed. The seeds and round outcome do not match.
            </p>`;
        }
        
        resultEl.innerHTML = resultHTML;

    } catch (error) {
        console.error('Verification error:', error);
        resultEl.className = 'result-panel error';
        resultEl.innerHTML = `
            <h3>Verification Error</h3>
            <p>${error.message || 'An error occurred during verification.'}</p>
        `;
    }
}

/**
 * Loads past rounds data from the server API for display in the fair page.
 * @param {number} page - The page number to load (1-based).
 */
async function loadPastRounds(page = 1) {
    const { pastRoundsTable, pastRoundsBody, loadingIndicator, pagination, pageInfo } = DOMElements.pastRounds;
    
    if (!pastRoundsTable || !pastRoundsBody || !loadingIndicator) {
        console.error("Past rounds elements missing.");
        return;
    }
    
    // Reset and show loading
    pastRoundsBody.innerHTML = '';
    loadingIndicator.style.display = 'flex';
    pastRoundsTable.style.display = 'none';
    if (pagination) pagination.style.display = 'none';
    if (pageInfo) pageInfo.textContent = '';
    
    try {
        const pageSize = CONFIG.PAST_ROUNDS_PAGE_SIZE;
        const response = await safeFetch(`/api/rounds?page=${page}&limit=${pageSize}`);
        const data = await response.json();
        
        loadingIndicator.style.display = 'none';
        
        if (!data.rounds || !Array.isArray(data.rounds)) {
            throw new Error("Invalid rounds data received from server.");
        }
        
        if (data.rounds.length === 0) {
            pastRoundsBody.innerHTML = `
                <tr>
                    <td colspan="7" class="empty-table-message">
                        No past rounds found.
                    </td>
                </tr>`;
            pastRoundsTable.style.display = 'table';
            return;
        }
        
        // Populate table with rounds data
        data.rounds.forEach(round => {
            const row = document.createElement('tr');
            
            // Format timestamp
            const roundDate = round.createdAt ? formatDate(round.createdAt) : 'N/A';
            
            // Format winner with color
            const winnerId = round.winner?._id || round.winner?.id;
            let winnerHTML = 'No Winner';
            if (winnerId) {
                const userColor = getUserColor(winnerId);
                const winnerName = round.winner?.username || 'Unknown';
                winnerHTML = `<span class="user-name" style="color: ${userColor}">${sanitizeHTML(winnerName)}</span>`;
            }
            
            // Format total value
            const totalValueText = typeof round.totalValue === 'number' ? 
                formatCurrency(round.totalValue) : 'N/A';
            
            row.innerHTML = `
                <td>${round.roundId || 'N/A'}</td>
                <td>${roundDate}</td>
                <td>${totalValueText}</td>
                <td>${round.participants?.length || 0}</td>
                <td>${winnerHTML}</td>
                <td><code class="seed-hash">${sanitizeHTML(round.serverSeedHash || 'N/A')}</code></td>
                <td>
                    <button class="btn btn-small btn-verify" data-round-id="${round.roundId}" 
                            data-server-seed-hash="${sanitizeHTML(round.serverSeedHash || '')}"
                            data-client-seed="${sanitizeHTML(round.clientSeed || '')}">
                        Verify
                    </button>
                </td>
            `;
            
            pastRoundsBody.appendChild(row);
        });
        
        // Add event listeners to verify buttons
        pastRoundsBody.querySelectorAll('.btn-verify').forEach(btn => {
            btn.addEventListener('click', () => {
                const roundId = btn.dataset.roundId;
                const serverSeedHash = btn.dataset.serverSeedHash;
                const clientSeed = btn.dataset.clientSeed;
                
                // Scroll to verification form and pre-fill values
                document.getElementById('fair-verify-section')?.scrollIntoView({ behavior: 'smooth' });
                
                // Pre-fill verification form if elements exist
                if (DOMElements.provablyFair.roundIdInput) {
                    DOMElements.provablyFair.roundIdInput.value = roundId || '';
                }
                if (DOMElements.provablyFair.clientSeedInput) {
                    DOMElements.provablyFair.clientSeedInput.value = clientSeed || '';
                }
                // Note: Server Seed is left empty as it's revealed after round completes
                if (DOMElements.provablyFair.serverSeedInput) {
                    DOMElements.provablyFair.serverSeedInput.value = '';
                    DOMElements.provablyFair.serverSeedInput.focus();
                }
            });
        });
        
        pastRoundsTable.style.display = 'table';
        
        // Update pagination if available
        if (pagination && data.totalPages > 1) {
            updatePagination(page, data.totalPages);
            pagination.style.display = 'flex';
        }
        
        // Update page info text if element exists
        if (pageInfo) {
            const totalRounds = data.totalRounds || 'many';
            pageInfo.textContent = `Page ${page} of ${data.totalPages} (${totalRounds} rounds total)`;
        }
        
    } catch (error) {
        console.error("Failed to load past rounds:", error);
        loadingIndicator.style.display = 'none';
        pastRoundsBody.innerHTML = `
            <tr>
                <td colspan="7" class="error-message">
                    Failed to load past rounds: ${error.message}. Please try again later.
                </td>
            </tr>`;
        pastRoundsTable.style.display = 'table';
    }
}

/**
 * Updates the pagination controls for past rounds navigation.
 * @param {number} currentPage - The current page number.
 * @param {number} totalPages - The total number of pages.
 */
function updatePagination(currentPage, totalPages) {
    const pagination = DOMElements.pastRounds.pagination;
    if (!pagination) return;
    
    pagination.innerHTML = '';
    
    // Helper to create a page button
    const createPageButton = (page, label, isActive = false, isDisabled = false) => {
        const button = document.createElement('button');
        button.className = `pagination-btn ${isActive ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`;
        button.disabled = isDisabled;
        button.textContent = label;
        
        if (!isDisabled) {
            button.addEventListener('click', () => loadPastRounds(page));
        }
        
        return button;
    };
    
    // Previous button
    pagination.appendChild(createPageButton(
        currentPage - 1, 
        '←', 
        false, 
        currentPage <= 1
    ));
    
    // Determine which page buttons to show
    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    
    // Adjust start if we're near the end
    if (endPage - startPage < 4) {
        startPage = Math.max(1, endPage - 4);
    }
    
    // First page and ellipsis if needed
    if (startPage > 1) {
        pagination.appendChild(createPageButton(1, '1'));
        if (startPage > 2) {
            const ellipsis = document.createElement('span');
            ellipsis.className = 'pagination-ellipsis';
            ellipsis.textContent = '...';
            pagination.appendChild(ellipsis);
        }
    }
    
    // Page buttons
    for (let i = startPage; i <= endPage; i++) {
        pagination.appendChild(createPageButton(i, i.toString(), i === currentPage));
    }
    
    // Last page and ellipsis if needed
    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            const ellipsis = document.createElement('span');
            ellipsis.className = 'pagination-ellipsis';
            ellipsis.textContent = '...';
            pagination.appendChild(ellipsis);
        }
        pagination.appendChild(createPageButton(totalPages, totalPages.toString()));
    }
    
    // Next button
    pagination.appendChild(createPageButton(
        currentPage + 1, 
        '→', 
        false, 
        currentPage >= totalPages
    ));
}

// --- Socket Event Handlers ---

/**
 * Initializes the WebSocket connection and sets up event handlers.
 */
function initializeSocketConnection() {
    if (socket && socket.connected) {
        console.log("Socket already connected. Skipping initialization.");
        return;
    }
    
    console.log("Initializing socket connection...");
    
    // Initialize socket connection
    socket = io({
        reconnectionAttempts: CONFIG.SOCKET_RECONNECT_ATTEMPTS,
        reconnectionDelay: CONFIG.SOCKET_RECONNECT_DELAY,
        timeout: CONFIG.SOCKET_TIMEOUT,
        transports: ['websocket', 'polling'] // Prefer WebSocket, fallback to polling
    });
    
    // --- Connection Events ---
    socket.on('connect', handleSocketConnect);
    socket.on('disconnect', handleSocketDisconnect);
    socket.on('connect_error', handleSocketError);
    socket.on('reconnect_attempt', (attemptNumber) => {
        console.log(`Socket: Reconnect attempt ${attemptNumber}/${CONFIG.SOCKET_RECONNECT_ATTEMPTS}`);
    });
    
    // --- Game Events ---
    socket.on('roundCreated', handleRoundCreated);
    socket.on('roundData', handleRoundData);
    socket.on('participantUpdated', handleNewDeposit);
    socket.on('roundRolling', handleRoundRolling);
    socket.on('roundWinner', handleWinnerAnnouncement);
    socket.on('tradeUpdate', handleTradeUpdate);
    
    // --- Chat Events ---
    socket.on('chatMessage', handleChatMessage);
}
Let me continue with the socket event handler implementations:
javascript/**
 * Handles the socket 'connect' event.
 */
function handleSocketConnect() {
    console.log("Socket connected successfully.");
    isSocketConnected = true;
    showNotification('Connected to game server.', 'success', 2000);
    
    // Request current round data on connect
    socket.emit('requestRoundData');
    
    // Check login status (if not already authenticated)
    if (!currentUser) {
        checkLoginStatus();
    }
}

/**
 * Handles the socket 'disconnect' event.
 * @param {string} reason - The reason for disconnection.
 */
function handleSocketDisconnect(reason) {
    console.log(`Socket disconnected: ${reason}`);
    isSocketConnected = false;
    
    // Only show notification for unexpected disconnects
    if (reason !== 'io client disconnect') {
        showNotification('Disconnected from game server. Reconnecting...', 'warning');
    }
}

/**
 * Handles socket connection errors.
 * @param {Error} error - The error object.
 */
function handleSocketError(error) {
    console.error("Socket connection error:", error);
    showNotification('Connection error. Please check your internet connection.', 'error');
}

/**
 * Handles the 'roundCreated' event (new round started).
 * @param {object} data - The round data object.
 */
function handleRoundCreated(data) {
    console.log("New round created:", data.roundId);
    
    // Validate round data
    if (!data || !data.roundId) {
        console.error("Invalid round data in roundCreated event:", data);
        return;
    }
    
    // Initialize round state with defaults
    currentRound = {
        roundId: data.roundId,
        createdAt: data.createdAt || new Date().toISOString(),
        status: data.status || 'active',
        serverSeedHash: data.serverSeedHash || null,
        clientSeed: data.clientSeed || null,
        timeLeft: data.timeLeft !== undefined ? data.timeLeft : CONFIG.ROUND_DURATION,
        participants: [],
        items: [],
        totalValue: 0,
        winner: null
    };
    
    // Reset roulette state
    isSpinning = false;
    
    // Stop any active timer
    if (timerActive) {
        timerActive = false;
        if (roundTimer) {
            clearInterval(roundTimer);
            roundTimer = null;
        }
    }
    
    // Visually reset UI for new round
    initiateNewRoundVisualReset();
    
    // Update round header UI
    updateRoundUI();
    
    // Update deposit button state for new round
    updateDepositButtonState();
    
    // If we have a complete current round, don't assume it has participants yet
    // The backend will send participantUpdated events for each participant if needed
}

/**
 * Handles the 'roundData' event (full state sync).
 * @param {object} data - The complete round data object.
 */
function handleRoundData(data) {
    console.log("Received full round data for:", data.roundId);
    
    // Validate round data
    if (!data || !data.roundId) {
        console.error("Invalid round data in roundData event:", data);
        return;
    }
    
    // Handle case where the round has a winner already (entering during winner display)
    if (data.winner && (data.status === 'completed' || data.status === 'rolling')) {
        console.log("Received round data with existing winner.");
        currentRound = data; // Store the complete round data
        
        // If not already spinning, show winner display
        if (!isSpinning) {
            // If joining during a winner reveal, display it
            handleWinnerAnnouncement(data);
        }
        return;
    }
    
    // Normal round data handling
    currentRound = data;
    
    // Reset visual display first
    initiateNewRoundVisualReset();
    
    // Update round header UI with new data
    updateRoundUI();
    
    // Display existing participants if any
    if (data.participants && data.participants.length > 0) {
        const container = DOMElements.jackpot.participantsContainer;
        const emptyMsg = DOMElements.jackpot.emptyPotMessage;
        
        if (container) {
            // Hide empty message if we have participants
            if (emptyMsg) emptyMsg.style.display = 'none';
            
            // Create a clone of participants array to avoid modifying original data
            const sortedParticipants = [...data.participants].sort((a, b) => {
                // Sort by timestamp descending (newest first)
                // Fallback to ID comparison if timestamps missing
                if (a.timestamp && b.timestamp) {
                    return new Date(b.timestamp) - new Date(a.timestamp);
                }
                return 0; // Default: no change in order
            });
            
            // Display each participant's latest deposit
            sortedParticipants.forEach(participant => {
                if (!participant.user || !participant.user._id) {
                    console.warn("Skipping participant with missing user data:", participant);
                    return;
                }
                
                // Prepare data object format for displayLatestDeposit
                const displayData = {
                    userId: participant.user._id,
                    username: participant.user.username,
                    avatar: participant.user.avatar,
                    itemsValue: participant.itemsValue || 0,
                    // Find items from this participant in the round's items array
                    depositedItems: currentRound.items.filter(item => 
                        item.owner === participant.user._id
                    ) || []
                };
                
                displayLatestDeposit(displayData);
            });
            
            updateAllParticipantPercentages();
        }
        
        // Start timer if it's an active round with participants
        if (data.status === 'active' && !timerActive) {
            startClientTimer(data.timeLeft ?? CONFIG.ROUND_DURATION);
        }
    }
    
    // Update deposit button state based on new round data
    updateDepositButtonState();
}

/**
 * Handles the 'roundRolling' event (when winner selection starts).
 * @param {object} data - Event data including roundId.
 */
function handleRoundRolling(data) {
    console.log("Round entering rolling state:", data.roundId);
    
    // Validate data
    if (!data || !data.roundId) {
        console.error("Invalid data in roundRolling event:", data);
        return;
    }
    
    // Update round status in local state
    if (currentRound && currentRound.roundId === data.roundId) {
        currentRound.status = 'rolling';
    } else {
        console.warn(`Received roundRolling for ${data.roundId}, but current round is ${currentRound?.roundId}`);
        // Request fresh round data to ensure sync
        socket.emit('requestRoundData');
    }
    
    // Stop timer if running
    if (timerActive) {
        timerActive = false;
        clearInterval(roundTimer);
        roundTimer = null;
    }
    
    // Update UI
    if (DOMElements.jackpot.timerValue) {
        DOMElements.jackpot.timerValue.textContent = "Rolling";
        DOMElements.jackpot.timerValue.classList.remove('urgent-pulse', 'timer-pulse');
    }
    
    // Update round status visually
    updateRoundUI();
    
    // Update deposit button state (should disable during rolling)
    updateDepositButtonState();
    
    // The server should send a 'roundWinner' event shortly after this
}

/**
 * Handles trade offer status updates from the server.
 * @param {object} data - Trade update data { offerId, status, type }.
 */
function handleTradeUpdate(data) {
    console.log("Trade update received:", data);
    
    // Validate trade data
    if (!data || !data.offerId) {
        console.error("Invalid trade update data:", data);
        return;
    }
    
    // Update trade in local storage
    const updated = updateTradeStatus(data.offerId, data.status);
    
    // If this was the current user's pending deposit offer and it was completed
    if (currentUser && currentUser.pendingDepositOfferId === data.offerId &&
        (data.status === 'accepted' || data.status === 'declined' || data.status === 'expired' || data.status === 'error')) {
        // Clear the pending offer ID
        currentUser.pendingDepositOfferId = null;
        // Update UI
        updateUserUI();
        updateDepositButtonState();
        
        // Optionally show notification
        if (data.status === 'accepted') {
            showNotification('Your deposit offer has been accepted!', 'success');
        } else if (data.status === 'declined') {
            showNotification('Your deposit offer was declined.', 'info');
        } else if (data.status === 'expired') {
            showNotification('Your deposit offer has expired.', 'warning');
        }
    }
    
    // If the trade updated was a winning offer, update pendingTrades list
    if (data.type === 'winnings') {
        pendingTrades = pendingTrades.filter(t => t.offerId !== data.offerId);
        
        // If status changed to accepted, update total won
        if (data.status === 'accepted' && currentUser && data.value) {
            currentUser.totalWon = (currentUser.totalWon || 0) + data.value;
        }
    }
    
    // Update trade history modal if it's open
    if (DOMElements.tradeHistory.modal.style.display === 'flex') {
        populateTradeHistoryTable(tradeHistory);
        if (pendingTrades.length > 0) {
            populatePendingTradesList(pendingTrades);
            DOMElements.tradeHistory.pendingSection.style.display = 'block';
        } else {
            DOMElements.tradeHistory.pendingSection.style.display = 'none';
        }
    }
    
    // Update profile modal if it's open (to refresh pending offer status)
    if (DOMElements.profileModal.modal.style.display === 'flex') {
        populateProfileModal();
    }
}

/**
 * Handles chat messages from the server.
 * @param {object} data - Message data { userId, username, avatar, message, timestamp }.
 */
function handleChatMessage(data) {
    // Optional: Implement chat functionality if needed
    console.log("Chat message received:", data);
}
Let's finish with the app initialization and event binding:
javascript// --- App Initialization and Event Binding ---

/**
 * Performs initial setup when the DOM is loaded.
 */
function initializeApp() {
    console.log("Initializing app...");
    
    // Step 1: Cache DOM elements
    cacheDOMElements();
    
    // Step 2: Set up event listeners
    bindEventListeners();
    
    // Step 3: Initialize socket connection
    initializeSocketConnection();
    
    // Step 4: Check initial login status
    checkLoginStatus();
    
    console.log("App initialization complete.");
}

/**
 * Binds event listeners to DOM elements.
 */
function bindEventListeners() {
    console.log("Binding event listeners...");
    
    // --- Navigation Links ---
    document.querySelectorAll('.main-nav a, .secondary-nav a').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const target = link.getAttribute('href');
            // Check if it's an internal page link
            if (target.startsWith('#') && target.length > 1) {
                const pageId = target.substring(1);
                showPage(document.getElementById(pageId));
            } else {
                // External link
                window.open(target, '_blank', 'noopener');
            }
        });
    });
    
    // --- User Profile Dropdown Toggle ---
    const profileBtn = DOMElements.user.userProfile;
    const profileMenu = DOMElements.user.userDropdownMenu;
    if (profileBtn && profileMenu) {
        profileBtn.addEventListener('click', () => {
            const expanded = profileBtn.getAttribute('aria-expanded') === 'true';
            profileBtn.setAttribute('aria-expanded', !expanded);
            profileBtn.classList.toggle('open');
            profileMenu.style.display = expanded ? 'none' : 'block';
            
            // Close when clicking outside
            if (!expanded) {
                const closeMenu = (e) => {
                    if (!profileBtn.contains(e.target) && !profileMenu.contains(e.target)) {
                        profileBtn.setAttribute('aria-expanded', 'false');
                        profileBtn.classList.remove('open');
                        profileMenu.style.display = 'none';
                        document.removeEventListener('click', closeMenu);
                    }
                };
                // Delay adding the event listener to avoid immediate closure
                setTimeout(() => {
                    document.addEventListener('click', closeMenu);
                }, 0);
            }
        });
    }
    
    // --- Login Button ---
    const loginBtn = DOMElements.user.loginButton;
    if (loginBtn) {
        loginBtn.addEventListener('click', () => {
            // Redirect to OAuth login endpoint
            window.location.href = '/auth/steam';
        });
    }
    
    // --- Logout Button ---
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            handleLogout();
        });
    }
    
    // --- Profile Button ---
    const profileOpenBtn = document.getElementById('profile-btn');
    if (profileOpenBtn) {
        profileOpenBtn.addEventListener('click', (e) => {
            e.preventDefault();
            populateProfileModal();
        });
    }
    
    // --- Trade History Button ---
    const historyBtn = document.getElementById('history-btn');
    if (historyBtn) {
        historyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            loadTradeHistory();
            showModal(DOMElements.tradeHistory.modal);
        });
    }
    
    // --- Trade URL Save Button ---
    const saveProfileBtn = document.getElementById('save-profile-btn');
    if (saveProfileBtn) {
        saveProfileBtn.addEventListener('click', (e) => {
            e.preventDefault();
            saveProfile();
        });
    }
    
    // --- Verification Form Submit ---
    const verifyFormBtn = document.getElementById('verify-round-btn');
    if (verifyFormBtn) {
        verifyFormBtn.addEventListener('click', (e) => {
            e.preventDefault();
            verifyRound();
        });
    }
    
    // --- Deposit Buttons ---
    const showDepositBtn = DOMElements.deposit.showDepositModalButton;
    if (showDepositBtn) {
        showDepositBtn.addEventListener('click', () => {
            if (!currentUser) {
                // Not logged in - redirect to login
                window.location.href = '/auth/steam';
                return;
            }
            
            // Show deposit modal and load inventory
            showModal(DOMElements.deposit.depositModal);
            loadUserInventory();
        });
    }
    
    // --- Deposit Modal Actions ---
    const depositBtn = DOMElements.deposit.depositButton;
    if (depositBtn) {
        depositBtn.addEventListener('click', requestDepositOffer);
    }
    
    const acceptOfferBtn = DOMElements.deposit.acceptDepositOfferBtn;
    if (acceptOfferBtn) {
        acceptOfferBtn.addEventListener('click', () => {
            if (currentDepositOfferURL) {
                window.open(currentDepositOfferURL, '_blank', 'noopener,noreferrer');
                showNotification('Opening trade offer in a new tab...', 'info');
            } else {
                showNotification('No offer URL available. Please try again.', 'error');
            }
        });
    }
    
    // --- Modal Close Buttons ---
    document.querySelectorAll('.modal-close, .modal-backdrop').forEach(el => {
        el.addEventListener('click', (e) => {
            // Only close if clicking the backdrop or an explicit close button
            if (e.target.classList.contains('modal-backdrop') || 
                e.target.classList.contains('modal-close')) {
                const modal = e.target.closest('.modal');
                hideModal(modal);
            }
        });
    });
    
    // --- Return to Jackpot Button ---
    const returnBtn = DOMElements.roulette.returnToJackpotButton;
    if (returnBtn) {
        returnBtn.addEventListener('click', () => {
            resetToJackpotView();
        });
    }
    
    console.log("Event listeners bound successfully.");
}

// Initialize the app when DOM content is loaded
document.addEventListener('DOMContentLoaded', initializeApp);
