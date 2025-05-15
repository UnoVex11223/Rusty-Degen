// main.js - Rust Jackpot Frontend Logic (Combined with Profile Dropdown)
// Modifications: Simplified header profile, updated dropdown, added Profile Modal, implemented trade offer flow.

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
        profileDropdownButton: document.getElementById('profileDropdownButton'), // NEW "Profile" button inside dropdown
        logoutButton: document.getElementById('logoutButton'),    // The logout button inside the dropdown
        pendingOfferIndicator: document.getElementById('pending-offer-indicator'), // ADDED
    },
    // *** NEW Profile Modal Elements ***
    profileModal: {
        modal: document.getElementById('profileModal'),
        avatar: document.getElementById('profileModalAvatar'),
        name: document.getElementById('profileModalName'),
        deposited: document.getElementById('profileModalDeposited'),
        tradeUrlInput: document.getElementById('profileModalTradeUrl'),
        saveBtn: document.getElementById('profileModalSaveBtn'),
        closeBtn: document.getElementById('profileModalCloseBtn'),
        cancelBtn: document.getElementById('profileModalCancelBtn'), // Added based on HTML
        pendingOfferStatus: document.getElementById('profile-pending-offer-status'), // ADDED
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
        depositButton: document.getElementById('depositButton'), // The actual "Deposit Items" button inside modal
        inventoryItemsContainer: document.getElementById('inventory-items'),
        selectedItemsContainer: document.getElementById('selectedItems'),
        totalValueDisplay: document.getElementById('totalValue'),
        inventoryLoadingIndicator: document.getElementById('inventory-loading'),
        acceptDepositOfferBtn: document.getElementById('acceptDepositOfferBtn'), // ADDED
        depositStatusText: document.getElementById('depositStatusText'), // ADDED
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
let currentUser = null; // Stores logged-in user data (null if not logged in)
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
let currentDepositOfferURL = null; // ADDED: Store the URL for the accept button

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
    if (modalElement === DOMElements.deposit.depositModal) { // ADDED IF BLOCK
        resetDepositModalUI();
    }
}

/**
 * Shows a specific page section and hides others. Updates navigation link styles.
 * @param {HTMLElement} pageElement - The page element to display.
 */
function showPage(pageElement) {
    // Hide all page containers
    Object.values(DOMElements.pages).forEach(page => {
        if (page) page.style.display = 'none';
    });

    // Show the selected page container
    if (pageElement) pageElement.style.display = 'block';

    // Update active state on navigation links
    document.querySelectorAll('.main-nav a, .secondary-nav a, .primary-nav a')
        .forEach(link => link?.classList.remove('active'));

    // Find the corresponding link element to activate
    let activeLink = null;
    if (pageElement === DOMElements.pages.homePage) activeLink = DOMElements.nav.homeLink;
    else if (pageElement === DOMElements.pages.aboutPage) activeLink = DOMElements.nav.aboutLink;
    else if (pageElement === DOMElements.pages.tosPage) activeLink = DOMElements.nav.tosLink;
    else if (pageElement === DOMElements.pages.faqPage) activeLink = DOMElements.nav.faqLink;
    else if (pageElement === DOMElements.pages.fairPage) activeLink = DOMElements.nav.fairLink;

    if (activeLink) activeLink.classList.add('active');

    // Load round history if navigating to the Provably Fair page
    if (pageElement === DOMElements.pages.fairPage) {
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
    if (!userColorMap.has(userId)) {
        const colorIndex = userColorMap.size % COLOR_PALETTE.length;
        userColorMap.set(userId, COLOR_PALETTE[colorIndex]);
    }
    return userColorMap.get(userId) || '#cccccc'; // Fallback color
}

/**
 * Displays a non-blocking notification message.
 * Uses the notificationBar element defined in DOMElements.
 * Allows HTML content.
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

    bar.innerHTML = message; // Use innerHTML to render links etc.
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
            userProfile?.classList.remove('open'); // Optional class for arrow styling
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
        acceptDepositOfferBtn.removeAttribute('data-offer-url'); // Clear stored URL (though not strictly needed as we use state var)
    }
    if (depositStatusText) {
        depositStatusText.textContent = ''; // Clear status text
        depositStatusText.className = 'deposit-status-text'; // Reset class
    }
    currentDepositOfferURL = null; // Clear state variable
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
    } else if (currentUser.pendingDepositOfferId) { // ADDED check for pending offer
         disabled = true;
         title = 'Accept or cancel your pending deposit offer first (check profile)';
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
            } else {
                throw new Error(`Server error fetching user: ${response.status}`);
            }
        } else {
            currentUser = await response.json();
            // Manually add mock stats if backend doesn't provide them yet
            // Remove these lines once your backend provides real stats
            if (currentUser && currentUser.totalDeposited === undefined) {
                 currentUser.totalDeposited = Math.random() * 2000; // Mock data
            }
            if (currentUser && currentUser.totalWon === undefined) {
                  currentUser.totalWon = Math.random() * 3000; // Mock data
            }
             if (currentUser && !currentUser.steamId) {
                  currentUser.steamId = `mock_${Math.floor(Math.random() * 100000000)}`; // Mock data
             }
            console.log('User logged in:', currentUser?.username);
        }
    } catch (error) {
        console.error('Error checking login status:', error);
        currentUser = null;
        showNotification(`Error checking login: ${error.message}`, 'error');
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
    const { loginButton, userProfile, userAvatar, userName, userDropdownMenu, pendingOfferIndicator } = DOMElements.user; // Add pendingOfferIndicator here

    if (!loginButton || !userProfile) return; // Essential elements must exist

    if (currentUser) {
        // --- Header Elements (Simplified View) ---
        if (userAvatar) userAvatar.src = currentUser.avatar || '/img/default-avatar.png';
        if (userName) userName.textContent = currentUser.username || 'User';

        loginButton.style.display = 'none';
        userProfile.style.display = 'flex'; // Show the avatar+name element
        userProfile.setAttribute('aria-disabled', 'false'); // Enable profile trigger

        // Show/hide pending offer indicator in header (ADDED LOGIC)
        if (pendingOfferIndicator) {
            const hasPending = !!currentUser.pendingDepositOfferId;
            pendingOfferIndicator.style.display = hasPending ? 'inline-block' : 'none';
             if (hasPending) {
                 pendingOfferIndicator.title = `You have a pending deposit offer (#${currentUser.pendingDepositOfferId})! Click your profile to see details.`;
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
        if (pendingOfferIndicator) pendingOfferIndicator.style.display = 'none'; // Hide indicator if logged out (ADDED)
    }
}

/**
 * Fetches the user's inventory from the backend API and displays it in the deposit modal.
 */
async function loadUserInventory() {
    const { inventoryItemsContainer, selectedItemsContainer, inventoryLoadingIndicator, totalValueDisplay } = DOMElements.deposit;
    if (!inventoryItemsContainer || !selectedItemsContainer || !inventoryLoadingIndicator || !totalValueDisplay) {
        console.error("Inventory DOM elements missing.");
        return;
    }

    resetDepositModalUI(); // ADDED: Ensure buttons/status reset on load

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
    resetDepositModalUI(); // ADDED: Reset footer buttons/text when selection changes
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
 * Updates the total value display in the deposit modal.
 */
function updateTotalValue() {
    const { totalValueDisplay } = DOMElements.deposit;
    if (!totalValueDisplay) return;

    const total = selectedItemsList.reduce((sum, item) => {
        // Ensure price is valid before adding
        const price = typeof item.price === 'number' && !isNaN(item.price) ? item.price : 0;
        return sum + price;
    }, 0);

    totalValueDisplay.textContent = `$${total.toFixed(2)}`;
    // Deposit button enable/disable logic is handled in resetDepositModalUI
}

// --- Second Part of main.js (Continued) ---

/**
 * Handles the initial deposit request. Sends selected asset IDs to the backend,
 * expects an offer URL back, and updates the modal UI.
 * REPLACES the old submitDeposit function.
 */
async function requestDepositOffer() {
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit;
    if (!depositButton || !acceptDepositOfferBtn || !depositStatusText) return;

    if (selectedItemsList.length === 0) {
        showNotification('No Items Selected: Please select items first.', 'info');
        return;
    }
    // Double-check round status/limits client-side
    if (!currentRound || currentRound.status !== 'active' || isSpinning) { showNotification('Deposit Error: Deposits are currently closed.', 'error'); return; }
    if (currentUser?.pendingDepositOfferId) {
        showNotification('Deposit Error: You already have a pending deposit offer. Check your profile or Steam.', 'error');
        if (DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
        return;
    }
     const participantsLength = currentRound.participants?.length || 0;
     const isNewParticipant = !currentRound.participants?.some(p => p.user?._id === currentUser?._id);
     if (isNewParticipant && participantsLength >= CONFIG.MAX_PARTICIPANTS_DISPLAY) { showNotification(`Deposit Error: Participant limit (${CONFIG.MAX_PARTICIPANTS_DISPLAY}) reached.`, 'error'); return; }
     const itemsInPot = currentRound.items?.length || 0;
     if (itemsInPot + selectedItemsList.length > CONFIG.MAX_ITEMS_PER_POT_FRONTEND) { const slotsLeft = CONFIG.MAX_ITEMS_PER_POT_FRONTEND - itemsInPot; showNotification(`Deposit Error: Pot item limit would be exceeded (Max ${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}). Only ${slotsLeft} slots left.`, 'error', 6000); return; }

    depositButton.disabled = true;
    depositButton.textContent = 'Requesting...';
    acceptDepositOfferBtn.style.display = 'none';
    depositStatusText.textContent = 'Creating deposit offer... Please wait.';
    depositStatusText.className = 'deposit-status-text info';

    let response;

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
             if (response.status === 409 && result.offerURL && result.offerId) {
                 console.warn("User already has a pending offer:", result.offerId);
                 depositStatusText.textContent = `You already have a pending offer! Click 'Accept on Steam' to view it.`;
                 depositStatusText.className = 'deposit-status-text warning';
                 currentDepositOfferURL = result.offerURL;
                 acceptDepositOfferBtn.style.display = 'inline-block';
                 acceptDepositOfferBtn.disabled = false;
                 depositButton.style.display = 'none';
                 if (currentUser && !currentUser.pendingDepositOfferId) { currentUser.pendingDepositOfferId = result.offerId; updateUserUI(); updateDepositButtonState(); }
                 return;
             } else {
                 throw new Error(result.error || `Failed to create offer (${response.status})`);
             }
        } else if (!result.success || !result.offerURL || !result.offerId) {
            throw new Error(result.error || 'Backend did not return a valid offer URL and ID.');
        } else {
            // --- Success ---
            console.log("Deposit offer created:", result.offerId);
            depositStatusText.textContent = "Offer created! Click 'Accept on Steam' below to complete.";
            depositStatusText.className = 'deposit-status-text success';
            currentDepositOfferURL = result.offerURL;
            depositButton.style.display = 'none';
            acceptDepositOfferBtn.style.display = 'inline-block';
            acceptDepositOfferBtn.disabled = false;
            if(currentUser) { currentUser.pendingDepositOfferId = result.offerId; updateUserUI(); updateDepositButtonState(); }
        }

    } catch (error) {
        console.error('Error requesting deposit offer:', error);
        depositStatusText.textContent = `Error: ${error.message}`;
        depositStatusText.className = 'deposit-status-text error';
        if (!(response && response.status === 409)) {
             // Only fully reset UI if it wasn't a 409 (pending offer exists) error
             resetDepositModalUI();
        }
        // Ensure pending offer ID is cleared locally if a non-409 error occurred
        if (currentUser && currentUser.pendingDepositOfferId && !(response && response.status === 409)) {
            console.log("Clearing potentially stale pending offer ID due to error.");
            currentUser.pendingDepositOfferId = null; updateUserUI(); updateDepositButtonState();
        }
    }
}

/**
 * Updates the main jackpot header UI elements (Pot Value, Timer Display, Participant Count).
 */
function updateRoundUI() {
    const { potValue, participantCount } = DOMElements.jackpot;
    if (!currentRound || !potValue || !participantCount) return;

    potValue.textContent = `$${(currentRound.totalValue || 0).toFixed(2)}`;

    if (!timerActive) {
        updateTimerUI(currentRound.timeLeft !== undefined ? currentRound.timeLeft : CONFIG.ROUND_DURATION);
    }

    const participantNum = currentRound.participants?.length || 0;
    participantCount.textContent = `${participantNum}/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
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

     if (currentRound && currentRound.status === 'active' && !timerActive && currentRound.participants?.length === 0) {
         // If round is active, timer not started client-side, and no participants, show full duration
          displayValue = CONFIG.ROUND_DURATION.toString();
     } else if (timerActive || (currentRound && currentRound.status === 'active' && timeToShow > 0)) {
         // If timer is active or round active with time left, show countdown
          displayValue = timeToShow.toString();
     } else if (isSpinning || (currentRound && currentRound.status === 'rolling')) {
         // If spinning or server says rolling, show "Rolling"
          displayValue = "Rolling";
     } else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'error')) {
         // If round ended, show "Ended"
          displayValue = "Ended";
     } else if (!timerActive && timeToShow <= 0 && currentRound && currentRound.status === 'active') {
         // If timer not active client-side but server indicates time is up (timeLeft <= 0)
          displayValue = "0";
     } else if (currentRound && currentRound.status === 'pending') {
           displayValue = "Waiting"; // Show waiting if server says pending
     } else if (!currentRound) {
           displayValue = "--"; // Default if no round data yet
     }

    timerValue.textContent = displayValue;
    updateTimerCircle(timeToShow, CONFIG.ROUND_DURATION);

    // Update pulse animation
    if (timerActive && timeToShow <= 10 && timeToShow > 0) {
        timerValue.classList.add('urgent-pulse');
        timerValue.classList.remove('timer-pulse');
    } else {
        timerValue.classList.remove('urgent-pulse');
        if (timerActive && timeToShow > 10) {
            timerValue.classList.add('timer-pulse');
        } else {
            timerValue.classList.remove('timer-pulse');
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
        // Calculate progress, ensure totalTime is not zero
        const progress = Math.min(1, Math.max(0, timeLeft / Math.max(1, totalTime)));
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
    const currentTotalPotValue = Math.max(0.01, currentRound.totalValue || 0.01); // Ensure > 0 for calculation

    depositBlocks.forEach(block => {
        const userId = block.dataset.userId;
        if (!userId) return; // Skip block if no userId found

        // Find the latest participant data from the currentRound state
        const participantData = currentRound.participants.find(p => p.user?._id === userId || p.user === userId);

        if (!participantData) return; // Skip if participant data not found (e.g., inconsistency)

        const cumulativeValue = participantData.itemsValue || 0;
        // Calculate percentage based on the participant's current total value and the *current* total pot value
        const percentage = ((cumulativeValue / currentTotalPotValue) * 100).toFixed(1);

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
 * Calculates and includes the initial percentage chance.
 * @param {object} data - Participant update data.
 */
function displayLatestDeposit(data) {
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (!container) return;

    // Use user ID directly from data if available, fallback to data.user._id
    const userId = data.userId || data.user?._id;
    if (!userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue)) {
        console.error("Invalid data passed to displayLatestDeposit:", data);
        return;
    }

    // --->>> Play Deposit Sound <<<---
    const depositSfx = DOMElements.audio.depositSound;
    if (depositSfx) {
        depositSfx.volume = 0.6; // Adjust volume (0.0 to 1.0) as needed
        depositSfx.currentTime = 0; // Ensure it plays from the start if triggered quickly
        depositSfx.play().catch(e => console.error("Error playing deposit sound:", e));
    }
    // --->>> End Deposit Sound <<<---


    const username = data.username || data.user?.username || 'Unknown User';
    const avatar = data.avatar || data.user?.avatar || '/img/default-avatar.png';
    const value = data.itemsValue; // This deposit's value
    const items = data.depositedItems || [];
    const userColor = getUserColor(userId);

    // --- Calculate Percentage for Display ---
    // Find the participant's LATEST cumulative data from currentRound
    const participantData = currentRound?.participants?.find(p => (p.user?._id === userId || p.user === userId));
    const cumulativeValue = participantData ? participantData.itemsValue : value; // Use latest cumulative value if found
    const currentTotalPotValue = Math.max(0.01, currentRound?.totalValue || 0.01); // Use current round total, ensure > 0
    const percentage = ((cumulativeValue / currentTotalPotValue) * 100).toFixed(1); // Calculate percentage

    const depositContainer = document.createElement('div');
    depositContainer.dataset.userId = userId; // Use the determined userId
    depositContainer.className = 'player-deposit-container player-deposit-new';

    const depositHeader = document.createElement('div');
    depositHeader.className = 'player-deposit-header';
    // Update innerHTML to include percentage and apply user color
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

    if (items.length > 0) {
        items.sort((a, b) => (b.price || 0) - (a.price || 0));
        const displayItems = items.slice(0, CONFIG.MAX_ITEMS_PER_DEPOSIT);

        displayItems.forEach(item => {
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

    // Fade-in animation trigger
    setTimeout(() => {
        depositContainer.classList.remove('player-deposit-new');
    }, 500);

    // Limit displayed deposit blocks
    const currentDepositBlocks = container.querySelectorAll('.player-deposit-container');
    if (currentDepositBlocks.length > CONFIG.MAX_DISPLAY_DEPOSITS) {
        const blocksToRemove = currentDepositBlocks.length - CONFIG.MAX_DISPLAY_DEPOSITS;
        for (let i = 0; i < blocksToRemove; i++) {
            const oldestBlock = container.querySelector('.player-deposit-container:last-child');
            if (oldestBlock && oldestBlock !== depositContainer) { // Don't remove the one just added
                oldestBlock.style.transition = 'opacity 0.3s ease-out';
                oldestBlock.style.opacity = '0';
                setTimeout(() => {
                    if (oldestBlock.parentNode === container) { // Check if still attached before removing
                        oldestBlock.remove();
                    }
                }, 300);
            }
        }
    }
}


/**
 * Processes participant updates from the server. Called when deposit confirmed.
 * @param {object} data - Data received from the 'participantUpdated' socket event.
 */
function handleNewDeposit(data) {
    // Basic data validation
    if (!data || !data.roundId || !data.userId ||
        typeof data.itemsValue !== 'number' || isNaN(data.itemsValue) ||
        data.totalValue === undefined || data.tickets === undefined) {
        console.error("Invalid participant update data received:", data);
        return;
    }
    if (!data.depositedItems) data.depositedItems = []; // Ensure depositedItems array exists

    // Ensure local round state exists or initialize it
    if (!currentRound) {
        currentRound = {
            roundId: data.roundId,
            status: 'active',
            timeLeft: CONFIG.ROUND_DURATION,
            totalValue: 0,
            participants: [],
            items: []
        };
        console.warn("Handling deposit for non-existent local round. Initializing round.");
    } else if (currentRound.roundId !== data.roundId) {
        // Ignore updates for a previous round
        console.warn(`Deposit received for wrong round (${data.roundId}). Current is ${currentRound.roundId}. Ignoring.`);
        return;
    }

    // Ensure participants and items arrays exist
    if (!currentRound.participants) currentRound.participants = [];
    if (!currentRound.items) currentRound.items = [];

    // Check if this update corresponds to clearing a pending offer for the current user (ADDED BLOCK)
    if (currentUser && currentUser.pendingDepositOfferId && currentUser._id === data.userId) {
         console.log(`Deposit processed for user ${currentUser.username}, clearing local pending offer flag.`);
         currentUser.pendingDepositOfferId = null; // Clear local flag
         updateUserUI(); // Update header indicator
         updateDepositButtonState(); // Re-enable main deposit button if appropriate
         // Reset deposit modal if it's open
         if (DOMElements.deposit.depositModal?.style.display === 'flex') {
             resetDepositModalUI();
             // Clear selection list visually as items are now deposited
             selectedItemsList = [];
             if(DOMElements.deposit.selectedItemsContainer) DOMElements.deposit.selectedItemsContainer.innerHTML = '';
             updateTotalValue(); // Reset total value display
             // Optionally close modal after successful deposit confirmation from backend
             // hideModal(DOMElements.deposit.depositModal);
         }
     }

    // Find if participant already exists in this round
    let participantIndex = currentRound.participants.findIndex(p => p.user?._id === data.userId || p.user === data.userId);

    // Update existing participant or add new one
    if (participantIndex !== -1) {
        // Update existing participant's total value and tickets
        currentRound.participants[participantIndex] = {
            ...currentRound.participants[participantIndex],
            itemsValue: (currentRound.participants[participantIndex].itemsValue || 0) + data.itemsValue,
            tickets: data.tickets // Update tickets based on server calculation
        };
    } else {
        // Add new participant
        currentRound.participants.push({
            user: { // Store user info nested
                _id: data.userId, // Use _id consistently if available
                username: data.username || 'Unknown User',
                avatar: data.avatar || '/img/default-avatar.png'
            },
            itemsValue: data.itemsValue, // Initial value for this participant
            tickets: data.tickets // Initial tickets for this participant
        });
    }

    // Update the total pot value
    currentRound.totalValue = data.totalValue;

    // Add the newly deposited items to the round's master item list
    data.depositedItems.forEach(item => {
        if (item && typeof item.price === 'number' && !isNaN(item.price)) {
            currentRound.items.push({ ...item, owner: data.userId }); // Include owner info
        } else {
            console.warn("Skipping invalid item while adding to round master list:", item);
        }
    });

    // Update UI Elements
    updateRoundUI(); // Update header (pot value, participant count)
    displayLatestDeposit(data); // Display the new deposit block (will show initial percentage)
    updateAllParticipantPercentages(); // Update percentages for all visible blocks
    updateDepositButtonState(); // Update deposit button availability

    // Start timer visually if this is the first participant
    if (currentRound.status === 'active' &&
        currentRound.participants.length === 1 &&
        !timerActive) {
        console.log("First participant joined. Starting client timer visually.");
        timerActive = true;
        startClientTimer(currentRound.timeLeft || CONFIG.ROUND_DURATION);
    }
}


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

    if (!hasDepositBlocks && participantNum === 0) { // Ensure count is also 0
        emptyMsg.style.display = 'block';
        if (!container.contains(emptyMsg)) {
            container.appendChild(emptyMsg);
        }
    } else {
        emptyMsg.style.display = 'none';
    }
}


/**
 * Function to test deposit display with mock data. Adds a new deposit block to the top.
 */
function testDeposit() {
    console.log("--- TESTING DEPOSIT DISPLAY (Adds to Top) ---");

    if (!currentRound) {
        currentRound = { roundId: 'test-round-123', status: 'active', totalValue: 0, participants: [], items: [] };
    } else {
        currentRound.status = 'active';
        if (!currentRound.participants) currentRound.participants = [];
        if (!currentRound.items) currentRound.items = [];
    }

    const randomValue = parseFloat((Math.random() * 50 + 1).toFixed(2));
    // Use _id format for mock user ID for consistency
    const mockUserId = `mock_${Math.floor(Math.random() * 1000)}`;
    const mockUsername = ["RustPlayer99", "ScrapCollector", "AK47Master", "TheNaked", "ZergLeader", "TheRaider", "OilRigEnjoyer"][Math.floor(Math.random() * 7)];
    const mockAvatar = ['https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg', 'https://avatars.steamstatic.com/bb8a0a497b4b1f46b96b6b0775e9368fc8c5c3b4_full.jpg', 'https://avatars.steamstatic.com/3c4c5a7c9968414c3a1ddd1e73cb8e6aeeec5f32_full.jpg', '/img/default-avatar.png'][Math.floor(Math.random() * 4)];

    // Simulate server calculation for cumulative values and tickets
    let existingParticipant = currentRound.participants.find(p => p.user?._id === mockUserId);
    let newTotalValue = (currentRound.totalValue || 0) + randomValue;
    let cumulativeValue = (existingParticipant ? existingParticipant.itemsValue : 0) + randomValue;
    let cumulativeTickets = Math.max(1, Math.floor(cumulativeValue * 100)); // Example ticket calc

    const mockDepositData = {
        roundId: currentRound.roundId,
        userId: mockUserId, // Send ID
        username: mockUsername,
        avatar: mockAvatar,
        itemsValue: randomValue, // Value of *this* deposit
        tickets: cumulativeTickets, // Participant's *new total* tickets
        totalValue: newTotalValue, // *New* total pot value
        depositedItems: []
    };

    // Generate mock items for this deposit
    const rustItemNames = ["Assault Rifle", "Metal Facemask", "Garage Door", "Semi-Automatic Rifle", "Road Sign Kilt", "Coffee Can Helmet", "Sheet Metal Door", "Medical Syringe", "MP5A4", "LR-300", "Bolt Action Rifle", "Satchel Charge", "Explosive Ammo", "High Quality Metal", "Crude Oil", "Tech Trash", "Scrap"];
    const numItems = Math.floor(Math.random() * 10) + 1;
    let remainingValue = mockDepositData.itemsValue;
    let accumulatedValue = 0;

    for (let i = 0; i < numItems; i++) {
        const isLastItem = i === numItems - 1;
        let itemValue;
        if (isLastItem) {
            itemValue = Math.max(0.01, remainingValue);
        } else {
            itemValue = parseFloat((Math.random() * remainingValue * 0.6 + 0.01).toFixed(2));
            itemValue = Math.min(itemValue, remainingValue - (numItems - 1 - i) * 0.01);
            itemValue = Math.max(0.01, itemValue);
        }
        remainingValue -= itemValue;
        accumulatedValue += itemValue;
        if (isLastItem && Math.abs(accumulatedValue - mockDepositData.itemsValue) > 0.001) {
            itemValue += (mockDepositData.itemsValue - accumulatedValue);
            itemValue = Math.max(0.01, parseFloat(itemValue.toFixed(2)));
        } else {
            itemValue = parseFloat(itemValue.toFixed(2));
        }
        mockDepositData.depositedItems.push({
            assetId: `test_asset_${Math.floor(Math.random() * 100000)}`,
            name: rustItemNames[Math.floor(Math.random() * rustItemNames.length)],
            image: `/img/default-item.png`,
            price: itemValue
        });
    }
    // Ensure itemsValue matches sum precisely
    mockDepositData.itemsValue = mockDepositData.depositedItems.reduce((sum, item) => sum + item.price, 0);
    mockDepositData.totalValue = (currentRound.totalValue || 0) + mockDepositData.itemsValue;

    console.log("Mock Deposit Data (Passed to handleNewDeposit):", mockDepositData);
    // Call the main handler which will update the state and then call display functions
    handleNewDeposit(mockDepositData);
}


/**
 * Starts the client-side countdown timer interval.
 * @param {number} [initialTime=CONFIG.ROUND_DURATION] - The time to start counting down from.
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
        if (!timerActive) { // Check if timer should stop
            clearInterval(roundTimer);
            roundTimer = null;
            console.log("Client timer interval stopped (timerActive is false).");
            return;
        }

        timeLeft--; // Decrement time
        if (currentRound) currentRound.timeLeft = timeLeft; // Update local state

        updateTimerUI(timeLeft); // Update UI display
        updateDepositButtonState(); // Update button state (might disable when timer is low)

        if (timeLeft <= 0) { // Timer reached zero
            clearInterval(roundTimer);
            roundTimer = null;
            timerActive = false;
            console.log("Client timer reached zero.");
            if (timerDisplay) timerDisplay.textContent = "0"; // Ensure display shows 0
            updateDepositButtonState(); // Update button state (deposits definitely closed)
            // Server will trigger the 'roundRolling' event
        }
    }, 1000);
}

// --- Roulette/Winner Animation Functions ---

/**
 * Creates the visual items (player avatars) for the roulette animation track.
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

    // Build the ticket pool for visual representation
    let ticketPool = [];
    const totalTicketsInRound = currentRound.participants.reduce((sum, p) => sum + (p.tickets || 0), 0);

    if (totalTicketsInRound <= 0) {
        // Fallback: Use value percentage if tickets are zero
        console.warn("Total tickets in round is zero. Building roulette based on value percentage.");
        const totalValueNonZero = Math.max(0.01, currentRound.totalValue || 0.01);
        const targetVisualBlocks = 150; // Target number of visual blocks
        currentRound.participants.forEach(p => {
            const visualBlocks = Math.max(3, Math.ceil(((p.itemsValue || 0) / totalValueNonZero) * targetVisualBlocks));
            for (let i = 0; i < visualBlocks; i++) ticketPool.push(p); // Add participant reference
        });
    } else {
        // Normal case: Use ticket percentage
        const targetVisualBlocks = 150; // Target number of visual blocks
        currentRound.participants.forEach(p => {
            const tickets = p.tickets || 0;
            const visualBlocksForUser = Math.max(3, Math.ceil((tickets / totalTicketsInRound) * targetVisualBlocks));
            for (let i = 0; i < visualBlocksForUser; i++) {
                ticketPool.push(p); // Add participant reference
            }
        });
    }

    if (ticketPool.length === 0) {
        console.error("Ticket pool calculation resulted in zero items for roulette.");
        track.innerHTML = '<div class="roulette-message">Error building roulette items.</div>';
        return;
    }

    // Shuffle the pool for visual randomness
    ticketPool = shuffleArray([...ticketPool]);

    // Calculate how many items are needed based on container width and desired spin length
    const rouletteContainer = container.querySelector('.roulette-container');
    const containerWidth = rouletteContainer?.offsetWidth || container.offsetWidth || 1000;
    const itemWidthWithMargin = 60 + 10; // Use updated item width + margin (60px + 5px*2)
    const itemsInView = Math.ceil(containerWidth / itemWidthWithMargin);
    const itemsForSpin = 400; // Number of items to spin past (adjust for speed/duration)
    const totalItemsNeeded = itemsForSpin + (itemsInView * 2); // Ensure enough items for wrap-around feel
    const itemsToCreate = Math.max(totalItemsNeeded, 500); // Ensure a minimum number

    console.log(`Targeting ${itemsToCreate} roulette items for smooth animation.`);

    // Create DOM elements
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < itemsToCreate; i++) {
        const participant = ticketPool[i % ticketPool.length]; // Cycle through shuffled pool
        if (!participant || !participant.user) {
            console.warn(`Skipping roulette item creation at index ${i} due to invalid participant data.`);
            continue;
        }

        // Participant.user might be just an ID if not fully populated yet, handle gracefully
        const userId = participant.user._id || participant.user; // Get ID
        const userColor = getUserColor(userId);
        const avatar = participant.user.avatar || '/img/default-avatar.png';
        const username = participant.user.username || 'Unknown User'; // Alt text

        const itemElement = document.createElement('div');
        itemElement.className = 'roulette-item';
        itemElement.dataset.userId = userId; // Store ID
        itemElement.style.borderColor = userColor; // Set border color immediately

        itemElement.innerHTML = `
             <img class="roulette-avatar" src="${avatar}" alt="${username}" loading="lazy"
                   onerror="this.onerror=null; this.src='/img/default-avatar.png';" >`; // Removed inline style on img

        fragment.appendChild(itemElement);
    }

    track.appendChild(fragment);
    console.log(`Created ${track.children.length} items for roulette animation.`);
}


/**
 * Handles the 'roundWinner' event from the server. Switches view and starts the animation.
 * @param {object} data - Winner announcement data.
 */
function handleWinnerAnnouncement(data) {
    if (isSpinning) {
        console.warn("Received winner announcement but animation is already spinning.");
        return;
    }

    // Ensure participant data is loaded before starting
    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) {
        console.error("Missing participant data for winner announcement. Requesting fresh data.");
        socket.emit('requestRoundData'); // Ask server for current data
        setTimeout(() => { // Wait a bit for data to arrive
            if (currentRound?.participants?.length > 0) {
                console.log("Retrying winner announcement after receiving data.");
                handleWinnerAnnouncement(data); // Try again
            } else {
                console.error("Still no participant data after requesting. Cannot start spin.");
                resetToJackpotView(); // Give up and reset
            }
        }, 1500);
        return;
    }

    // Get winner details (from event or local state if available)
    const winnerDetails = data.winner || currentRound?.winner;
    // Use winnerDetails.id (which should be Mongo _id) or winnerDetails._id
    const winnerId = winnerDetails?.id || winnerDetails?._id;
    if (!winnerId) {
        console.error("Invalid winner data received in announcement:", data);
        resetToJackpotView();
        return;
    }


    console.log(`Winner announced: ${winnerDetails.username}. Preparing roulette...`);

    // Stop client timer if it's running
    if (timerActive) {
        timerActive = false;
        clearInterval(roundTimer);
        roundTimer = null;
        console.log("Stopped client timer due to winner announcement.");
    }

    // Switch UI to roulette view
    switchToRouletteView();

    // Start the animation after a short delay to allow UI transition
    setTimeout(() => {
        startRouletteAnimation({ winner: winnerDetails }); // Pass the winner object
    }, 500);
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

    const valueDisplay = header.querySelector('.jackpot-value');
    const timerDisplay = header.querySelector('.jackpot-timer');
    const statsDisplay = header.querySelector('.jackpot-stats');

    // Fade out header elements
    [valueDisplay, timerDisplay, statsDisplay].forEach(el => {
        if (el) {
            el.style.transition = 'opacity 0.5s ease';
            el.style.opacity = '0';
            setTimeout(() => { el.style.display = 'none'; }, 500); // Hide after fade
        }
    });

    header.classList.add('roulette-mode'); // Apply class for background/height changes
    rouletteContainer.style.display = 'flex'; // Show roulette (use flex from CSS)
    rouletteContainer.style.opacity = '0';
    rouletteContainer.style.transform = 'translateY(20px)'; // Start slightly down

    // Fade in roulette
    setTimeout(() => {
        rouletteContainer.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
        rouletteContainer.style.opacity = '1';
        rouletteContainer.style.transform = 'translateY(0)';
    }, 600); // Stagger fade in

    if (DOMElements.roulette.returnToJackpotButton) {
        DOMElements.roulette.returnToJackpotButton.style.display = 'none'; // Ensure hidden initially
    }
}


/**
 * Starts the roulette spinning animation after items are created.
 * @param {object} winnerData - Object containing winner details { winner: { id/ _id, username, avatar } }.
 */
function startRouletteAnimation(winnerData) {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
        console.log("Cancelled previous animation frame.");
    }

    const winnerId = winnerData?.winner?.id || winnerData?.winner?._id;
    if (!winnerId) {
        console.error("Invalid winner data passed to startRouletteAnimation.");
        resetToJackpotView();
        return;
    }

    isSpinning = true;
    updateDepositButtonState();
    spinStartTime = 0; // Reset spin start time tracker

    if (DOMElements.roulette.winnerInfoBox) DOMElements.roulette.winnerInfoBox.style.display = 'none'; // Hide previous winner info

    clearConfetti(); // Clear any leftover confetti
    createRouletteItems(); // Build the items in the track

    const winnerParticipantData = findWinnerFromData(winnerData); // Find full details including value/percentage
    if (!winnerParticipantData) {
        console.error('Could not find full winner details in startRouletteAnimation.');
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
        const minIndexPercent = 0.65;
        const maxIndexPercent = 0.85;
        const minIndex = Math.floor(items.length * minIndexPercent);
        const maxIndex = Math.floor(items.length * maxIndexPercent);

        let winnerItemsIndices = [];
        for (let i = minIndex; i <= maxIndex; i++) {
            if (items[i]?.dataset?.userId === winnerId) { // Compare with winnerId
                winnerItemsIndices.push(i);
            }
        }

        if (winnerItemsIndices.length === 0) {
            console.warn(`No winner items found in preferred range [${minIndex}-${maxIndex}]. Expanding search.`);
            for (let i = 0; i < items.length; i++) {
                 if (items[i]?.dataset?.userId === winnerId) { // Compare with winnerId
                      winnerItemsIndices.push(i);
                 }
            }
        }

        let winningElement, targetIndex;
        if (winnerItemsIndices.length === 0) {
            console.error(`No items found matching winner ID ${winnerId}. Using fallback index.`);
            targetIndex = Math.max(0, Math.min(items.length - 1, Math.floor(items.length * 0.75)));
            winningElement = items[targetIndex];
             if (!winningElement) {
                  console.error('Fallback winning element is invalid!');
                  isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
             }
        } else {
            targetIndex = winnerItemsIndices[Math.floor(Math.random() * winnerItemsIndices.length)];
            winningElement = items[targetIndex];
             if (!winningElement) {
                   console.error(`Selected winning element at index ${targetIndex} is invalid!`);
                   isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
             }
        }
        // --- End Select Winning Element ---

        console.log(`Selected winning element at index ${targetIndex} of ${items.length} total items`);

        // Initiate the animation towards the selected element
        // Pass the full participant data found earlier
        handleRouletteSpinAnimation(winningElement, winnerParticipantData);
    }, 100);
}


/**
 * Handles the core requestAnimationFrame loop for the roulette spin.
 * Calculates the target position (with adjusted variation) and animates towards it.
 * @param {HTMLElement} winningElement - The target DOM element.
 * @param {object} winner - Winner data { user, value, percentage }.
 */
function handleRouletteSpinAnimation(winningElement, winner) {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer?.querySelector('.roulette-container');
    const sound = DOMElements.audio.spinSound;

    if (!winningElement || !track || !container) {
        console.error("Missing elements for roulette animation loop.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const containerWidth = container.offsetWidth;
    const itemWidth = winningElement.offsetWidth || 60; // Use updated width from CSS
    const itemOffsetLeft = winningElement.offsetLeft;

    // Calculate the offset needed to perfectly center the item under the ticker
    const centerOffset = (containerWidth / 2) - (itemWidth / 2);
    const perfectCenterScrollPosition = -(itemOffsetLeft - centerOffset);

    // --- ADJUSTED VARIATION LOGIC START ---
    const initialVariation = (Math.random() * 2 - 1) * (itemWidth * CONFIG.LANDING_POSITION_VARIATION);
    const maxAllowedAbsVariation = itemWidth * 0.49; // Max offset based on item width

    let finalVariation;
    if (Math.abs(initialVariation) <= maxAllowedAbsVariation) {
        finalVariation = initialVariation; // Use original variation if safe
    } else {
        // Snap to edge if variation would land in gap
        finalVariation = Math.sign(initialVariation) * maxAllowedAbsVariation;
        // console.log(`Initial variation ${initialVariation.toFixed(2)} too large, snapping to edge: ${finalVariation.toFixed(2)}`);
    }

    // Calculate the final target position using the adjusted variation
    const targetScrollPosition = perfectCenterScrollPosition + finalVariation;
    // --- ADJUSTED VARIATION LOGIC END ---

    const finalTargetPosition = targetScrollPosition; // This is the definitive end point

    // Animation parameters
    const startPosition = parseFloat(track.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1] || '0');
    const duration = CONFIG.SPIN_DURATION_SECONDS * 1000;
    const bounceDuration = CONFIG.BOUNCE_ENABLED ? 1200 : 0;
    const totalAnimationTime = duration + bounceDuration;
    const totalDistance = finalTargetPosition - startPosition;
    const overshootAmount = totalDistance * CONFIG.BOUNCE_OVERSHOOT_FACTOR;

    let startTime = performance.now();
    spinStartTime = startTime;
    let lastPosition = startPosition;
    let lastTimestamp = startTime;

    track.style.transition = 'none'; // Ensure direct transform manipulation

    // Animation loop function
    function animateRoulette(timestamp) {
        if (!isSpinning) {
            console.log("Animation loop stopped: isSpinning false.");
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
            return;
        }

        const elapsed = timestamp - startTime;
        let currentPosition;
        let animationFinished = false;

        if (elapsed <= duration) {
            const animationPhaseProgress = elapsed / duration;
            const easedProgress = easeOutAnimation(animationPhaseProgress);
            currentPosition = startPosition + totalDistance * easedProgress;
        } else if (CONFIG.BOUNCE_ENABLED && elapsed <= totalAnimationTime) {
            const bouncePhaseProgress = (elapsed - duration) / bounceDuration;
            const bounceDisplacementFactor = calculateBounce(bouncePhaseProgress);
            currentPosition = finalTargetPosition - (overshootAmount * bounceDisplacementFactor);
        } else {
            currentPosition = finalTargetPosition;
            animationFinished = true;
        }

        track.style.transform = `translateX(${currentPosition}px)`;

        lastPosition = currentPosition;
        lastTimestamp = timestamp;

        if (!animationFinished) {
            animationFrameId = requestAnimationFrame(animateRoulette);
        } else {
            console.log("Animation finished naturally in loop.");
            animationFrameId = null;
            finalizeSpin(winningElement, winner); // Call the next step
        }
    }

    // Start the animation loop
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = requestAnimationFrame(animateRoulette);
}


/**
 * Called when the roulette animation physically stops. Applies winner highlighting.
 * @param {HTMLElement} winningElement - The element that won.
 * @param {object} winner - Winner data { user, value, percentage }.
 */
function finalizeSpin(winningElement, winner) {
    // Prevent double execution or running with invalid data
    if ((!isSpinning && winningElement?.classList.contains('winner-highlight')) || !winningElement || !winner?.user) {
        console.log("FinalizeSpin called, but seems already finalized or data invalid.");
        if (isSpinning) { isSpinning = false; updateDepositButtonState(); resetToJackpotView(); }
        return;
    }

    console.log("Finalizing spin: Applying highlight.");
    const winnerId = winner.user.id || winner.user._id; // Get winner ID
    const userColor = getUserColor(winnerId); // Use ID to get color

    // Add highlight class and inject dynamic CSS for the pulse animation
    winningElement.classList.add('winner-highlight');
    const styleId = 'winner-pulse-style';
    document.getElementById(styleId)?.remove();

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        .winner-highlight {
            z-index: 5; border-width: 3px; border-color: ${userColor};
            animation: winnerPulse 1.5s infinite; --winner-color: ${userColor};
            transform: scale(1.05); /* Apply scale directly */
        }
        @keyframes winnerPulse {
            0%, 100% { box-shadow: 0 0 15px var(--winner-color); transform: scale(1.05); }
            50% { box-shadow: 0 0 25px var(--winner-color), 0 0 10px var(--winner-color); transform: scale(1.1); }
        }`;
    document.head.appendChild(style);

    // Short delay before showing winner info box
    setTimeout(() => {
        handleSpinEnd(winningElement, winner);
    }, 300);
}


/**
 * Handles the final actions after the spin animation ends. Displays winner info and triggers confetti.
 * @param {HTMLElement} winningElement - The element that won.
 * @param {object} winner - Winner data { user, value, percentage }.
 */
function handleSpinEnd(winningElement, winner) {
    if (!winningElement || !winner?.user) {
        console.error("handleSpinEnd called with invalid data/element.");
        if (!isSpinning) return; // Already stopped
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; } // Ensure animation frame is stopped

    console.log("Handling spin end: Displaying winner info and confetti.");

    const { winnerInfoBox, winnerAvatar, winnerName, winnerDeposit, winnerChance } = DOMElements.roulette;

    // Check if all necessary winner display elements exist
    if (winnerInfoBox && winnerAvatar && winnerName && winnerDeposit && winnerChance) {
        const winnerId = winner.user.id || winner.user._id; // Get winner ID
        const userColor = getUserColor(winnerId); // Use ID to get color

        // Populate winner details
        winnerAvatar.src = winner.user.avatar || '/img/default-avatar.png';
        winnerAvatar.alt = winner.user.username || 'Winner';
        winnerAvatar.style.borderColor = userColor;
        winnerAvatar.style.boxShadow = `0 0 15px ${userColor}`;

        winnerName.textContent = winner.user.username || 'Winner';
        winnerName.style.color = userColor;

        const depositValueStr = `$${(winner.value || 0).toFixed(2)}`;
        const chanceValueStr = `${(winner.percentage || 0).toFixed(2)}%`;

        // Clear previous text for typing effect
        winnerDeposit.textContent = '';
        winnerChance.textContent = '';

        // Display and animate winner box
        winnerInfoBox.style.display = 'flex';
        winnerInfoBox.style.opacity = '0';
        winnerInfoBox.style.animation = 'fadeIn 0.5s ease forwards';

        // Typing effect for details
        setTimeout(() => {
            let depositIndex = 0; let chanceIndex = 0; const typeDelay = 35;
            if (window.typeDepositInterval) clearInterval(window.typeDepositInterval);
            if (window.typeChanceInterval) clearInterval(window.typeChanceInterval);

            window.typeDepositInterval = setInterval(() => {
                if (depositIndex < depositValueStr.length) {
                    winnerDeposit.textContent += depositValueStr[depositIndex]; depositIndex++;
                } else {
                    clearInterval(window.typeDepositInterval); window.typeDepositInterval = null;
                    window.typeChanceInterval = setInterval(() => {
                        if (chanceIndex < chanceValueStr.length) {
                            winnerChance.textContent += chanceValueStr[chanceIndex]; chanceIndex++;
                        } else {
                            clearInterval(window.typeChanceInterval); window.typeChanceInterval = null;
                            setTimeout(() => { launchConfetti(userColor); }, 200); // Launch confetti using winner's color
                            isSpinning = false; // Officially mark as not spinning
                            updateDepositButtonState();
                            console.log("isSpinning set to false after winner display/confetti.");
                            setTimeout(resetToJackpotView, CONFIG.WINNER_DISPLAY_DURATION); // Schedule reset
                        }
                    }, typeDelay);
                }
            }, typeDelay);
        }, 500); // Delay typing

    } else {
        console.error("Winner info display elements missing.");
        isSpinning = false; // Still mark as not spinning
        updateDepositButtonState();
        resetToJackpotView(); // Reset view immediately
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
        confetti.className = 'confetti-piece'; // Use updated class name from CSS

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

        if (Math.random() < 0.5) confetti.style.borderRadius = '50%';

        container.appendChild(confetti);
    }
}


/**
 * Clears confetti elements and removes winner highlighting styles.
 */
function clearConfetti() {
    if (DOMElements.roulette.confettiContainer) DOMElements.roulette.confettiContainer.innerHTML = '';
    document.getElementById('winner-pulse-style')?.remove();
    document.querySelectorAll('.roulette-item.winner-highlight').forEach(el => {
        el.classList.remove('winner-highlight');
        el.style.transform = ''; // Reset transform
        // Reset border color based on user ID if available
        if (el.dataset?.userId) el.style.borderColor = getUserColor(el.dataset.userId);
        else el.style.borderColor = 'transparent';
    });
}


/**
 * Resets the UI back to the main jackpot view after a round ends.
 */
function resetToJackpotView() {
    console.log("Resetting to jackpot view...");

    // --- Clear Timers & Intervals ---
    if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null;
    if (window.soundFadeInInterval) clearInterval(window.soundFadeInInterval); window.soundFadeInInterval = null;
    if (window.soundFadeOutInterval) clearInterval(window.soundFadeOutInterval); window.soundFadeOutInterval = null;
    if (window.typeDepositInterval) clearInterval(window.typeDepositInterval); window.typeDepositInterval = null;
    if (window.typeChanceInterval) clearInterval(window.typeChanceInterval); window.typeChanceInterval = null;
    if (roundTimer) clearInterval(roundTimer); roundTimer = null;
    timerActive = false;
    // --- End Clear Timers ---

    isSpinning = false; // Ensure state is reset
    spinStartTime = 0;

    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer;
    const winnerInfoBox = DOMElements.roulette.winnerInfoBox;
    const track = DOMElements.roulette.rouletteTrack;
    if (!header || !rouletteContainer || !winnerInfoBox || !track) {
        console.error("Missing elements for resetToJackpotView.");
        return;
    }

    // Reset sound properties
    const sound = DOMElements.audio.spinSound;
    if (sound) {
        sound.pause(); // Ensure sound stops
        sound.currentTime = 0;
        sound.volume = 1.0;
        sound.playbackRate = 1.0;
    }

    // Fade out roulette elements
    rouletteContainer.style.transition = 'opacity 0.5s ease';
    rouletteContainer.style.opacity = '0';
    if (winnerInfoBox.style.display !== 'none') {
        winnerInfoBox.style.transition = 'opacity 0.3s ease';
        winnerInfoBox.style.opacity = '0';
    }
    clearConfetti(); // Clear confetti and highlights

    // After fade out, reset layout and fade in jackpot header
    setTimeout(() => {
        header.classList.remove('roulette-mode');
        track.style.transition = 'none';
        track.style.transform = 'translateX(0)';
        track.innerHTML = ''; // Clear roulette items
        rouletteContainer.style.display = 'none';
        winnerInfoBox.style.display = 'none';
        winnerInfoBox.style.opacity = '';
        winnerInfoBox.style.animation = '';

        // Get jackpot header elements
        const valueDisplay = header.querySelector('.jackpot-value');
        const timerDisplay = header.querySelector('.jackpot-timer');
        const statsDisplay = header.querySelector('.jackpot-stats');

        // Restore and fade in header elements with stagger
        [valueDisplay, timerDisplay, statsDisplay].forEach((el, index) => {
            if (el) {
                // Reset display property based on computed style or default 'flex'
                const computedStyle = window.getComputedStyle(el);
                el.style.display = computedStyle.display !== 'none' ? computedStyle.display : 'flex';
                el.style.opacity = '0'; // Start faded out
                setTimeout(() => {
                    el.style.transition = 'opacity 0.5s ease'; // Apply fade-in transition
                    el.style.opacity = '1'; // Fade in
                }, 50 + index * 50); // Stagger fade-in
            }
        });

        // Reset visual state for a new round
        initiateNewRoundVisualReset();
        updateDepositButtonState(); // Update button state AFTER resetting

        // Request fresh data from server
        if (socket?.connected) { // Check if socket exists and is connected
            console.log("Requesting fresh round data after reset.");
            socket.emit('requestRoundData');
        } else {
            console.warn("Socket not connected, skipping requestRoundData after reset.");
        }

    }, 500); // Delay matches fade-out duration
}


/**
 * Performs the visual reset needed when a new round starts or view is reset.
 */
function initiateNewRoundVisualReset() {
    console.log("Initiating visual reset for new round display");

    // Reset Timer UI
    updateTimerUI(CONFIG.ROUND_DURATION); // Show full duration initially
    if (DOMElements.jackpot.timerValue) {
        DOMElements.jackpot.timerValue.classList.remove('urgent-pulse', 'timer-pulse');
    }
    if (roundTimer) clearInterval(roundTimer); roundTimer = null;
    timerActive = false;

    // Reset Participants List
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (container && emptyMsg) {
        container.innerHTML = ''; // Clear existing blocks
        if (!container.contains(emptyMsg)) container.appendChild(emptyMsg); // Ensure empty message exists
        emptyMsg.style.display = 'block'; // Show empty message
    }

    // Reset Pot Value and Participant Count Display
    if (DOMElements.jackpot.potValue) DOMElements.jackpot.potValue.textContent = "$0.00";
    if (DOMElements.jackpot.participantCount) {
        DOMElements.jackpot.participantCount.textContent = `0/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
    }

    userColorMap.clear(); // Clear user color mappings for the new round
    updateDepositButtonState(); // Update deposit button state
}

/**
 * Helper function to find winner details from local round data.
 * @param {object} winnerData - Data containing winner ID.
 * @returns {object|null} Object with { user, value, percentage } or null.
 */
function findWinnerFromData(winnerData) {
    // Winner ID could be in winnerData.winner.id or winnerData.winner._id
    const winnerId = winnerData?.winner?.id || winnerData?.winner?._id;
    if (!winnerId) {
        console.error("Missing winner ID in findWinnerFromData:", winnerData);
        return null;
    }

    if (!currentRound || !currentRound.participants) {
        console.warn("Missing currentRound/participants data for findWinnerFromData.");
        // Try to return basic info if available directly in winnerData
        if (winnerData.winner) return { user: { ...winnerData.winner }, percentage: 0, value: 0 };
        return null;
    }

    // Find the participant whose user ID matches
    const winnerParticipant = currentRound.participants.find(p => p.user?._id === winnerId || p.user === winnerId);

    if (!winnerParticipant) {
        console.warn(`Winner ID ${winnerId} not found in local participants.`);
        if (winnerData.winner) return { user: { ...winnerData.winner }, percentage: 0, value: 0 };
        return null;
    }

    const totalValue = Math.max(0.01, currentRound.totalValue || 0.01);
    const participantValue = winnerParticipant.itemsValue || 0;
    const percentage = (participantValue / totalValue) * 100;

    return {
        user: { ...(winnerParticipant.user) }, // Return a copy of the user object
        percentage: percentage || 0,
        value: participantValue
    };
}


/**
 * Test function to trigger the roulette animation with mock or current round data.
 */
function testRouletteAnimation() {
    console.log("--- TESTING ROULETTE ANIMATION ---");

    if (isSpinning) {
        showNotification("Already spinning, test cancelled.", 'info');
        return;
    }

    let testData = currentRound;

    if (!testData || !testData.participants || testData.participants.length === 0) {
        console.log('Using sample Rust test data for animation...');
        // Use _id format for mock user IDs
        testData = {
            _id: 'mock-round-id', // Add a mock _id
            roundId: `test-${Date.now()}`, status: 'active', totalValue: 215.50,
            participants: [
                { user: { _id: 'rust_user_1', username: 'Scrap King', avatar: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg' }, itemsValue: 150.25, tickets: 15025 },
                { user: { _id: 'rust_user_2', username: 'Foundation Wipe', avatar: 'https://avatars.steamstatic.com/bb8a0a497b4b1f46b96b6b0775e9368fc8c5c3b4_full.jpg' }, itemsValue: 45.75, tickets: 4575 },
                { user: { _id: 'rust_user_3', username: 'Heli Enjoyer', avatar: 'https://avatars.steamstatic.com/3c4c5a7c9968414c3a1ddd1e73cb8e6aeeec5f32_full.jpg' }, itemsValue: 19.50, tickets: 1950 }
            ],
            items: [ { owner: 'rust_user_1', name: 'Assault Rifle', price: 50.00, image: '/img/default-item.png' }, /* ... */ ]
        };
        currentRound = testData; // Update global state
        // Visually reset and populate based on mock data
        initiateNewRoundVisualReset();
        updateRoundUI();
        if (currentRound.participants?.length > 0) {
            const sortedParticipants = [...currentRound.participants].sort((a, b) => (b.itemsValue || 0) - (a.itemsValue || 0));
            sortedParticipants.forEach(p => {
                const userItems = currentRound.items?.filter(item => item.owner === p.user?._id) || [];
                // Pass data structure matching displayLatestDeposit expectation
                const mockDepositData = { userId: p.user._id, username: p.user.username, avatar: p.user.avatar, itemsValue: p.itemsValue, depositedItems: userItems };
                displayLatestDeposit(mockDepositData); // Will calculate initial %
                // Remove animation class immediately
                const element = DOMElements.jackpot.participantsContainer?.querySelector(`.player-deposit-container[data-user-id="${p.user._id}"]`);
                if (element) element.classList.remove('player-deposit-new');
            });
            updateAllParticipantPercentages(); // Ensure all percentages correct after populating
        }
    } else {
        currentRound.status = 'active'; // Ensure suitable status
    }

    if (!currentRound?.participants?.length > 0) {
        showNotification('Test Error: No participants available for test spin.', 'error');
        return;
    }

    const idx = Math.floor(Math.random() * currentRound.participants.length);
    const winningParticipant = currentRound.participants[idx];

    if (!winningParticipant?.user) {
        console.error("Selected winning participant invalid:", winningParticipant);
        showNotification('Test Error: Could not select valid winner.', 'error');
        return;
    }

    const mockWinnerData = {
        roundId: currentRound.roundId,
        winner: winningParticipant.user, // Pass user object (should have _id)
        winningTicket: Math.floor(Math.random() * (winningParticipant.tickets || 1)) + 1
    };

    console.log('Test Winner Selected:', mockWinnerData.winner.username);
    handleWinnerAnnouncement(mockWinnerData); // Trigger animation flow
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

        const response = await fetch(`/api/rounds?page=${page}&limit=10`);

        if (!response.ok) {
            throw new Error(`Failed to load round history (${response.status})`);
        }
        const data = await response.json();

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
                row.dataset.roundId = round.roundId;

                let date = 'N/A';
                const timeToFormat = round.completedTime || round.endTime;
                if (timeToFormat) {
                    try {
                        const d = new Date(timeToFormat);
                        if (!isNaN(d.getTime())) {
                            date = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
                        }
                    } catch (e) { console.error("Date formatting error:", e); }
                }

                // Escape single quotes in seeds for the onclick attribute
                const serverSeedStr = (round.serverSeed || '').replace(/'/g, "\\'");
                const clientSeedStr = (round.clientSeed || '').replace(/'/g, "\\'");
                const roundIdStr = round.roundId || 'N/A';
                const winnerUsername = round.winner?.username || (round.status === 'error' ? 'ERROR' : 'N/A');
                const potValueStr = (round.totalValue !== undefined) ? `$${round.totalValue.toFixed(2)}` : '$0.00';

                row.innerHTML = `
                    <td>#${roundIdStr}</td>
                    <td>${date}</td>
                    <td>${potValueStr}</td>
                    <td class="${round.winner ? 'winner-cell' : ''}">${winnerUsername}</td>
                    <td>
                        <button class="btn btn-secondary btn-small btn-details" onclick="window.showRoundDetails('${roundIdStr}')" ${roundIdStr === 'N/A' ? 'disabled' : ''}>Details</button>
                        <button class="btn btn-secondary btn-small btn-verify" onclick="window.populateVerificationFields('${roundIdStr}', '${serverSeedStr}', '${clientSeedStr}')" ${!round.serverSeed ? 'disabled title="Seed not revealed yet"' : ''}>Verify</button>
                    </td>`;
                tableBody.appendChild(row);
            });
        }
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
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationSection } = DOMElements.provablyFair;

    if (roundIdInput) roundIdInput.value = roundId || '';
    if (serverSeedInput) serverSeedInput.value = serverSeed || '';
    if (clientSeedInput) clientSeedInput.value = clientSeed || '';

    if (verificationSection) {
        verificationSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    if (!serverSeed && roundId && roundId !== 'N/A') {
        showNotification(`Info: Server Seed for Round #${roundId} is revealed after the round ends.`, 'info');
    }
};

/**
 * Placeholder function to show round details. Made globally accessible via window.
 * @param {string} roundId
 */
window.showRoundDetails = async function(roundId) {
    console.log(`Showing details for round ${roundId}`);
    if (!roundId || roundId === 'N/A') {
        showNotification('Info: Invalid Round ID for details.', 'info');
        return;
    }
    showNotification(`Showing details for round #${roundId}... (Implementation needed)`, 'info');
    // Future implementation needed: Fetch detailed round data (participants, items) and display in a modal or dedicated view.
};


/**
 * Creates pagination controls for the round history table.
 * @param {number} currentPage
 * @param {number} totalPages
 */
function createPagination(currentPage, totalPages) {
    const container = DOMElements.provablyFair.roundsPagination;
    if (!container) return;
    container.innerHTML = '';

    if (totalPages <= 1) return;

    const maxPagesToShow = 5; // Max number buttons (excluding prev/next, including ellipsis)

    const createButton = (text, page, isActive = false, isDisabled = false, isEllipsis = false) => {
        if (isEllipsis) {
            const span = document.createElement('span');
            span.className = 'page-ellipsis'; span.textContent = '...'; return span;
        }
        const button = document.createElement('button');
        button.className = `page-button ${isActive ? 'active' : ''}`;
        button.textContent = text; button.disabled = isDisabled;
        if (!isDisabled && typeof page === 'number') {
            button.addEventListener('click', (e) => { e.preventDefault(); loadPastRounds(page); });
        }
        return button;
    };

    // Previous Button
    container.appendChild(createButton('« Prev', currentPage - 1, false, currentPage <= 1));

    // Page Number Logic (modified from original for better handling of few pages)
    if (totalPages <= maxPagesToShow) {
        // Show all pages if total is less than or equal to max
        for (let i = 1; i <= totalPages; i++) {
            container.appendChild(createButton(i, i, i === currentPage));
        }
    } else {
        // Complex case: Ellipsis needed
        let pages = [];
        pages.push(1); // Always show first page

        // Calculate range around current page
        const rangePadding = Math.floor((maxPagesToShow - 3) / 2); // -3 for first, last, ellipsis
        let rangeStart = Math.max(2, currentPage - rangePadding);
        let rangeEnd = Math.min(totalPages - 1, currentPage + rangePadding);

        // Adjust range if it's too small
        const rangeLength = rangeEnd - rangeStart + 1;
        const needed = (maxPagesToShow - 3); // Number of middle buttons (excluding first, last, potentially two ellipsis)
        if (rangeLength < needed) {
             if (currentPage - rangeStart < rangeEnd - currentPage) { // If closer to start
                 rangeEnd = Math.min(totalPages - 1, rangeStart + needed -1);
             } else { // If closer to end
                 rangeStart = Math.max(2, rangeEnd - needed + 1);
             }
        }

        // Add ellipsis if needed before the range
        if (rangeStart > 2) {
            pages.push('...');
        }

        // Add the calculated range of pages
        for (let i = rangeStart; i <= rangeEnd; i++) {
            pages.push(i);
        }

        // Add ellipsis if needed after the range
        if (rangeEnd < totalPages - 1) {
            pages.push('...');
        }

        pages.push(totalPages); // Always show last page

        // Render the determined pages/ellipsis
        pages.forEach(page => {
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
        socket.emit('requestRoundData'); // Request initial data
    });

    socket.on('disconnect', (reason) => {
        console.log('Socket disconnected:', reason);
        showNotification('Disconnected from server. Attempting to reconnect...', 'error', 5000);
        updateDepositButtonState();
    });

    socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
        showNotification('Connection Error. Please refresh.', 'error', 10000);
        updateDepositButtonState();
    });

    // --- Round Lifecycle Events ---
    socket.on('roundCreated', (data) => {
        console.log('New round created:', data);
        currentRound = data;
        resetToJackpotView(); // Visual reset for the new round
        updateRoundUI(); // Update display with new round data (e.g., hash)
        updateDepositButtonState();
    });

    socket.on('participantUpdated', (data) => {
        console.log('Participant updated:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            handleNewDeposit(data); // Process deposit and update percentages
        } else if (!currentRound && data.roundId) {
            console.warn("Participant update for unknown round. Requesting full data.");
            socket.emit('requestRoundData');
        }
    });

    socket.on('roundRolling', (data) => {
        console.log('Round rolling event received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            timerActive = false; // Stop client timer
            if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
            if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Rolling";
            if (DOMElements.jackpot.timerForeground) updateTimerCircle(0, CONFIG.ROUND_DURATION); // Set circle to empty
            currentRound.status = 'rolling';
            updateDepositButtonState(); // Disable deposits
        }
    });

    socket.on('roundWinner', (data) => {
        console.log('Round winner received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            // Update local round state with winner info if not already set
            if (!currentRound.winner) currentRound.winner = data.winner;
            currentRound.status = 'rolling'; // Ensure status reflects rolling phase
            handleWinnerAnnouncement(data); // Trigger animation
        } else {
            console.warn("Received winner for mismatched round ID.");
        }
    });

    socket.on('roundCompleted', (data) => {
        console.log('Round completed event received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'completed';
            // Update seed info if provided
            if(data.serverSeed) currentRound.serverSeed = data.serverSeed;
            if(data.clientSeed) currentRound.clientSeed = data.clientSeed;
        }
        updateDepositButtonState(); // Keep deposits disabled
        // Note: resetToJackpotView happens after winner animation delay
    });

    socket.on('roundError', (data) => {
        console.error('Round Error event received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'error';
            showNotification(`Round Error: ${data.error || 'Unknown error.'}`, 'error');
            updateDepositButtonState();
            // Optionally reset view immediately on error
            resetToJackpotView();
        }
    });

    // --- Initial/Sync Data ---
    socket.on('roundData', (data) => {
        console.log('Received initial/updated round data:', data);
        if (!data || typeof data !== 'object') { // Add type check for data
            console.error("Invalid round data received from server.");
            showNotification('Error syncing with server.', 'error');
             initiateNewRoundVisualReset(); // Reset to a known empty state
            return;
        }

        currentRound = data; // Update local state
        updateRoundUI();
        updateDepositButtonState();

        // --- Sync Timer and UI State ---
        if (currentRound.status === 'rolling' || currentRound.status === 'completed') {
            // If round is rolling/completed and we have a winner, but animation isn't running, start it
             if (!isSpinning && currentRound.winner) {
                 console.log("Connected mid-round with winner known, triggering animation.");
                 handleWinnerAnnouncement(currentRound);
             } else if (!isSpinning) { // If rolling/completed but no winner data OR already spinning, just reset
                   console.log("Connected after round ended or rolling. Resetting view.");
                   resetToJackpotView();
             }
        } else if (currentRound.status === 'active') {
             // If round is active, has participants, has time left, and timer isn't running client-side -> start/sync it
             if (currentRound.participants?.length > 0 && currentRound.timeLeft > 0 && !timerActive) {
                 console.log(`Received active round data. Starting/syncing timer from ${currentRound.timeLeft}s.`);
                 timerActive = true;
                 startClientTimer(currentRound.timeLeft);
             }
             // If server says time is up, but client timer is still running, stop it
             else if (currentRound.timeLeft <= 0 && timerActive) {
                 console.log("Server data indicates time up, stopping client timer.");
                 timerActive = false;
                 if (roundTimer) clearInterval(roundTimer); roundTimer = null;
                 updateTimerUI(0);
                 updateDepositButtonState();
             }
             // If server says no participants, but client timer is running, stop it
              else if (currentRound.participants?.length === 0 && timerActive) {
                  console.log("Server data indicates no participants, stopping client timer.");
                  timerActive = false;
                  if (roundTimer) clearInterval(roundTimer); roundTimer = null;
                  updateTimerUI(CONFIG.ROUND_DURATION); // Reset timer display visually
                  updateDepositButtonState();
              } else if (!timerActive) {
                  // If timer isn't active, ensure UI reflects current timeLeft from server
                  updateTimerUI(currentRound.timeLeft);
              }
        } else if (currentRound.status === 'pending') {
            console.log("Received pending round state.");
            initiateNewRoundVisualReset(); // Reset to empty state
            if(DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Waiting";
            updateDepositButtonState();
        } else if (!currentRound.status) {
             console.warn("Received round data with no status. Resetting.");
             initiateNewRoundVisualReset();
        }

        // --- Re-render deposits on initial connect/sync ---
        const container = DOMElements.jackpot.participantsContainer;
        if(container && data.participants?.length > 0) {
            console.log("Rendering existing deposits from full round data.");
            container.innerHTML = ''; // Clear first
            if (DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'none';

            // Ensure participants have user details before sorting/displaying
             const validParticipants = data.participants.filter(p => p.user && p.user._id);

             // Sort participants for consistent display (e.g., by total value descending)
             const sortedParticipants = [...validParticipants].sort((a,b) => (b.itemsValue || 0) - (a.itemsValue || 0));

             sortedParticipants.forEach(p => {
                 // Find items associated with this participant
                 const participantItems = data.items?.filter(item => item.owner === p.user._id) || [];
                 displayLatestDeposit({ // Simulate deposit event structure
                     userId: p.user._id,
                     username: p.user.username,
                     avatar: p.user.avatar,
                     itemsValue: p.itemsValue, // Use participant's cumulative value for display
                     depositedItems: participantItems, // Show items linked to this participant
                 });
                  // Remove animation class immediately after adding
                  const element = container.querySelector(`.player-deposit-container[data-user-id="${p.user._id}"]`);
                  if (element) element.classList.remove('player-deposit-new');
             });
              // Update all percentages after rendering initial deposits
              updateAllParticipantPercentages();

        } else if (container && (!data.participants || data.participants.length === 0)) {
            // Ensure empty message is shown if data confirms no participants
            initiateNewRoundVisualReset();
        }

    });

     // MODIFIED: Trade Offer Sent Handler - uses offerURL for link
     socket.on('tradeOfferSent', (data) => {
         console.log('Trade offer sent event received:', data);
         if (currentUser && data.userId === currentUser._id && data.offerURL) {
              // Offer a more direct link for winnings
              showNotification(`Trade Offer Sent: <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">Click here to accept your winnings on Steam!</a> (#${data.offerId})`, 'success', 10000);
         } else if (currentUser && data.userId === currentUser._id) {
              // Fallback if URL is missing (shouldn't happen with backend changes)
              showNotification(`Trade Offer Sent: Check Steam for your winnings! (#${data.offerId})`, 'success', 8000);
         }
     });

    // --- Notification Event (Generic) ---
    socket.on('notification', (data) => {
       console.log('Notification event received:', data);
       // Show notification if it's general (no userId) or targeted at the current user
       if (!data.userId || (currentUser && data.userId === currentUser._id)) {
        showNotification(data.message || 'Received notification from server.', data.type || 'info', data.duration || 4000);
       }
    });
}

// --- Event Listener Setup ---
function setupEventListeners() {
    // Navigation Links
    DOMElements.nav.homeLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.homePage); });
    DOMElements.nav.aboutLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.aboutPage); });
    DOMElements.nav.tosLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.tosPage); }); // Added TOS
    DOMElements.nav.faqLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.faqPage); });
    DOMElements.nav.fairLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.fairPage); });

    // Login Button (with integrated age check)
    DOMElements.user.loginButton?.addEventListener('click', () => {
        if (localStorage.getItem('ageVerified') === 'true') {
            console.log("Age already verified, proceeding to Steam login.");
            window.location.href = '/auth/steam'; // Backend auth route
        } else {
            console.log("Age not verified, showing verification modal.");
            const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
            if(ageCheckbox) ageCheckbox.checked = false;
            if(ageAgreeButton) ageAgreeButton.disabled = true;
            showModal(DOMElements.ageVerification.modal);
        }
    });

    // --- User Profile Dropdown Listeners (MODIFIED) ---
    const { userProfile, userDropdownMenu, logoutButton, profileDropdownButton } = DOMElements.user;

    // Toggle dropdown menu
    userProfile?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (userDropdownMenu) {
            const isVisible = userDropdownMenu.style.display === 'block';
            userDropdownMenu.style.display = isVisible ? 'none' : 'block';
            userProfile?.setAttribute('aria-expanded', !isVisible);
            userProfile?.classList.toggle('open', !isVisible);
        }
    });
    userProfile?.addEventListener('keydown', (e) => {
         if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }
    });

    // Logout Button
    logoutButton?.addEventListener('click', (e) => { e.stopPropagation(); handleLogout(); });
    logoutButton?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleLogout(); } });

    // *** NEW: Profile Button (inside dropdown) Listener ***
    profileDropdownButton?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation(); // Prevent closing dropdown immediately
        const menu = DOMElements.user.userDropdownMenu;
        const modal = DOMElements.profileModal.modal;

        if (currentUser && modal) {
            populateProfileModal(); // Populate with current user data
            showModal(modal); // Show the profile modal
        } else if (!currentUser) {
            showNotification("Please log in to view your profile.", "info");
        } else {
            console.error("Profile modal element not found.");
        }

        // Hide dropdown after clicking profile
        if (menu) menu.style.display = 'none';
        userProfile?.setAttribute('aria-expanded', 'false');
        userProfile?.classList.remove('open');
    });

    // --- NEW: Profile Modal Listeners ---
    DOMElements.profileModal.saveBtn?.addEventListener('click', handleProfileSave);
    DOMElements.profileModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.profileModal.cancelBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal)); // Also hide on Cancel

    // --- Deposit Modal Trigger ---
    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => {
        const button = DOMElements.deposit.showDepositModalButton;
        if (button.disabled) {
            showNotification(button.title || 'Deposits are currently closed.', 'info'); return;
        }
        if (!currentUser) {
            showNotification('Login Required: Please log in first.', 'error'); return;
        }
        // Check trade URL from current user data (should be populated by checkLoginStatus or saved via profile)
         if (!currentUser.tradeUrl) {
             console.log("Trade URL missing for user. Prompting user to set it in profile.");
             showNotification('Trade URL Required: Please open your profile (click your avatar) and set your Steam Trade URL before depositing.', 'error', 6000);
             // Automatically open the NEW profile modal instead of the dropdown
             if (DOMElements.profileModal.modal) {
                 populateProfileModal();
                 showModal(DOMElements.profileModal.modal);
             }
             return;
         }
        showModal(DOMElements.deposit.depositModal);
        loadUserInventory();
    });

    // Deposit Modal Controls
    DOMElements.deposit.closeDepositModalButton?.addEventListener('click', () => hideModal(DOMElements.deposit.depositModal));
    // MODIFIED: Main deposit button now calls requestDepositOffer
    DOMElements.deposit.depositButton?.addEventListener('click', requestDepositOffer);
    // ADDED: Listener for the new accept button
    DOMElements.deposit.acceptDepositOfferBtn?.addEventListener('click', () => {
         if (currentDepositOfferURL) {
              console.log("Opening Steam trade offer:", currentDepositOfferURL);
              window.open(currentDepositOfferURL, '_blank', 'noopener,noreferrer');
              const { depositStatusText } = DOMElements.deposit;
              if(depositStatusText) depositStatusText.textContent = "Check Steam tab...";
              // Optionally hide modal or provide further instructions
              // hideModal(DOMElements.deposit.depositModal);
         } else {
              console.error("No deposit offer URL found for accept button.");
              showNotification("Error: Could not find the trade offer URL.", "error");
         }
    });

    // Age Verification Modal Controls
    const { modal: ageModal, checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
    if (ageModal && ageCheckbox && ageAgreeButton) {
        ageCheckbox.addEventListener('change', () => {
            ageAgreeButton.disabled = !ageCheckbox.checked;
        });
        ageAgreeButton.addEventListener('click', () => {
            if (ageCheckbox.checked) {
                localStorage.setItem('ageVerified', 'true');
                hideModal(ageModal);
                console.log("Age verification agreed. Proceeding to Steam login.");
                window.location.href = '/auth/steam'; // Proceed to login
            }
        });
        ageAgreeButton.disabled = !ageCheckbox.checked; // Initial state
    }

    // Test Buttons
     const testSpinBtn = document.getElementById('testSpinButton');
     const testDepositBtn = document.getElementById('testDepositButton');
     if (testSpinBtn) testSpinBtn.addEventListener('click', testRouletteAnimation);
     if (testDepositBtn) testDepositBtn.addEventListener('click', testDeposit);


    // Provably Fair Verify Button
    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound);

    // --- Global Listeners (MODIFIED) ---
    window.addEventListener('click', (e) => {
        const profileModal = DOMElements.profileModal.modal;

        // Close dropdown when clicking outside
        if (userDropdownMenu && userProfile && userDropdownMenu.style.display === 'block' &&
            !userProfile.contains(e.target) && !userDropdownMenu.contains(e.target)) {
            userDropdownMenu.style.display = 'none';
            userProfile.setAttribute('aria-expanded', 'false');
            userProfile.classList.remove('open');
        }
        // Close modals on backdrop click
        if (e.target === DOMElements.deposit.depositModal) hideModal(DOMElements.deposit.depositModal);
        // Close profile modal on backdrop click
        if (e.target === profileModal) hideModal(profileModal);
        // Age verification backdrop click behavior (optional)
        if (e.target === DOMElements.ageVerification.modal) {
            // Decide if clicking backdrop closes age verification
            // hideModal(DOMElements.ageVerification.modal);
        }
    });

    document.addEventListener('keydown', function(event) {
        const profileModal = DOMElements.profileModal.modal;
        const depositModal = DOMElements.deposit.depositModal;

        // Escape Key Logic
        if (event.key === 'Escape') {
             // Close open modals first (priority)
             if (profileModal?.style.display === 'flex') {
                 hideModal(profileModal);
             } else if (depositModal?.style.display === 'flex') {
                 hideModal(depositModal);
             }
             // Then close dropdown if no modal was closed
             else if (userDropdownMenu && userDropdownMenu.style.display === 'block') {
                 userDropdownMenu.style.display = 'none';
                 userProfile?.setAttribute('aria-expanded', 'false');
                 userProfile?.classList.remove('open');
                 userProfile?.focus(); // Return focus to the profile button
             }
        }

        // Spacebar test trigger (only if home page visible and not in modal/input)
        if (event.code === 'Space' &&
            DOMElements.pages.homePage?.style.display === 'block' &&
            !isSpinning &&
            !document.querySelector('.modal[style*="display: flex"]') && // Check if any modal is open
            !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) // Check if focus is on interactive element
        {
            console.log("Spacebar pressed for test spin.");
             if (testSpinBtn) testSpinBtn.click(); // Trigger the button's click handler
            event.preventDefault();
        }
    });
}

// --- NEW Helper Functions for Profile Modal ---

/**
 * Populates the profile modal fields, including pending offer status.
 */
function populateProfileModal() {
    const modalElements = DOMElements.profileModal; if (!currentUser || !modalElements.modal) return;
    modalElements.avatar.src = currentUser.avatar || '/img/default-avatar.png'; modalElements.name.textContent = currentUser.username || 'User';
    modalElements.deposited.textContent = `$${(currentUser.totalDeposited || 0).toFixed(2)}`; modalElements.tradeUrlInput.value = currentUser.tradeUrl || '';
    // Handle Pending Offer Status Display (ADDED/MODIFIED PART)
    const statusDiv = modalElements.pendingOfferStatus; if (!statusDiv) return;
    if (currentUser.pendingDepositOfferId) {
        const offerId = currentUser.pendingDepositOfferId; const offerURL = `https://steamcommunity.com/tradeoffer/${offerId}/`;
        // Use innerHTML to create a clickable link
        statusDiv.innerHTML = `<p>⚠️ You have a <a href="${offerURL}" target="_blank" rel="noopener noreferrer" class="profile-pending-link">pending deposit offer (#${offerId})</a> awaiting action on Steam.</p>`;
        statusDiv.style.display = 'block';
    } else {
        statusDiv.style.display = 'none';
        statusDiv.innerHTML = ''; // Clear content when no offer
    }
}

/**
 * Handles saving profile changes (currently just trade URL).
 */
async function handleProfileSave() {
    const { tradeUrlInput, saveBtn } = DOMElements.profileModal;
    if (!tradeUrlInput || !saveBtn) return;
    if (!currentUser) {
         showNotification("Not logged in.", "error");
         return;
     }

    const newTradeUrl = tradeUrlInput.value.trim();

    // Basic URL validation (Improve this regex as needed)
    const urlPattern = /^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/i;
    if (!newTradeUrl) {
        // Allow clearing the trade URL
        console.log("Attempting to clear Trade URL.");
    } else if (!urlPattern.test(newTradeUrl)) {
        // If not empty, validate the format
        showNotification('Invalid Steam Trade URL format. Please check and try again. It should look like https://steamcommunity.com/tradeoffer/new/?partner=...&token=...', 'error', 6000);
        return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
        const response = await fetch('/api/user/tradeurl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tradeUrl: newTradeUrl }), // Send empty string to clear
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.error || `Failed to save trade URL (${response.status})`);
        }

        // Success! Update local state and notify user
        currentUser.tradeUrl = newTradeUrl; // Update with the new value (could be empty string)
        showNotification(newTradeUrl ? 'Trade URL saved successfully!' : 'Trade URL cleared successfully!', 'success');
        updateDepositButtonState(); // ADDED: Re-check deposit button state
        hideModal(DOMElements.profileModal.modal); // Close modal on success

    } catch (error) {
        console.error("Error saving trade URL:", error);
        showNotification(`Error saving Trade URL: ${error.message}`, 'error');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
    }
}


// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed.");

    // Check age verification status first
    const ageVerified = localStorage.getItem('ageVerified') === 'true';

    // Initialize core components
    checkLoginStatus(); // Check login status (which updates UI)
    setupEventListeners();
    setupSocketConnection();
    showPage(DOMElements.pages.homePage); // Show home page by default
    initiateNewRoundVisualReset(); // Reset UI elements to default state

    // If age is not verified, ensure modal is shown (even if checkLoginStatus ran first)
    if (!ageVerified && DOMElements.ageVerification.modal) {
        // Ensure initial state of checkbox/button
        const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
        if(ageCheckbox) ageCheckbox.checked = false;
        if(ageAgreeButton) ageAgreeButton.disabled = true;
        showModal(DOMElements.ageVerification.modal);
    }
});

console.log("main.js (Combined Version, Modified - Trade Offer Flow) loaded.");
