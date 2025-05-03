// main.js - Rust Jackpot Frontend Logic

// Ensure Socket.IO client library is loaded before this script
// Example: <script src="/socket.io/socket.io.js"></script>

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
        deposited: document.getElementById('profileModalDeposited'), // Assuming this displays total deposited
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
        roundIdInput: document.getElementById('round-id'), // Corrected ID matching your request
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
let currentUser = null; // Stores logged-in user data (null if not logged in) { _id, username, avatar, tradeUrl, totalDeposited, totalWon, pendingDepositOfferId }
let currentRound = null; // Stores data about the current jackpot round { roundId, status, timeLeft, totalValue, participants, items, serverSeedHash, etc. }
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

// --- Helper Functions ---

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
 * @param {string} pageId - The ID of the page element to display ('home-page', 'about-page', etc.).
 */
function showPage(pageId) {
    const pageElement = document.getElementById(pageId);
    if (!pageElement) {
        console.error(`Page element with ID '${pageId}' not found.`);
        return; // Exit if target page doesn't exist
    }

    // Hide all page containers
    Object.values(DOMElements.pages).forEach(page => {
        if (page) page.style.display = 'none';
    });

    // Show the selected page container
    pageElement.style.display = 'block';

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
        loadPastRounds();
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
 * Allows HTML content (use with caution, ensure backend sanitizes any user input in messages).
 * @param {string} message - The message to display (can be HTML).
 * @param {string} type - 'success', 'error', or 'info' (for styling). Default 'info'.
 * @param {number} duration - How long to show the message (ms). Default 4000.
 */
function showNotification(message, type = 'info', duration = 4000) {
    if (!DOMElements.notificationBar) {
        console.warn("Notification bar element (#notification-bar) not found. Using console.log as fallback.");
        console.log(`[${type.toUpperCase()}] ${message}`);
        return;
    }

    const bar = DOMElements.notificationBar;
    // Clear any existing timeout to prevent premature hiding
    if (notificationTimeout) clearTimeout(notificationTimeout);

    bar.innerHTML = message; // Use innerHTML to render links etc. Sanitize on backend!
    // Remove previous type classes and add the new one
    bar.className = 'notification-bar'; // Reset classes
    bar.classList.add(type); // Add the type class for styling
    bar.classList.add('show'); // Add 'show' class to trigger CSS transition/animation

    // Set a timeout to hide the notification
    notificationTimeout = setTimeout(() => {
        bar.classList.remove('show');
        notificationTimeout = null; // Clear the timeout ID
    }, duration);
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

// --- Color Utility Functions --- (Used for Confetti)
function getComplementaryColor(hex) {
    hex = hex.replace('#', '');
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);
    r = 255 - r; g = 255 - g; b = 255 - b;
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function lightenColor(hex, percent) {
    hex = hex.replace('#', '');
    let r = parseInt(hex.substring(0, 2), 16);
    let g = parseInt(hex.substring(2, 4), 16);
    let b = parseInt(hex.substring(4, 6), 16);
    r = Math.min(255, Math.floor(r + (255 - r) * (percent / 100)));
    g = Math.min(255, Math.floor(g + (255 - g) * (percent / 100)));
    b = Math.min(255, Math.floor(b + (255 - b) * (percent / 100)));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function darkenColor(hex, percent) {
    hex = hex.replace('#', '');
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
 * @param {string|number} dateInput - Date string or timestamp
 * @returns {string} Formatted date string
 */
function formatDate(dateInput) {
    if (!dateInput) return 'N/A';

    try {
        const date = new Date(dateInput);
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

// --- Logout Function ---
/**
 * Handles the user logout process by calling the backend.
 */
async function handleLogout() {
    console.log("Attempting logout...");
    try {
        const response = await fetch('/logout', { // Assuming '/logout' is your backend endpoint
            method: 'POST',
            headers: {
                // Add CSRF token header if your session setup requires it
                // 'X-CSRF-Token': 'your_csrf_token_here'
            }
        });

        if (!response.ok) {
             const result = await response.json().catch(() => ({ error: 'Logout request failed.' }));
            throw new Error(result.error || `Logout request failed with status ${response.status}.`);
        }

        const result = await response.json();
         if (!result.success) {
             throw new Error(result.error || 'Logout unsuccessful according to server.');
         }

        console.log('Logout successful.');
        currentUser = null; // Clear local user state
        updateUserUI(); // Update header to show login button
        updateDepositButtonState(); // Update deposit button state
        showNotification('You have been successfully signed out.', 'success');
        // Optionally reload the page for a full reset:
        // window.location.reload();

    } catch (error) {
        console.error('Logout Error:', error);
        showNotification(`Logout failed: ${error.message}`, 'error');
    } finally {
        // Ensure dropdown is closed after attempt
        const { userDropdownMenu, userProfile } = DOMElements.user;
        if (userDropdownMenu) {
            userDropdownMenu.style.display = 'none';
            userProfile?.setAttribute('aria-expanded', 'false');
            userProfile?.classList.remove('open'); // Remove open class for CSS styling
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
        acceptDepositOfferBtn.removeAttribute('data-offer-url'); // Clear stored URL (though not strictly needed as we use state var)
    }
    if (depositStatusText) {
        depositStatusText.textContent = ''; // Clear status text
        depositStatusText.className = 'deposit-status-text'; // Reset class
    }
    currentDepositOfferURL = null; // Clear state variable
}


// --- Trade History Functions ---

/**
 * Fetches the user's trade history from the backend
 */
async function loadTradeHistory() {
    const { loading, table, tableBody, emptyMessage, modal } = DOMElements.tradeHistory;

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
    loading.style.display = 'flex';

    try {
        // Endpoint could be /api/trades or /api/user/trades
        const response = await fetch('/api/trades', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
                // Add authentication headers if needed (e.g., JWT, session cookie handled by browser)
            }
        });

        if (!response.ok) {
             const errorData = await response.json().catch(() => ({ error: `HTTP error ${response.status}` }));
            throw new Error(errorData.error || `Error fetching trade history: ${response.status}`);
        }

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
            return;
        }

        // Store trade history in memory
        tradeHistory = data.trades;

        // Show table and populate rows
        table.style.display = 'table';
        populateTradeHistoryTable(tradeHistory);

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
        DOMElements.tradeHistory.table.style.display = 'none';
        DOMElements.tradeHistory.emptyMessage.style.display = 'block';
        return;
    }

    // Ensure table is visible and empty message is hidden if we have trades
    DOMElements.tradeHistory.table.style.display = 'table';
    DOMElements.tradeHistory.emptyMessage.style.display = 'none';

    trades.forEach(trade => {
        const row = document.createElement('tr');

        // Get status class for styling
        const statusClass = getTradeStatusClass(trade.status);

        // Format items count and value
        const itemsText = trade.items ? `${trade.items.length} item${trade.items.length !== 1 ? 's' : ''}` : 'N/A';
        const valueText = typeof trade.totalValue === 'number' ? `$${trade.totalValue.toFixed(2)}` : 'N/A';

        row.innerHTML = `
            <td>${formatDate(trade.createdAt)}</td>
            <td>${trade.roundId || 'N/A'}</td>
            <td>${trade.type === 'deposit' ? 'Deposit' : trade.type === 'winnings' ? 'Winnings' : (trade.type || 'N/A')}</td>
            <td>${itemsText}</td>
            <td>${valueText}</td>
            <td><span class="trade-history-status ${statusClass}">${formatTradeStatus(trade.status)}</span></td>
            <td>
                ${trade.offerId && trade.status !== 'declined' && trade.status !== 'expired' && trade.status !== 'accepted' ?
                    `<button class="btn btn-small btn-accept-offer" data-offer-id="${trade.offerId}">View Offer</button>`
                    : trade.offerId && trade.status === 'accepted' ? `<span class="trade-history-status accepted">(Accepted)</span>` : ''}
            </td>
        `;

        // Add event listeners to action buttons
        const viewOfferBtn = row.querySelector('.btn-accept-offer');
        if (viewOfferBtn) {
            viewOfferBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const offerId = viewOfferBtn.dataset.offerId;
                const offerUrl = `https://steamcommunity.com/tradeoffer/${offerId}/`;
                window.open(offerUrl, '_blank', 'noopener,noreferrer');
            });
        }

        tableBody.appendChild(row);
    });
}

/**
 * Returns appropriate CSS class for trade status
 * @param {string} status - Trade status
 * @returns {string} CSS class
 */
function getTradeStatusClass(status) {
    switch (status?.toLowerCase()) { // Added optional chaining and lowercase check
        case 'pending':
        case 'sent': // Treat 'sent' like 'pending' visually
            return 'pending';
        case 'accepted':
        case 'complete': // Treat 'complete' like 'accepted' visually
            return 'accepted';
        case 'declined':
            return 'declined';
        case 'expired':
        case 'canceled': // Treat 'canceled' like 'expired' visually
            return 'expired';
        default:
            return 'info'; // Default style for unknown statuses
    }
}

/**
 * Formats trade status text for display
 * @param {string} status - Trade status
 * @returns {string} Formatted status text
 */
function formatTradeStatus(status) {
    if (!status) return 'N/A';
    // Capitalize first letter, handle different variations
    switch (status.toLowerCase()) {
        case 'pending': return 'Pending';
        case 'sent': return 'Sent';
        case 'accepted': return 'Accepted';
        case 'complete': return 'Complete';
        case 'declined': return 'Declined';
        case 'expired': return 'Expired';
        case 'canceled': return 'Canceled';
        default: return status.charAt(0).toUpperCase() + status.slice(1); // Capitalize unknown statuses too
    }
}

// --- Core Application Logic ---

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
    button.classList.toggle('deposit-disabled', disabled); // Optional class for styling
}

/**
 * Fetches the user's login status from the backend API.
 */
async function checkLoginStatus() {
    try {
        const response = await fetch('/api/user'); // Assumes API endpoint exists
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
            // Ensure essential fields exist (example)
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
        // showNotification(`Error checking login: ${error.message}`, 'error');
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
            const hasPending = !!currentUser.pendingDepositOfferId;
            pendingOfferIndicator.style.display = hasPending ? 'inline-block' : 'none';
             if (hasPending) {
                 pendingOfferIndicator.title = `You have a pending deposit offer (#${currentUser.pendingDepositOfferId})! Click your profile to see details.`;
                 // Optional: Add a pulse animation class
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
        const response = await fetch('/api/inventory'); // Assumes API endpoint exists
        if (!response.ok) {
            let errorMsg = 'Inventory load failed.';
            try {
                const errorData = await response.json();
                errorMsg = errorData.error || `Inventory load failed (${response.status})`;
            } catch (e) { /* Ignore if response is not JSON */ }

            if (response.status === 401 || response.status === 403) {
                errorMsg = 'Please log in first.';
                hideModal(depositModal); // Close modal if user is not logged in
                showNotification(errorMsg, 'error');
            }
            throw new Error(errorMsg);
        }

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
        // Error is shown within the modal, no need for separate notification unless modal was closed (e.g., 401)
    }
}

/**
 * Renders the user's inventory items in the deposit modal.
 */
function displayInventoryItems() {
    const container = DOMElements.deposit.inventoryItemsContainer;
    if (!container) return;
    container.innerHTML = ''; // Clear previous items

    userInventory.forEach(item => {
        // Basic validation of item structure
        if (!item || typeof item.price !== 'number' || isNaN(item.price) ||
            !item.assetId || !item.name || !item.image) {
            console.warn("Skipping invalid inventory item:", item);
            return; // Skip this item
        }

        const itemElement = document.createElement('div');
        itemElement.className = 'inventory-item';
        itemElement.dataset.assetId = item.assetId;
        itemElement.dataset.name = item.name;
        itemElement.dataset.image = item.image;
        itemElement.dataset.price = item.price.toFixed(2);

        itemElement.innerHTML = `
            <img src="${item.image}" alt="${item.name}" loading="lazy"
                 onerror="this.onerror=null; this.src='/img/default-item.png';">
            <div class="item-details">
                <div class="item-name" title="${item.name}">${item.name}</div>
                <div class="item-value">$${item.price.toFixed(2)}</div>
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
        <img src="${item.image}" alt="${item.name}" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-item.png';">
        <div class="item-name" title="${item.name}">${item.name}</div>
        <div class="item-value">$${item.price.toFixed(2)}</div>
        <button class="remove-item-btn" title="Remove ${item.name}" data-asset-id="${item.assetId}" aria-label="Remove ${item.name}">&times;</button>
        `; // Added a remove button

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
    const selectedElement = container?.querySelector(`.selected-item-display[data-asset-id="${assetId}"]`); // Match class used in addSelectedItemElement
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

    totalValueDisplay.textContent = `$${total.toFixed(2)}`;

    // Update deposit button state (inside modal)
    if (depositButton) {
        depositButton.disabled = selectedItemsList.length === 0;
    }
}


/**
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
         if (isNewParticipant && participantsLength >= CONFIG.MAX_PARTICIPANTS_DISPLAY) preCheckError = `Deposit Error: Participant limit (${CONFIG.MAX_PARTICIPANTS_DISPLAY}) reached.`;
         else {
             const itemsInPot = currentRound.items?.length || 0;
             if (itemsInPot + selectedItemsList.length > CONFIG.MAX_ITEMS_PER_POT_FRONTEND) { const slotsLeft = CONFIG.MAX_ITEMS_PER_POT_FRONTEND - itemsInPot; preCheckError = `Deposit Error: Pot item limit would be exceeded (Max ${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}). Only ${slotsLeft} slot${slotsLeft !== 1 ? 's' : ''} left.`; }
         }
    }

    if (preCheckError) {
         showNotification(preCheckError, 'error', 6000);
         if (preCheckError.includes('pending offer') && DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
         return;
    }
    // --- End Pre-checks ---


    depositButton.disabled = true;
    depositButton.textContent = 'Requesting...';
    acceptDepositOfferBtn.style.display = 'none';
    depositStatusText.textContent = 'Creating deposit offer... Please wait.';
    depositStatusText.className = 'deposit-status-text info';

    let response; // Declare outside try for use in catch/finally

    try {
        const assetIds = selectedItemsList.map(item => item.assetId);
        console.log("Requesting deposit offer for assetIds:", assetIds);

        response = await fetch('/api/deposit', {
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
                if (currentUser && currentUser.pendingDepositOfferId !== result.offerId) { currentUser.pendingDepositOfferId = result.offerId; updateUserUI(); updateDepositButtonState(); }
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
        if(currentUser) { currentUser.pendingDepositOfferId = result.offerId; updateUserUI(); updateDepositButtonState(); } // Update user state and global UI

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
        // Only fully reset UI if it wasn't a 409 (pending offer exists) error
        if (!(response && response.status === 409)) {
            resetDepositModalUI();
             // Ensure pending offer ID is cleared locally if a non-409 error occurred
             if (currentUser && currentUser.pendingDepositOfferId) {
                 console.log("Clearing potentially stale pending offer ID due to error.");
                 currentUser.pendingDepositOfferId = null; updateUserUI(); updateDepositButtonState();
             }
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

    potValue.textContent = `$${currentTotalValue.toFixed(2)}`;
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
    const timerElement = DOMElements.jackpot.timerValue;
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
    } else {
        // Optional: Log a warning if the element is not as expected
        // console.warn("timerForeground is not an SVG circle or 'r' attribute missing.");
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
        const participantData = currentRound.participants.find(p => p.user?._id === userId || p.user === userId); // Handle potential string ID

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
            valueElement.textContent = `$${cumulativeValue.toFixed(2)} | ${percentage}%`;
            valueElement.title = `Deposited: $${cumulativeValue.toFixed(2)} | Chance: ${percentage}%`;
            valueElement.style.color = userColor; // Apply user color
        }
    });
}


/**
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
        <img src="${avatar}" alt="${username}" class="player-avatar" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-avatar.png';" style="border-color: ${userColor};">
        <div class="player-info">
            <div class="player-name" title="${username}">${username}</div>
            <div class="player-deposit-value" style="color: ${userColor}" title="Deposited: $${cumulativeValue.toFixed(2)} | Chance: ${percentage}%">
                $${cumulativeValue.toFixed(2)} | ${percentage}%
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
            itemElement.title = `${item.name} ($${item.price.toFixed(2)})`;
            itemElement.style.borderColor = userColor; // Use the same user color for item border
            // Apply user color to item value as well
            itemElement.innerHTML = `
                <img src="${item.image}" alt="${item.name}" class="player-deposit-item-image" loading="lazy"
                     onerror="this.onerror=null; this.src='/img/default-item.png';">
                <div class="player-deposit-item-info">
                    <div class="player-deposit-item-name" title="${item.name}">${item.name}</div>
                    <div class="player-deposit-item-value" style="color: ${userColor}">$${item.price.toFixed(2)}</div>
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
                  // If trade history modal is open, update it
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
    let participantIndex = currentRound.participants.findIndex(p => p.user?._id === data.userId || p.user === data.userId);

    if (participantIndex !== -1) {
        // Update existing participant's total value and tickets
        // Ensure itemsValue is additive based on this deposit's value
        currentRound.participants[participantIndex].itemsValue = (currentRound.participants[participantIndex].itemsValue || 0) + data.itemsValue;
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
        // Ensure empty message is inside container if needed
        // if (!container.contains(emptyMsg)) { container.appendChild(emptyMsg); }
    } else {
        emptyMsg.style.display = 'none';
    }
}


/**
 * Function to test deposit display with mock data. Adds a new deposit block to the top.
 * NOTE: For development/testing only.
 */
function testDeposit() {
    console.log("--- TESTING DEPOSIT DISPLAY (Adds to Top) ---");

    // Ensure a mock round exists
    if (!currentRound) {
        currentRound = { roundId: 'test-round-123', status: 'active', totalValue: 0, participants: [], items: [], timeLeft: CONFIG.ROUND_DURATION };
    } else {
        currentRound.status = 'active';
        if (!currentRound.participants) currentRound.participants = [];
        if (!currentRound.items) currentRound.items = [];
    }

    const randomValue = parseFloat((Math.random() * 50 + 1).toFixed(2));
    const mockUserId = `mock_${Math.floor(Math.random() * 1000)}`;
    const mockUsername = ["RustPlayer99", "ScrapCollector", "AK47Master", "TheNaked", "ZergLeader", "TheRaider", "OilRigEnjoyer"][Math.floor(Math.random() * 7)];
    const mockAvatar = ['https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg', 'https://avatars.steamstatic.com/bb8a0a497b4b1f46b96b6b0775e9368fc8c5c3b4_full.jpg', 'https://avatars.steamstatic.com/3c4c5a7c9968414c3a1ddd1e73cb8e6aeeec5f32_full.jpg', '/img/default-avatar.png'][Math.floor(Math.random() * 4)];

    // --- Simulate data structure expected by handleNewDeposit ---
    const depositedItemsMock = [];
    const rustItemNames = ["Assault Rifle", "Metal Facemask", "Garage Door", "Semi-Automatic Rifle", "Road Sign Kilt", "Coffee Can Helmet", "Sheet Metal Door", "Medical Syringe", "MP5A4", "LR-300", "Bolt Action Rifle", "Satchel Charge", "Explosive Ammo", "High Quality Metal", "Crude Oil", "Tech Trash", "Scrap"];
    const numItems = Math.floor(Math.random() * 5) + 1;
    let remainingValue = randomValue;
    for (let i = 0; i < numItems; i++) {
        const isLast = i === numItems - 1;
        let itemPrice = isLast ? remainingValue : parseFloat((Math.random() * remainingValue * 0.7 + 0.01).toFixed(2));
        itemPrice = Math.max(0.01, Math.min(itemPrice, remainingValue));
        remainingValue -= itemPrice;
        depositedItemsMock.push({
             assetId: `test_asset_${Date.now()}_${i}`, name: rustItemNames[Math.floor(Math.random() * rustItemNames.length)],
             image: `/img/default-item.png`, price: parseFloat(itemPrice.toFixed(2))
         });
         if (remainingValue <= 0 && !isLast) break; // Stop if value used up early
    }
     // Adjust last item price for precision
     const calculatedSum = depositedItemsMock.reduce((sum, item) => sum + item.price, 0);
     if (depositedItemsMock.length > 0 && Math.abs(calculatedSum - randomValue) > 0.001) {
          const diff = randomValue - calculatedSum;
          depositedItemsMock[depositedItemsMock.length-1].price = Math.max(0.01, parseFloat((depositedItemsMock[depositedItemsMock.length-1].price + diff).toFixed(2)));
     }
     const actualItemsValue = depositedItemsMock.reduce((sum, item) => sum + item.price, 0); // Use actual sum

    // Simulate server calculation for cumulative values and tickets AFTER this deposit
    const existingParticipantData = currentRound.participants.find(p => p.user?._id === mockUserId);
    const newTotalValueAfterDeposit = (currentRound.totalValue || 0) + actualItemsValue;
    const newCumulativeValueForUser = (existingParticipantData ? existingParticipantData.itemsValue : 0) + actualItemsValue;
    const newTotalTicketsForUser = Math.max(1, Math.floor(newCumulativeValueForUser * 100)); // Example ticket calc

    const mockDepositData = {
        roundId: currentRound.roundId,
        userId: mockUserId,
        username: mockUsername,
        avatar: mockAvatar,
        itemsValue: actualItemsValue, // Value of *this* deposit
        tickets: newTotalTicketsForUser, // Participant's *new total* tickets after this deposit
        totalValue: newTotalValueAfterDeposit, // *New* total pot value after this deposit
        depositedItems: depositedItemsMock // Items in *this* deposit
    };
    // --- End Simulation ---

    console.log("Mock Deposit Data (Passed to handleNewDeposit):", mockDepositData);
    // Call the main handler which will update the state and then call display functions
    handleNewDeposit(mockDepositData);
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
// --- Roulette/Winner Animation Functions ---

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
            <img class="roulette-avatar" src="${avatar}" alt="${username}" loading="lazy"
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
        // For now, just log the error and potentially reset
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
            console.log("Added pending winning trade to local history:", newTrade);

            // If trade history modal is open, update it
            if (DOMElements.tradeHistory.modal.style.display === 'flex') {
                populateTradeHistoryTable(tradeHistory);
            }
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

    // Optional: Select specific elements to hide if needed
    // const valueDisplay = header.querySelector('.jackpot-value');
    // const timerDisplay = header.querySelector('.jackpot-timer');
    // const statsDisplay = header.querySelector('.jackpot-stats');

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
        }
        // Optional bounce phase
        else if (CONFIG.BOUNCE_ENABLED && elapsed <= totalAnimationTime) {
            const bouncePhaseProgress = (elapsed - duration) / bounceDuration;
            const bounceDisplacementFactor = calculateBounce(bouncePhaseProgress); // Apply bounce calculation
            currentPosition = finalTargetPosition - (overshootAmount * bounceDisplacementFactor);
        }
        // Animation complete
        else {
            currentPosition = finalTargetPosition; // Snap to final position
            animationFinished = true;
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
        const depositValueStr = `$${(winner.value || 0).toFixed(2)}`;
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
    // Clear any other potential intervals (e.g., sound fade, typing effects if used)
    // if (window.soundFadeInInterval) clearInterval(window.soundFadeInInterval); window.soundFadeInInterval = null;
    // if (window.typeDepositInterval) clearInterval(window.typeDepositInterval); window.typeDepositInterval = null;
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
        sound.volume = 1.0;
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


/**
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
    // Ensure logical timer state is reset (done in resetToJackpotView)
    // if (roundTimer) clearInterval(roundTimer); roundTimer = null;
    // timerActive = false;

    // Reset Participants List Display
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (container) {
        container.innerHTML = ''; // Clear existing blocks
        if (emptyMsg) {
            // Ensure empty message exists in DOM (append if not) and display it
            if (!container.contains(emptyMsg)) {
                // Example: Create if doesn't exist (adjust based on your HTML structure)
                // const p = document.createElement('p');
                // p.id = 'emptyPotMessage'; p.className = 'empty-pot-message';
                // p.textContent = 'Pot is empty. Deposit items to start!';
                // DOMElements.jackpot.emptyPotMessage = p; // Update reference
                // container.appendChild(p);
                 console.warn("Empty pot message element was not initially found in container.");
            }
             if(emptyMsg) emptyMsg.style.display = 'block'; // Show empty message
        }
    }

    // Reset Pot Value and Participant Count Display in Header
    if (DOMElements.jackpot.potValue) DOMElements.jackpot.potValue.textContent = "$0.00";
    updateParticipantsUI(); // Update count display (will show 0/MAX)

    userColorMap.clear(); // Clear user color mappings for the new round
    // updateDepositButtonState(); // Called by resetToJackpotView after this function
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
    const winnerParticipant = currentRound.participants.find(p => p.user?._id === winnerId || p.user === winnerId);

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


/**
 * Test function to trigger the roulette animation with mock or current round data.
 * NOTE: For development/testing only.
 */
function testRouletteAnimation() {
    console.log("--- TESTING ROULETTE ANIMATION ---");

    if (isSpinning) {
        showNotification("Already spinning, test cancelled.", 'info');
        return;
    }

    let testRoundData = currentRound; // Use current data if available

    // If no current data or no participants, create mock data
    if (!testRoundData || !testRoundData.participants || testRoundData.participants.length === 0) {
        console.log('Using sample Rust test data for animation...');
        testRoundData = {
            _id: 'mock-round-' + Date.now(),
            roundId: `test-${Date.now()}`, status: 'active', totalValue: 215.50, timeLeft: 60,
            participants: [
                { user: { _id: 'rust_user_1', username: 'Scrap King', avatar: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg' }, itemsValue: 150.25, tickets: 15025 },
                { user: { _id: 'rust_user_2', username: 'Foundation Wipe', avatar: 'https://avatars.steamstatic.com/bb8a0a497b4b1f46b96b6b0775e9368fc8c5c3b4_full.jpg' }, itemsValue: 45.75, tickets: 4575 },
                { user: { _id: 'rust_user_3', username: 'Heli Enjoyer', avatar: 'https://avatars.steamstatic.com/3c4c5a7c9968414c3a1ddd1e73cb8e6aeeec5f32_full.jpg' }, itemsValue: 19.50, tickets: 1950 }
            ],
            items: [ // Sample items
                 { owner: 'rust_user_1', name: 'Assault Rifle', price: 50.00, image: '/img/default-item.png' },
                 { owner: 'rust_user_1', name: 'Metal Facemask', price: 40.25, image: '/img/default-item.png' },
                 { owner: 'rust_user_1', name: 'Garage Door', price: 60.00, image: '/img/default-item.png' },
                 { owner: 'rust_user_2', name: 'Semi Rifle', price: 25.75, image: '/img/default-item.png' },
                 { owner: 'rust_user_2', name: 'Roadsign Kilt', price: 20.00, image: '/img/default-item.png' },
                 { owner: 'rust_user_3', name: 'Medical Syringe', price: 9.50, image: '/img/default-item.png' },
                 { owner: 'rust_user_3', name: 'Satchel Charge', price: 10.00, image: '/img/default-item.png' },
            ]
        };
        currentRound = testRoundData; // Update global state with mock data for the test
        // Visually reset and populate based on mock data
        initiateNewRoundVisualReset(); // Clear previous display
        updateRoundUI(); // Update header
        if (currentRound.participants?.length > 0) {
             // Render mock participants
             currentRound.participants.forEach(p => {
                 const userItems = currentRound.items?.filter(item => item.owner === p.user?._id) || [];
                 // Use displayLatestDeposit format, ensuring itemsValue is cumulative for the participant
                 displayLatestDeposit({ userId: p.user._id, username: p.user.username, avatar: p.user.avatar, itemsValue: p.itemsValue, depositedItems: userItems });
                 const element = DOMElements.jackpot.participantsContainer?.querySelector(`.player-deposit-container[data-user-id="${p.user._id}"]`);
                 if (element) element.classList.remove('player-deposit-new'); // Remove entry animation immediately
             });
             updateAllParticipantPercentages(); // Ensure all percentages correct after populating
        }
    } else {
        currentRound.status = 'active'; // Ensure suitable status if using real data
    }

    if (!currentRound?.participants?.length > 0) {
        showNotification('Test Error: No participants available for test spin.', 'error');
        return;
    }

    // Select a random winner from the participants
    const idx = Math.floor(Math.random() * currentRound.participants.length);
    const winningParticipant = currentRound.participants[idx];

    if (!winningParticipant?.user?._id) { // Check if valid participant selected
        console.error("Selected winning participant invalid:", winningParticipant);
        showNotification('Test Error: Could not select valid winner.', 'error');
        return;
    }

    // Create the data structure expected by handleWinnerAnnouncement
    const mockWinnerEventData = {
        roundId: currentRound.roundId,
        winner: { ...winningParticipant.user }, // Pass a copy of the user object
        winningTicket: Math.floor(Math.random() * (winningParticipant.tickets || 1)) + 1 // Mock ticket
        // offerId: 'mock_offer_123' // Optional: Mock offer ID
    };

    console.log('Test Winner Selected:', mockWinnerEventData.winner.username);
    handleWinnerAnnouncement(mockWinnerEventData); // Trigger animation flow
}

// --- Provably Fair Section Functions ---

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
        resultEl.className = 'verification-result error';
        resultEl.innerHTML = `<p>${validationError}</p>`;
        return;
    }

    try {
        resultEl.style.display = 'block';
        resultEl.className = 'verification-result loading';
        resultEl.innerHTML = '<p>Verifying...</p>';

        const response = await fetch('/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roundId, serverSeed, clientSeed })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || `Verification failed (${response.status})`);
        }

        // Display result
        resultEl.className = `verification-result ${result.verified ? 'success' : 'error'}`;
        let html = `<h4>Result (Round #${result.roundId || roundId})</h4>`;

        if (result.verified) {
            html += `<p style="color: var(--success-color); font-weight: bold;">✅ Verified Fair.</p>`;
            if (result.serverSeedHash) html += `<p><strong>Server Seed Hash (Used):</strong> <code class="seed-value">${result.serverSeedHash}</code></p>`;
            if (result.serverSeed) html += `<p><strong>Server Seed (Provided):</strong> <code class="seed-value">${result.serverSeed}</code></p>`;
            if (result.clientSeed) html += `<p><strong>Client Seed (Provided):</strong> <code class="seed-value">${result.clientSeed}</code></p>`;
            if (result.combinedString) html += `<p><strong>Combined String (Server-Client):</strong> <code class="seed-value wrap-anywhere">${result.combinedString}</code></p>`;
            if (result.finalHash) html += `<p><strong>Resulting SHA256 Hash:</strong> <code class="seed-value">${result.finalHash}</code></p>`;
            if (result.winningTicket !== undefined) html += `<p><strong>Winning Ticket Number:</strong> ${result.winningTicket} (out of ${result.totalTickets || 'N/A'} total tickets)</p>`;
            if (result.winnerUsername) html += `<p><strong>Verified Winner:</strong> ${result.winnerUsername}</p>`;
            if (result.totalValue !== undefined) html += `<p><strong>Final Pot Value:</strong> $${result.totalValue.toFixed(2)}</p>`;
        } else {
            html += `<p style="color: var(--error-color); font-weight: bold;">❌ Verification Failed.</p>`;
            html += `<p><strong>Reason:</strong> ${result.reason || 'Mismatch detected.'}</p>`;
            // Include relevant details based on what the backend might send on failure
            if (result.serverSeedHash) html += `<p><strong>Expected Server Seed Hash:</strong> <code class="seed-value">${result.serverSeedHash}</code></p>`;
            if (result.calculatedHash) html += `<p><strong>Calculated Hash from Provided Seed:</strong> <code class="seed-value">${result.calculatedHash}</code></p>`;
            if (result.serverSeed) html += `<p><strong>Expected Server Seed:</strong> <code class="seed-value">${result.serverSeed}</code></p>`;
            if (result.clientSeed) html += `<p><strong>Expected Client Seed:</strong> <code class="seed-value">${result.clientSeed}</code></p>`;
            if (result.calculatedWinningTicket !== undefined) html += `<p><strong>Calculated Ticket from Inputs:</strong> ${result.calculatedWinningTicket}</p>`;
            if (result.actualWinningTicket !== undefined) html += `<p><strong>Actual Recorded Ticket:</strong> ${result.actualWinningTicket}</p>`;
            if (result.totalTickets !== undefined) html += `<p><strong>Total Tickets in Round:</strong> ${result.totalTickets}</p>`;
        }
        resultEl.innerHTML = html;

    } catch (error) {
        resultEl.style.display = 'block';
        resultEl.className = 'verification-result error';
        resultEl.innerHTML = `<p>Verification Error: ${error.message}</p>`;
        console.error('Error verifying round:', error);
    }
}

/**
 * Loads a page of past round history from the backend API.
 * @param {number} [page=1] - The page number to load.
 */
async function loadPastRounds(page = 1) {
    const tableBody = DOMElements.provablyFair.roundsTableBody;
    const paginationContainer = DOMElements.provablyFair.roundsPagination;

    if (!tableBody || !paginationContainer) {
        console.warn("Rounds history table/pagination elements missing.");
        return;
    }

    try {
        tableBody.innerHTML = '<tr><td colspan="5" class="loading-message">Loading round history...</td></tr>';
        paginationContainer.innerHTML = ''; // Clear old pagination

        const response = await fetch(`/api/rounds?page=${page}&limit=10`); // Fetch specific page

        if (!response.ok) {
             const errorData = await response.json().catch(() => ({ error: `HTTP error ${response.status}` }));
            throw new Error(errorData.error || `Failed to load round history (${response.status})`);
        }
        const data = await response.json();

        // Validate response structure
        if (!data || !Array.isArray(data.rounds) || typeof data.currentPage !== 'number' || typeof data.totalPages !== 'number') {
            throw new Error('Invalid rounds data received from server.');
        }

        tableBody.innerHTML = ''; // Clear loading message

        if (data.rounds.length === 0) {
            const message = (page === 1) ? 'No past rounds found.' : 'No rounds found on this page.';
            tableBody.innerHTML = `<tr><td colspan="5" class="no-rounds-message">${message}</td></tr>`;
        } else {
            data.rounds.forEach(round => {
                const row = document.createElement('tr');
                row.dataset.roundId = round.roundId; // Use roundId from data

                const dateStr = formatDate(round.completedTime || round.endTime || round.startTime); // Use best available time
                const roundIdStr = round.roundId || 'N/A';
                // Use optional chaining for winner username
                const winnerUsername = round.winner?.username || (round.status === 'error' ? 'ERROR' : 'N/A');
                const potValueStr = (round.totalValue !== undefined) ? `$${round.totalValue.toFixed(2)}` : '$0.00';

                // Escape single quotes in seeds for the onclick attribute
                const serverSeedStr = (round.serverSeed || '').replace(/'/g, "\\'");
                const clientSeedStr = (round.clientSeed || '').replace(/'/g, "\\'");

                row.innerHTML = `
                    <td>#${roundIdStr}</td>
                    <td>${dateStr}</td>
                    <td>${potValueStr}</td>
                    <td class="${round.winner ? 'winner-cell' : ''}">${winnerUsername}</td>
                    <td>
                         <button class="btn btn-secondary btn-small btn-details" onclick="window.showRoundDetails('${roundIdStr}')" ${roundIdStr === 'N/A' ? 'disabled' : ''}>Details</button>
                        <button class="btn btn-secondary btn-small btn-verify" onclick="window.populateVerificationFields('${roundIdStr}', '${serverSeedStr}', '${clientSeedStr}')" ${!round.serverSeed ? 'disabled title="Seed not revealed yet"' : ''}>Verify</button>
                    </td>`;
                tableBody.appendChild(row);
            });
        }
        // Create pagination controls based on response
        createPagination(data.currentPage, data.totalPages);
    } catch (error) {
        tableBody.innerHTML = `<tr><td colspan="5" class="error-message">Error loading rounds: ${error.message}</td></tr>`;
        console.error('Error loading past rounds:', error);
    }
}

/**
 * Populates the verification form fields. Made globally accessible via window.
 * @param {string} roundId
 * @param {string} serverSeed
 * @param {string} clientSeed
 */
window.populateVerificationFields = function(roundId, serverSeed, clientSeed) {
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationSection, verificationResultDisplay } = DOMElements.provablyFair;

    if (roundIdInput) roundIdInput.value = roundId || '';
    if (serverSeedInput) serverSeedInput.value = serverSeed || '';
    if (clientSeedInput) clientSeedInput.value = clientSeed || '';

    // Clear previous verification result when populating
    if (verificationResultDisplay) {
        verificationResultDisplay.innerHTML = '';
        verificationResultDisplay.style.display = 'none';
    }

    // Scroll to the verification section smoothly
    if (verificationSection) {
        verificationSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    if (!serverSeed && roundId && roundId !== 'N/A') {
        showNotification(`Info: Server Seed for Round #${roundId} is revealed after the round ends.`, 'info');
    }
};

/**
 * Shows round details in a modal or dedicated view (fetches from backend).
 * Made globally accessible via window.
 * @param {string} roundId
 */
window.showRoundDetails = async function(roundId) {
    console.log(`Showing details for round ${roundId}`);
    if (!roundId || roundId === 'N/A') {
        showNotification('Info: Invalid Round ID for details.', 'info');
        return;
    }

    // Show loading state (e.g., in notification)
    showNotification(`Loading details for Round #${roundId}...`, 'info', 2000);

    try {
        // Fetch detailed round data from backend
        const response = await fetch(`/api/rounds/${roundId}/details`);

        if (!response.ok) {
             const errorData = await response.json().catch(() => ({ error: `HTTP error ${response.status}` }));
            throw new Error(errorData.error || `Failed to fetch round details (${response.status})`);
        }

        const roundDetails = await response.json();
        if (!roundDetails || typeof roundDetails !== 'object') {
             throw new Error("Invalid details data received.");
        }

        // --- Create and Populate Modal ---
        // (This creates a new modal each time; consider reusing a single modal element)
        const existingModal = document.getElementById('roundDetailsModalInstance');
        existingModal?.remove(); // Remove previous instance if any

        const detailsModal = document.createElement('div');
        detailsModal.id = 'roundDetailsModalInstance'; // Give it an ID for potential removal
        detailsModal.className = 'modal round-details-modal'; // Add specific class for styling
        detailsModal.style.display = 'flex'; // Show it

        // Safely access nested properties using optional chaining (?.)
        detailsModal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2>Round #${roundId} Details</h2>
                    <button class="close-btn" id="closeDetailsModalInstance">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="content-section">
                        <h3 class="content-section-title">Round Information</h3>
                        <div class="content-section-body">
                            <p><strong>Status:</strong> ${roundDetails.status || 'N/A'}</p>
                            <p><strong>Started:</strong> ${formatDate(roundDetails.startTime)}</p>
                            <p><strong>Completed:</strong> ${formatDate(roundDetails.completedTime)}</p>
                            <p><strong>Final Pot Value:</strong> $${(roundDetails.totalValue ?? 0).toFixed(2)}</p>
                            <p><strong>Winner:</strong> ${roundDetails.winner?.username || 'N/A'}</p>
                            <p><strong>Winning Ticket:</strong> ${roundDetails.winningTicket ?? 'N/A'}</p>
                            <p><strong>Total Participants:</strong> ${roundDetails.participants?.length || 0}</p>
                            <p><strong>Total Items:</strong> ${roundDetails.items?.length || 0}</p>
                        </div>
                    </div>

                    ${(roundDetails.participants && roundDetails.participants.length > 0) ? `
                    <div class="content-section">
                        <h3 class="content-section-title">Participants</h3>
                        <div class="content-section-body">
                            <table class="history-table participant-details-table">
                                <thead><tr><th>User</th><th>Value</th><th>Tickets</th><th>Chance</th></tr></thead>
                                <tbody>
                                    ${roundDetails.participants.map(p => {
                                        const totalTickets = roundDetails.participants.reduce((sum, part) => sum + (part.tickets || 0), 0);
                                        const chance = totalTickets > 0 ? (( (p.tickets || 0) / totalTickets) * 100).toFixed(2) : '0.00';
                                        return `<tr>
                                            <td>${p.user?.username || 'Unknown'}</td>
                                            <td>$${(p.itemsValue ?? 0).toFixed(2)}</td>
                                            <td>${p.tickets ?? 0}</td>
                                            <td>${chance}%</td>
                                        </tr>`;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>` : ''}

                    ${(roundDetails.serverSeed) ? `
                    <div class="content-section">
                        <h3 class="content-section-title">Provable Fairness</h3>
                        <div class="content-section-body">
                            <p><strong>Server Seed:</strong> <code class="seed-value">${roundDetails.serverSeed}</code></p>
                            <p><strong>Server Seed Hash:</strong> <code class="seed-value">${roundDetails.serverSeedHash || 'N/A'}</code></p>
                            <p><strong>Client Seed:</strong> <code class="seed-value">${roundDetails.clientSeed || 'N/A'}</code></p>
                            <p><strong>Provable Hash (Result):</strong> <code class="seed-value">${roundDetails.provableHash || 'N/A'}</code></p>
                            <button class="btn btn-secondary btn-verify" onclick="window.populateVerificationFields('${roundId}', '${(roundDetails.serverSeed || '').replace(/'/g, "\\'")}', '${(roundDetails.clientSeed || '').replace(/'/g, "\\'")}')">Verify This Round</button>
                        </div>
                    </div>` : '<p>Provably fair details (seeds) are revealed after round completion.</p>'}
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" id="closeDetailsBtnInstance">Close</button>
                </div>
            </div>`;

        document.body.appendChild(detailsModal);

        // Add event listeners to close buttons within this specific modal instance
        document.getElementById('closeDetailsModalInstance').addEventListener('click', () => detailsModal.remove());
        document.getElementById('closeDetailsBtnInstance').addEventListener('click', () => detailsModal.remove());

        // Close on backdrop click
        detailsModal.addEventListener('click', (e) => {
            if (e.target === detailsModal) {
                detailsModal.remove();
            }
        });
        // --- End Modal ---

    } catch (error) {
        console.error('Error fetching or displaying round details:', error);
        showNotification(`Error loading round details: ${error.message}`, 'error');
    }
};


/**
 * Creates pagination controls for the round history table.
 * @param {number} currentPage
 * @param {number} totalPages
 */
function createPagination(currentPage, totalPages) {
    const container = DOMElements.provablyFair.roundsPagination;
    if (!container) return;
    container.innerHTML = ''; // Clear previous pagination

    if (totalPages <= 1) return; // No pagination needed for 1 page or less

    const maxPagesToShow = 5; // Max number buttons shown (odd number recommended)

    const createButton = (text, page, isActive = false, isDisabled = false, isEllipsis = false) => {
        if (isEllipsis) {
            const span = document.createElement('span');
            span.className = 'page-ellipsis'; span.textContent = '...'; return span;
        }
        const button = document.createElement('button');
        button.className = `page-button ${isActive ? 'active' : ''}`;
        button.textContent = text; button.disabled = isDisabled;
        if (!isDisabled && typeof page === 'number' && page > 0) { // Ensure page is valid number
            button.addEventListener('click', (e) => { e.preventDefault(); loadPastRounds(page); });
        }
        return button;
    };

    // Previous Button
    container.appendChild(createButton('« Prev', currentPage - 1, false, currentPage <= 1));

    // Page Number Logic
    if (totalPages <= maxPagesToShow) {
        // Show all pages if total is less than or equal to max
        for (let i = 1; i <= totalPages; i++) {
            container.appendChild(createButton(i, i, i === currentPage));
        }
    } else {
        // Complex case: Ellipsis needed
        let pages = [];
        const rangePadding = Math.floor((maxPagesToShow - 2) / 2); // Space around current (-2 for first/last)

        // Always add first page
        pages.push(1);

        // Ellipsis or pages before current range
        if (currentPage > rangePadding + 2) { // Need ellipsis before range?
            pages.push('...');
        } else if (currentPage > 2) { // Show pages between 1 and range start
             for (let i = 2; i < currentPage - rangePadding; i++) pages.push(i);
        }

        // Current range
        const rangeStart = Math.max(2, currentPage - rangePadding);
        const rangeEnd = Math.min(totalPages - 1, currentPage + rangePadding);
        for (let i = rangeStart; i <= rangeEnd; i++) {
            pages.push(i);
        }

        // Ellipsis or pages after current range
        if (currentPage < totalPages - rangePadding - 1) { // Need ellipsis after range?
             pages.push('...');
        } else if (currentPage < totalPages - 1) { // Show pages between range end and last
             for (let i = rangeEnd + 1; i < totalPages; i++) pages.push(i);
        }

        // Always add last page
        pages.push(totalPages);

         // De-duplicate and render
         const uniquePages = [...new Set(pages)]; // Remove duplicates if logic overlaps
         uniquePages.forEach(page => {
             if (page === '...') {
                 container.appendChild(createButton('...', null, false, true, true));
             } else {
                 container.appendChild(createButton(page, page, page === currentPage));
             }
         });
    }

    // Next Button
    container.appendChild(createButton('Next »', currentPage + 1, false, currentPage >= totalPages));
}


// --- Socket.IO Event Handlers ---
function setupSocketConnection() {
    socket.on('connect', () => {
        console.log('Socket connected:', socket.id);
        showNotification('Connected to server.', 'success', 2000);
        socket.emit('requestRoundData'); // Request initial data upon connection
         // If user is logged in, maybe fetch trade history on reconnect too
         if (currentUser) {
             loadTradeHistory();
         }
    });

    socket.on('disconnect', (reason) => {
        console.log('Socket disconnected:', reason);
        showNotification('Disconnected from server. Attempting to reconnect...', 'error', 5000);
        updateDepositButtonState(); // Disable deposits on disconnect
        // Optionally clear round data visually?
         // initiateNewRoundVisualReset();
         if(DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Offline";
    });

    socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
        showNotification('Connection Error. Please check connection or refresh.', 'error', 10000);
        updateDepositButtonState();
         if(DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Error";
    });

    // --- Round Lifecycle Events ---
    socket.on('roundCreated', (data) => {
        console.log('New round created:', data);
         if (!data || !data.roundId) { console.error("Invalid roundCreated data", data); return; }
        currentRound = data;
        resetToJackpotView(); // Visual reset for the new round
        updateRoundUI(); // Update display with new round data (e.g., hash)
        updateDepositButtonState();
    });

    socket.on('participantUpdated', (data) => {
        console.log('Participant updated event:', data);
        // Check if update is for the current round
        if (currentRound && data && currentRound.roundId === data.roundId) {
            handleNewDeposit(data); // Process deposit, update state and UI
        } else if (data && data.roundId) {
            // If data looks valid but round doesn't match, request full sync
            console.warn("Participant update for mismatched/unknown round. Requesting full data.");
            socket.emit('requestRoundData');
        } else {
             console.error("Invalid participantUpdated data received:", data);
        }
    });

    socket.on('roundRolling', (data) => {
        console.log('Round rolling event received:', data);
        if (currentRound && data && currentRound.roundId === data.roundId) {
            timerActive = false; // Stop client timer
            if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
            if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Rolling";
            if (DOMElements.jackpot.timerForeground) updateTimerCircle(0, CONFIG.ROUND_DURATION); // Set circle to empty
            currentRound.status = 'rolling'; // Update local state
            updateDepositButtonState(); // Disable deposits
        }
    });

    socket.on('roundWinner', (data) => {
        console.log('Round winner event received:', data);
        // Ensure data is valid and for the current round
        if (currentRound && data && currentRound.roundId === data.roundId && data.winner) {
            // Update local round state with winner info if not already set
            if (!currentRound.winner) currentRound.winner = data.winner;
            currentRound.status = 'rolling'; // Ensure status reflects rolling phase
            handleWinnerAnnouncement(data); // Trigger animation using the received winner data
        } else {
            console.warn("Received winner for mismatched round ID or invalid data.");
             // If current round is not rolling, request sync
             if(currentRound && currentRound.status !== 'rolling') socket.emit('requestRoundData');
        }
    });

    socket.on('roundCompleted', (data) => {
        console.log('Round completed event received:', data);
        if (currentRound && data && currentRound.roundId === data.roundId) {
            currentRound.status = 'completed';
            // Update seed info if provided (server reveals seeds after completion)
            if(data.serverSeed) currentRound.serverSeed = data.serverSeed;
            if(data.clientSeed) currentRound.clientSeed = data.clientSeed;
            if(data.provableHash) currentRound.provableHash = data.provableHash;
            updateDepositButtonState(); // Keep deposits disabled
             // Update round history if fair page is currently visible
             if (DOMElements.pages.fairPage?.style.display === 'block') {
                 loadPastRounds(); // Refresh the history table
             }
        }
        // Note: resetToJackpotView happens after winner animation delay, triggered by handleSpinEnd
    });

    socket.on('roundError', (data) => {
        console.error('Round Error event received:', data);
        if (currentRound && data && currentRound.roundId === data.roundId) {
            currentRound.status = 'error';
            showNotification(`Round Error: ${data.error || 'Unknown error.'}`, 'error');
            updateDepositButtonState();
            // Reset view immediately on error to avoid inconsistent state
            resetToJackpotView();
        } else if (!currentRound && data.error) {
             // Show error even if round context is unclear
             showNotification(`Server Error: ${data.error || 'Unknown error.'}`, 'error');
        }
    });

    // --- Initial/Sync Data ---
    socket.on('roundData', (data) => {
        console.log('Received initial/updated round data:', data);
        if (!data || typeof data !== 'object' || !data.roundId) {
            console.error("Invalid round data received from server. Resetting UI.", data);
            showNotification('Error syncing with server data.', 'error');
             initiateNewRoundVisualReset(); // Reset to a known empty state
             currentRound = null; // Clear local state
            return;
        }

        const isNewRound = !currentRound || currentRound.roundId !== data.roundId;
        currentRound = data; // Update local state with the received data

        // --- Sync UI based on received state ---
        if (isNewRound && currentRound.status !== 'rolling' && currentRound.status !== 'completed') {
             // If it's a truly new round (or we missed the end of the last one), reset visually
             console.log(`New round detected (${currentRound.roundId}), resetting view.`);
             resetToJackpotView(); // This calls initiateNewRoundVisualReset & requests data again, maybe redundant?
                                   // Let's refine: just update UI based on new data directly.
             initiateNewRoundVisualReset(); // Reset visuals
             updateRoundUI(); // Update header with new round data
        } else {
             // Otherwise, just update the UI with current state
             updateRoundUI();
        }
        updateDepositButtonState(); // Always update button state after sync

        // --- Sync Timer and Participants ---
        if (currentRound.status === 'active') {
             // Sync participants display
             const container = DOMElements.jackpot.participantsContainer;
             if (container) {
                  container.innerHTML = ''; // Clear previous rendering
                  if (currentRound.participants && currentRound.participants.length > 0) {
                       if(DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'none';
                       // Sort and display participants based on the full data
                       const sortedParticipants = [...currentRound.participants].sort((a, b) => (b.itemsValue || 0) - (a.itemsValue || 0));
                       sortedParticipants.forEach(p => {
                           const participantItems = currentRound.items?.filter(item => item.owner === p.user?._id) || [];
                           displayLatestDeposit({ userId: p.user._id, username: p.user.username, avatar: p.user.avatar, itemsValue: p.itemsValue, depositedItems: participantItems });
                           const element = container.querySelector(`.player-deposit-container[data-user-id="${p.user._id}"]`);
                           if (element) element.classList.remove('player-deposit-new'); // Remove animation class
                       });
                       updateAllParticipantPercentages(); // Update percentages after rendering all
                  } else {
                       if(DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'block';
                  }
             }

             // Sync Timer
             const timeLeftFromServer = currentRound.timeLeft ?? CONFIG.ROUND_DURATION;
             if (currentRound.participants?.length > 0 && timeLeftFromServer > 0 && !timerActive) {
                 // Start timer if participants, time left, and not already running
                 console.log(`Sync: Starting client timer from ${timeLeftFromServer}s.`);
                 startClientTimer(timeLeftFromServer);
             } else if (timeLeftFromServer <= 0 && timerActive) {
                 // Stop timer if server says time is up but client timer is running
                 console.log("Sync: Server indicates time up, stopping client timer.");
                 timerActive = false; if (roundTimer) clearInterval(roundTimer); roundTimer = null;
                 updateTimerUI(0); updateDepositButtonState();
             } else if (currentRound.participants?.length === 0 && timerActive) {
                  // Stop timer if server says no participants but client timer running
                  console.log("Sync: Server indicates no participants, stopping client timer.");
                  timerActive = false; if (roundTimer) clearInterval(roundTimer); roundTimer = null;
                  updateTimerUI(CONFIG.ROUND_DURATION); updateDepositButtonState();
             } else if (!timerActive) {
                 // If timer isn't active, ensure UI reflects current timeLeft from server
                 updateTimerUI(timeLeftFromServer);
             }
        } else if (currentRound.status === 'rolling' || currentRound.status === 'completed') {
            // If round is rolling/completed and we have a winner, but animation isn't running, start it
             if (!isSpinning && currentRound.winner) {
                 console.log("Sync: Connected mid-round with winner known, triggering animation.");
                 handleWinnerAnnouncement(currentRound); // Use the full round data
             } else if (!isSpinning) { // If rolling/completed but no winner data OR animation *already* running, do nothing or reset
                  console.log("Sync: Round ended or rolling state detected.");
                  // If completed, ensure timer shows 'Ended'
                  if (currentRound.status === 'completed' && DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Ended";
             }
        } else if (currentRound.status === 'pending') {
             console.log("Sync: Received pending round state.");
             initiateNewRoundVisualReset();
             if(DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Waiting";
             updateDepositButtonState();
        }
        // --- End Sync ---
    });

    // Trade Offer Sent Handler (Primarily for Winnings)
    socket.on('tradeOfferSent', (data) => {
        console.log('Trade offer sent event received:', data);
        // Check if it's for the current user and contains necessary info
        if (currentUser && data && data.userId === currentUser._id && data.offerId && data.offerURL) {

            // Add/Update trade history
            const existingTradeIndex = tradeHistory.findIndex(t => t.offerId === data.offerId);
             if (existingTradeIndex === -1) {
                 const newTrade = {
                     offerId: data.offerId,
                     type: data.type || 'winnings', // Assume winnings if type missing
                     status: 'pending', // Offer just sent is pending acceptance
                     roundId: data.roundId,
                     totalValue: data.totalValue || currentRound?.totalValue || 0,
                     items: data.items || [], // Include items if sent by backend
                     createdAt: new Date().toISOString()
                 };
                 tradeHistory.unshift(newTrade);
             } else {
                 // Update status if it wasn't pending before (e.g., retry)
                  tradeHistory[existingTradeIndex].status = 'pending';
             }

            // Update trade history table if visible
            if (DOMElements.tradeHistory.modal.style.display === 'flex') {
                populateTradeHistoryTable(tradeHistory);
            }

            // Notify user with a direct link
            showNotification(
                `Trade Offer Sent: <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">Click here to accept your items on Steam!</a> (Offer #${data.offerId})`,
                'success',
                15000 // Show longer for acceptance link
            );
        } else if (currentUser && data && data.userId === currentUser._id && data.offerId) {
            // Fallback notification if URL is missing
            showNotification(`Trade Offer Sent: Check Steam for your items! (Offer #${data.offerId})`, 'success', 8000);
        }
    });

    // --- Notification Event (Generic from Server) ---
    socket.on('notification', (data) => {
       console.log('Notification event received:', data);
       if (!data || !data.message) return; // Ignore invalid notifications

       // Show notification if it's general (no userId) or targeted at the current user
       if (!data.userId || (currentUser && data.userId === currentUser._id)) {
            const type = data.type || 'info'; // 'info', 'success', 'error', 'warning'
            const duration = data.duration || 5000;
            showNotification(data.message, type, duration); // Display the message
       }
    });

     // --- User Data Update Event ---
     socket.on('userDataUpdate', (data) => {
         console.log('User data update received:', data);
         if (currentUser && data && typeof data === 'object') {
              // Update specific fields if provided
              currentUser = { ...currentUser, ...data };
              console.log('currentUser updated:', currentUser);
              updateUserUI(); // Refresh UI reflecting new data (e.g., pending offer cleared, trade URL set)
              updateDepositButtonState();
              // If profile modal is open, refresh its content
              if (DOMElements.profileModal.modal?.style.display === 'flex') {
                   populateProfileModal();
              }
         }
     });
}

// --- Placeholder Functions (Implement based on your API/needs) ---

/** Populates the profile modal with current user data. */
function populateProfileModal() {
    const { modal, avatar, name, deposited, tradeUrlInput, pendingOfferStatus } = DOMElements.profileModal;
    if (!modal || !currentUser) {
        console.warn("Cannot populate profile modal: Element missing or user not logged in.");
        return;
    }

    console.log("Populating profile modal for:", currentUser.username);

    if (avatar) avatar.src = currentUser.avatar || '/img/default-avatar.png';
    if (name) name.textContent = currentUser.username || 'User';
    // Assuming backend provides totalDeposited, format it
    if (deposited) deposited.textContent = `$${(currentUser.totalDeposited || 0).toFixed(2)}`;
    if (tradeUrlInput) tradeUrlInput.value = currentUser.tradeUrl || '';

    // Display pending offer status
    if (pendingOfferStatus) {
        if (currentUser.pendingDepositOfferId) {
             const offerLink = `https://steamcommunity.com/tradeoffer/${currentUser.pendingDepositOfferId}/`;
             pendingOfferStatus.innerHTML = `
                <p class="warning-text">
                    <strong>Pending Deposit Offer:</strong> #${currentUser.pendingDepositOfferId}<br>
                    <a href="${offerLink}" target="_blank" rel="noopener noreferrer">Accept/View on Steam</a>
                    </p>`;
             // Optional: Add listener for cancel button if you implement it
             // document.getElementById('cancelPendingOfferBtn')?.addEventListener('click', handleCancelPendingOffer);
        } else {
            pendingOfferStatus.innerHTML = '<p>No pending deposit offers.</p>';
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
        // --- Replace with your actual API endpoint and method ---
        const response = await fetch('/api/user/tradeurl', {
            method: 'POST', // or PUT
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tradeUrl: newTradeUrl }),
        });
        // --- End API Call ---

        if (!response.ok) {
             const errorData = await response.json().catch(() => ({ error: `Save failed (${response.status})` }));
            throw new Error(errorData.error);
        }

        const result = await response.json(); // Expect { success: true, user: updatedUserData } or similar

        if (!result.success) {
             throw new Error(result.error || "Save failed on server.");
        }

        // Update local user state with potentially updated data from server response
         if (result.user) {
             currentUser = { ...currentUser, ...result.user }; // Merge updates
         } else {
             currentUser.tradeUrl = newTradeUrl; // Optimistic update if backend doesn't return full user
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

/** Handles the agreement in the Age Verification modal */
function handleAgeVerificationAgree() {
    const { modal, checkbox } = DOMElements.ageVerification;
    if (!modal || !checkbox) return;

    if (checkbox.checked) {
        try {
            // Set a flag in localStorage (simple client-side check)
            localStorage.setItem(CONFIG.AGE_VERIFICATION_KEY, 'true');
            hideModal(modal);
            console.log("Age verified flag set.");
            // Optionally enable features that were disabled
        } catch (e) {
            console.error("Failed to write to localStorage:", e);
            showNotification("Could not save age verification preference.", "error");
        }
    } else {
        showNotification("You must check the box to confirm you are 18 or older.", "warning");
    }
}

// --- Initial Setup & Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed.');

    // --- Initial State Setup ---
    checkLoginStatus(); // Check if user is logged in on load
    setupSocketConnection(); // Establish connection to backend
    showPage('home-page'); // Show the main jackpot page by default

    // --- Age Verification Check ---
     try {
         if (localStorage.getItem(CONFIG.AGE_VERIFICATION_KEY) !== 'true') {
             if (DOMElements.ageVerification.modal) {
                  console.log("Age not verified, showing modal.");
                  showModal(DOMElements.ageVerification.modal);
             } else {
                  console.warn("Age verification modal element not found.");
             }
         } else {
             console.log("Age already verified.");
         }
     } catch (e) {
         console.error("Failed to read age verification status from localStorage:", e);
          // Show modal if localStorage access fails? Or assume verified? Decide policy.
          if (DOMElements.ageVerification.modal) showModal(DOMElements.ageVerification.modal);
     }


    // --- Navigation Listeners ---
    const navLinks = DOMElements.nav;
    navLinks.homeLink?.addEventListener('click', (e) => { e.preventDefault(); showPage('home-page'); });
    navLinks.aboutLink?.addEventListener('click', (e) => { e.preventDefault(); showPage('about-page'); });
    navLinks.tosLink?.addEventListener('click', (e) => { e.preventDefault(); showPage('tos-page'); });
    navLinks.faqLink?.addEventListener('click', (e) => { e.preventDefault(); showPage('faq-page'); });
    navLinks.fairLink?.addEventListener('click', (e) => { e.preventDefault(); showPage('fair-page'); });

    // --- User/Auth Listeners ---
    DOMElements.user.loginButton?.addEventListener('click', () => {
        window.location.href = '/auth/steam'; // Redirect to Steam login route
    });

    DOMElements.user.userProfile?.addEventListener('click', (e) => {
         e.stopPropagation(); // Prevent outside click listener from closing it immediately
        const dropdown = DOMElements.user.userDropdownMenu;
        const profile = DOMElements.user.userProfile;
        if (!dropdown || !profile) return;
        const isExpanded = profile.getAttribute('aria-expanded') === 'true';
        dropdown.style.display = isExpanded ? 'none' : 'block';
        profile.setAttribute('aria-expanded', !isExpanded);
        profile.classList.toggle('open', !isExpanded); // Toggle class for CSS styling hook
    });

    DOMElements.user.logoutButton?.addEventListener('click', handleLogout);

    DOMElements.user.profileDropdownButton?.addEventListener('click', () => {
        populateProfileModal();
         // Close main dropdown after clicking an item
         if(DOMElements.user.userDropdownMenu) DOMElements.user.userDropdownMenu.style.display = 'none';
         if(DOMElements.user.userProfile) DOMElements.user.userProfile.setAttribute('aria-expanded', 'false');
         if(DOMElements.user.userProfile) DOMElements.user.userProfile.classList.remove('open');
    });

    DOMElements.user.tradeHistoryButton?.addEventListener('click', () => {
        loadTradeHistory(); // Fetch data
        showModal(DOMElements.tradeHistory.modal); // Show modal
         // Close main dropdown after clicking an item
         if(DOMElements.user.userDropdownMenu) DOMElements.user.userDropdownMenu.style.display = 'none';
         if(DOMElements.user.userProfile) DOMElements.user.userProfile.setAttribute('aria-expanded', 'false');
         if(DOMElements.user.userProfile) DOMElements.user.userProfile.classList.remove('open');
    });

    // --- Profile Modal Listeners ---
    DOMElements.profileModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.profileModal.cancelBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.profileModal.saveBtn?.addEventListener('click', saveProfile);

    // --- Trade History Modal Listeners ---
    DOMElements.tradeHistory.closeBtn?.addEventListener('click', () => hideModal(DOMElements.tradeHistory.modal));
    DOMElements.tradeHistory.closeBtnFooter?.addEventListener('click', () => hideModal(DOMElements.tradeHistory.modal));

    // --- Deposit Modal Listeners ---
    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => {
        if (currentUser && currentUser.tradeUrl) {
             showModal(DOMElements.deposit.depositModal);
             loadUserInventory(); // Load inventory when modal opens
        } else if (currentUser && !currentUser.tradeUrl) {
             showNotification('Please set your Trade URL in your profile first.', 'warning');
             populateProfileModal(); // Open profile modal directly
        } else {
             showNotification('Please log in to deposit items.', 'error');
        }
    });
    DOMElements.deposit.closeDepositModalButton?.addEventListener('click', () => hideModal(DOMElements.deposit.depositModal));
    DOMElements.deposit.depositButton?.addEventListener('click', requestDepositOffer); // Button inside modal
    DOMElements.deposit.acceptDepositOfferBtn?.addEventListener('click', () => {
         if (currentDepositOfferURL) {
             window.open(currentDepositOfferURL, '_blank', 'noopener,noreferrer');
             // Optionally hide modal or update status after clicking
             // hideModal(DOMElements.deposit.depositModal);
             if(DOMElements.deposit.depositStatusText) DOMElements.deposit.depositStatusText.textContent = "Check Steam to accept the offer...";
         } else {
             console.error("Accept offer button clicked but no URL stored.");
             showNotification("Error: Could not find the offer URL. Please try requesting again.", "error");
             resetDepositModalUI(); // Reset modal state
         }
    });


    // --- Provably Fair Listeners ---
    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound);

    // --- Age Verification Listener ---
    DOMElements.ageVerification.agreeButton?.addEventListener('click', handleAgeVerificationAgree);

    // --- Test Button Listeners (Remove in production) ---
    // document.getElementById('testDepositBtn')?.addEventListener('click', testDeposit);
    // document.getElementById('testRouletteBtn')?.addEventListener('click', testRouletteAnimation);


    // --- Global Click Listener (to close dropdowns/modals) ---
    document.addEventListener('click', (e) => {
        // Close User Dropdown
        const userDropdown = DOMElements.user.userDropdownMenu;
        const userProfile = DOMElements.user.userProfile;
        if (userDropdown?.style.display === 'block' && !userProfile?.contains(e.target) && !userDropdown.contains(e.target)) {
            userDropdown.style.display = 'none';
            userProfile.setAttribute('aria-expanded', 'false');
            userProfile.classList.remove('open');
        }

        // Close Modals on backdrop click (check if target is the modal itself)
         const modals = document.querySelectorAll('.modal'); // Add generic '.modal' class to all modals
         modals.forEach(modal => {
             if (modal.style.display === 'flex' && e.target === modal) {
                 // Check for specific modal IDs if different closing behavior is needed
                  if (modal.id === DOMElements.profileModal.modal?.id) hideModal(DOMElements.profileModal.modal);
                  else if (modal.id === DOMElements.deposit.depositModal?.id) hideModal(DOMElements.deposit.depositModal);
                  else if (modal.id === DOMElements.tradeHistory.modal?.id) hideModal(DOMElements.tradeHistory.modal);
                  else if (modal.id === DOMElements.ageVerification.modal?.id) { /* Don't close age modal on backdrop */ }
                  else if (modal.id === 'roundDetailsModalInstance') modal.remove(); // Remove dynamically created details modal
                  else hideModal(modal); // Generic hide
             }
         });
    });

    // --- Initial UI Updates ---
    updateDepositButtonState(); // Set initial deposit button state
});

console.log("main.js loaded.");
