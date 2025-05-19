// main.js - Rust Jackpot Frontend Logic
// Modifications:
// - Removed test functions (testRouletteAnimation, testDeposit) and associated UI.
// - Updated profile modal to display total deposited/won.
// - Removed display of skin names, showing only image and price.
// - Retained profile dropdown and modal logic from previous updates.
// - ADDED: Frontend chat functionality, integrated with socket.io.
// - REMOVED: "Details" button from Provably Fair round history.
// - ADDED: Frontend visual cooldown for chat send button.
// - ADDED: Winner trade offer modal/notification.
// - REMOVED: Pre-roulette "Spinning..." text animation. Direct transition to roulette.
// - ADDRESSED: Pot clearing and state management for animations.

// Ensure Socket.IO client library is loaded before this script

// Establish Socket.IO connection
const socket = io();

// --- Configuration Constants ---
const CONFIG = {
    ROUND_DURATION: 99, // Timer duration in seconds
    MAX_ITEMS_PER_DEPOSIT: 20, // Max selectable items per deposit action
    MAX_DISPLAY_DEPOSITS: 10, // Max vertical deposit blocks shown visually
    MAX_PARTICIPANTS_DISPLAY: 20, // Max participants allowed (should match backend)
    MAX_ITEMS_PER_POT_FRONTEND: 200, // Max items in pot (should match backend)
    ROULETTE_REPETITIONS: 20, // This seems unused, related to how many times items repeat in roulette visual
    SPIN_DURATION_SECONDS: 6.5, // Duration of the roulette spin animation
    WINNER_DISPLAY_DURATION: 7000, // How long the winner info box is shown
    CONFETTI_COUNT: 150,
    EASE_OUT_POWER: 5, // For roulette easing
    BOUNCE_ENABLED: false, // Roulette bounce effect
    BOUNCE_OVERSHOOT_FACTOR: 0.07,
    BOUNCE_DAMPING: 0.35,
    BOUNCE_FREQUENCY: 3.5,
    LANDING_POSITION_VARIATION: 0.60, // How much the roulette can vary from perfect center
    MAX_CHAT_MESSAGES: 100, // Max chat messages to display in the chatbox
    CHAT_SEND_COOLDOWN_MS: 2000, // Frontend visual cooldown for chat send button
    WINNER_TRADE_OFFER_NOTIFICATION_DURATION: 15000, // Duration for the winner trade offer notification
};

const COLOR_PALETTE = [
    '#00bcd4', '#ff5722', '#9c27b0', '#4caf50', '#ffeb3b', '#2196f3', '#f44336', '#ff9800',
    '#e91e63', '#8bc34a', '#3f51b5', '#009688', '#cddc39', '#795548', '#607d8b', '#673ab7',
    '#ffc107', '#03a9f4', '#9e9e9e', '#8d6e63'
];

const DOMElements = {
    nav: {
        homeLink: document.getElementById('home-link'),
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
    user: {
        loginButton: document.getElementById('loginButton'),
        userProfile: document.getElementById('userProfile'),
        userAvatar: document.getElementById('userAvatar'),
        userName: document.getElementById('userName'),
        userDropdownMenu: document.getElementById('userDropdownMenu'),
        profileDropdownButton: document.getElementById('profileDropdownButton'),
        winningHistoryDropdownButton: document.getElementById('winningHistoryDropdownButton'), // Added
        logoutButton: document.getElementById('logoutButton'),
        pendingOfferIndicator: document.getElementById('pending-offer-indicator'),
    },
    profileModal: {
        modal: document.getElementById('profileModal'),
        avatar: document.getElementById('profileModalAvatar'),
        name: document.getElementById('profileModalName'),
        deposited: document.getElementById('profileModalDeposited'),
        won: document.getElementById('profileModalWon'),
        tradeUrlInput: document.getElementById('profileModalTradeUrl'),
        saveBtn: document.getElementById('profileModalSaveBtn'),
        closeBtn: document.getElementById('profileModalCloseBtn'),
        cancelBtn: document.getElementById('profileModalCancelBtn'),
        pendingOfferStatus: document.getElementById('profile-pending-offer-status'),
    },
    winningHistoryModal: { // Added
        modal: document.getElementById('winningHistoryModal'),
        closeBtn: document.getElementById('closeWinningHistoryModal'),
        closeFooterBtn: document.getElementById('winningHistoryModalCloseFooterBtn'),
        tableBody: document.getElementById('winningHistoryTableBody'),
        loadingIndicator: document.getElementById('winning-history-loading'),
        noWinningsMessage: document.getElementById('noWinningsMessage'),
    },
    jackpot: {
        potValue: document.getElementById('potValue'),
        timerValue: document.getElementById('timerValue'),
        timerForeground: document.querySelector('.timer-foreground'),
        participantCount: document.getElementById('participantCount'),
        participantsContainer: document.getElementById('itemsContainer'),
        emptyPotMessage: document.getElementById('emptyPotMessage'),
        jackpotHeader: document.getElementById('jackpotHeader'),
    },
    deposit: {
        showDepositModalButton: document.getElementById('showDepositModal'),
        depositModal: document.getElementById('depositModal'),
        closeDepositModalButton: document.getElementById('closeDepositModal'),
        depositButton: document.getElementById('depositButton'),
        inventoryItemsContainer: document.getElementById('inventory-items'),
        selectedItemsContainer: document.getElementById('selectedItems'),
        totalValueDisplay: document.getElementById('totalValue'),
        inventoryLoadingIndicator: document.getElementById('inventory-loading'),
        acceptDepositOfferBtn: document.getElementById('acceptDepositOfferBtn'),
        depositStatusText: document.getElementById('depositStatusText'),
    },
    roulette: {
        inlineRouletteContainer: document.getElementById('inlineRoulette'),
        rouletteTrack: document.getElementById('rouletteTrack'),
        winnerInfoBox: document.getElementById('winnerInfo'),
        winnerAvatar: document.getElementById('winnerAvatar'),
        winnerName: document.getElementById('winnerName'),
        winnerDeposit: document.getElementById('winnerDeposit'),
        winnerChance: document.getElementById('winnerChance'),
        returnToJackpotButton: document.getElementById('returnToJackpot'), // Will be hidden/removed if not used
        confettiContainer: document.getElementById('confettiContainer'),
    },
    audio: {
        spinSound: document.getElementById('spinSound'),
        depositSound: document.getElementById('depositSound')
    },
    provablyFair: {
        verifyButton: document.getElementById('verify-btn'),
        roundsTableBody: document.getElementById('rounds-table-body'),
        roundsPagination: document.getElementById('rounds-pagination'),
        roundIdInput: document.getElementById('round-id'),
        serverSeedInput: document.getElementById('server-seed'),
        clientSeedInput: document.getElementById('client-seed'),
        verificationResultDisplay: document.getElementById('verification-result'),
        verificationSection: document.getElementById('provably-fair-verification'),
    },
    ageVerification: {
        modal: document.getElementById('ageVerificationModal'),
        checkbox: document.getElementById('agreeCheckbox'),
        agreeButton: document.getElementById('agreeButton'),
    },
    notificationBar: document.getElementById('notification-bar'),
    chat: {
        onlineUsers: document.getElementById('chatOnlineUsers'),
        messagesContainer: document.getElementById('chatMessagesContainer'),
        messageInput: document.getElementById('chatMessageInput'),
        sendMessageBtn: document.getElementById('chatSendMessageBtn'),
    }
};

let currentUser = null;
let currentRound = null; // Stores data for the current ongoing or last completed round
let selectedItemsList = []; // For deposit modal
let userInventory = []; // For deposit modal
let isSpinning = false; // Client-side flag for roulette animation state
let timerActive = false; // Client-side flag for round timer state
let roundTimer = null; // Interval ID for client-side timer
let animationFrameId = null; // For roulette animation loop
let userColorMap = new Map(); // Maps user IDs to display colors
let notificationTimeout = null; // For the notification bar
let currentDepositOfferURL = null; // Stores URL for active deposit offer
let onlineUserCount = 0;
let isChatSendOnCooldown = false;

function showModal(modalElement) {
    if (modalElement) modalElement.style.display = 'flex';
}

function hideModal(modalElement) {
    if (modalElement) modalElement.style.display = 'none';
    if (modalElement === DOMElements.deposit.depositModal) {
        resetDepositModalUI(); // Clear selections and status when closing deposit modal
    }
}

function showPage(pageElement) {
    Object.values(DOMElements.pages).forEach(page => {
        if (page) page.style.display = 'none';
    });
    if (pageElement) pageElement.style.display = 'block';

    document.querySelectorAll('.main-nav a, .secondary-nav a, .primary-nav a')
        .forEach(link => link?.classList.remove('active'));

    let activeLink = null;
    if (pageElement === DOMElements.pages.homePage) activeLink = DOMElements.nav.homeLink;
    else if (pageElement === DOMElements.pages.aboutPage) activeLink = DOMElements.nav.aboutLink;
    else if (pageElement === DOMElements.pages.tosPage) activeLink = DOMElements.nav.tosLink;
    else if (pageElement === DOMElements.pages.faqPage) activeLink = DOMElements.nav.faqLink;
    else if (pageElement === DOMElements.pages.fairPage) activeLink = DOMElements.nav.fairLink;

    if (activeLink) activeLink.classList.add('active');

    if (pageElement === DOMElements.pages.fairPage) {
        loadPastRounds(); // Load history when navigating to Provably Fair page
    }
}
window.showPage = showPage; // Make it globally accessible for inline script in HTML

function getUserColor(userId) {
    if (!userId) return '#cccccc'; // Default color for unknown users
    if (!userColorMap.has(userId)) {
        const colorIndex = userColorMap.size % COLOR_PALETTE.length;
        userColorMap.set(userId, COLOR_PALETTE[colorIndex]);
    }
    return userColorMap.get(userId);
}

function showNotification(message, type = 'info', duration = 4000, isHtml = false) {
    if (!DOMElements.notificationBar) {
        console.warn("Notification bar element (#notification-bar) not found. Using console.log as fallback.");
        console.log(`[${type.toUpperCase()}] ${message}`);
        return;
    }
    const bar = DOMElements.notificationBar;
    if (notificationTimeout) clearTimeout(notificationTimeout);

    if (isHtml) {
        bar.innerHTML = message; // Directly set HTML if specified
    } else {
        bar.textContent = message; // Use textContent for safety by default
    }

    bar.className = 'notification-bar'; // Reset classes
    bar.classList.add(type); // Add type class (e.g., 'success', 'error')
    bar.classList.add('show'); // Add 'show' class to trigger CSS animation

    notificationTimeout = setTimeout(() => {
        bar.classList.remove('show');
        notificationTimeout = null;
    }, duration);
}

function shuffleArray(array) {
    let currentIndex = array.length, randomIndex;
    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
}

function easeOutAnimation(t) {
    const clampedT = Math.max(0, Math.min(1, t));
    return 1 - Math.pow(1 - clampedT, CONFIG.EASE_OUT_POWER);
}

function calculateBounce(t) { // For roulette bounce, if enabled
    if (!CONFIG.BOUNCE_ENABLED) return 0;
    const clampedT = Math.max(0, Math.min(1, t));
    const decay = Math.exp(-clampedT / CONFIG.BOUNCE_DAMPING);
    const oscillations = Math.sin(clampedT * Math.PI * 2 * CONFIG.BOUNCE_FREQUENCY);
    return -decay * oscillations;
}

// Helper color functions (if needed for advanced confetti or UI, otherwise can be removed if unused)
function getComplementaryColor(hex) {
    hex = hex.replace('#', '');
    let r = parseInt(hex.substring(0, 2), 16); let g = parseInt(hex.substring(2, 4), 16); let b = parseInt(hex.substring(4, 6), 16);
    r = 255 - r; g = 255 - g; b = 255 - b;
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
function lightenColor(hex, percent) {
    hex = hex.replace('#', '');
    let r = parseInt(hex.substring(0,2), 16); let g = parseInt(hex.substring(2,4), 16); let b = parseInt(hex.substring(4,6), 16);
    r = Math.min(255, Math.floor(r + (255-r) * (percent/100))); g = Math.min(255, Math.floor(g + (255-g) * (percent/100))); b = Math.min(255, Math.floor(b + (255-b) * (percent/100)));
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}
function darkenColor(hex, percent) {
    hex = hex.replace('#', '');
    let r = parseInt(hex.substring(0,2), 16); let g = parseInt(hex.substring(2,4), 16); let b = parseInt(hex.substring(4,6), 16);
    r = Math.max(0, Math.floor(r * (1 - percent/100))); g = Math.max(0, Math.floor(g * (1 - percent/100))); b = Math.max(0, Math.floor(b * (1 - percent/100)));
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}


async function handleLogout() {
    console.log("Attempting logout...");
    try {
        const response = await fetch('/logout', { method: 'POST' });
        if (!response.ok) {
             const result = await response.json().catch(() => ({ error: 'Logout request failed.' }));
            throw new Error(result.error || `Logout request failed with status ${response.status}.`);
        }
        const result = await response.json();
         if (!result.success) {
             throw new Error(result.error || 'Logout unsuccessful according to server.');
         }
        console.log('Logout successful.');
        currentUser = null;
        updateUserUI();
        updateDepositButtonState();
        updateChatUI();
        showNotification('You have been successfully signed out.', 'success');
    } catch (error) {
        console.error('Logout Error:', error);
        showNotification(`Logout failed: ${error.message}`, 'error');
    } finally {
        // Ensure dropdown is closed after logout attempt
        const { userDropdownMenu, userProfile } = DOMElements.user;
        if (userDropdownMenu) {
            userDropdownMenu.style.display = 'none';
            userProfile?.setAttribute('aria-expanded', 'false');
            userProfile?.classList.remove('open');
        }
    }
}

function resetDepositModalUI() {
    const { depositButton, acceptDepositOfferBtn, depositStatusText, selectedItemsContainer, inventoryItemsContainer } = DOMElements.deposit;

    // Clear selected items list and UI
    selectedItemsList = [];
    if (selectedItemsContainer) selectedItemsContainer.innerHTML = '';
    // Unselect items in the main inventory display
    inventoryItemsContainer?.querySelectorAll('.inventory-item.selected').forEach(el => el.classList.remove('selected'));
    updateTotalValue(); // Reset total value display to $0.00

    if (depositButton) {
        depositButton.disabled = true; // Should be disabled if no items selected
        depositButton.style.display = 'inline-block';
        depositButton.textContent = 'Request Deposit Offer';
    }
    if (acceptDepositOfferBtn) {
        acceptDepositOfferBtn.style.display = 'none';
        acceptDepositOfferBtn.removeAttribute('data-offer-url');
    }
    if (depositStatusText) {
        depositStatusText.textContent = 'Select items from your inventory to deposit.';
        depositStatusText.className = 'deposit-status-text'; // Reset class
    }
    currentDepositOfferURL = null;
}


function updateDepositButtonState() {
    const button = DOMElements.deposit.showDepositModalButton;
    if (!button) return;

    let disabled = false;
    let title = 'Deposit Rust skins into the pot'; // Default title

    if (!currentUser) {
        disabled = true; title = 'Log in to deposit';
    } else if (currentUser.pendingDepositOfferId) {
         disabled = true; title = 'You have a pending deposit offer. Check your profile or Steam.';
    } else if (!currentUser.tradeUrl) {
         disabled = true; title = 'Set your Steam Trade URL in your profile to deposit';
    } else if (isSpinning || (currentRound && currentRound.status === 'rolling')) { // Check both client-side spinning and server 'rolling' status
        disabled = true; title = 'Deposits closed during winner selection';
    } else if (!currentRound || currentRound.status !== 'active') {
        disabled = true; title = 'Deposits are currently closed';
        if (currentRound) {
            switch (currentRound.status) {
                // 'rolling' is already handled above
                case 'completed': case 'error': title = 'Deposits closed (Round ended)'; break;
                case 'pending': title = 'Deposits closed (Waiting for new round)'; break;
            }
        }
    } else if (currentRound.participants && currentRound.participants.length >= CONFIG.MAX_PARTICIPANTS_DISPLAY) {
        disabled = true; title = `Participant limit (${CONFIG.MAX_PARTICIPANTS_DISPLAY}) reached`;
    } else if (currentRound.items && currentRound.items.length >= CONFIG.MAX_ITEMS_PER_POT_FRONTEND) {
        disabled = true; title = `Pot item limit (${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}) reached`;
    } else if (timerActive && currentRound.timeLeft !== undefined && currentRound.timeLeft <= 0) {
        // This condition means client timer hit 0, but server might not have processed 'endRound' yet.
        // Deposits should be closed if client timer shows 0.
        disabled = true; title = 'Deposits closed (Round ending)';
    }

    button.disabled = disabled;
    button.title = title;
    button.classList.toggle('deposit-disabled', disabled);
}


async function checkLoginStatus() {
    try {
        const response = await fetch('/api/user');
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) currentUser = null;
            else throw new Error(`Server error fetching user: ${response.status}`);
        } else {
            currentUser = await response.json();
            console.log('User logged in:', currentUser?.username);
        }
    } catch (error) {
        console.error('Error checking login status:', error);
        currentUser = null;
        if (error.message && !error.message.includes("401") && !error.message.includes("403")) {
            showNotification(`Error checking login: ${error.message}`, 'error');
        }
    } finally {
        updateUserUI();
        updateDepositButtonState();
        updateChatUI();
    }
}

function updateUserUI() {
    const { loginButton, userProfile, userAvatar, userName, userDropdownMenu, pendingOfferIndicator } = DOMElements.user;
    if (!loginButton || !userProfile) return;

    if (currentUser) {
        if (userAvatar) userAvatar.src = currentUser.avatar || '/img/default-avatar.png';
        if (userName) userName.textContent = currentUser.username || 'User';
        loginButton.style.display = 'none';
        userProfile.style.display = 'flex';
        userProfile.setAttribute('aria-disabled', 'false');

        if (pendingOfferIndicator) {
            const hasPending = !!currentUser.pendingDepositOfferId;
            pendingOfferIndicator.style.display = hasPending ? 'inline-block' : 'none';
             if (hasPending) {
                 pendingOfferIndicator.title = `You have a pending deposit offer (#${currentUser.pendingDepositOfferId})! Click your profile to see details.`;
             } else {
                 pendingOfferIndicator.title = '';
             }
        }
    } else {
        loginButton.style.display = 'flex';
        userProfile.style.display = 'none';
        userProfile.setAttribute('aria-disabled', 'true');
        if (userDropdownMenu) userDropdownMenu.style.display = 'none';
        userProfile.setAttribute('aria-expanded', 'false');
        userProfile.classList.remove('open');
        if (pendingOfferIndicator) pendingOfferIndicator.style.display = 'none';
    }
}

async function loadUserInventory() {
    const { inventoryItemsContainer, selectedItemsContainer, inventoryLoadingIndicator, totalValueDisplay } = DOMElements.deposit;
    if (!inventoryItemsContainer || !selectedItemsContainer || !inventoryLoadingIndicator || !totalValueDisplay) {
        console.error("Inventory DOM elements missing for loadUserInventory.");
        return;
    }

    resetDepositModalUI(); // Ensures selected items are cleared and UI is fresh

    inventoryLoadingIndicator.style.display = 'flex';
    inventoryItemsContainer.innerHTML = '';

    try {
        const response = await fetch('/api/inventory');
        if (!response.ok) {
            let errorMsg = 'Inventory load failed.';
            try { const errorData = await response.json(); errorMsg = errorData.error || `Inventory load failed (${response.status})`; } catch (e) { /* ignore */ }
            if (response.status === 401 || response.status === 403) errorMsg = 'Please log in first to view your inventory.';
            throw new Error(errorMsg);
        }
        userInventory = await response.json();
        inventoryLoadingIndicator.style.display = 'none';

        if (!Array.isArray(userInventory)) throw new Error('Invalid inventory data format received.');

        if (userInventory.length === 0) {
            inventoryItemsContainer.innerHTML = '<p class="empty-inventory-message">Your Rust inventory is empty or could not be loaded. Ensure it is set to public on Steam.</p>';
            return;
        }
        displayInventoryItems();
    } catch (error) {
        inventoryLoadingIndicator.style.display = 'none';
        inventoryItemsContainer.innerHTML = `<p class="error-message">Error loading inventory: ${error.message}</p>`;
        console.error('Error loading inventory:', error);
    }
}

function displayInventoryItems() {
    const container = DOMElements.deposit.inventoryItemsContainer;
    if (!container) return;
    container.innerHTML = ''; // Clear previous items

    userInventory.forEach(item => {
        if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.assetId || !item.image) {
            console.warn("Skipping invalid inventory item in displayInventoryItems:", item);
            return;
        }

        const itemElement = document.createElement('div');
        itemElement.className = 'inventory-item';
        itemElement.dataset.assetId = item.assetId;
        itemElement.dataset.price = item.price.toFixed(2); // Store price for easy access
        itemElement.title = `${item.name || 'Unknown Item'} - $${item.price.toFixed(2)}`; // Tooltip shows name and price

        itemElement.innerHTML = `
            <img src="${item.image}" alt="${item.name || 'Skin Image'}" loading="lazy" onerror="this.onerror=null; this.src='/img/default-item.png';">
            <div class="item-details">
                <div class="item-value">$${item.price.toFixed(2)}</div>
            </div>`;

        // Check if item is already selected from a previous state (e.g. modal re-open)
        if (selectedItemsList.some(selected => selected.assetId === item.assetId)) {
            itemElement.classList.add('selected');
        }
        itemElement.addEventListener('click', () => toggleItemSelection(itemElement, item));
        container.appendChild(itemElement);
    });
}


function toggleItemSelection(element, item) {
    if (typeof item.price !== 'number' || isNaN(item.price)) {
        console.error("Attempted to select item with invalid price:", item);
        showNotification('Selection Error: Cannot select item with an invalid price.', 'error');
        return;
    }

    const assetId = item.assetId;
    const index = selectedItemsList.findIndex(i => i.assetId === assetId);

    if (index === -1) { // Item not selected, try to select
        if (selectedItemsList.length >= CONFIG.MAX_ITEMS_PER_DEPOSIT) {
            showNotification(`Selection Limit: You can select a maximum of ${CONFIG.MAX_ITEMS_PER_DEPOSIT} items.`, 'info');
            return;
        }
        selectedItemsList.push(item);
        element.classList.add('selected');
        addSelectedItemElement(item);
    } else { // Item already selected, deselect
        selectedItemsList.splice(index, 1);
        element.classList.remove('selected');
        removeSelectedItemElement(assetId);
    }
    updateTotalValue();
    // Update deposit button state based on selection (enabled if items selected, disabled if not)
    const depositBtn = DOMElements.deposit.depositButton;
    if (depositBtn) depositBtn.disabled = selectedItemsList.length === 0;
}

function addSelectedItemElement(item) {
    const container = DOMElements.deposit.selectedItemsContainer;
    if (!container) return;
    if (typeof item.price !== 'number' || isNaN(item.price)) {
        console.error("Cannot add selected item element, invalid price:", item);
        return;
    }

    const selectedElement = document.createElement('div');
    selectedElement.className = 'selected-item-display';
    selectedElement.dataset.assetId = item.assetId;
    selectedElement.title = `${item.name || 'Selected Item'} - $${item.price.toFixed(2)}`;

    selectedElement.innerHTML = `
        <img src="${item.image}" alt="${item.name || 'Selected Skin'}" loading="lazy" onerror="this.onerror=null; this.src='/img/default-item.png';">
        <div class="item-value">$${item.price.toFixed(2)}</div>
        <button class="remove-item-btn" title="Remove Item" data-asset-id="${item.assetId}" aria-label="Remove Item">&times;</button>
        `;

    selectedElement.querySelector('.remove-item-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const assetIdToRemove = e.target.dataset.assetId;
        if (assetIdToRemove) {
            removeSelectedItem(assetIdToRemove); // This will also update inventory item class
            updateTotalValue();
            const depositBtn = DOMElements.deposit.depositButton;
            if (depositBtn) depositBtn.disabled = selectedItemsList.length === 0;
        }
    });
    selectedElement.addEventListener('click', () => { // Clicking the item itself also removes it
        removeSelectedItem(item.assetId);
        updateTotalValue();
        const depositBtn = DOMElements.deposit.depositButton;
        if (depositBtn) depositBtn.disabled = selectedItemsList.length === 0;
    });
    container.appendChild(selectedElement);
}

function removeSelectedItemElement(assetId) {
    const container = DOMElements.deposit.selectedItemsContainer;
    const selectedElement = container?.querySelector(`.selected-item-display[data-asset-id="${assetId}"]`);
    if (selectedElement) selectedElement.remove();
}

function removeSelectedItem(assetId) {
    selectedItemsList = selectedItemsList.filter(item => item.assetId !== assetId);
    const inventoryElement = DOMElements.deposit.inventoryItemsContainer?.querySelector(`.inventory-item[data-asset-id="${assetId}"]`);
    if (inventoryElement) inventoryElement.classList.remove('selected');
    removeSelectedItemElement(assetId);
}

function updateTotalValue() {
    const { totalValueDisplay } = DOMElements.deposit;
    if (!totalValueDisplay) return;
    const total = selectedItemsList.reduce((sum, item) => {
        const price = typeof item.price === 'number' && !isNaN(item.price) ? item.price : 0;
        return sum + price;
    }, 0);
    totalValueDisplay.textContent = `$${total.toFixed(2)}`;
}

// main.js - Rust Jackpot Frontend Logic - Part 2 of 2

async function requestDepositOffer() {
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit;
    if (!depositButton || !acceptDepositOfferBtn || !depositStatusText) return;

    if (selectedItemsList.length === 0) {
        showNotification('No Items Selected: Please select items first.', 'info');
        return;
    }
    if (!currentRound || currentRound.status !== 'active' || isSpinning) {
        showNotification('Deposit Error: Deposits are currently closed.', 'error');
        return;
    }
    if (currentUser?.pendingDepositOfferId) {
        showNotification('Deposit Error: You already have a pending deposit offer. Check your profile or Steam.', 'error');
        if (DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
        return;
    }

    // Client-side checks for limits before hitting the API
    const participantsLength = currentRound.participants?.length || 0;
    const isNewParticipant = !currentRound.participants?.some(p => p.user?._id === currentUser?._id || p.user?.id === currentUser?._id);
    if (isNewParticipant && participantsLength >= CONFIG.MAX_PARTICIPANTS_DISPLAY) {
        showNotification(`Deposit Error: Participant limit (${CONFIG.MAX_PARTICIPANTS_DISPLAY}) reached.`, 'error'); return;
    }

    const itemsInPot = currentRound.items?.length || 0;
    if (itemsInPot + selectedItemsList.length > CONFIG.MAX_ITEMS_PER_POT_FRONTEND) {
        const slotsLeft = CONFIG.MAX_ITEMS_PER_POT_FRONTEND - itemsInPot;
        showNotification(`Deposit Error: Pot item limit would be exceeded (Max ${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}). Only ${slotsLeft} slots left.`, 'error', 6000);
        return;
    }

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
                depositStatusText.innerHTML = `You already have a pending offer! Click <a href="${result.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link" style="font-weight:bold; text-decoration:underline;">Accept on Steam</a> to view it.`;
                depositStatusText.className = 'deposit-status-text warning';
                currentDepositOfferURL = result.offerURL;
                // No separate accept button in modal footer anymore for deposits, status text has the link.
                // depositButton.style.display = 'none'; // Keep deposit button visible but disabled.
                depositButton.disabled = true;
                depositButton.textContent = "Pending Offer Exists";

                if (currentUser && !currentUser.pendingDepositOfferId) {
                    currentUser.pendingDepositOfferId = result.offerId; updateUserUI(); updateDepositButtonState();
                }
                return;
            } else {
                throw new Error(result.error || `Failed to create offer (${response.status})`);
            }
        } else if (!result.success || !result.offerURL || !result.offerId) {
            throw new Error(result.error || 'Backend did not return a valid offer URL and ID.');
        } else {
            console.log("Deposit offer created:", result.offerId);
            depositStatusText.innerHTML = `Offer created! <a href="${result.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link" style="font-weight:bold; text-decoration:underline;">Click here to accept it on Steam.</a>`;
            depositStatusText.className = 'deposit-status-text success';
            currentDepositOfferURL = result.offerURL; // Store for potential re-use if needed
            // depositButton.style.display = 'none'; // Keep it visible but disabled
            depositButton.disabled = true;
            depositButton.textContent = "Offer Sent to Steam";
            if (currentUser) { currentUser.pendingDepositOfferId = result.offerId; updateUserUI(); updateDepositButtonState(); }
        }
    } catch (error) {
        console.error('Error requesting deposit offer:', error);
        depositStatusText.textContent = `Error: ${error.message}`;
        depositStatusText.className = 'deposit-status-text error';
        if (!(response && response.status === 409)) {
            resetDepositModalUI(); // Full reset for other errors
            if (depositButton) depositButton.textContent = 'Request Failed - Retry';
        }
        if (currentUser && currentUser.pendingDepositOfferId && !(response && response.status === 409)) {
            currentUser.pendingDepositOfferId = null; updateUserUI(); updateDepositButtonState();
        }
    }
}


function updateRoundUI() {
    const { potValue, participantCount } = DOMElements.jackpot;
    if (!currentRound || !potValue || !participantCount) {
        // If currentRound is null, it implies a reset or initial state.
        // Ensure pot value and participant count reflect this.
        if (potValue) potValue.textContent = "$0.00";
        if (participantCount) participantCount.textContent = `0/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
        if (!timerActive && DOMElements.jackpot.timerValue) { // If no active timer, show default
            updateTimerUI(CONFIG.ROUND_DURATION);
        }
        return;
    }

    potValue.textContent = `$${(currentRound.totalValue || 0).toFixed(2)}`;
    if (!timerActive) { // Only update timer directly if not actively being managed by client-side interval
        updateTimerUI(currentRound.timeLeft !== undefined ? currentRound.timeLeft : CONFIG.ROUND_DURATION);
    }
    const participantNum = currentRound.participants?.length || 0;
    participantCount.textContent = `${participantNum}/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
}


function updateTimerUI(timeLeft) {
    const { timerValue, timerForeground } = DOMElements.jackpot;
    if (!timerValue || !timerForeground) return;

    const timeToShow = Math.max(0, Math.round(timeLeft));
    let displayValue = timeToShow.toString();

    if (isSpinning || (currentRound && currentRound.status === 'rolling')) {
        displayValue = "Rolling"; // This state should be brief as roulette view takes over
    } else if (currentRound && currentRound.status === 'active' && !timerActive && currentRound.participants?.length === 0) {
        displayValue = CONFIG.ROUND_DURATION.toString();
    } else if (timerActive || (currentRound && currentRound.status === 'active' && timeToShow > 0)) {
        displayValue = timeToShow.toString();
    } else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'error')) {
        displayValue = "Ended";
    } else if (!timerActive && timeToShow <= 0 && currentRound && currentRound.status === 'active') {
        displayValue = "0"; // Timer has hit zero but round outcome not yet processed by server
    } else if (currentRound && currentRound.status === 'pending') {
        displayValue = "Waiting";
    } else if (!currentRound && !isSpinning) { // No round data at all, not spinning
        displayValue = "--";
    }


    timerValue.textContent = displayValue;
    updateTimerCircle(timeToShow, CONFIG.ROUND_DURATION);

    timerValue.classList.remove('urgent-pulse', 'timer-pulse');
    if (timerActive && timeToShow <= 10 && timeToShow > 0) {
        timerValue.classList.add('urgent-pulse');
    } else if (timerActive && timeToShow > 10) {
        timerValue.classList.add('timer-pulse');
    }
}

function updateTimerCircle(timeLeft, totalTime) {
    const circle = DOMElements.jackpot.timerForeground;
    if (!circle || !(circle instanceof SVGCircleElement) || !circle.r?.baseVal?.value) return;

    const radius = circle.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    const progress = Math.min(1, Math.max(0, timeLeft / Math.max(1, totalTime)));
    const offset = circumference * (1 - progress);
    circle.style.strokeDasharray = `${circumference}`;
    circle.style.strokeDashoffset = `${Math.max(0, offset)}`;
}

function updateAllParticipantPercentages() {
    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) return;
    const container = DOMElements.jackpot.participantsContainer;
    if (!container) return;

    const depositBlocks = container.querySelectorAll('.player-deposit-container');
    const currentTotalPotValue = Math.max(0.01, currentRound.totalValue || 0.01);

    depositBlocks.forEach(block => {
        const userId = block.dataset.userId;
        if (!userId) return;
        const participantData = currentRound.participants.find(p => p.user?._id === userId || p.user?.id === userId);
        if (!participantData) return;

        const cumulativeValue = participantData.itemsValue || 0;
        const percentage = ((cumulativeValue / currentTotalPotValue) * 100).toFixed(1);
        const valueElement = block.querySelector('.player-deposit-value');
        if (valueElement) {
            const userColor = getUserColor(userId);
            valueElement.textContent = `$${cumulativeValue.toFixed(2)} | ${percentage}%`;
            valueElement.title = `Deposited: $${cumulativeValue.toFixed(2)} | Chance: ${percentage}%`;
            valueElement.style.color = userColor;
        }
    });
}

function displayLatestDeposit(data) { // data comes from participantUpdated event
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (!container) return;

    const userId = data.userId || data.user?._id;
    if (!userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue)) {
        console.error("Invalid data for displayLatestDeposit:", data); return;
    }

    const depositSfx = DOMElements.audio.depositSound;
    if (depositSfx) { depositSfx.volume = 0.3; depositSfx.currentTime = 0; depositSfx.play().catch(e => console.warn("Error playing deposit sound:", e)); }

    const username = data.username || data.user?.username || 'Player';
    const avatar = data.avatar || data.user?.avatar || '/img/default-avatar.png';
    const itemsDepositedThisTime = data.depositedItems || []; // Items from *this* specific deposit action
    const userColor = getUserColor(userId);

    // This function is called for a new deposit, so 'itemsValue' from data is the user's *new total* value in round
    const cumulativeValueForUser = data.itemsValue;
    const currentTotalPotValue = Math.max(0.01, currentRound?.totalValue || 0.01); // Use round's total value
    const percentage = ((cumulativeValueForUser / currentTotalPotValue) * 100).toFixed(1);


    let depositContainer = container.querySelector(`.player-deposit-container[data-user-id="${userId}"]`);
    let isNewBlock = false;
    if (!depositContainer) {
        depositContainer = document.createElement('div');
        depositContainer.dataset.userId = userId;
        depositContainer.className = 'player-deposit-container player-deposit-new'; // Animate if new block
        isNewBlock = true;

        const depositHeader = document.createElement('div');
        depositHeader.className = 'player-deposit-header';
        depositHeader.innerHTML = `
            <img src="${avatar}" alt="${username}" class="player-avatar" loading="lazy" onerror="this.onerror=null; this.src='/img/default-avatar.png';" style="border-color: ${userColor};">
            <div class="player-info">
                <div class="player-name" title="${username}">${username}</div>
                <div class="player-deposit-value" style="color: ${userColor};"></div>
            </div>`;
        const itemsGrid = document.createElement('div');
        itemsGrid.className = 'player-items-grid';
        depositContainer.appendChild(depositHeader);
        depositContainer.appendChild(itemsGrid);
    } else {
        // If block exists, ensure it's at the top
        if (container.firstChild !== depositContainer) {
            container.insertBefore(depositContainer, container.firstChild);
        }
    }

    // Update header (value/percentage)
    const valueElement = depositContainer.querySelector('.player-deposit-value');
    if (valueElement) {
        valueElement.textContent = `$${cumulativeValueForUser.toFixed(2)} | ${percentage}%`;
        valueElement.title = `Deposited: $${cumulativeValueForUser.toFixed(2)} | Chance: ${percentage}%`;
    }

    // Add/update items in the grid for this user
    const itemsGrid = depositContainer.querySelector('.player-items-grid');
    if (itemsGrid) {
        // Add new items from this specific deposit
        itemsDepositedThisTime.sort((a, b) => (b.price || 0) - (a.price || 0));
        itemsDepositedThisTime.forEach(item => {
            if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.image) return;
            const itemElement = document.createElement('div');
            itemElement.className = 'player-deposit-item';
            itemElement.title = `$${item.price.toFixed(2)}`;
            itemElement.style.borderColor = userColor; // Use user's color for item border
            itemElement.innerHTML = `
                <img src="${item.image}" alt="Skin" class="player-deposit-item-image" loading="lazy" onerror="this.onerror=null; this.src='/img/default-item.png';">
                <div class="player-deposit-item-info">
                    <div class="player-deposit-item-value" style="color: ${userColor};">$${item.price.toFixed(2)}</div>
                </div>`;
            itemsGrid.insertBefore(itemElement, itemsGrid.firstChild); // Add new items to start of grid
        });

        // Limit displayed items per player visually (optional, backend tracks all)
        const maxVisualItemsPerPlayer = 10;
        while (itemsGrid.children.length > maxVisualItemsPerPlayer) {
            itemsGrid.removeChild(itemsGrid.lastChild); // Remove oldest items if too many shown
        }
    }


    if (isNewBlock) {
        if (container.firstChild) container.insertBefore(depositContainer, container.firstChild);
        else container.appendChild(depositContainer);
        setTimeout(() => depositContainer.classList.remove('player-deposit-new'), 500);
    }


    if (emptyMsg) emptyMsg.style.display = 'none';

    // Limit total displayed deposit blocks
    const currentDepositBlocks = container.querySelectorAll('.player-deposit-container');
    if (currentDepositBlocks.length > CONFIG.MAX_DISPLAY_DEPOSITS) {
        const oldestBlock = container.querySelector('.player-deposit-container:last-child');
        if (oldestBlock && oldestBlock !== depositContainer) { // Don't remove the one just added/updated
             oldestBlock.style.transition = 'opacity 0.3s ease-out, height 0.3s ease-out';
             oldestBlock.style.opacity = '0';
             oldestBlock.style.height = '0px'; // Animate height collapse
             oldestBlock.style.padding = '0';
             oldestBlock.style.margin = '0';
            setTimeout(() => { if (oldestBlock.parentNode === container) oldestBlock.remove(); }, 300);
        }
    }
}


function handleNewDeposit(data) { // data is from 'participantUpdated'
    if (!data || !data.roundId || !data.userId || typeof data.itemsValue !== 'number' || data.totalValue === undefined) {
        console.error("Invalid participant update data for handleNewDeposit:", data); return;
    }
    if (!currentRound) { // Client might have missed roundCreated
        currentRound = { roundId: data.roundId, status: 'active', timeLeft: CONFIG.ROUND_DURATION, totalValue: 0, participants: [], items: [] };
        console.warn("Local currentRound was null during new deposit. Initialized with received data.");
    } else if (currentRound.roundId !== data.roundId) {
        console.warn(`Deposit for round ${data.roundId}, but local is ${currentRound.roundId}. Requesting sync.`);
        socket.emit('requestRoundData'); return;
    }

    if (!currentRound.participants) currentRound.participants = [];
    if (!currentRound.items) currentRound.items = [];

    if (currentUser && currentUser.pendingDepositOfferId && (currentUser._id === data.userId || currentUser.id === data.userId)) {
       currentUser.pendingDepositOfferId = null; updateUserUI(); updateDepositButtonState();
       if (DOMElements.deposit.depositModal?.style.display === 'flex') {
           resetDepositModalUI(); // Reset modal state as deposit is confirmed
       }
    }

    let participantIndex = currentRound.participants.findIndex(p => p.user?._id === data.userId || p.user?.id === data.userId);
    if (participantIndex !== -1) { // Update existing participant
        currentRound.participants[participantIndex].itemsValue = data.itemsValue; // This is the new TOTAL for user
        currentRound.participants[participantIndex].tickets = data.tickets;    // This is the new TOTAL for user
    } else { // Add new participant
        currentRound.participants.push({
            user: { _id: data.userId, id: data.userId, username: data.username, avatar: data.avatar },
            itemsValue: data.itemsValue, tickets: data.tickets
        });
    }

    currentRound.totalValue = data.totalValue; // Update total pot value from server
    (data.depositedItems || []).forEach(item => { // Add items from THIS deposit to the round's master item list
        if (item && typeof item.price === 'number') {
            currentRound.items.push({ ...item, owner: data.userId });
        }
    });

    updateRoundUI();
    displayLatestDeposit(data); // Visually update/add the participant's deposit block
    updateAllParticipantPercentages(); // Recalculate for all displayed participants
    updateDepositButtonState();

    if (currentRound.status === 'active' && currentRound.participants.length === 1 && !timerActive) {
        timerActive = true; startClientTimer(currentRound.timeLeft || CONFIG.ROUND_DURATION);
    }
}

function updateParticipantsUI() {
    const { participantCount } = DOMElements.jackpot;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    const container = DOMElements.jackpot.participantsContainer;
    if (!participantCount || !emptyMsg || !container) return;

    const participantNum = currentRound?.participants?.length || 0;
    participantCount.textContent = `${participantNum}/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
    const hasDepositBlocks = container.querySelector('.player-deposit-container') !== null;
    emptyMsg.style.display = (!hasDepositBlocks && participantNum === 0) ? 'block' : 'none';
}

function startClientTimer(initialTime = CONFIG.ROUND_DURATION) {
    if (roundTimer) clearInterval(roundTimer);
    let timeLeft = Math.max(0, initialTime);
    timerActive = true;
    updateTimerUI(timeLeft); updateDepositButtonState();

    roundTimer = setInterval(() => {
        if (!timerActive) { clearInterval(roundTimer); roundTimer = null; return; }
        timeLeft--;
        if (currentRound) currentRound.timeLeft = timeLeft;
        updateTimerUI(timeLeft); updateDepositButtonState();
        if (timeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null; timerActive = false;
            if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "0";
            updateDepositButtonState(); // Deposits should be closed
        }
    }, 1000);
}


function createRouletteItems() {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer;
    if (!track || !container) { console.error("Roulette elements missing."); return; }
    track.innerHTML = ''; track.style.transition = 'none'; track.style.transform = 'translateX(0)';

    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0 || !currentRound.items || currentRound.items.length === 0) {
        console.error('No participants or items data for roulette.');
        track.innerHTML = '<div class="roulette-message">Error: Not enough data for roulette.</div>';
        return;
    }

    // Create a flat list of items, where each item is an object { image, price, userId, userAvatar, userColor }
    let visualItemPool = [];
    currentRound.participants.forEach(p => {
        if (!p.user || !p.user._id || p.itemsValue <= 0) return; // Skip if no user or no value
        const userItems = currentRound.items.filter(item => (item.owner && item.owner.toString() === p.user._id.toString()));
        if (userItems.length === 0) return; // Skip if user has no items in the pot

        // Simplification: repeat each of the user's actual items a few times, or use avatars based on value
        // For this version, we will use participant avatars weighted by their value for the visual roulette
        const numSlots = Math.max(3, Math.ceil((p.itemsValue / currentRound.totalValue) * 200)); // Min 3 slots, scale up to ~200 total
        for(let i=0; i < numSlots; i++) {
            visualItemPool.push({
                userId: p.user._id,
                avatar: p.user.avatar || '/img/default-avatar.png',
                color: getUserColor(p.user._id)
            });
        }
    });

    if (visualItemPool.length === 0) {
        console.warn("Visual item pool for roulette is empty. Falling back to basic participant list.");
        // Fallback: add each participant once if item-based pool fails
        currentRound.participants.forEach(p => {
            if (p.user && p.user._id) {
                visualItemPool.push({ userId: p.user._id, avatar: p.user.avatar || '/img/default-avatar.png', color: getUserColor(p.user._id) });
            }
        });
        if (visualItemPool.length === 0) {
             track.innerHTML = '<div class="roulette-message">No participants to display.</div>'; return;
        }
    }

    visualItemPool = shuffleArray(visualItemPool); // Shuffle for visual variety

    const itemsToCreate = Math.max(300, visualItemPool.length * CONFIG.ROULETTE_REPETITIONS); // Ensure enough for smooth animation
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < itemsToCreate; i++) {
        const visualItem = visualItemPool[i % visualItemPool.length]; // Cycle through pool
        const itemElement = document.createElement('div');
        itemElement.className = 'roulette-item';
        itemElement.dataset.userId = visualItem.userId;
        itemElement.style.borderColor = visualItem.color;
        itemElement.innerHTML = `<img class="roulette-avatar" src="${visualItem.avatar}" alt="Participant Avatar" loading="lazy" onerror="this.onerror=null; this.src='/img/default-avatar.png';">`;
        fragment.appendChild(itemElement);
    }
    track.appendChild(fragment);
    console.log(`Created ${track.children.length} visual items for roulette animation.`);
}

function handleWinnerAnnouncement(data) { // Data from 'roundWinner' event
    if (isSpinning) { console.warn("Winner announced, but already spinning."); return; }
    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) {
        console.error("Winner announced, but missing local round/participant data. Requesting sync.");
        socket.emit('requestRoundData');
        // Optionally, queue the winner announcement to retry after data arrives
        // For now, we rely on roundRolling to have set up the view.
        return;
    }

    const winnerDetails = data.winner; // From server: { id, steamId, username, avatar }
    if (!winnerDetails || !winnerDetails.id) {
        console.error("Invalid winner data in announcement:", data);
        resetToJackpotView(); return;
    }

    console.log(`Winner announced: ${winnerDetails.username}. Preparing to start roulette animation.`);
    if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }

    // switchToRouletteView() should have been called by 'roundRolling'
    // Now, directly start the animation with the winner data.
    startRouletteAnimation(winnerDetails, data); // Pass full event data for seeds etc.
}

function switchToRouletteView() { // Called on 'roundRolling'
    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer;
    if (!header || !rouletteContainer) { console.error("Roulette UI elements missing."); return; }

    isSpinning = true; // Set spinning true as we are entering roulette mode
    updateDepositButtonState(); // Disable deposits

    // Fade out regular jackpot header elements
    const elementsToFade = [header.querySelector('.jackpot-value'), header.querySelector('.jackpot-timer'), header.querySelector('.jackpot-stats')];
    elementsToFade.forEach(el => {
        if (el) {
            el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
            el.style.opacity = '0';
            el.style.transform = 'scale(0.8)';
            setTimeout(() => { if(el) el.style.display = 'none'; }, 300);
        }
    });

    header.classList.add('roulette-mode'); // Adjust header style for compact roulette view
    rouletteContainer.style.display = 'flex';
    rouletteContainer.style.opacity = '0';
    rouletteContainer.style.transform = 'translateY(10px)';

    // Create items for the roulette track *before* it becomes fully visible
    createRouletteItems();

    setTimeout(() => { // Fade in roulette container
        rouletteContainer.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        rouletteContainer.style.opacity = '1';
        rouletteContainer.style.transform = 'translateY(0)';
    }, 100); // Short delay after header elements start fading

    if (DOMElements.roulette.winnerInfoBox) DOMElements.roulette.winnerInfoBox.style.display = 'none';
    clearConfetti();
    console.log("Switched to roulette view. Waiting for winner data to start spin.");
}


function startRouletteAnimation(winnerServerDetails, roundEndData) { // winnerServerDetails = data.winner from event
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
    if (!winnerServerDetails || !winnerServerDetails.id) {
        console.error("Invalid winner data for roulette animation start.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const winnerId = winnerServerDetails.id; // MongoDB _id
    // Find full participant details (value, percentage) locally. currentRound should be populated.
    const winnerParticipantData = currentRound?.participants?.find(p => p.user?._id === winnerId || p.user?.id === winnerId);

    if (!winnerParticipantData || !winnerParticipantData.user) {
        console.error(`Could not find full local data for winner ID ${winnerId}. Using server details primarily.`);
        // Use server details, but value/percentage might be missing or approximate
        const approxWinnerData = {
            user: winnerServerDetails,
            value: roundEndData.totalValue, // This is total pot value sent to winner (after tax)
            percentage: (roundEndData.totalTickets > 0 && winnerParticipantData?.tickets) ? (winnerParticipantData.tickets / roundEndData.totalTickets * 100) : (1/ (currentRound?.participants?.length || 1)) * 100 // Rough estimate if tickets missing
        };
        // This is a fallback, ideally winnerParticipantData is found
        handleRouletteSpinLogic(winnerServerDetails, approxWinnerData);
    } else {
        // Calculate percentage for the actual winner based on currentRound data
        const totalPotValueForCalc = Math.max(0.01, currentRound.totalValue || 0.01); // Use pre-tax value for chance calc
        const winnerValueInPot = winnerParticipantData.itemsValue || 0;
        const winnerChance = (winnerValueInPot / totalPotValueForCalc) * 100;

        const fullWinnerDetailsForDisplay = {
            user: winnerParticipantData.user, // Contains avatar, username, id
            value: winnerValueInPot,          // Their deposited value
            percentage: winnerChance
        };
        handleRouletteSpinLogic(winnerServerDetails, fullWinnerDetailsForDisplay);
    }
}

function handleRouletteSpinLogic(winnerServerIdentity, winnerDisplayDetails) { // winnerServerIdentity is for targeting, winnerDisplayDetails for the info box
    const sound = DOMElements.audio.spinSound;
    if (sound) { sound.volume = 0.4; sound.currentTime = 0; sound.playbackRate = 1.0; sound.play().catch(e => console.warn('Error playing spin sound:', e)); }

    const track = DOMElements.roulette.rouletteTrack;
    const items = track?.querySelectorAll('.roulette-item');
    if (!track || !items || items.length === 0) {
        console.error('Roulette track or items missing for spin.');
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const winnerIdToTarget = winnerServerIdentity.id; // The ID we need to land on

    // Find a suitable winning item index. Prioritize items in the latter part of the strip for a better visual spin.
    const minIndexPercent = 0.70; const maxIndexPercent = 0.90; // Land towards the end
    const minLandingIndex = Math.floor(items.length * minIndexPercent);
    const maxLandingIndex = Math.floor(items.length * maxIndexPercent);

    let possibleWinnerIndices = [];
    for (let i = minLandingIndex; i <= maxLandingIndex; i++) {
        if (items[i]?.dataset?.userId === winnerIdToTarget) possibleWinnerIndices.push(i);
    }
    if (possibleWinnerIndices.length === 0) { // Fallback: search entire strip
        for (let i = 0; i < items.length; i++) {
            if (items[i]?.dataset?.userId === winnerIdToTarget) possibleWinnerIndices.push(i);
        }
    }

    let targetIndex;
    let winningElement;

    if (possibleWinnerIndices.length > 0) {
        targetIndex = possibleWinnerIndices[Math.floor(Math.random() * possibleWinnerIndices.length)]; // Pick one randomly
        winningElement = items[targetIndex];
    } else { // Should be rare if winner is in participants and roulette items were created correctly
        console.warn(`No visual item found for winner ID ${winnerIdToTarget}. Using a fallback random item.`);
        targetIndex = Math.max(0, Math.min(items.length - 1, Math.floor(items.length * 0.8))); // Fallback to ~80%
        winningElement = items[targetIndex];
        if (!winningElement) {
            console.error("Fallback winning element is also invalid. Aborting spin.");
            isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
        }
        // Override display details if we couldn't land on the actual winner's item
        const fallbackUserId = winningElement.dataset.userId;
        const fallbackParticipant = currentRound?.participants?.find(p => p.user?._id === fallbackUserId);
        if (fallbackParticipant && fallbackParticipant.user) {
            winnerDisplayDetails.user = fallbackParticipant.user; // Show who it landed on
            // Recalculate value/chance for this displayed "winner"
             const totalPotVal = Math.max(0.01, currentRound.totalValue || 0.01);
             winnerDisplayDetails.value = fallbackParticipant.itemsValue || 0;
             winnerDisplayDetails.percentage = ((fallbackParticipant.itemsValue || 0) / totalPotVal) * 100;
        } else {
             winnerDisplayDetails.user.username = "Error User"; // Generic if even fallback fails
        }
        console.log(`Spin Target: Fallback item at index ${targetIndex} for user ${winnerDisplayDetails.user.username}`);
    }

    console.log(`Spin Target: Item at index ${targetIndex} for winner ${winnerDisplayDetails.user.username}`);
    performRouletteSpinAnimation(winningElement, winnerDisplayDetails);
}


function performRouletteSpinAnimation(winningElement, winnerForDisplay) {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer?.querySelector('.roulette-container');
    if (!winningElement || !track || !container) {
        console.error("Missing elements for performRouletteSpinAnimation.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const containerWidth = container.offsetWidth;
    const itemWidth = winningElement.offsetWidth || 60;
    const itemOffsetLeft = winningElement.offsetLeft;
    const centerOffset = (containerWidth / 2) - (itemWidth / 2);
    const perfectCenterScrollPosition = -(itemOffsetLeft - centerOffset);

    const variation = (Math.random() * 2 - 1) * (itemWidth * CONFIG.LANDING_POSITION_VARIATION);
    const maxAbsVariation = itemWidth * 0.48; // Ensure it doesn't land exactly on edge
    const finalVariation = Math.max(-maxAbsVariation, Math.min(maxAbsVariation, variation));
    const targetScrollPosition = perfectCenterScrollPosition + finalVariation;

    const startPosition = parseFloat(track.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1] || '0');
    const duration = CONFIG.SPIN_DURATION_SECONDS * 1000;
    const bounceDuration = CONFIG.BOUNCE_ENABLED ? 1200 : 0;
    const totalAnimationTime = duration + bounceDuration;
    const totalDistance = targetScrollPosition - startPosition;
    const overshootAmount = totalDistance * CONFIG.BOUNCE_OVERSHOOT_FACTOR;
    let startTime = performance.now();

    track.style.transition = 'none'; // Use rAF

    function animate(timestamp) {
        if (!isSpinning) { // Check if spin was cancelled externally
            if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null;
            console.log("Roulette animation cancelled."); return;
        }
        const elapsed = timestamp - startTime;
        let currentPos, animationDone = false;

        if (elapsed <= duration) {
            const progress = elapsed / duration;
            currentPos = startPosition + totalDistance * easeOutAnimation(progress);
        } else if (CONFIG.BOUNCE_ENABLED && elapsed <= totalAnimationTime) {
            const bounceProgress = (elapsed - duration) / bounceDuration;
            currentPos = targetScrollPosition - (overshootAmount * calculateBounce(bounceProgress));
        } else {
            currentPos = targetScrollPosition; animationDone = true;
        }
        track.style.transform = `translateX(${currentPos}px)`;
        if (!animationDone) animationFrameId = requestAnimationFrame(animate);
        else {
            animationFrameId = null;
            finalizeSpin(winningElement, winnerForDisplay);
        }
    }
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = requestAnimationFrame(animate);
}

function finalizeSpin(winningElement, winnerToDisplay) {
    if ((!isSpinning && winningElement?.classList.contains('winner-highlight')) || !winningElement || !winnerToDisplay?.user) {
        if (isSpinning) { isSpinning = false; updateDepositButtonState(); resetToJackpotView(); }
        return;
    }
    const winnerId = winnerToDisplay.user.id || winnerToDisplay.user._id;
    const userColor = getUserColor(winnerId);
    winningElement.classList.add('winner-highlight'); // Add class for CSS pulse

    const styleId = 'winner-pulse-style'; document.getElementById(styleId)?.remove();
    const style = document.createElement('style'); style.id = styleId;
    style.textContent = `
        .winner-highlight {
            z-index: 5; border-width: 3px !important; border-color: ${userColor} !important;
            animation: winnerPulse 1.2s infinite ease-in-out; --winner-color: ${userColor};
            transform: scale(1.1); box-shadow: 0 0 20px ${userColor}, inset 0 0 10px ${lightenColor(userColor, 20)};
        }
        @keyframes winnerPulse {
            0%, 100% { box-shadow: 0 0 20px var(--winner-color), inset 0 0 10px ${lightenColor(userColor, 20)}; transform: scale(1.1); }
            50% { box-shadow: 0 0 30px var(--winner-color), 0 0 15px var(--winner-color), inset 0 0 15px ${lightenColor(userColor, 30)}; transform: scale(1.15); }
        }`;
    document.head.appendChild(style);
    setTimeout(() => handleSpinEnd(winnerToDisplay), 300); // Show info box after highlight
}


function handleSpinEnd(winnerToDisplay) { // winnerToDisplay contains {user, value, percentage}
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
    if (!winnerToDisplay || !winnerToDisplay.user) {
        console.error("handleSpinEnd: Invalid winner data.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const { winnerInfoBox, winnerAvatar, winnerName, winnerDeposit, winnerChance } = DOMElements.roulette;
    if (!winnerInfoBox || !winnerAvatar || !winnerName || !winnerDeposit || !winnerChance) {
        console.error("Winner info display elements missing.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const userColor = getUserColor(winnerToDisplay.user.id || winnerToDisplay.user._id);
    winnerAvatar.src = winnerToDisplay.user.avatar || '/img/default-avatar.png';
    winnerAvatar.alt = winnerToDisplay.user.username || 'Winner';
    winnerAvatar.style.borderColor = userColor;
    winnerAvatar.style.boxShadow = `0 0 15px ${userColor}`;
    winnerName.textContent = winnerToDisplay.user.username || 'Winner!';
    winnerName.style.color = userColor;

    const depositValueStr = `$${(winnerToDisplay.value || 0).toFixed(2)}`;
    const chanceValueStr = `${(winnerToDisplay.percentage || 0).toFixed(2)}%`;
    winnerDeposit.textContent = ''; winnerChance.textContent = ''; // Clear for typing effect

    winnerInfoBox.style.display = 'flex'; winnerInfoBox.style.opacity = '0';
    winnerInfoBox.style.animation = 'fadeIn 0.5s ease forwards';

    setTimeout(() => { // Typing animation
        let dIdx = 0, cIdx = 0; const typeDelay = 40;
        if (window.typeDepInt) clearInterval(window.typeDepInt); if (window.typeChaInt) clearInterval(window.typeChaInt);
        window.typeDepInt = setInterval(() => {
            if (dIdx < depositValueStr.length) { winnerDeposit.textContent += depositValueStr[dIdx++]; }
            else {
                clearInterval(window.typeDepInt); window.typeDepInt = null;
                window.typeChaInt = setInterval(() => {
                    if (cIdx < chanceValueStr.length) { winnerChance.textContent += chanceValueStr[cIdx++]; }
                    else {
                        clearInterval(window.typeChaInt); window.typeChaInt = null;
                        launchConfetti(userColor);
                        // isSpinning is set to false *after* all animations and winner display is complete.
                        // The server will send 'roundCompleted' and then 'roundCreated' for the next round.
                        // resetToJackpotView will be called based on WINNER_DISPLAY_DURATION timeout
                    }
                }, typeDelay);
            }
        }, typeDelay);
    }, 500); // Delay before typing

    // isSpinning should remain true until resetToJackpotView is called
    console.log("Winner info displayed. Waiting for auto-reset or next round event.");
    setTimeout(() => {
        // Check if we are still in the winner display phase for this round before resetting
        if (isSpinning && currentRound && currentRound.winner && (currentRound.winner.id === winnerToDisplay.user.id || currentRound.winner._id === winnerToDisplay.user.id)) {
            console.log("Winner display duration ended. Resetting to jackpot view.");
            resetToJackpotView();
        } else {
            console.log("Winner display duration ended, but state changed (e.g., new round started). No explicit reset here.");
        }
    }, CONFIG.WINNER_DISPLAY_DURATION);
}


function launchConfetti(mainColor = '#00e676') {
    const container = DOMElements.roulette.confettiContainer;
    if (!container) return;
    clearConfetti(); // Clear previous

    const colors = [mainColor, lightenColor(mainColor, 30), darkenColor(mainColor, 20), getComplementaryColor(mainColor), '#FFFFFF'];
    for (let i = 0; i < CONFIG.CONFETTI_COUNT; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        piece.style.left = `${Math.random() * 100}%`;
        const duration = 2.5 + Math.random() * 2.5;
        const delay = Math.random() * 1.0;
        piece.style.setProperty('--duration', `${duration}s`);
        piece.style.setProperty('--delay', `${delay}s`);
        piece.style.setProperty('--color', colors[Math.floor(Math.random() * colors.length)]);
        const size = Math.random() * 6 + 5;
        piece.style.width = `${size}px`; piece.style.height = `${size}px`;
        const rotStart = Math.random() * 360; const rotEnd = rotStart + (Math.random() - 0.5) * 720;
        const fallX = (Math.random() - 0.5) * 150;
        piece.style.setProperty('--fall-x', `${fallX}px`);
        piece.style.setProperty('--rotation-start', `${rotStart}deg`);
        piece.style.setProperty('--rotation-end', `${rotEnd}deg`);
        if (Math.random() < 0.4) piece.style.borderRadius = '50%';
        container.appendChild(piece);
    }
}

function clearConfetti() {
    if (DOMElements.roulette.confettiContainer) DOMElements.roulette.confettiContainer.innerHTML = '';
    document.getElementById('winner-pulse-style')?.remove();
    document.querySelectorAll('.roulette-item.winner-highlight').forEach(el => {
        el.classList.remove('winner-highlight');
        el.style.transform = '';
        // Reset border based on its original user color or to transparent
        const itemUserId = el.dataset.userId;
        el.style.borderColor = itemUserId ? getUserColor(itemUserId) : 'transparent';
    });
}

function resetToJackpotView() {
    console.log("Resetting to jackpot view. Current isSpinning state:", isSpinning);
    if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null;
    if (window.typeDepInt) clearInterval(window.typeDepInt); window.typeDepInt = null;
    if (window.typeChaInt) clearInterval(window.typeChaInt); window.typeChaInt = null;
    if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
    timerActive = false; // Ensure client timer is marked inactive

    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer;
    const winnerInfoBox = DOMElements.roulette.winnerInfoBox;
    const track = DOMElements.roulette.rouletteTrack;

    if (!header || !rouletteContainer || !winnerInfoBox || !track) {
        console.error("Elements missing for resetToJackpotView.");
        isSpinning = false; updateDepositButtonState(); // Ensure state is consistent
        return;
    }

    const sound = DOMElements.audio.spinSound;
    if (sound) { sound.pause(); sound.currentTime = 0; sound.volume = 1.0; sound.playbackRate = 1.0; }

    rouletteContainer.style.transition = 'opacity 0.4s ease'; rouletteContainer.style.opacity = '0';
    if (winnerInfoBox.style.display !== 'none') {
        winnerInfoBox.style.transition = 'opacity 0.3s ease'; winnerInfoBox.style.opacity = '0';
    }
    clearConfetti();

    setTimeout(() => {
        header.classList.remove('roulette-mode');
        track.style.transition = 'none'; track.style.transform = 'translateX(0)'; track.innerHTML = '';
        rouletteContainer.style.display = 'none';
        winnerInfoBox.style.display = 'none'; winnerInfoBox.style.opacity = ''; winnerInfoBox.style.animation = '';

        const elementsToShow = [header.querySelector('.jackpot-value'), header.querySelector('.jackpot-timer'), header.querySelector('.jackpot-stats')];
        elementsToShow.forEach((el, index) => {
            if (el) {
                el.style.display = 'flex'; // Or appropriate display type
                el.style.opacity = '0'; el.style.transform = 'scale(0.9)';
                setTimeout(() => {
                    el.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                    el.style.opacity = '1'; el.style.transform = 'scale(1)';
                }, 50 + index * 50);
            }
        });

        // Important: Set isSpinning to false AFTER UI reset is complete or when round is truly over.
        // The new round 'roundCreated' event will trigger the main UI reset.
        // This function mostly handles the visual transition back from roulette.
        // The actual state of isSpinning should be false if we are not in roulette animation.
        isSpinning = false;
        initiateNewRoundVisualReset(); // This function handles clearing pot, resetting timer text etc. for NEW round
        updateDepositButtonState();

        // Do NOT request round data here if a 'roundCreated' is expected soon.
        // 'roundCreated' or 'roundData' will provide the necessary state.
        console.log("Jackpot view reset visually. isSpinning is now false. Waiting for next round data from server.");
    }, 400); // Duration of fade-out
}


function initiateNewRoundVisualReset() {
    console.log("Initiating visual reset for a new round or initial page load.");
    // Reset timer display
    updateTimerUI(CONFIG.ROUND_DURATION);
    if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.classList.remove('urgent-pulse', 'timer-pulse');
    if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
    timerActive = false;

    // Clear participant display
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (container) container.innerHTML = ''; // Clear all visual participant blocks
    if (emptyMsg) {
        if (container && !container.contains(emptyMsg)) container.appendChild(emptyMsg); // Add if not present
        emptyMsg.style.display = 'block'; // Show "empty pot" message
    }

    // Reset pot value and participant count displays
    if (DOMElements.jackpot.potValue) DOMElements.jackpot.potValue.textContent = "$0.00";
    if (DOMElements.jackpot.participantCount) DOMElements.jackpot.participantCount.textContent = `0/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;

    userColorMap.clear(); // Reset user colors for the new round
    currentRound = null; // Clear local currentRound data; will be repopulated by server
    updateDepositButtonState(); // Update button states based on reset
    isSpinning = false; // Ensure spinning is false if we are resetting for a new round
}


async function verifyRound() {
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationResultDisplay } = DOMElements.provablyFair;
    if (!roundIdInput || !serverSeedInput || !clientSeedInput || !verificationResultDisplay) {
        console.error("Verify form elements missing."); return;
    }
    const roundId = roundIdInput.value.trim(), serverSeed = serverSeedInput.value.trim(), clientSeed = clientSeedInput.value.trim();
    const resultEl = verificationResultDisplay;
    let validationError = null;

    if (!roundId || !serverSeed || !clientSeed) validationError = 'Please fill in all fields.';
    else if (serverSeed.length !== 64 || !/^[a-f0-9]{64}$/i.test(serverSeed)) validationError = 'Invalid Server Seed format (64 hex chars).';
    else if (clientSeed.length === 0) validationError = 'Client Seed cannot be empty.';

    if (validationError) {
        resultEl.style.display = 'block'; resultEl.className = 'verification-result error';
        resultEl.innerHTML = `<p>${validationError}</p>`; return;
    }

    try {
        resultEl.style.display = 'block'; resultEl.className = 'verification-result loading';
        resultEl.innerHTML = '<p>Verifying...</p>';
        const response = await fetch('/api/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roundId, serverSeed, clientSeed })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Verification failed (${response.status})`);

        resultEl.className = `verification-result ${result.verified ? 'success' : 'error'}`;
        let html = `<h4>Verification Result (Round #${result.roundId || roundId})</h4>`;
        if (result.verified) {
            html += `<p style="color: var(--success-color); font-weight: bold;">✅ Verified Fair.</p>`;
            if(result.message) html += `<p>${result.message}</p>`;
            if (result.serverSeedHashOfficial) html += `<p><strong>Official Server Seed Hash:</strong> <code class="seed-value">${result.serverSeedHashOfficial}</code></p>`;
            html += `<p><strong>Server Seed (Used for Calc):</strong> <code class="seed-value">${result.serverSeedUsed}</code></p>`;
            html += `<p><strong>Client Seed (Used for Calc):</strong> <code class="seed-value">${result.clientSeedUsed}</code></p>`;
            if (result.combinedStringCalculated) html += `<p><strong>Combined String (Server+Client):</strong> <code class="seed-value wrap-anywhere">${result.combinedStringCalculated}</code></p>`;
            if (result.finalHashCalculated) html += `<p><strong>Resulting SHA256 Hash:</strong> <code class="seed-value">${result.finalHashCalculated}</code></p>`;
            if (result.winningTicketCalculated !== undefined) html += `<p><strong>Winning Ticket:</strong> ${result.winningTicketCalculated} (out of ${result.totalTicketsInRound || 'N/A'} total tickets)</p>`;
            if (result.officialWinnerUsername) html += `<p><strong>Verified Winner:</strong> ${result.officialWinnerUsername}</p>`;
            if (result.officialPotValue !== undefined) html += `<p><strong>Verified Pot Value (Winner received):</strong> $${result.officialPotValue.toFixed(2)}</p>`;
        } else {
            html += `<p style="color: var(--error-color); font-weight: bold;">❌ Verification Failed.</p>`;
            html += `<p><strong>Reason:</strong> ${result.reason || 'Mismatch detected.'}</p>`;
            // Show expected vs calculated where applicable
            if (result.expectedServerSeedHash && result.calculatedHashFromProvidedSeed) {
                html += `<p><strong>Expected Server Seed Hash:</strong> <code class="seed-value">${result.expectedServerSeedHash}</code></p>`;
                html += `<p><strong>Calculated Hash from Your Seed:</strong> <code class="seed-value">${result.calculatedHashFromProvidedSeed}</code></p>`;
            }
            if (result.officialProvableHash && result.calculatedProvableHashFromInputs) {
                 html += `<p><strong>Official Provable Hash:</strong> <code class="seed-value">${result.officialProvableHash}</code></p>`;
                 html += `<p><strong>Calculated Provable Hash from Inputs:</strong> <code class="seed-value">${result.calculatedProvableHashFromInputs}</code></p>`;
            }
            if (result.actualWinningTicket !== undefined && result.calculatedTicket !== undefined) {
                 html += `<p><strong>Official Winning Ticket:</strong> ${result.actualWinningTicket}</p>`;
                 html += `<p><strong>Calculated Ticket from Inputs:</strong> ${result.calculatedTicket}</p>`;
            }
        }
        resultEl.innerHTML = html;
    } catch (error) {
        resultEl.style.display = 'block'; resultEl.className = 'verification-result error';
        resultEl.innerHTML = `<p>Verification Error: ${error.message}</p>`;
        console.error('Error verifying round:', error);
    }
}

async function loadPastRounds(page = 1) {
    const tableBody = DOMElements.provablyFair.roundsTableBody;
    const paginationContainer = DOMElements.provablyFair.roundsPagination;
    if (!tableBody || !paginationContainer) { console.warn("Rounds history elements missing."); return; }

    try {
        tableBody.innerHTML = '<tr><td colspan="5" class="loading-message">Loading round history...</td></tr>';
        paginationContainer.innerHTML = '';
        const response = await fetch(`/api/rounds?page=${page}&limit=10`);
        if (!response.ok) throw new Error(`Failed to load round history (${response.status})`);
        const data = await response.json();
        if (!data || !Array.isArray(data.rounds)) throw new Error('Invalid rounds data received.');

        tableBody.innerHTML = '';
        if (data.rounds.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" class="no-rounds-message">${page === 1 ? 'No past rounds found.' : 'No rounds on this page.'}</td></tr>`;
        } else {
            data.rounds.forEach(round => {
                const row = document.createElement('tr');
                row.dataset.roundId = round.roundId;
                let date = 'N/A';
                const timeToFormat = round.completedTime || round.endTime;
                if (timeToFormat) { try { date = new Date(timeToFormat).toLocaleString(); } catch (e) { /* ignore */ } }

                const serverSeedStr = (round.serverSeed || '').replace(/'/g, "\\'");
                const clientSeedStr = (round.clientSeed || '').replace(/'/g, "\\'");
                const roundIdStr = round.roundId || 'N/A';
                const winnerUsername = round.winner?.username || (round.status === 'error' ? 'ERROR' : (round.status === 'completed' ? 'N/A' : 'Pending'));
                // totalValue in completed rounds is after-tax
                const potValueStr = (round.totalValue !== undefined) ? `$${round.totalValue.toFixed(2)}` : '$0.00';

                row.innerHTML = `
                    <td>#${roundIdStr}</td> <td>${date}</td> <td>${potValueStr}</td>
                    <td class="${round.winner ? 'winner-cell' : ''}">${winnerUsername}</td>
                    <td>
                        <button class="btn btn-secondary btn-small btn-verify"
                                onclick="window.populateVerificationFields('${roundIdStr}', '${serverSeedStr}', '${clientSeedStr}')"
                                ${!round.serverSeed || round.status !== 'completed' ? 'disabled title="Seeds revealed after round completion"' : 'title="Verify this round"'} >
                            Verify
                        </button>
                    </td>`;
                tableBody.appendChild(row);
            });
        }
        createPagination(data.currentPage, data.totalPages);
    } catch (error) {
        tableBody.innerHTML = `<tr><td colspan="5" class="error-message">Error: ${error.message}</td></tr>`;
        console.error('Error loading past rounds:', error);
    }
}
window.populateVerificationFields = function(roundId, serverSeed, clientSeed) {
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationSection } = DOMElements.provablyFair;
    if (roundIdInput) roundIdInput.value = roundId || '';
    if (serverSeedInput) serverSeedInput.value = serverSeed || '';
    if (clientSeedInput) clientSeedInput.value = clientSeed || '';
    if (verificationSection) verificationSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (!serverSeed && roundId && roundId !== 'N/A') showNotification(`Info: Server Seed for Round #${roundId} is revealed after the round ends.`, 'info');
};

function createPagination(currentPage, totalPages) {
    const container = DOMElements.provablyFair.roundsPagination;
    if (!container) return; container.innerHTML = '';
    if (totalPages <= 1) return;

    const maxPages = 5;
    const createBtn = (text, page, active = false, disabled = false, ellipsis = false) => {
        if (ellipsis) { const s = document.createElement('span'); s.className = 'page-ellipsis'; s.textContent = '...'; return s; }
        const btn = document.createElement('button');
        btn.className = `page-button ${active ? 'active' : ''}`;
        btn.textContent = text; btn.disabled = disabled;
        if (!disabled && typeof page === 'number') btn.addEventListener('click', (e) => { e.preventDefault(); loadPastRounds(page); });
        return btn;
    };
    container.appendChild(createBtn('« Prev', currentPage - 1, false, currentPage <= 1));
    if (totalPages <= maxPages) {
        for (let i = 1; i <= totalPages; i++) container.appendChild(createBtn(i, i, i === currentPage));
    } else {
        let pages = [1];
        const pad = Math.floor((maxPages - 3) / 2);
        let start = Math.max(2, currentPage - pad);
        let end = Math.min(totalPages - 1, currentPage + pad);
        const len = end - start + 1;
        const needed = maxPages - 3;
        if (len < needed) { if (currentPage - start < end - currentPage) end = Math.min(totalPages - 1, start + needed -1); else start = Math.max(2, end - needed + 1); }
        if (start > 2) pages.push('...');
        for (let i = start; i <= end; i++) pages.push(i);
        if (end < totalPages - 1) pages.push('...');
        pages.push(totalPages);
        pages.forEach(p => container.appendChild(p === '...' ? createBtn('...', null, false, true, true) : createBtn(p, p, p === currentPage)));
    }
    container.appendChild(createBtn('Next »', currentPage + 1, false, currentPage >= totalPages));
}


function updateChatUI() {
    const { messageInput, sendMessageBtn, onlineUsers } = DOMElements.chat;
    if (currentUser) {
        if (messageInput) { messageInput.disabled = false; messageInput.placeholder = 'Type your message...'; }
        if (sendMessageBtn) sendMessageBtn.disabled = isChatSendOnCooldown;
    } else {
        if (messageInput) { messageInput.disabled = true; messageInput.placeholder = 'Sign in to chat'; }
        if (sendMessageBtn) sendMessageBtn.disabled = true;
    }
    if (onlineUsers) onlineUsers.textContent = onlineUserCount;
}

function displayChatMessage(messageData) {
    const { messagesContainer } = DOMElements.chat;
    if (!messagesContainer) return;
    const { type = 'user', username, avatar, message, userId, userSteamId } = messageData;
    const msgEl = document.createElement('div');
    msgEl.classList.add('chat-message');
    if (userId) msgEl.dataset.userId = userId;

    if (type === 'system') {
        msgEl.classList.add('system-message'); msgEl.textContent = message;
    } else {
        const userColor = getUserColor(userId || 'system');
        msgEl.innerHTML = `
            <img src="${avatar || '/img/default-avatar.png'}" alt="${username || 'User'}" class="chat-message-avatar" style="border-color: ${userColor};">
            <div class="chat-message-content">
                <span class="chat-message-user" style="color: ${userColor};">${username || 'User'}</span>
                <p class="chat-message-text"></p>
            </div>`;
        const textEl = msgEl.querySelector('.chat-message-text');
        if (textEl) textEl.textContent = message; // Use textContent for safety
    }
    messagesContainer.insertBefore(msgEl, messagesContainer.firstChild);
    while (messagesContainer.children.length > CONFIG.MAX_CHAT_MESSAGES) {
        messagesContainer.removeChild(messagesContainer.lastChild);
    }
}

function handleSendMessage() {
    const { messageInput, sendMessageBtn } = DOMElements.chat;
    if (!messageInput || !currentUser || isChatSendOnCooldown) return;
    const msgText = messageInput.value.trim();
    if (msgText) {
        socket.emit('chatMessage', msgText); messageInput.value = '';
        isChatSendOnCooldown = true;
        if (sendMessageBtn) {
            sendMessageBtn.disabled = true; const origTxt = sendMessageBtn.textContent;
            let count = Math.floor(CONFIG.CHAT_SEND_COOLDOWN_MS / 1000);
            sendMessageBtn.textContent = `Wait ${count}s`;
            const intervalId = setInterval(() => {
                count--;
                if (count > 0) sendMessageBtn.textContent = `Wait ${count}s`;
                else { clearInterval(intervalId); sendMessageBtn.textContent = origTxt; isChatSendOnCooldown = false; if(currentUser) sendMessageBtn.disabled = false; }
            }, 1000);
        }
        setTimeout(() => { isChatSendOnCooldown = false; if(currentUser && sendMessageBtn && !sendMessageBtn.textContent.startsWith("Wait")) sendMessageBtn.disabled = false; }, CONFIG.CHAT_SEND_COOLDOWN_MS);
    }
}

function setupChatEventListeners() {
    DOMElements.chat.sendMessageBtn?.addEventListener('click', handleSendMessage);
    DOMElements.chat.messageInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } });
}

function updateChatOnlineUsers(count) {
    onlineUserCount = count;
    if (DOMElements.chat.onlineUsers) DOMElements.chat.onlineUsers.textContent = onlineUserCount;
}

function setupSocketConnection() {
    socket.on('connect', () => {
        console.log('Socket connected:', socket.id);
        showNotification('Connected to server.', 'success', 2000);
        socket.emit('requestRoundData'); // Request current state on connect
    });
    socket.on('disconnect', (reason) => {
        console.warn('Socket disconnected:', reason);
        showNotification('Disconnected. Attempting to reconnect...', 'error', 5000);
        timerActive = false; if (roundTimer) clearInterval(roundTimer); roundTimer = null; // Stop client timer
        updateDepositButtonState(); updateChatOnlineUsers(0);
        // Do not reset `isSpinning` here; it should persist if disconnect happens mid-spin
        // and be resolved by `resetToJackpotView` or new round data.
    });
    socket.on('connect_error', (err) => { console.error('Socket connection error:', err); showNotification('Connection Error. Refresh page.', 'error', 10000); });

    socket.on('roundCreated', (data) => { // Server signals a completely new round
        console.log('Socket: roundCreated', data);
        currentRound = data; // Set the new round data
        initiateNewRoundVisualReset(); // Full visual reset: pot, timer, etc.
        updateRoundUI(); // Update displays with new round data
        updateDepositButtonState();
        userColorMap.clear(); // Clear user colors for new round
        isSpinning = false; // Ensure spinning is false for a new round
        if (DOMElements.roulette.inlineRouletteContainer.style.display === 'flex') { // If roulette was somehow visible
            resetToJackpotView(); // Ensure it's hidden and jackpot view is primary
        }
    });

    socket.on('participantUpdated', (data) => { // A player deposited
        console.log('Socket: participantUpdated', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            handleNewDeposit(data);
        } else if (data.roundId) { // If client missed roundCreated or is out of sync
            console.warn("Participant update for a round client isn't tracking. Requesting full sync.");
            socket.emit('requestRoundData');
        }
    });

    socket.on('roundRolling', (data) => { // Server is starting to pick a winner
        console.log('Socket: roundRolling', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
            currentRound.status = 'rolling';
            // Don't show "Rolling..." text. Directly switch to roulette view.
            // The actual animation starts when 'roundWinner' is received.
            switchToRouletteView(); // Prepares the visual roulette area
            updateTimerUI(0); // Show timer as 0 or "Rolling"
            updateDepositButtonState();
        }
    });

    socket.on('roundWinner', (data) => { // Server has picked a winner and sends details
        console.log('Socket: roundWinner', data);
        if (currentRound && currentRound.roundId === data.roundId && isSpinning) { // isSpinning should be true from roundRolling
            currentRound.winner = data.winner; // Store winner info
            currentRound.serverSeed = data.serverSeed; // Store revealed seeds
            currentRound.clientSeed = data.clientSeed;
            currentRound.provableHash = data.provableHash;
            handleWinnerAnnouncement(data); // This will start the actual roulette animation
        } else if (!isSpinning && currentRound && currentRound.roundId === data.roundId) {
            console.warn("Received roundWinner but client wasn't in 'isSpinning' state. Attempting to start animation.");
            // This might happen if 'roundRolling' was missed or processed too quickly.
            currentRound.status = 'rolling'; // Ensure status is correct
            switchToRouletteView(); // Make sure view is correct
            handleWinnerAnnouncement(data);
        } else {
            console.warn("Received roundWinner for mismatched round or state. Current:", currentRound?.roundId, "Spinning:", isSpinning, "Received:", data.roundId);
        }
    });

    socket.on('roundCompleted', (data) => { // Server confirms round is fully done (after payout logic etc.)
        console.log('Socket: roundCompleted', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'completed';
            // `resetToJackpotView` is typically called after WINNER_DISPLAY_DURATION.
            // This event mainly confirms server-side completion.
            // If client is still showing winner, let it finish. If already reset, this confirms state.
            // A 'roundCreated' for the next round will follow.
        }
        updateDepositButtonState();
    });


    socket.on('roundError', (data) => {
        console.error('Socket: roundError', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'error';
            showNotification(`Round Error: ${data.error || 'Unknown error.'}`, 'error', 6000);
            resetToJackpotView(); // Reset UI immediately on error
        } else if (data.roundId && !currentRound) { // Error for a round client isn't aware of
             showNotification(`Error on round ${data.roundId}: ${data.error || 'Unknown error.'}`, 'error', 6000);
             initiateNewRoundVisualReset(); // Reset to a clean state
        }
    });

    socket.on('roundData', (data) => { // For initial sync or manual request
        console.log('Socket: roundData received', data);
        if (!data || typeof data !== 'object') {
            console.error("Invalid full round data from server.");
            initiateNewRoundVisualReset(); return;
        }
        currentRound = data;
        isSpinning = false; // Assume not spinning when full data refresh comes, unless status is rolling

        // Stop any existing client-side timers before processing new state
        if (roundTimer) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }

        if (currentRound.status === 'rolling') {
            console.log("Received 'rolling' status in roundData. Switching to roulette view.");
            currentRound.timeLeft = 0; // Ensure timer shows 0 or rolling
            switchToRouletteView(); // Prepare roulette view
            // Backend will send 'roundWinner' shortly to start the animation
        } else if (currentRound.status === 'completed') {
            console.log("Received 'completed' status in roundData.");
            if (currentRound.winner) {
                // If winner is known, but client might have missed animation, show minimal winner info or just reset
                // For simplicity, we'll just ensure the view is reset for the next round.
                // The 'roundCreated' event is the primary trigger for a fresh start.
                console.log("Round already completed with winner. Ensuring jackpot view is ready for next round.");
            }
            resetToJackpotView(); // Ensure we are back to jackpot view if round is completed
        } else if (currentRound.status === 'active') {
            // Clear old participant blocks and re-render based on fresh data
            const participantsContainer = DOMElements.jackpot.participantsContainer;
            if(participantsContainer) participantsContainer.innerHTML = ''; // Clear visual pot
            if(DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'block';

            if (currentRound.participants && currentRound.participants.length > 0) {
                currentRound.participants.forEach(p => {
                    // Find items for this participant from the round's main item list
                    const pItems = currentRound.items.filter(item => item.owner && (item.owner === p.user._id || item.owner === p.user.id || item.owner.toString() === p.user._id.toString()));
                    displayLatestDeposit({ // Reconstruct data for display function
                        userId: p.user._id || p.user.id, username: p.user.username, avatar: p.user.avatar,
                        itemsValue: p.itemsValue, tickets: p.tickets, totalValue: currentRound.totalValue,
                        depositedItems: pItems // Send items belonging to this participant
                    });
                });
                updateAllParticipantPercentages();
            }
             updateParticipantsUI(); // To ensure empty message is hidden if participants exist

            if (currentRound.participants.length > 0 && currentRound.timeLeft > 0) {
                timerActive = true; startClientTimer(currentRound.timeLeft);
            } else {
                timerActive = false; updateTimerUI(currentRound.timeLeft); // Show time but don't start interval if 0 or no players
            }
        } else if (currentRound.status === 'pending') {
            initiateNewRoundVisualReset(); // Reset for pending state
        }
        updateRoundUI(); // General UI update
        updateDepositButtonState();
    });


    socket.on('tradeOfferSent', (data) => { // For both deposit and winnings
        console.log('Socket: tradeOfferSent', data);
        if (data.type === 'winning' && currentUser && data.userId === (currentUser._id || currentUser.id) && data.offerURL) {
            const message = `🏆 WINNER! <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link" style="font-weight:bold; text-decoration:underline;">Click to accept your items! (Offer #${data.offerId})</a>`;
            showNotification(message, 'success', CONFIG.WINNER_TRADE_OFFER_NOTIFICATION_DURATION, true);
        } else if (data.type === 'deposit' && currentUser && data.userId === (currentUser._id || currentUser.id) && data.offerURL) {
            // This is now handled directly in requestDepositOffer response and modal UI.
            // Can be used as a fallback or secondary notification if needed.
            // showNotification(`Deposit offer sent! <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer">Accept on Steam (#${data.offerId})</a>`, 'info', 10000, true);
        }
    });

    socket.on('notification', (data) => {
        if (!data.userId || (currentUser && data.userId === (currentUser._id || currentUser.id))) {
            showNotification(data.message || 'Server notification.', data.type || 'info', data.duration || 5000, data.isHtml || false);
        }
    });

    socket.on('chatMessage', displayChatMessage);
    socket.on('updateUserCount', updateChatOnlineUsers);
}


function setupEventListeners() {
    // Navigation
    DOMElements.nav.homeLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.homePage); });
    DOMElements.nav.aboutLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.aboutPage); });
    DOMElements.nav.tosLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.tosPage); });
    DOMElements.nav.faqLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.faqPage); });
    DOMElements.nav.fairLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.fairPage); });

    // User Authentication & Profile
    DOMElements.user.loginButton?.addEventListener('click', () => {
        if (localStorage.getItem('ageVerified') === 'true') window.location.href = '/auth/steam';
        else showModal(DOMElements.ageVerification.modal);
    });
    const { userProfile, userDropdownMenu, logoutButton, profileDropdownButton, winningHistoryDropdownButton } = DOMElements.user;
    userProfile?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (userDropdownMenu) {
            const isVisible = userDropdownMenu.style.display === 'block';
            userDropdownMenu.style.display = isVisible ? 'none' : 'block';
            userProfile.setAttribute('aria-expanded', String(!isVisible)); userProfile.classList.toggle('open', !isVisible);
        }
    });
    userProfile?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }});
    logoutButton?.addEventListener('click', (e) => { e.stopPropagation(); handleLogout(); });
    profileDropdownButton?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (currentUser && DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
        else if (!currentUser) showNotification("Please log in to view your profile.", "info");
        if (userDropdownMenu) userDropdownMenu.style.display = 'none'; userProfile?.classList.remove('open'); userProfile?.setAttribute('aria-expanded', 'false');
    });
     winningHistoryDropdownButton?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (currentUser && DOMElements.winningHistoryModal.modal) { loadWinningHistory(); showModal(DOMElements.winningHistoryModal.modal); }
        else if (!currentUser) showNotification("Log in to see your winning history.", "info");
        if (userDropdownMenu) userDropdownMenu.style.display = 'none'; userProfile?.classList.remove('open'); userProfile?.setAttribute('aria-expanded', 'false');
    });


    // Profile Modal
    DOMElements.profileModal.saveBtn?.addEventListener('click', handleProfileSave);
    DOMElements.profileModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.profileModal.cancelBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));

    // Winning History Modal
    DOMElements.winningHistoryModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.winningHistoryModal.modal));
    DOMElements.winningHistoryModal.closeFooterBtn?.addEventListener('click', () => hideModal(DOMElements.winningHistoryModal.modal));


    // Deposit Modal
    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => {
        const btn = DOMElements.deposit.showDepositModalButton;
        if (btn.disabled) { showNotification(btn.title || 'Deposits currently closed.', 'info'); return; }
        if (!currentUser) { showNotification('Login Required.', 'error'); return; }
        if (!currentUser.tradeUrl) {
            showNotification('Trade URL Required: Set it in your profile first.', 'error', 6000);
            if (DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
            return;
        }
        showModal(DOMElements.deposit.depositModal); loadUserInventory();
    });
    DOMElements.deposit.closeDepositModalButton?.addEventListener('click', () => hideModal(DOMElements.deposit.depositModal));
    DOMElements.deposit.depositButton?.addEventListener('click', requestDepositOffer);
    // Removed separate acceptDepositOfferBtn listener as link is now in status text

    // Age Verification
    const { modal: ageModal, checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
    if (ageModal && ageCheckbox && ageAgreeButton) {
        ageCheckbox.addEventListener('change', () => { ageAgreeButton.disabled = !ageCheckbox.checked; });
        ageAgreeButton.addEventListener('click', () => {
            if (ageCheckbox.checked) { localStorage.setItem('ageVerified', 'true'); hideModal(ageModal); window.location.href = '/auth/steam'; }
        });
        ageAgreeButton.disabled = !ageCheckbox.checked;
    }

    // Provably Fair
    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound);

    // Global click/key listeners
    window.addEventListener('click', (e) => {
        if (userDropdownMenu && userProfile && userDropdownMenu.style.display === 'block' && !userProfile.contains(e.target) && !userDropdownMenu.contains(e.target)) {
            userDropdownMenu.style.display = 'none'; userProfile.setAttribute('aria-expanded', 'false'); userProfile.classList.remove('open');
        }
        Object.values(DOMElements.pages).forEach(modal => { // Simplify modal closing
            if (modal && modal.classList.contains('modal') && modal.style.display === 'flex' && e.target === modal) {
                hideModal(modal);
            }
        });
        if (e.target === DOMElements.deposit.depositModal) hideModal(DOMElements.deposit.depositModal);
        if (e.target === DOMElements.profileModal.modal) hideModal(DOMElements.profileModal.modal);
        if (e.target === DOMElements.winningHistoryModal.modal) hideModal(DOMElements.winningHistoryModal.modal);

    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (DOMElements.deposit.depositModal?.style.display === 'flex') hideModal(DOMElements.deposit.depositModal);
            else if (DOMElements.profileModal.modal?.style.display === 'flex') hideModal(DOMElements.profileModal.modal);
            else if (DOMElements.winningHistoryModal.modal?.style.display === 'flex') hideModal(DOMElements.winningHistoryModal.modal);
            else if (userDropdownMenu?.style.display === 'block') {
                userDropdownMenu.style.display = 'none'; userProfile?.setAttribute('aria-expanded', 'false'); userProfile?.classList.remove('open'); userProfile?.focus();
            }
        }
    });
    setupChatEventListeners();
}

async function loadWinningHistory() {
    const { tableBody, loadingIndicator, noWinningsMessage } = DOMElements.winningHistoryModal;
    if (!tableBody || !loadingIndicator || !noWinningsMessage) {
        console.error("Winning history modal elements not found."); return;
    }
    loadingIndicator.style.display = 'flex';
    noWinningsMessage.style.display = 'none';
    tableBody.innerHTML = '';

    try {
        const response = await fetch('/api/user/winning-history');
        if (!response.ok) {
            const errData = await response.json().catch(() => ({error: `Failed to load history (${response.status})`}));
            throw new Error(errData.error);
        }
        const history = await response.json();
        loadingIndicator.style.display = 'none';

        if (!Array.isArray(history) || history.length === 0) {
            noWinningsMessage.style.display = 'block'; return;
        }

        history.forEach(win => {
            const row = tableBody.insertRow();
            row.insertCell().textContent = `#${win.gameId}`;
            row.insertCell().textContent = new Date(win.dateWon).toLocaleString();
            row.insertCell().textContent = `$${(win.amountWon || 0).toFixed(2)}`;

            const statusCell = row.insertCell();
            statusCell.className = 'trade-status-cell'; // For potential styling
            if (win.tradeOfferId && win.tradeStatus !== 'Failed' && win.tradeStatus !== 'Declined' && win.tradeStatus !== 'Canceled' && win.tradeStatus !== 'Expired') {
                const offerLink = `https://steamcommunity.com/tradeoffer/${win.tradeOfferId}/`;
                statusCell.innerHTML = `<a href="${offerLink}" target="_blank" rel="noopener noreferrer" class="trade-link">${win.tradeStatus} (#${win.tradeOfferId}) <i class="fas fa-external-link-alt"></i></a>`;
            } else {
                statusCell.textContent = win.tradeStatus || 'Unknown';
            }
             // Add class to status text based on status
            const statusSpan = statusCell.querySelector('a') || statusCell; // Get link or cell itself
            statusSpan.classList.add('trade-status'); // Base class
            if (win.tradeStatus) {
                const statusClass = win.tradeStatus.toLowerCase().replace(/\s+/g, '-'); // e.g. "Pending Send" -> "pending-send"
                statusSpan.classList.add(statusClass);
                 // More specific classes for coloring:
                if (['accepted', 'sent'].includes(statusClass)) statusSpan.classList.add('success');
                else if (['failed', 'declined', 'canceled', 'expired', 'invaliditems'].includes(statusClass)) statusSpan.classList.add('error');
                else if (['pending send', 'escrow', 'pendingconfirmation'].includes(statusClass)) statusSpan.classList.add('warning');

            }
        });

    } catch (error) {
        loadingIndicator.style.display = 'none';
        noWinningsMessage.textContent = `Error loading history: ${error.message}`;
        noWinningsMessage.style.display = 'block';
        noWinningsMessage.classList.add('error');
        console.error("Error loading winning history:", error);
    }
}


function populateProfileModal() {
    const modalElements = DOMElements.profileModal;
    if (!currentUser || !modalElements.modal) return;
    modalElements.avatar.src = currentUser.avatar || '/img/default-avatar.png';
    modalElements.name.textContent = currentUser.username || 'User';
    modalElements.deposited.textContent = `$${(currentUser.totalDepositedValue || 0).toFixed(2)}`;
    modalElements.won.textContent = `$${(currentUser.totalWinningsValue || 0).toFixed(2)}`;
    modalElements.tradeUrlInput.value = currentUser.tradeUrl || '';
    const statusDiv = modalElements.pendingOfferStatus;
    if (!statusDiv) return;
    if (currentUser.pendingDepositOfferId) {
        const offerId = currentUser.pendingDepositOfferId;
        const offerURL = `https://steamcommunity.com/tradeoffer/${offerId}/`;
        statusDiv.innerHTML = `<p>⚠️ You have a <a href="${offerURL}" target="_blank" rel="noopener noreferrer" class="profile-pending-link">pending deposit offer (#${offerId})</a> awaiting action on Steam.</p>`;
        statusDiv.style.display = 'block';
    } else {
        statusDiv.style.display = 'none'; statusDiv.innerHTML = '';
    }
}

async function handleProfileSave() {
    const { tradeUrlInput, saveBtn } = DOMElements.profileModal;
    if (!tradeUrlInput || !saveBtn || !currentUser) { showNotification("Not logged in or profile elements missing.", "error"); return; }
    const newTradeUrl = tradeUrlInput.value.trim();
    const urlPattern = /^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/i;
    if (newTradeUrl && !urlPattern.test(newTradeUrl)) {
        showNotification('Invalid Steam Trade URL format. Check or leave empty.', 'error', 6000); return;
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
        const response = await fetch('/api/user/tradeurl', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tradeUrl: newTradeUrl }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || `Failed to save URL (${response.status})`);
        currentUser.tradeUrl = newTradeUrl;
        showNotification(newTradeUrl ? 'Trade URL saved!' : 'Trade URL cleared!', 'success');
        updateDepositButtonState();
        hideModal(DOMElements.profileModal.modal);
    } catch (error) {
        console.error("Error saving trade URL:", error);
        showNotification(`Error: ${error.message}`, 'error');
    } finally {
        saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed.");
    const ageVerified = localStorage.getItem('ageVerified') === 'true';
    checkLoginStatus().then(() => { // Wait for login status before other initializations
        setupEventListeners();
        setupSocketConnection(); // Socket connection depends on user potentially
        showPage(DOMElements.pages.homePage);
        initiateNewRoundVisualReset(); // Initial visual state for jackpot
        updateChatUI(); // Initial chat UI
        if (!ageVerified && DOMElements.ageVerification.modal) {
            const { checkbox: ageCb, agreeButton: ageBtn } = DOMElements.ageVerification;
            if(ageCb) ageCb.checked = false; if(ageBtn) ageBtn.disabled = true;
            showModal(DOMElements.ageVerification.modal);
        }
    });
});

console.log("main.js modifications complete, including winner trade offer notification and animation flow adjustments.");
