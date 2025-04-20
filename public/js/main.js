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
        homeLink: document.querySelector('.main-nav a.active'), // Assuming first link is home
        faqLink: document.getElementById('faq-link'),
        fairLink: document.getElementById('fair-link'),
        aboutLink: document.getElementById('about-link'),
        roadmapLink: document.getElementById('roadmap-link'),
    },
    pages: {
        homePage: document.getElementById('home-page'),
        faqPage: document.getElementById('faq-page'),
        fairPage: document.getElementById('fair-page'),
        aboutPage: document.getElementById('about-page'),
        roadmapPage: document.getElementById('roadmap-page'),
    },
    // User Authentication / Profile
    user: {
        loginButton: document.getElementById('loginButton'),
        userProfile: document.getElementById('userProfile'), // The clickable profile part
        userAvatar: document.getElementById('userAvatar'),
        userName: document.getElementById('userName'),
        userDropdownMenu: document.getElementById('userDropdownMenu'), // The dropdown menu itself
        logoutButton: document.getElementById('logoutButton'), // The logout button inside the dropdown
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
    },
    // Trade URL Modal
    tradeUrl: {
        tradeUrlModal: document.getElementById('tradeUrlModal'),
        closeTradeUrlModalButton: document.getElementById('closeTradeUrlModal'),
        tradeUrlInput: document.getElementById('tradeUrlInput'),
        saveTradeUrlButton: document.getElementById('saveTradeUrl'),
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
    // Audio Elements (Moved Here)
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
    document.querySelectorAll('.main-nav a, a#about-link, a#roadmap-link, a#faq-link, a#fair-link')
        .forEach(link => link?.classList.remove('active'));

    // Find the corresponding link element to activate
    let activeLink = null;
    if (pageElement === DOMElements.pages.homePage) activeLink = DOMElements.nav.homeLink;
    else if (pageElement === DOMElements.pages.faqPage) activeLink = DOMElements.nav.faqLink;
    else if (pageElement === DOMElements.pages.fairPage) activeLink = DOMElements.nav.fairLink;
    else if (pageElement === DOMElements.pages.aboutPage) activeLink = DOMElements.nav.aboutLink;
    else if (pageElement === DOMElements.pages.roadmapPage) activeLink = DOMElements.nav.roadmapLink;

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
 * Requires a div with id="notification-bar" in the HTML.
 * @param {string} message - The message to display.
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

    bar.textContent = message;
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

// --- Add Logout Function ---
/**
 * Handles the user logout process by calling the backend.
 */
async function handleLogout() {
    console.log("Attempting logout...");
    try {
        const response = await fetch('/logout', {
            method: 'POST',
            headers: {
                // No 'Content-Type' needed for an empty body POST usually
                // Add CSRF token header if your session setup requires it
            }
        });

        const result = await response.json();

        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Logout request failed.');
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
        if (DOMElements.user.userDropdownMenu) {
            DOMElements.user.userDropdownMenu.style.display = 'none';
            DOMElements.user.userProfile?.setAttribute('aria-expanded', 'false');
            DOMElements.user.userProfile?.classList.remove('open'); // Optional class for arrow styling
        }
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
            console.log('User logged in:', currentUser?.username);
        }
    } catch (error) {
        console.error('Error checking login status:', error);
        currentUser = null;
        showNotification(`Error checking login: ${error.message}`, 'error');
    } finally {
        updateUserUI(); // Update profile/login button visibility
        updateDepositButtonState(); // Update deposit button based on login status
    }
}

/**
 * Updates the user profile section (avatar, name) or shows the login button.
 */
function updateUserUI() {
    // ADD userDropdownMenu to the destructuring assignment:
    const { loginButton, userProfile, userAvatar, userName, userDropdownMenu } = DOMElements.user;
    if (!userProfile || !loginButton || !userAvatar || !userName) return;

    if (currentUser) {
        userAvatar.src = currentUser.avatar || '/img/default-avatar.png';
        userName.textContent = currentUser.username || 'User';
        loginButton.style.display = 'none';
        userProfile.style.display = 'flex'; // Show the profile block
        userProfile.setAttribute('aria-disabled', 'false'); // Enable profile button
    } else {
        loginButton.style.display = 'flex'; // Show login button
        userProfile.style.display = 'none'; // Hide profile block
        userProfile.setAttribute('aria-disabled', 'true'); // Disable profile button

        // Ensure dropdown is hidden if user logs out while it's open
        if (userDropdownMenu) userDropdownMenu.style.display = 'none';
        userProfile.setAttribute('aria-expanded', 'false');
        userProfile.classList.remove('open');
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

    updateTotalValue(); // Update total value display and deposit button state
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
    // Use a more specific class if needed, or reuse inventory-item style with adjustments
    selectedElement.className = 'selected-item-display'; // Use the class defined in CSS
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
        }
    });

    // Add listener to the item itself to allow deselecting by clicking it here too
    selectedElement.addEventListener('click', () => {
        removeSelectedItem(item.assetId);
        updateTotalValue();
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
 * Updates the total value display in the deposit modal and enables/disables the deposit button.
 */
function updateTotalValue() {
    const { totalValueDisplay, depositButton } = DOMElements.deposit;
    if (!totalValueDisplay || !depositButton) return;

    const total = selectedItemsList.reduce((sum, item) => {
        // Ensure price is valid before adding
        const price = typeof item.price === 'number' && !isNaN(item.price) ? item.price : 0;
        return sum + price;
    }, 0);

    totalValueDisplay.textContent = `$${total.toFixed(2)}`;
    // Enable deposit button only if items are selected AND user is logged in etc. (basic check here)
    depositButton.disabled = selectedItemsList.length === 0;
}

/**
 * Handles the deposit submission process.
 * Initiates the deposit with the backend and instructs the user on the trade offer process.
 */
async function submitDeposit() {
    const { depositButton: button, depositModal } = DOMElements.deposit;
    if (!button) return;

    if (selectedItemsList.length === 0) {
        showNotification('No Items Selected: Please select items from your inventory first.', 'info');
        return;
    }

    // Double-check round status client-side (backend enforces this anyway)
    if (!currentRound || currentRound.status !== 'active' || isSpinning) {
        showNotification('Deposit Error: Deposits are currently closed.', 'error');
        return;
    }
    // Add checks for limits again, although main button should be disabled
    if (currentRound.participants && currentRound.participants.length >= CONFIG.MAX_PARTICIPANTS_DISPLAY) {
        showNotification(`Deposit Error: The participant limit (${CONFIG.MAX_PARTICIPANTS_DISPLAY}) has been reached.`, 'error');
        return;
    }
    if (currentRound.items && currentRound.items.length + selectedItemsList.length > CONFIG.MAX_ITEMS_PER_POT_FRONTEND) {
        showNotification(`Deposit Error: Depositing these items would exceed the pot limit (${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}).`, 'error');
        return;
    }

    button.disabled = true;
    button.textContent = 'Processing...';

    try {
        // Step 1: Initiate deposit with the server to get token/URL
        const initiateResponse = await fetch('/api/deposit/initiate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        if (!initiateResponse.ok) {
            const error = await initiateResponse.json().catch(() => ({ error: 'Failed to initiate deposit.' }));
            throw new Error(error.error || `Deposit initiation failed (${initiateResponse.status})`);
        }

        const { depositToken, botTradeUrl } = await initiateResponse.json();

        if (!depositToken || !botTradeUrl) {
            throw new Error('Invalid response from deposit initiation.');
        }

        // Step 2: Construct the trade offer URL and instructions for the user
        const fullBotTradeUrl = `${botTradeUrl}&message=${encodeURIComponent(depositToken)}`;
        console.log("Deposit Token:", depositToken);
        console.log("Full URL for user:", fullBotTradeUrl);

        // Step 3: Inform the user clearly about the next steps.
        const selectedValue = DOMElements.deposit.totalValueDisplay?.textContent || '$?.??';
        const instructionMessage = `Trade Offer Required:\n\n` +
            `1. Open a trade offer with our bot.\n` +
            `2. Add the ${selectedItemsList.length} item(s) you selected (Value: ${selectedValue}).\n` +
            `3. IMPORTANT: Put this EXACT code in the trade message: ${depositToken}\n\n` +
            `Use the link below (or copy it) to open the trade window. The deposit will be processed once the trade is accepted with the correct message.`;

        showNotification(instructionMessage, 'info', 15000); // Show for longer duration

        // Provide a clickable link inside the modal or notification if possible
        // Example (requires adding a placeholder element):
        // const tradeLinkPlaceholder = document.getElementById('tradeLinkPlaceholder');
        // if (tradeLinkPlaceholder) {
        //     tradeLinkPlaceholder.innerHTML = `<p>Open trade: <a href="${fullBotTradeUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-small">Steam Trade</a><br>Message: <code>${depositToken}</code></p>`;
        // }


        // Clear selection and close modal AFTER initiating successfully
        if (depositModal) hideModal(depositModal);
        selectedItemsList = [];
        if (DOMElements.deposit.selectedItemsContainer) DOMElements.deposit.selectedItemsContainer.innerHTML = '';
        if (DOMElements.deposit.inventoryItemsContainer) {
            DOMElements.deposit.inventoryItemsContainer.querySelectorAll('.inventory-item.selected')
                .forEach(el => el.classList.remove('selected'));
        }
        updateTotalValue(); // Resets value and deposit button state

    } catch (error) {
        showNotification(`Deposit Initiation Error: ${error.message}`, 'error');
        console.error('Error initiating deposit:', error);
        // Re-enable button based on selection only if error occurred
        button.disabled = selectedItemsList.length === 0;
    } finally {
        // Reset button text regardless of success/failure after processing
         button.textContent = 'Deposit Items';
    }
}


/**
 * Saves the user's Steam Trade URL via backend API call.
 */
async function saveUserTradeUrl() {
    const { tradeUrlInput, saveTradeUrlButton, tradeUrlModal } = DOMElements.tradeUrl;
    if (!tradeUrlInput || !saveTradeUrlButton || !tradeUrlModal) {
        console.error("Trade URL modal elements missing.");
        return;
    }

    const tradeUrl = tradeUrlInput.value.trim();

    // Basic validation
    if (!tradeUrl) {
        showNotification('Input Required: Please enter your Steam Trade URL.', 'error');
        return;
    }
    // More specific validation
    if (!tradeUrl.includes('steamcommunity.com/tradeoffer/new/') ||
        !tradeUrl.includes('partner=') ||
        !tradeUrl.includes('token=')) {
        showNotification('Invalid Format: Please enter a valid Steam Trade URL including partner and token parameters.', 'error');
        return;
    }

    saveTradeUrlButton.disabled = true;
    saveTradeUrlButton.textContent = 'Saving...';

    try {
        const response = await fetch('/api/user/tradeurl', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tradeUrl })
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Failed to save Trade URL.' }));
            throw new Error(error.error || `Save failed (${response.status})`);
        }

        const result = await response.json();
        if (currentUser) currentUser.tradeUrl = result.tradeUrl; // Update local user object

        hideModal(tradeUrlModal);

        const depositTriggerButton = DOMElements.deposit.showDepositModalButton;
        updateDepositButtonState(); // Re-evaluate deposit button state
        if (depositTriggerButton && !depositTriggerButton.disabled) {
            showNotification('Success: Trade URL saved. You can now try depositing again.', 'success');
        } else {
            showNotification('Success: Trade URL saved.', 'success');
        }

    } catch (error) {
        showNotification(`Error Saving URL: ${error.message}`, 'error');
        console.error('Error updating trade URL:', error);
    } finally {
        saveTradeUrlButton.disabled = false;
        saveTradeUrlButton.textContent = 'Save Trade URL';
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
        displayValue = CONFIG.ROUND_DURATION.toString();
    } else if (timerActive || (currentRound && currentRound.status === 'active' && timeToShow > 0)) {
        displayValue = timeToShow.toString();
    } else if (isSpinning || (currentRound && currentRound.status === 'rolling')) {
        displayValue = "Rolling";
    } else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'error')) {
        displayValue = "Ended";
    } else if (!timerActive && timeToShow <= 0 && currentRound && currentRound.status === 'active') {
        displayValue = "0";
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

    if (circle.tagName === 'circle' && circle.r?.baseVal?.value) {
        const radius = circle.r.baseVal.value;
        const circumference = 2 * Math.PI * radius;
        const progress = Math.min(1, Math.max(0, timeLeft / Math.max(1, totalTime)));
        const offset = circumference * (1 - progress);

        circle.style.strokeDasharray = `${circumference}`;
        circle.style.strokeDashoffset = `${Math.max(0, offset)}`;
    } else {
        // console.warn("timerForeground is not an SVG circle or 'r' attribute missing.");
    }
}


/**
 * Displays the latest deposit as a new block at the TOP of the participants container.
 * @param {object} data - Participant update data.
 */
function displayLatestDeposit(data) {
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (!container) return;

    if (!data || !data.userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue)) {
        console.error("Invalid data passed to displayLatestDeposit:", data);
        return;
    }

    // --->>> Play Deposit Sound <<<---
    const depositSfx = DOMElements.audio.depositSound; // Get the deposit sound element
    if (depositSfx) {
        depositSfx.volume = 0.6; // Adjust volume (0.0 to 1.0) as needed
        depositSfx.currentTime = 0; // Ensure it plays from the start if triggered quickly
        depositSfx.play().catch(e => console.error("Error playing deposit sound:", e));
    }
    // --->>> End Deposit Sound <<<---


    const username = data.username || 'Unknown User';
    const avatar = data.avatar || '/img/default-avatar.png';
    const value = data.itemsValue;
    const items = data.depositedItems || [];
    const userColor = getUserColor(data.userId);

    const depositContainer = document.createElement('div');
    depositContainer.dataset.userId = data.userId;
    depositContainer.className = 'player-deposit-container player-deposit-new';

    const depositHeader = document.createElement('div');
    depositHeader.className = 'player-deposit-header';
    depositHeader.innerHTML = `
        <img src="${avatar}" alt="${username}" class="player-avatar" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-avatar.png';" style="border-color: ${userColor};">
        <div class="player-info">
            <div class="player-name" title="${username}">${username}</div>
            <div class="player-deposit-value" style="color: ${userColor}" title="Deposited Value: $${value.toFixed(2)}">$${value.toFixed(2)}</div>
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
            itemElement.style.borderColor = userColor;
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
            moreItems.style.color = userColor;
            moreItems.textContent = `+${items.length - CONFIG.MAX_ITEMS_PER_DEPOSIT} more`;
            itemsGrid.appendChild(moreItems);
        }
    }

    depositContainer.appendChild(depositHeader);
    depositContainer.appendChild(itemsGrid);

    if (container.firstChild) {
        container.insertBefore(depositContainer, container.firstChild);
    } else {
        container.appendChild(depositContainer);
    }

    if (emptyMsg) emptyMsg.style.display = 'none';

    setTimeout(() => {
        depositContainer.classList.remove('player-deposit-new');
    }, 500);

    const currentDepositBlocks = container.querySelectorAll('.player-deposit-container');
    if (currentDepositBlocks.length > CONFIG.MAX_DISPLAY_DEPOSITS) {
        const blocksToRemove = currentDepositBlocks.length - CONFIG.MAX_DISPLAY_DEPOSITS;
        for (let i = 0; i < blocksToRemove; i++) {
            const oldestBlock = container.querySelector('.player-deposit-container:last-child');
            if (oldestBlock && oldestBlock !== depositContainer) {
                oldestBlock.style.transition = 'opacity 0.3s ease-out';
                oldestBlock.style.opacity = '0';
                setTimeout(() => {
                    if (oldestBlock.parentNode === container) {
                        oldestBlock.remove();
                    }
                }, 300);
            }
        }
    }
}


/**
 * Handles incoming participant update data from the server via Socket.IO.
 * @param {object} data - Data received from the 'participantUpdated' socket event.
 */
function handleNewDeposit(data) {
    if (!data || !data.roundId || !data.userId ||
        typeof data.itemsValue !== 'number' || isNaN(data.itemsValue) ||
        data.totalValue === undefined || data.tickets === undefined) {
        console.error("Invalid participant update data received:", data);
        return;
    }
    if (!data.depositedItems) data.depositedItems = [];

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
        console.warn(`Deposit received for wrong round (${data.roundId}). Current is ${currentRound.roundId}. Ignoring.`);
        return;
    }

    if (!currentRound.participants) currentRound.participants = [];
    if (!currentRound.items) currentRound.items = [];

    let participantIndex = currentRound.participants.findIndex(p => p.user?.id === data.userId);

    if (participantIndex !== -1) {
        currentRound.participants[participantIndex] = {
            ...currentRound.participants[participantIndex],
            itemsValue: (currentRound.participants[participantIndex].itemsValue || 0) + data.itemsValue,
            tickets: data.tickets
        };
    } else {
        currentRound.participants.push({
            user: {
                id: data.userId,
                username: data.username || 'Unknown User',
                avatar: data.avatar || '/img/default-avatar.png'
            },
            itemsValue: data.itemsValue,
            tickets: data.tickets
        });
    }

    currentRound.totalValue = data.totalValue;

    data.depositedItems.forEach(item => {
        if (item && typeof item.price === 'number' && !isNaN(item.price)) {
            currentRound.items.push({ ...item, owner: data.userId });
        } else {
            console.warn("Skipping invalid item while adding to round master list:", item);
        }
    });

    updateRoundUI();
    displayLatestDeposit(data);
    updateDepositButtonState();

    if (currentRound.status === 'active' &&
        currentRound.participants.length === 1 &&
        !timerActive) {
        console.log("First participant joined. Starting client timer visually.");
        timerActive = true;
        startClientTimer(currentRound.timeLeft || CONFIG.ROUND_DURATION);
    }
}


/**
 * Updates ONLY the participant count display in the header and the empty pot message visibility.
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

    if (!hasDepositBlocks) {
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
    const mockUserId = `test_user_${Math.floor(Math.random() * 1000)}`;
    const mockUsername = ["RustPlayer99", "ScrapCollector", "AK47Master", "TheNaked", "ZergLeader", "TheRaider", "OilRigEnjoyer"][Math.floor(Math.random() * 7)];
    const mockAvatar = ['https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg', 'https://avatars.steamstatic.com/bb8a0a497b4b1f46b96b6b0775e9368fc8c5c3b4_full.jpg', 'https://avatars.steamstatic.com/3c4c5a7c9968414c3a1ddd1e73cb8e6aeeec5f32_full.jpg', '/img/default-avatar.png'][Math.floor(Math.random() * 4)];

    let existingParticipant = currentRound.participants.find(p => p.user.id === mockUserId);
    let cumulativeTickets = 0;
    let cumulativeValue = 0;
    if (existingParticipant) {
        cumulativeValue = (existingParticipant.itemsValue || 0) + randomValue;
        cumulativeTickets = Math.max(1, Math.floor(cumulativeValue * 100));
    } else {
        cumulativeValue = randomValue;
        cumulativeTickets = Math.max(1, Math.floor(cumulativeValue * 100));
    }

    const mockDepositData = {
        roundId: currentRound.roundId,
        userId: mockUserId,
        username: mockUsername,
        avatar: mockAvatar,
        itemsValue: randomValue,
        tickets: cumulativeTickets,
        totalValue: (currentRound.totalValue || 0) + randomValue,
        depositedItems: []
    };

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
    mockDepositData.itemsValue = mockDepositData.depositedItems.reduce((sum, item) => sum + item.price, 0);
    mockDepositData.totalValue = (currentRound.totalValue || 0) + mockDepositData.itemsValue;

    console.log("Mock Deposit Data:", mockDepositData);
    handleNewDeposit(mockDepositData);
}


/**
 * Starts the client-side countdown timer interval.
 * @param {number} [initialTime=CONFIG.ROUND_DURATION] - The time to start counting down from.
 */
function startClientTimer(initialTime = CONFIG.ROUND_DURATION) {
    const timerDisplay = DOMElements.jackpot.timerValue;
    if (!timerDisplay) return;

    if (roundTimer) clearInterval(roundTimer);

    let timeLeft = Math.max(0, initialTime);
    console.log(`Starting/Syncing client timer from ${timeLeft}s`);
    timerActive = true;
    updateTimerUI(timeLeft);
    updateDepositButtonState();

    roundTimer = setInterval(() => {
        if (!timerActive) {
            clearInterval(roundTimer);
            roundTimer = null;
            console.log("Client timer interval stopped (timerActive is false).");
            return;
        }

        timeLeft--;
        if (currentRound) currentRound.timeLeft = timeLeft;

        updateTimerUI(timeLeft);
        updateDepositButtonState();

        if (timeLeft <= 0) {
            clearInterval(roundTimer);
            roundTimer = null;
            timerActive = false;
            console.log("Client timer reached zero.");
            if (timerDisplay) timerDisplay.textContent = "0";
            updateDepositButtonState();
        }
    }, 1000);
}

// --- Roulette/Winner Animation Functions ---

/**
 * Creates the visual items (player avatars/info) for the roulette animation track.
 */
function createRouletteItems() {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer;
    if (!track || !container) {
        console.error("Roulette track or inline roulette element missing.");
        return;
    }

    track.innerHTML = '';
    track.style.transition = 'none';
    track.style.transform = 'translateX(0)';

    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) {
        console.error('No participants data available to create roulette items.');
        track.innerHTML = '<div class="roulette-message">Waiting for participants...</div>';
        return;
    }

    let ticketPool = [];
    const totalTicketsInRound = currentRound.participants.reduce((sum, p) => sum + (p.tickets || 0), 0);

    if (totalTicketsInRound <= 0) {
        console.warn("Total tickets in round is zero. Building roulette based on value percentage.");
        const totalValueNonZero = Math.max(0.01, currentRound.totalValue || 0.01);
        const targetVisualBlocks = 150;
        currentRound.participants.forEach(p => {
            const visualBlocks = Math.max(3, Math.ceil(((p.itemsValue || 0) / totalValueNonZero) * targetVisualBlocks));
            for (let i = 0; i < visualBlocks; i++) ticketPool.push(p);
        });
    } else {
        const targetVisualBlocks = 150;
        currentRound.participants.forEach(p => {
            const tickets = p.tickets || 0;
            const visualBlocksForUser = Math.max(3, Math.ceil((tickets / totalTicketsInRound) * targetVisualBlocks));
            for (let i = 0; i < visualBlocksForUser; i++) {
                ticketPool.push(p);
            }
        });
    }

    if (ticketPool.length === 0) {
        console.error("Ticket pool calculation resulted in zero items for roulette.");
        track.innerHTML = '<div class="roulette-message">Error building roulette items.</div>';
        return;
    }

    ticketPool = shuffleArray([...ticketPool]);

    const rouletteContainer = container.querySelector('.roulette-container');
    const containerWidth = rouletteContainer?.offsetWidth || container.offsetWidth || 1000;
    const itemWidthWithMargin = 90 + 10;
    const itemsInView = Math.ceil(containerWidth / itemWidthWithMargin);
    const itemsForSpin = 400;
    const totalItemsNeeded = itemsForSpin + (itemsInView * 2);
    const itemsToCreate = Math.max(totalItemsNeeded, 500);

    console.log(`Targeting ${itemsToCreate} roulette items for smooth animation.`);

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < itemsToCreate; i++) {
        const participant = ticketPool[i % ticketPool.length];
        if (!participant || !participant.user) {
            console.warn(`Skipping roulette item creation at index ${i} due to invalid participant data.`);
            continue;
        }

        const userId = participant.user.id;
        const userColor = getUserColor(userId);
        const itemElement = document.createElement('div');
        itemElement.className = 'roulette-item';
        itemElement.dataset.userId = userId;
        itemElement.style.borderColor = userColor; // Set border color immediately

        const totalValueForPercent = Math.max(0.01, currentRound.totalValue || 0.01);
        const percentage = ((participant.itemsValue || 0) / totalValueForPercent * 100).toFixed(1);
        const avatar = participant.user.avatar || '/img/default-avatar.png';
        const username = participant.user.username || 'Unknown User';

        // Use the simpler structure if defined in CSS (adjust HTML generation)
         itemElement.innerHTML = `
             <img class="roulette-avatar" src="${avatar}" alt="${username}" loading="lazy"
                  onerror="this.onerror=null; this.src='/img/default-avatar.png';" style="border-color:${userColor}">
             <div class="roulette-name" title="${username}">${username}</div>
             <div class="roulette-percentage" style="color:${userColor}">${percentage}%</div>`;

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

    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) {
        console.error("Missing participant data for winner announcement. Requesting fresh data.");
        socket.emit('requestRoundData');
        setTimeout(() => {
            if (currentRound?.participants?.length > 0) {
                console.log("Retrying winner announcement after receiving data.");
                handleWinnerAnnouncement(data);
            } else {
                console.error("Still no participant data after requesting. Cannot start spin.");
                resetToJackpotView();
            }
        }, 1500);
        return;
    }

    const winnerDetails = data.winner || currentRound?.winner;
    if (!winnerDetails || !winnerDetails.id) {
        console.error("Invalid winner data received in announcement:", data);
        resetToJackpotView();
        return;
    }

    console.log(`Winner announced: ${winnerDetails.username}. Preparing roulette...`);

    if (timerActive) {
        timerActive = false;
        clearInterval(roundTimer);
        roundTimer = null;
        console.log("Stopped client timer due to winner announcement.");
    }

    switchToRouletteView();

    setTimeout(() => {
        startRouletteAnimation({ winner: winnerDetails });
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

    [valueDisplay, timerDisplay, statsDisplay].forEach(el => {
        if (el) {
            el.style.transition = 'opacity 0.5s ease';
            el.style.opacity = '0';
            setTimeout(() => { el.style.display = 'none'; }, 500);
        }
    });

    header.classList.add('roulette-mode');
    rouletteContainer.style.display = 'block'; // Changed from 'flex' to 'block' if it's just a container
    rouletteContainer.style.opacity = '0';
    rouletteContainer.style.transform = 'translateY(20px)';

    setTimeout(() => {
        rouletteContainer.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
        rouletteContainer.style.opacity = '1';
        rouletteContainer.style.transform = 'translateY(0)';
    }, 600);

    if (DOMElements.roulette.returnToJackpotButton) {
        DOMElements.roulette.returnToJackpotButton.style.display = 'none';
    }
}


/**
 * Starts the roulette spinning animation after items are created.
 * @param {object} winnerData - Object containing winner details.
 */
function startRouletteAnimation(winnerData) {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
        console.log("Cancelled previous animation frame.");
    }

    if (!winnerData?.winner?.id) {
        console.error("Invalid winner data passed to startRouletteAnimation.");
        resetToJackpotView();
        return;
    }

    isSpinning = true;
    updateDepositButtonState();
    spinStartTime = 0;

    if (DOMElements.roulette.winnerInfoBox) DOMElements.roulette.winnerInfoBox.style.display = 'none';

    clearConfetti();
    createRouletteItems();

    const winnerParticipantData = findWinnerFromData(winnerData);
    if (!winnerParticipantData) {
        console.error('Could not find full winner details in startRouletteAnimation.');
        isSpinning = false;
        updateDepositButtonState();
        resetToJackpotView();
        return;
    }

    console.log('Starting animation for Winner:', winnerParticipantData.user.username);

    // Start Spin Sound
    const sound = DOMElements.audio.spinSound; // Use updated reference
    if (sound) {
        sound.volume = 0.7; // Set desired volume directly (e.g., 70%)
        sound.currentTime = 0; // Reset playback to the beginning
        sound.playbackRate = 1.0; // Ensure normal speed
        sound.play().catch(e => console.error('Error playing spin sound:', e)); // Attempt to play
    } else {
        console.warn("Spin sound element not found.");
    }

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

        const minIndexPercent = 0.65;
        const maxIndexPercent = 0.85;
        const minIndex = Math.floor(items.length * minIndexPercent);
        const maxIndex = Math.floor(items.length * maxIndexPercent);

        let winnerItemsIndices = [];
        for (let i = minIndex; i <= maxIndex; i++) {
            if (items[i]?.dataset?.userId === winnerParticipantData.user.id) {
                winnerItemsIndices.push(i);
            }
        }

        if (winnerItemsIndices.length === 0) {
            console.warn(`No winner items found in preferred range [${minIndex}-${maxIndex}]. Expanding search.`);
            for (let i = 0; i < items.length; i++) {
                if (items[i]?.dataset?.userId === winnerParticipantData.user.id) {
                    winnerItemsIndices.push(i);
                }
            }
        }

        let winningElement, targetIndex;
        if (winnerItemsIndices.length === 0) {
            console.error(`No items found matching winner ID ${winnerParticipantData.user.id}. Using fallback index.`);
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

        console.log(`Selected winning element at index ${targetIndex} of ${items.length} total items`);
        handleRouletteSpinAnimation(winningElement, winnerParticipantData);
    }, 100);
}


/**
 * Handles the core requestAnimationFrame loop for the roulette spin.
 * @param {HTMLElement} winningElement - The target DOM element.
 * @param {object} winner - Winner data { user, value, percentage }.
 */
function handleRouletteSpinAnimation(winningElement, winner) {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer?.querySelector('.roulette-container');
    const sound = DOMElements.audio.spinSound; // Use updated reference

    if (!winningElement || !track || !container) {
        console.error("Missing elements for roulette animation loop.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const containerWidth = container.offsetWidth;
    const itemWidth = winningElement.offsetWidth || 90;
    const itemOffsetLeft = winningElement.offsetLeft;

    const centerOffset = (containerWidth / 2) - (itemWidth / 2);
    const positionVariation = (Math.random() * 2 - 1) * (itemWidth * CONFIG.LANDING_POSITION_VARIATION);
    const targetScrollPosition = -(itemOffsetLeft - centerOffset) + positionVariation;
    const finalTargetPosition = targetScrollPosition;

    const startPosition = parseFloat(track.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1] || '0');
    const duration = CONFIG.SPIN_DURATION_SECONDS * 1000;
    const bounceDuration = CONFIG.BOUNCE_ENABLED ? 1200 : 0;
    const totalAnimationTime = duration + bounceDuration;
    const totalDistance = finalTargetPosition - startPosition;
    const overshootAmount = totalDistance * CONFIG.BOUNCE_OVERSHOOT_FACTOR;

    let startTime = performance.now();
    let lastPosition = startPosition;
    let lastTimestamp = startTime;

    track.style.transition = 'none';

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
            finalizeSpin(winningElement, winner);
        }
    }

    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = requestAnimationFrame(animateRoulette);
}


/**
 * Called when the roulette animation physically stops. Applies winner highlighting.
 * @param {HTMLElement} winningElement - The element that won.
 * @param {object} winner - Winner data { user, value, percentage }.
 */
function finalizeSpin(winningElement, winner) {
    if ((!isSpinning && winningElement?.classList.contains('winner-highlight')) || !winningElement || !winner?.user) {
        console.log("FinalizeSpin called, but seems already finalized or data invalid.");
        if (isSpinning) { isSpinning = false; updateDepositButtonState(); resetToJackpotView(); }
        return;
    }

    console.log("Finalizing spin: Applying highlight.");
    const userColor = getUserColor(winner.user.id);

    winningElement.classList.add('winner-highlight');
    const styleId = 'winner-pulse-style';
    document.getElementById(styleId)?.remove();

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        .winner-highlight {
            z-index: 5; border-width: 3px; border-color: ${userColor};
            animation: winnerPulse 1.5s infinite; --winner-color: ${userColor};
            transform: scale(1.05);
        }
        @keyframes winnerPulse {
            0%, 100% { box-shadow: 0 0 15px var(--winner-color); transform: scale(1.05); }
            50% { box-shadow: 0 0 25px var(--winner-color), 0 0 10px var(--winner-color); transform: scale(1.1); }
        }`;
    document.head.appendChild(style);

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
        if (!isSpinning) return;
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }

    console.log("Handling spin end: Displaying winner info and confetti.");

    const { winnerInfoBox, winnerAvatar, winnerName, winnerDeposit, winnerChance } = DOMElements.roulette;
    if (winnerInfoBox && winnerAvatar && winnerName && winnerDeposit && winnerChance) {
        const userColor = getUserColor(winner.user.id);

        winnerAvatar.src = winner.user.avatar || '/img/default-avatar.png';
        winnerAvatar.alt = winner.user.username || 'Winner';
        winnerAvatar.style.borderColor = userColor;
        winnerAvatar.style.boxShadow = `0 0 15px ${userColor}`;

        winnerName.textContent = winner.user.username || 'Winner';
        winnerName.style.color = userColor;

        const depositValueStr = `$${(winner.value || 0).toFixed(2)}`;
        const chanceValueStr = `${(winner.percentage || 0).toFixed(2)}%`;

        winnerDeposit.textContent = '';
        winnerChance.textContent = '';

        winnerInfoBox.style.display = 'flex'; // Changed from block to flex
        winnerInfoBox.style.opacity = '0';
        winnerInfoBox.style.animation = 'fadeIn 0.5s ease forwards';

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
                            setTimeout(() => { launchConfetti(userColor); }, 200);
                            isSpinning = false;
                            updateDepositButtonState();
                            console.log("isSpinning set to false after winner display/confetti.");
                            setTimeout(resetToJackpotView, CONFIG.WINNER_DISPLAY_DURATION);
                        }
                    }, typeDelay);
                }
            }, typeDelay);
        }, 500);

    } else {
        console.error("Winner info display elements missing.");
        isSpinning = false;
        updateDepositButtonState();
        resetToJackpotView();
    }
}


/**
 * Creates and launches confetti elements using the winner's color scheme.
 * @param {string} [mainColor='#00e676'] - Base confetti color.
 */
function launchConfetti(mainColor = '#00e676') {
    const container = DOMElements.roulette.confettiContainer;
    if (!container) return;
    clearConfetti();

    const baseColor = mainColor;
    const complementaryColor = getComplementaryColor(baseColor);
    const lighterColor = lightenColor(baseColor, 30);
    const darkerColor = darkenColor(baseColor, 30);
    const colors = [baseColor, lighterColor, darkerColor, complementaryColor, '#ffffff', lightenColor(complementaryColor, 20)];

    for (let i = 0; i < CONFIG.CONFETTI_COUNT; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'confetti';

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
        el.style.transform = '';
        if (el.dataset?.userId) el.style.borderColor = getUserColor(el.dataset.userId);
        else el.style.borderColor = 'transparent';
    });
}

/**
 * Resets the UI back to the main jackpot view after a round ends.
 */
function resetToJackpotView() {
    console.log("Resetting to jackpot view...");

    if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null;
    if (window.soundFadeInInterval) clearInterval(window.soundFadeInInterval); window.soundFadeInInterval = null;
    if (window.soundFadeOutInterval) clearInterval(window.soundFadeOutInterval); window.soundFadeOutInterval = null;
    if (window.typeDepositInterval) clearInterval(window.typeDepositInterval); window.typeDepositInterval = null;
    if (window.typeChanceInterval) clearInterval(window.typeChanceInterval); window.typeChanceInterval = null;
    if (roundTimer) clearInterval(roundTimer); roundTimer = null;
    timerActive = false;

    isSpinning = false;
    spinStartTime = 0;

    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer;
    const winnerInfoBox = DOMElements.roulette.winnerInfoBox;
    const track = DOMElements.roulette.rouletteTrack;
    if (!header || !rouletteContainer || !winnerInfoBox || !track) {
        console.error("Missing elements for resetToJackpotView.");
        return;
    }

    const sound = DOMElements.audio.spinSound; // Use updated reference
    if (sound) {
        // Reset properties for the *next* spin, but don't affect current playback
        sound.volume = 1.0;
        sound.playbackRate = 1.0;
    }

    rouletteContainer.style.transition = 'opacity 0.5s ease';
    rouletteContainer.style.opacity = '0';
    if (winnerInfoBox.style.display !== 'none') {
        winnerInfoBox.style.transition = 'opacity 0.3s ease';
        winnerInfoBox.style.opacity = '0';
    }
    clearConfetti();

    setTimeout(() => {
        header.classList.remove('roulette-mode');
        track.style.transition = 'none';
        track.style.transform = 'translateX(0)';
        track.innerHTML = '';
        rouletteContainer.style.display = 'none';
        winnerInfoBox.style.display = 'none';
        winnerInfoBox.style.opacity = '';
        winnerInfoBox.style.animation = '';

        const valueDisplay = header.querySelector('.jackpot-value');
        const timerDisplay = header.querySelector('.jackpot-timer');
        const statsDisplay = header.querySelector('.jackpot-stats');

        [valueDisplay, timerDisplay, statsDisplay].forEach((el, index) => {
            if (el) {
                // Ensure display style matches CSS (flex or block etc.)
                const computedStyle = window.getComputedStyle(el);
                el.style.display = computedStyle.display !== 'none' ? computedStyle.display : 'flex'; // Default to flex if hidden
                el.style.opacity = '0';
                setTimeout(() => {
                    el.style.transition = 'opacity 0.5s ease';
                    el.style.opacity = '1';
                }, 50 + index * 50);
            }
        });

        initiateNewRoundVisualReset();
        updateDepositButtonState(); // Update button state AFTER resetting

        if (socket.connected) {
            console.log("Requesting fresh round data after reset.");
            socket.emit('requestRoundData');
        } else {
            console.warn("Socket not connected, skipping requestRoundData after reset.");
        }

    }, 500);
}


/**
 * Performs the visual reset needed when a new round starts or view is reset.
 */
function initiateNewRoundVisualReset() {
    console.log("Initiating visual reset for new round display");

    updateTimerUI(CONFIG.ROUND_DURATION);
    if (DOMElements.jackpot.timerValue) {
        DOMElements.jackpot.timerValue.classList.remove('urgent-pulse', 'timer-pulse');
    }
    if (roundTimer) clearInterval(roundTimer); roundTimer = null;
    timerActive = false;

    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (container && emptyMsg) {
        container.innerHTML = '';
        if (!container.contains(emptyMsg)) container.appendChild(emptyMsg);
        emptyMsg.style.display = 'block';
    }

    if (DOMElements.jackpot.potValue) DOMElements.jackpot.potValue.textContent = "$0.00";
    if (DOMElements.jackpot.participantCount) {
        DOMElements.jackpot.participantCount.textContent = `0/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
    }

    userColorMap.clear();
    updateDepositButtonState();
}

/**
 * Helper function to find winner details from local round data.
 * @param {object} winnerData - Data containing winner ID.
 * @returns {object|null} Object with { user, value, percentage } or null.
 */
function findWinnerFromData(winnerData) {
    const winnerId = winnerData?.winner?.id;
    if (!winnerId) {
        console.error("Missing winner ID in findWinnerFromData:", winnerData);
        return null;
    }

    if (!currentRound || !currentRound.participants) {
        console.warn("Missing currentRound/participants data for findWinnerFromData.");
        if (winnerData.winner) return { user: { ...winnerData.winner }, percentage: 0, value: 0 };
        return null;
    }

    const winnerParticipant = currentRound.participants.find(p => p.user?.id === winnerId);

    if (!winnerParticipant) {
        console.warn(`Winner ID ${winnerId} not found in local participants.`);
        if (winnerData.winner) return { user: { ...winnerData.winner }, percentage: 0, value: 0 };
        return null;
    }

    const totalValue = Math.max(0.01, currentRound.totalValue || 0.01);
    const participantValue = winnerParticipant.itemsValue || 0;
    const percentage = (participantValue / totalValue) * 100;

    return {
        user: { ...winnerParticipant.user },
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
        testData = {
            roundId: `test-${Date.now()}`, status: 'active', totalValue: 215.50,
            participants: [
                { user: { id: 'rust_user_1', username: 'Scrap King', avatar: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg' }, itemsValue: 150.25, tickets: 15025 },
                { user: { id: 'rust_user_2', username: 'Foundation Wipe', avatar: 'https://avatars.steamstatic.com/bb8a0a497b4b1f46b96b6b0775e9368fc8c5c3b4_full.jpg' }, itemsValue: 45.75, tickets: 4575 },
                { user: { id: 'rust_user_3', username: 'Heli Enjoyer', avatar: 'https://avatars.steamstatic.com/3c4c5a7c9968414c3a1ddd1e73cb8e6aeeec5f32_full.jpg' }, itemsValue: 19.50, tickets: 1950 }
            ],
            items: [ { owner: 'rust_user_1', name: 'Assault Rifle', price: 50.00, image: '/img/default-item.png' }, /* ... more items ... */ ]
        };
        currentRound = testData;
        initiateNewRoundVisualReset();
        updateRoundUI();
        if (currentRound.participants?.length > 0) {
            const sortedParticipants = [...currentRound.participants].sort((a, b) => (b.itemsValue || 0) - (a.itemsValue || 0));
            sortedParticipants.forEach(p => {
                const userItems = currentRound.items?.filter(item => item.owner === p.user?.id) || [];
                const mockDepositData = { userId: p.user.id, username: p.user.username, avatar: p.user.avatar, itemsValue: p.itemsValue, depositedItems: userItems };
                displayLatestDeposit(mockDepositData);
                const element = DOMElements.jackpot.participantsContainer?.querySelector(`.player-deposit-container[data-user-id="${p.user.id}"]`);
                if (element) element.classList.remove('player-deposit-new');
            });
        }
    } else {
        currentRound.status = 'active';
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
        winner: winningParticipant.user,
        winningTicket: Math.floor(Math.random() * (winningParticipant.tickets || 1)) + 1
    };

    console.log('Test Winner Selected:', mockWinnerData.winner.username);
    handleWinnerAnnouncement(mockWinnerData);
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
        paginationContainer.innerHTML = '';

        const response = await fetch(`/api/rounds?page=${page}&limit=10`);

        if (!response.ok) {
            throw new Error(`Failed to load round history (${response.status})`);
        }
        const data = await response.json();

        if (!data || !Array.isArray(data.rounds) || typeof data.currentPage !== 'number' || typeof data.totalPages !== 'number') {
            throw new Error('Invalid rounds data received from server.');
        }

        tableBody.innerHTML = '';

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
 * Populates the verification form fields.
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
 * Placeholder function to show round details.
 * @param {string} roundId
 */
window.showRoundDetails = async function(roundId) {
    console.log(`Showing details for round ${roundId}`);
    if (!roundId || roundId === 'N/A') {
        showNotification('Info: Invalid Round ID for details.', 'info');
        return;
    }
    showNotification(`Workspaceing details for round #${roundId}... (Implementation needed)`, 'info');
    // Future implementation: Fetch details and display in a modal
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

    const maxPagesToShow = 5;

    const createButton = (text, page, isActive = false, isDisabled = false, isEllipsis = false) => {
        if (isEllipsis) {
            const span = document.createElement('span');
            span.className = 'page-ellipsis'; span.textContent = '...'; return span;
        }
        const button = document.createElement('button');
        button.className = `btn pagination-btn ${isActive ? 'active' : ''}`; // Added 'btn' class
        button.textContent = text; button.disabled = isDisabled;
        if (!isDisabled && typeof page === 'number') {
            button.addEventListener('click', (e) => { e.preventDefault(); loadPastRounds(page); });
        }
        return button;
    };

    container.appendChild(createButton('« Prev', currentPage - 1, false, currentPage <= 1));

    if (totalPages <= maxPagesToShow) {
        for (let i = 1; i <= totalPages; i++) container.appendChild(createButton(i, i, i === currentPage));
    } else {
        const pages = []; pages.push(1);
        const rangePadding = Math.floor((maxPagesToShow - 3) / 2);
        let rangeStart = Math.max(2, currentPage - rangePadding);
        let rangeEnd = Math.min(totalPages - 1, currentPage + rangePadding);
        const rangeLength = rangeEnd - rangeStart + 1;
        const needed = (maxPagesToShow - 3);
        if (rangeLength < needed) {
            if (currentPage < totalPages / 2) rangeEnd = Math.min(totalPages - 1, rangeEnd + (needed - rangeLength));
            else rangeStart = Math.max(2, rangeStart - (needed - rangeLength));
        }
        if (rangeStart > 2) pages.push('...');
        for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);
        if (rangeEnd < totalPages - 1) pages.push('...');
        pages.push(totalPages);
        pages.forEach(page => {
            if (page === '...') container.appendChild(createButton('...', null, false, true, true));
            else container.appendChild(createButton(page, page, page === currentPage));
        });
    }

    container.appendChild(createButton('Next »', currentPage + 1, false, currentPage >= totalPages));
}


// --- Socket.IO Event Handlers ---
function setupSocketConnection() {
    socket.on('connect', () => {
        console.log('Socket connected:', socket.id);
        showNotification('Connected to server.', 'success', 2000);
        socket.emit('requestRoundData');
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
        resetToJackpotView();
        updateRoundUI();
        updateDepositButtonState(); // Called within reset, but ensure final state is correct
    });

    socket.on('participantUpdated', (data) => {
        console.log('Participant updated:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            handleNewDeposit(data);
        } else if (!currentRound && data.roundId) {
            console.warn("Participant update for unknown round. Requesting full data.");
            socket.emit('requestRoundData');
        }
    });

    socket.on('roundRolling', (data) => {
        console.log('Round rolling event received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            timerActive = false;
            if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
            if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Rolling";
            if (DOMElements.jackpot.timerForeground) updateTimerCircle(0, CONFIG.ROUND_DURATION);
            currentRound.status = 'rolling';
            updateDepositButtonState();
        }
    });

    socket.on('roundWinner', (data) => {
        console.log('Round winner received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            if (!currentRound.winner) currentRound.winner = data.winner;
            currentRound.status = 'rolling';
            handleWinnerAnnouncement(data);
        } else {
            console.warn("Received winner for mismatched round ID.");
        }
    });

    socket.on('roundCompleted', (data) => {
        console.log('Round completed event received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'completed';
            if(data.serverSeed) currentRound.serverSeed = data.serverSeed;
            if(data.clientSeed) currentRound.clientSeed = data.clientSeed;
        }
        updateDepositButtonState();
    });

    socket.on('roundError', (data) => {
        console.error('Round Error event received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'error';
            showNotification(`Round Error: ${data.error || 'Unknown error.'}`, 'error');
            updateDepositButtonState();
        }
    });

    // --- Initial/Sync Data ---
    socket.on('roundData', (data) => {
        console.log('Received initial/updated round data:', data);
        if (!data) {
            console.error("Invalid round data received from server.");
            showNotification('Error syncing with server.', 'error');
            return;
        }

        currentRound = data;
        updateRoundUI();
        updateDepositButtonState();

        if (currentRound.status === 'rolling' || currentRound.status === 'completed') {
            if (!isSpinning && currentRound.winner) {
                console.log("Connected mid-round with winner known, triggering animation.");
                handleWinnerAnnouncement(currentRound);
            } else if (!isSpinning) {
                 console.log("Connected after round ended or rolling. Resetting view.");
                 resetToJackpotView(); // Ensure view is reset if connected post-spin
            }
        } else if (currentRound.status === 'active') {
            if (currentRound.participants?.length >= 1 && currentRound.timeLeft > 0 && !timerActive) {
                console.log(`Received active round data. Starting/syncing timer from ${currentRound.timeLeft}s.`);
                timerActive = true;
                startClientTimer(currentRound.timeLeft || CONFIG.ROUND_DURATION);
            } else if (currentRound.timeLeft <= 0 && timerActive) {
                console.log("Server data indicates time up, stopping client timer.");
                timerActive = false;
                if (roundTimer) clearInterval(roundTimer); roundTimer = null;
                updateTimerUI(0);
                updateDepositButtonState();
            } else if (currentRound.participants?.length === 0 && timerActive) {
                 console.log("Server data indicates no participants, stopping client timer.");
                 timerActive = false;
                 if (roundTimer) clearInterval(roundTimer); roundTimer = null;
                 updateTimerUI(CONFIG.ROUND_DURATION);
                 updateDepositButtonState();
            }
        } else if (currentRound.status === 'pending') {
            console.log("Received pending round state.");
            initiateNewRoundVisualReset();
            if(DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Waiting";
            updateDepositButtonState();
        }

        // Re-render deposits based on full round data if needed (e.g., on fresh connect)
        // This assumes `data.participants` includes `depositedItems` per participant or `data.items` is populated
        const container = DOMElements.jackpot.participantsContainer;
        if(container && container.children.length === 0 && data.participants?.length > 0) {
            console.log("Rendering existing deposits from full round data.");
            container.innerHTML = ''; // Clear empty message if present
            if (DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'none';
            // Sort participants for consistent display (e.g., by entry time or value)
            const sortedParticipants = [...data.participants].sort((a,b) => /* Add sorting logic if needed, e.g., first deposit time */ 0);
            sortedParticipants.forEach(p => {
                // Find items associated with this participant from the main items list if structured that way
                const participantItems = data.items?.filter(item => item.owner === p.user?.id) || [];
                displayLatestDeposit({ // Simulate the deposit event structure
                    userId: p.user.id,
                    username: p.user.username,
                    avatar: p.user.avatar,
                    itemsValue: p.itemsValue, // This should be their *total* value for this render pass
                    depositedItems: participantItems // Pass the found items
                });
                 // Remove animation class immediately
                 const element = container.querySelector(`.player-deposit-container[data-user-id="${p.user.id}"]`);
                 if (element) element.classList.remove('player-deposit-new');
            });
        } else if (container && data.participants?.length === 0) {
             // Ensure empty message is shown if data confirms no participants
             initiateNewRoundVisualReset();
        }

    });

    // --- Other Events ---
    socket.on('tradeOfferSent', (data) => {
        console.log('Trade offer sent event received:', data);
        if (currentUser && data.userId === currentUser._id) {
            showNotification('Trade Offer Sent: Check Steam for your winnings!', 'success');
        }
    });

    // --- Notification Event (Generic) ---
    socket.on('notification', (data) => {
       console.log('Notification event received:', data);
       // Check if notification is targeted to the current user or global
       if (!data.userId || (currentUser && data.userId === currentUser._id)) {
         showNotification(data.message || 'Received notification from server.', data.type || 'info', data.duration || 4000);
       }
   });

}


// --- Event Listener Setup ---
function setupEventListeners() {
    // Navigation Links
    Object.entries(DOMElements.nav).forEach(([key, element]) => {
        if (element && DOMElements.pages[key.replace('Link', 'Page')]) {
            element.addEventListener('click', (e) => {
                e.preventDefault();
                showPage(DOMElements.pages[key.replace('Link', 'Page')]);
            });
        }
    });

    // --- MODIFIED LOGIN BUTTON LISTENER ---
    DOMElements.user.loginButton?.addEventListener('click', () => {
        // Check if age is already verified in localStorage
        if (localStorage.getItem('ageVerified') === 'true') {
            // Already verified, proceed directly to Steam login
            console.log("Age already verified, proceeding to Steam login.");
            window.location.href = '/auth/steam';
        } else {
            // Not verified, show the age verification modal first
            console.log("Age not verified, showing verification modal.");
            // Ensure the modal's state is reset (checkbox unchecked, button disabled)
            const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
            if(ageCheckbox) ageCheckbox.checked = false;
            if(ageAgreeButton) ageAgreeButton.disabled = true;
            // Show the modal
            showModal(DOMElements.ageVerification.modal);
        }
    });
    // --- END OF MODIFIED LOGIN BUTTON LISTENER ---


    // User Profile Dropdown Toggle
    DOMElements.user.userProfile?.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = DOMElements.user.userDropdownMenu;
        const profileButton = DOMElements.user.userProfile;
        if (menu) {
            const isVisible = menu.style.display === 'block';
            menu.style.display = isVisible ? 'none' : 'block';
            profileButton?.setAttribute('aria-expanded', !isVisible);
            profileButton?.classList.toggle('open', !isVisible);
        }
    });
    DOMElements.user.userProfile?.addEventListener('keydown', (e) => {
         if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }
    });

    // Logout Button Listener
    DOMElements.user.logoutButton?.addEventListener('click', (e) => { e.stopPropagation(); handleLogout(); });
    DOMElements.user.logoutButton?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleLogout(); } });

    // Deposit Modal Trigger Button
    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => {
        const button = DOMElements.deposit.showDepositModalButton;
        if (button.disabled) {
            showNotification(button.title || 'Deposits are currently closed.', 'info'); return;
        }
        if (!currentUser) {
            showNotification('Login Required: Please log in first.', 'error'); return;
        }
        if (!currentUser.tradeUrl) {
            // Pre-fill trade URL modal if opened this way
             if(DOMElements.tradeUrl.tradeUrlInput) DOMElements.tradeUrl.tradeUrlInput.value = currentUser.tradeUrl || '';
            showModal(DOMElements.tradeUrl.tradeUrlModal); return;
        }
        showModal(DOMElements.deposit.depositModal);
        loadUserInventory();
    });

    // Deposit Modal Close / Submit Buttons
    DOMElements.deposit.closeDepositModalButton?.addEventListener('click', () => hideModal(DOMElements.deposit.depositModal));
    DOMElements.deposit.depositButton?.addEventListener('click', submitDeposit);

    // Trade URL Modal Close / Submit Buttons
    DOMElements.tradeUrl.closeTradeUrlModalButton?.addEventListener('click', () => hideModal(DOMElements.tradeUrl.tradeUrlModal));
    DOMElements.tradeUrl.saveTradeUrlButton?.addEventListener('click', saveUserTradeUrl);

    // --- MODIFIED AGE VERIFICATION LOGIC ---
    const { modal: ageModal, checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
    if (ageModal && ageCheckbox && ageAgreeButton) {
        // Enable/disable agree button based on checkbox state
        ageCheckbox.addEventListener('change', () => {
            ageAgreeButton.disabled = !ageCheckbox.checked;
        });

        // Handle clicking the "Agree" button
        ageAgreeButton.addEventListener('click', () => {
            if (ageCheckbox.checked) {
                // 1. Store verification status
                localStorage.setItem('ageVerified', 'true');
                // 2. Hide the modal
                hideModal(ageModal);
                // 3. *** ADDED: Proceed to Steam Login ***
                console.log("Age verification agreed. Proceeding to Steam login.");
                window.location.href = '/auth/steam';
            }
        });

        // Ensure button is initially disabled if checkbox isn't checked by default
        // (This applies when the modal is setup, not just on change)
        ageAgreeButton.disabled = !ageCheckbox.checked;
    }
    // --- END OF MODIFIED AGE VERIFICATION LOGIC ---


    // Test Buttons
    document.getElementById('testSpinButton')?.addEventListener('click', testRouletteAnimation);
    document.getElementById('testDepositButton')?.addEventListener('click', testDeposit);

    // Provably Fair Verify Button
    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound);

    // Combined window click listener
    window.addEventListener('click', (e) => {
        // Close dropdown
        const menu = DOMElements.user.userDropdownMenu;
        const profile = DOMElements.user.userProfile;
        if (menu && profile && menu.style.display === 'block' && !profile.contains(e.target) && !menu.contains(e.target)) {
            menu.style.display = 'none';
            profile.setAttribute('aria-expanded', 'false');
            profile.classList.remove('open');
        }

        // Close modals
        if (e.target === DOMElements.deposit.depositModal) hideModal(DOMElements.deposit.depositModal);
        if (e.target === DOMElements.tradeUrl.tradeUrlModal) hideModal(DOMElements.tradeUrl.tradeUrlModal);
        // Close age modal if clicked outside (but NOT if it was triggered by login button - only manually opened one)
        // if (e.target === DOMElements.ageVerification.modal) hideModal(DOMElements.ageVerification.modal);
        // ... other modal closing logic if needed ...
    });

    // Combined document keydown listener
    document.addEventListener('keydown', function(event) { // Changed 'e' to 'event' for clarity
        // Close dropdown with Escape key
        const menu = DOMElements.user.userDropdownMenu;
        if (event.key === 'Escape' && menu && menu.style.display === 'block') {
            menu.style.display = 'none';
            DOMElements.user.userProfile?.setAttribute('aria-expanded', 'false');
            DOMElements.user.userProfile?.classList.remove('open');
            DOMElements.user.userProfile?.focus();
        }

        // Existing Spacebar test (check conditions carefully)
        if (event.code === 'Space' &&
            DOMElements.pages.homePage?.style.display === 'block' &&
            !isSpinning &&
            !document.querySelector('.modal[style*="display: flex"]') &&
            !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName))
        {
            console.log("Spacebar pressed for test spin.");
            testRouletteAnimation();
            event.preventDefault();
        }
    });
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed.");

    // --- REMOVED INITIAL AGE CHECK ---
    /*
    if (DOMElements.ageVerification.modal && !localStorage.getItem('ageVerified')) {
        showModal(DOMElements.ageVerification.modal);
    }
    */
    // --- END REMOVED BLOCK ---

    checkLoginStatus();
    setupEventListeners(); // setupEventListeners now contains the updated login/age verification logic
    setupSocketConnection();
    showPage(DOMElements.pages.homePage);
    initiateNewRoundVisualReset();
});

console.log("main.js loaded.");
