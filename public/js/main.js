// main.js - Rust Jackpot Frontend Logic
// Modifications:
// - Winning History now fetches from a (placeholder) API.
// - Selected items in deposit modal now persist using localStorage.
// - Chat messages persist in localStorage and are limited to 15.
// - Profile dropdown alignment considered.
// - Tax and multiple deposit logic reviewed (primarily backend, but frontend interaction considered).

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
    ROULETTE_REPETITIONS: 20,
    SPIN_DURATION_SECONDS: 6.5,
    WINNER_DISPLAY_DURATION: 7000,
    CONFETTI_COUNT: 150,
    EASE_OUT_POWER: 5,
    BOUNCE_ENABLED: false,
    BOUNCE_OVERSHOOT_FACTOR: 0.07,
    BOUNCE_DAMPING: 0.35,
    BOUNCE_FREQUENCY: 3.5,
    LANDING_POSITION_VARIATION: 0.60,
    MAX_CHAT_MESSAGES: 15, // User request: Only 15 messages should be in the chat at once
    CHAT_SEND_COOLDOWN_MS: 2000, // Frontend visual cooldown for chat send button
    CHAT_LOCAL_STORAGE_KEY: 'rustyDegenChatHistory', // For chat persistence
    DEPOSIT_SELECTION_STORAGE_KEY: 'rustyDegenDepositSelection', // For deposit selection persistence
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
        winningHistoryDropdownButton: document.getElementById('winningHistoryDropdownButton'), // ADDED
        logoutButton: document.getElementById('logoutButton'),
        pendingOfferIndicator: document.getElementById('pending-offer-indicator'),
    },
    profileModal: {
        modal: document.getElementById('profileModal'),
        avatar: document.getElementById('profileModalAvatar'),
        name: document.getElementById('profileModalName'),
        deposited: document.getElementById('profileModalDeposited'),
        won: document.getElementById('profileModalWon'), // Added for total won
        tradeUrlInput: document.getElementById('profileModalTradeUrl'),
        saveBtn: document.getElementById('profileModalSaveBtn'),
        closeBtn: document.getElementById('profileModalCloseBtn'),
        cancelBtn: document.getElementById('profileModalCancelBtn'),
        pendingOfferStatus: document.getElementById('profile-pending-offer-status'),
    },
    winningHistoryModal: { // ADDED
        modal: document.getElementById('winningHistoryModal'),
        closeBtnHeader: document.getElementById('closeWinningHistoryModal'),
        closeBtnFooter: document.getElementById('winningHistoryModalCloseFooterBtn'),
        loadingIndicator: document.getElementById('winning-history-loading'),
        tableContainer: document.getElementById('winningHistoryTableContainer'),
        tableBody: document.getElementById('winningHistoryTableBody'),
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
        returnToJackpotButton: document.getElementById('returnToJackpot'),
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
let currentRound = null;
let selectedItemsList = []; // Holds full item objects for current selection
let userInventory = []; // Holds full item objects of user's inventory
let isSpinning = false;
let timerActive = false;
let roundTimer = null;
let animationFrameId = null;
let userColorMap = new Map();
let notificationTimeout = null;
let spinStartTime = 0;
let currentDepositOfferURL = null;
let onlineUserCount = 0;
let isChatSendOnCooldown = false;
let chatMessages = []; // Array to hold current chat messages for localStorage & display logic

// --- LocalStorage Helper for Deposit Selection ---
function saveSelectedDepositItems() {
    if (!currentUser) return; // Only save if a user is logged in
    // Store only assetIds to keep localStorage light and avoid stale data issues.
    const assetIdsToSave = selectedItemsList.map(item => item.assetId);
    try {
        localStorage.setItem(`${CONFIG.DEPOSIT_SELECTION_STORAGE_KEY}_${currentUser.steamId}`, JSON.stringify(assetIdsToSave));
    } catch (e) {
        console.warn("Could not save deposit selection to localStorage:", e);
    }
}

function loadSelectedDepositItemsFromStorage() { // Renamed to clarify it loads IDs
    if (!currentUser) return [];
    try {
        const storedAssetIds = localStorage.getItem(`${CONFIG.DEPOSIT_SELECTION_STORAGE_KEY}_${currentUser.steamId}`);
        if (storedAssetIds) {
            const parsedAssetIds = JSON.parse(storedAssetIds);
            return Array.isArray(parsedAssetIds) ? parsedAssetIds : [];
        }
    } catch (e) {
        console.warn("Could not load deposit selection from localStorage:", e);
    }
    return []; // Return empty array if nothing stored or error
}

function clearSelectedDepositItemsStorage() {
    if (!currentUser) return;
    try {
        localStorage.removeItem(`${CONFIG.DEPOSIT_SELECTION_STORAGE_KEY}_${currentUser.steamId}`);
    } catch (e) {
        console.warn("Could not clear deposit selection from localStorage:", e);
    }
}
// --- End LocalStorage Helper ---


function showModal(modalElement) {
    if (modalElement) modalElement.style.display = 'flex';
}

function hideModal(modalElement) {
    if (modalElement) modalElement.style.display = 'none';
    // No specific reset needed here for depositModal as loadUserInventory handles it
}
window.hideModal = hideModal; // Make globally accessible

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
        loadPastRounds();
    }
}
window.showPage = showPage;

function getUserColor(userId) {
    if (!userColorMap.has(userId)) {
        const colorIndex = userColorMap.size % COLOR_PALETTE.length;
        userColorMap.set(userId, COLOR_PALETTE[colorIndex]);
    }
    return userColorMap.get(userId) || '#cccccc';
}

function showNotification(message, type = 'info', duration = 4000) {
    if (!DOMElements.notificationBar) {
        console.warn("Notification bar element (#notification-bar) not found. Using console.log as fallback.");
        console.log(`[${type.toUpperCase()}] ${message}`);
        return;
    }
    const bar = DOMElements.notificationBar;
    if (notificationTimeout) clearTimeout(notificationTimeout);
    bar.innerHTML = message; // Be cautious if message can contain HTML; sanitize if needed
    bar.className = 'notification-bar'; // Reset classes
    bar.classList.add(type);
    bar.classList.add('show');
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

function calculateBounce(t) {
    if (!CONFIG.BOUNCE_ENABLED) return 0;
    const clampedT = Math.max(0, Math.min(1, t));
    const decay = Math.exp(-clampedT / CONFIG.BOUNCE_DAMPING);
    const oscillations = Math.sin(clampedT * Math.PI * 2 * CONFIG.BOUNCE_FREQUENCY);
    return -decay * oscillations;
}

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

async function handleLogout() {
    console.log("Attempting logout...");
    try {
        const response = await fetch('/logout', { method: 'POST' });
        if (!response.ok) {
             const result = await response.json().catch(() => ({ error: 'Logout request failed.' }));
            throw new Error(result.error || `Logout request failed with status ${response.status}.`);
        }
        const result = await response.json();
         if (!result.success) throw new Error(result.error || 'Logout unsuccessful according to server.');
        currentUser = null;
        clearSelectedDepositItemsStorage(); // Clear persistent deposit selection on logout
        updateUserUI();
        updateDepositButtonState();
        updateChatUI();
        showNotification('You have been successfully signed out.', 'success');
    } catch (error) {
        console.error('Logout Error:', error);
        showNotification(`Logout failed: ${error.message}`, 'error');
    } finally {
        const { userDropdownMenu, userProfile } = DOMElements.user;
        if (userDropdownMenu) {
            userDropdownMenu.style.display = 'none';
            userProfile?.setAttribute('aria-expanded', 'false');
            userProfile?.classList.remove('open');
        }
    }
}

function resetDepositModalUI(isOpeningModal = false) {
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit;
    if (depositButton) {
        depositButton.disabled = selectedItemsList.length === 0 || !!currentDepositOfferURL || depositButton.textContent === 'Requesting...';
        depositButton.style.display = 'inline-block';
        if (depositButton.textContent !== 'Requesting...') { // Don't overwrite if mid-request
            depositButton.textContent = 'Request Deposit Offer';
        }
    }
    if (acceptDepositOfferBtn) {
        acceptDepositOfferBtn.style.display = 'none'; // Hide by default
        acceptDepositOfferBtn.removeAttribute('data-offer-url');
    }
    if (depositStatusText) {
        depositStatusText.textContent = '';
        depositStatusText.className = 'deposit-status-text';
    }
    if (!isOpeningModal) { // Only reset currentDepositOfferURL if not just opening
        currentDepositOfferURL = null;
    }
    updateTotalValue(); // Ensure total value is always updated
}


function updateDepositButtonState() {
    const button = DOMElements.deposit.showDepositModalButton;
    if (!button) return;
    let disabled = false;
    let title = 'Deposit Rust skins into the pot';
    if (!currentUser) {
        disabled = true; title = 'Log in to deposit';
    } else if (currentUser.pendingDepositOfferId) {
         disabled = true; title = 'Accept or cancel your pending deposit offer first (check profile)';
    } else if (!currentUser.tradeUrl) {
         disabled = true; title = 'Set your Steam Trade URL in your profile to deposit';
    } else if (isSpinning) {
        disabled = true; title = 'Deposits closed during winner selection';
    } else if (!currentRound || currentRound.status !== 'active') {
        disabled = true; title = 'Deposits are currently closed';
        if (currentRound) {
            switch (currentRound.status) {
                case 'rolling': title = 'Deposits closed during winner selection'; break;
                case 'completed': case 'error': title = 'Deposits closed (Round ended)'; break;
                case 'pending': title = 'Deposits closed (Waiting for round)'; break;
            }
        }
    } else if (currentRound.participants && currentRound.participants.length >= CONFIG.MAX_PARTICIPANTS_DISPLAY) {
        disabled = true; title = `Participant limit (${CONFIG.MAX_PARTICIPANTS_DISPLAY}) reached`;
    } else if (currentRound.items && currentRound.items.length >= CONFIG.MAX_ITEMS_PER_POT_FRONTEND) {
        disabled = true; title = `Pot item limit (${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}) reached`;
    } else if (timerActive && currentRound.timeLeft !== undefined && currentRound.timeLeft <= 0) {
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
        loadChatHistory(); // Load chat history
        // If a user is logged in, `loadSelectedDepositItemsFromStorage` will be called within `loadUserInventory`
        // to correctly reconcile persisted selections with the actual inventory.
        if (!currentUser) {
            selectedItemsList = []; // Clear selection if no user
            clearSelectedDepositItemsStorage(); // Also clear from storage if no user session.
        }
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
        console.error("Inventory DOM elements missing."); return;
    }

    inventoryLoadingIndicator.style.display = 'flex';
    inventoryItemsContainer.innerHTML = '';
    selectedItemsContainer.innerHTML = ''; // Clear visual selected items on each load

    try {
        const response = await fetch('/api/inventory');
        if (!response.ok) {
            let errorMsg = 'Inventory load failed.';
            try { const errorData = await response.json(); errorMsg = errorData.error || `Inventory load failed (${response.status})`; } catch (e) { /*Ignore*/ }
            if (response.status === 401 || response.status === 403) errorMsg = 'Please log in first.';
            throw new Error(errorMsg);
        }
        userInventory = await response.json(); // Fresh inventory
        inventoryLoadingIndicator.style.display = 'none';
        if (!Array.isArray(userInventory)) throw new Error('Invalid inventory data received.');

        // Reconcile selectedItemsList with fresh inventory and persisted asset IDs
        const persistedAssetIds = loadSelectedDepositItemsFromStorage(); // Get IDs from localStorage
        const newSelectedItemsList = [];
        if (persistedAssetIds.length > 0 && userInventory.length > 0) {
            userInventory.forEach(invItem => {
                // If an item from fetched inventory was in the persisted selection and we haven't hit the limit
                if (persistedAssetIds.includes(invItem.assetId) && newSelectedItemsList.length < CONFIG.MAX_ITEMS_PER_DEPOSIT) {
                    newSelectedItemsList.push(invItem); // Add the full item object
                }
            });
        }
        selectedItemsList = newSelectedItemsList; // This is now our active selection
        saveSelectedDepositItems(); // Save the reconciled (and possibly trimmed) list of asset IDs

        if (userInventory.length === 0) {
            inventoryItemsContainer.innerHTML = '<p class="empty-inventory-message">Inventory empty or unavailable. Ensure it\'s public on Steam.</p>';
        } else {
            displayInventoryItems(); // This will visually mark items as selected based on the updated selectedItemsList
        }
        // Re-populate the "Selected Items" visual section based on the reconciled selectedItemsList
        selectedItemsList.forEach(item => addSelectedItemElement(item));
        updateTotalValue();
        resetDepositModalUI(true); // True because modal is opening/refreshing

    } catch (error) {
        inventoryLoadingIndicator.style.display = 'none';
        inventoryItemsContainer.innerHTML = `<p class="error-message">Error loading inventory: ${error.message}</p>`;
        console.error('Error loading inventory:', error);
        selectedItemsList = []; // Clear selection on error
        saveSelectedDepositItems(); // Persist empty selection
        updateTotalValue();
        resetDepositModalUI(true);
    }
}


function displayInventoryItems() {
    const container = DOMElements.deposit.inventoryItemsContainer;
    if (!container) return;
    container.innerHTML = ''; // Clear before re-rendering

    userInventory.forEach(item => {
        if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.assetId || !item.image) {
            console.warn("Skipping invalid inventory item:", item); return;
        }
        const itemElement = document.createElement('div');
        itemElement.className = 'inventory-item';
        itemElement.dataset.assetId = item.assetId;
        itemElement.dataset.image = item.image;
        itemElement.dataset.price = item.price.toFixed(2);
        itemElement.title = `$${item.price.toFixed(2)}`;
        itemElement.innerHTML = `
            <img src="${item.image}" alt="Skin Image" loading="lazy"
                 onerror="this.onerror=null; this.src='/img/default-item.png';">
            <div class="item-details">
                <div class="item-value">$${item.price.toFixed(2)}</div>
            </div>`;
        // Check if this item is in the current selectedItemsList by assetId
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
        showNotification('Selection Error: Cannot select item with invalid price.', 'error');
        return;
    }
    const assetId = item.assetId;
    const index = selectedItemsList.findIndex(i => i.assetId === assetId);
    if (index === -1) {
        if (selectedItemsList.length >= CONFIG.MAX_ITEMS_PER_DEPOSIT) {
            showNotification(`Selection Limit: You can select a maximum of ${CONFIG.MAX_ITEMS_PER_DEPOSIT} items per deposit.`, 'info');
            return;
        }
        selectedItemsList.push(item); // Add the full item object
        element.classList.add('selected');
        addSelectedItemElement(item);
    } else {
        selectedItemsList.splice(index, 1);
        element.classList.remove('selected');
        removeSelectedItemElement(assetId);
    }
    saveSelectedDepositItems(); // Save selection to localStorage
    updateTotalValue();
    resetDepositModalUI();
}

function addSelectedItemElement(item) {
    const container = DOMElements.deposit.selectedItemsContainer;
    if (!container) return;
    if (typeof item.price !== 'number' || isNaN(item.price)) {
        console.error("Cannot add selected item element, invalid price:", item); return;
    }
    const selectedElement = document.createElement('div');
    selectedElement.className = 'selected-item-display';
    selectedElement.dataset.assetId = item.assetId;
    selectedElement.title = `$${item.price.toFixed(2)}`;
    selectedElement.innerHTML = `
        <img src="${item.image}" alt="Selected Skin Image" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-item.png';">
        <div class="item-value">$${item.price.toFixed(2)}</div>
        <button class="remove-item-btn" title="Remove Item" data-asset-id="${item.assetId}" aria-label="Remove Item">&times;</button>
        `;
    selectedElement.querySelector('.remove-item-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const assetIdToRemove = e.target.dataset.assetId;
        if (assetIdToRemove) {
            removeSelectedItem(assetIdToRemove); // This will update selectedItemsList and save to localStorage
            updateTotalValue();
            resetDepositModalUI();
        }
    });
    selectedElement.addEventListener('click', () => {
        removeSelectedItem(item.assetId); // This will update selectedItemsList and save to localStorage
        updateTotalValue();
        resetDepositModalUI();
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
    saveSelectedDepositItems(); // Save change to localStorage
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


async function requestDepositOffer() {
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit;
    if (!depositButton || !acceptDepositOfferBtn || !depositStatusText) return;

    if (selectedItemsList.length === 0) {
        showNotification('No Items Selected: Please select items first.', 'info');
        return;
    }
    if (!currentRound || currentRound.status !== 'active' || isSpinning) { showNotification('Deposit Error: Deposits are currently closed.', 'error'); return; }
    if (currentUser?.pendingDepositOfferId) {
        showNotification('Deposit Error: You already have a pending deposit offer. Check your profile or Steam.', 'error');
        if (DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
        return;
    }

    const participantsLength = currentRound.participants?.length || 0;
    const isNewParticipant = !currentRound.participants?.some(p => p.user?._id === currentUser?._id || p.user?.id === currentUser?._id);
    if (isNewParticipant && participantsLength >= CONFIG.MAX_PARTICIPANTS_DISPLAY) { showNotification(`Deposit Error: Participant limit (${CONFIG.MAX_PARTICIPANTS_DISPLAY}) reached.`, 'error'); return; }

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
        response = await fetch('/api/deposit', { // This was the original endpoint
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetIds }),
        });
        const result = await response.json();

        if (!response.ok) {
            if (response.status === 409 && result.offerURL && result.offerId) {
                // User already has a pending offer logic
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
            // Success
            depositStatusText.textContent = "Offer created! Click 'Accept on Steam' below to complete.";
            depositStatusText.className = 'deposit-status-text success';
            currentDepositOfferURL = result.offerURL;
            depositButton.style.display = 'none';
            acceptDepositOfferBtn.style.display = 'inline-block';
            acceptDepositOfferBtn.disabled = false;
            if(currentUser) { currentUser.pendingDepositOfferId = result.offerId; updateUserUI(); updateDepositButtonState(); }
            clearSelectedDepositItemsStorage(); // Clear persisted selection on successful offer request
            selectedItemsList = []; // Also clear in-memory list
            // No need to call DOMElements.deposit.selectedItemsContainer.innerHTML = ''; here,
            // loadUserInventory on next modal open will handle reflecting the cleared selection.
        }
    } catch (error) {
        console.error('Error requesting deposit offer:', error);
        depositStatusText.textContent = `Error: ${error.message}`;
        depositStatusText.className = 'deposit-status-text error';
        // For most errors, we DON'T want to clear selectedItemsList or its storage,
        // so the user can retry without re-selecting.
        // Only reset the button state if it's not a 409 (already handled)
        if (!(response && response.status === 409)) {
            depositButton.disabled = selectedItemsList.length === 0; // Re-enable based on selection
            depositButton.textContent = 'Request Deposit Offer';
        }
        // If error was something other than 409, and we locally thought there was a pending offer, clear it
        if (currentUser && currentUser.pendingDepositOfferId && !(response && response.status === 409)) {
            currentUser.pendingDepositOfferId = null; updateUserUI(); updateDepositButtonState();
        }
    }
}

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
    } else if (currentRound && currentRound.status === 'pending') {
        displayValue = "Waiting";
    } else if (!currentRound) {
        displayValue = "--";
    }

    timerValue.textContent = displayValue;
    updateTimerCircle(timeToShow, CONFIG.ROUND_DURATION);

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

function updateTimerCircle(timeLeft, totalTime) {
    const circle = DOMElements.jackpot.timerForeground;
    if (!circle) return;
    if (circle instanceof SVGCircleElement && circle.r?.baseVal?.value) {
        const radius = circle.r.baseVal.value;
        const circumference = 2 * Math.PI * radius;
        const progress = Math.min(1, Math.max(0, timeLeft / Math.max(1, totalTime)));
        const offset = circumference * (1 - progress);
        circle.style.strokeDasharray = `${circumference}`;
        circle.style.strokeDashoffset = `${Math.max(0, offset)}`;
    }
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
        // Find the participant's total data for the current round
        const participantData = currentRound.participants.find(p => p.user?._id === userId || p.user?.id === userId);
        if (!participantData) return;

        const cumulativeValue = participantData.itemsValue || 0; // This is their total value in the pot
        const percentage = ((cumulativeValue / currentTotalPotValue) * 100).toFixed(1);
        const valueElement = block.querySelector('.player-deposit-value');

        if (valueElement) {
            const userColor = getUserColor(userId);
            // The text content for the value part of the block might still show individual deposit value,
            // but the percentage shown should be based on their total contribution.
            // The title attribute clarifies their total.
            const blockSpecificValueText = valueElement.textContent.split('|')[0].trim(); // Keep the originally displayed value for this block
            valueElement.textContent = `${blockSpecificValueText} | ${percentage}%`;
            valueElement.title = `Total Deposited: $${cumulativeValue.toFixed(2)} | Chance: ${percentage}%`;
            valueElement.style.color = userColor; // Color remains based on user
        }
    });
}


function displayLatestDeposit(data) {
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (!container) return;

    const userId = data.userId || data.user?._id;
    if (!userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue)) {
        console.error("Invalid data passed to displayLatestDeposit:", data);
        return;
    }

    const depositSfx = DOMElements.audio.depositSound;
    if (depositSfx) {
        depositSfx.volume = 0.6;
        depositSfx.currentTime = 0;
        depositSfx.play().catch(e => console.error("Error playing deposit sound:", e));
    }

    const username = data.username || data.user?.username || 'Unknown User';
    const avatar = data.avatar || data.user?.avatar || '/img/default-avatar.png';
    const valueOfThisDeposit = data.itemsValue; // Value of items in *this specific deposit*
    const itemsInThisDeposit = data.depositedItems || [];
    const userColor = getUserColor(userId);

    // Get participant's *total cumulative* value in the round for percentage calculation
    const participantDataForPercentage = currentRound?.participants?.find(p => (p.user?._id === userId || p.user?.id === userId));
    const cumulativeValueForPercentage = participantDataForPercentage ? participantDataForPercentage.itemsValue : valueOfThisDeposit;
    const currentTotalPotValue = Math.max(0.01, currentRound?.totalValue || 0.01);
    const percentage = ((cumulativeValueForPercentage / currentTotalPotValue) * 100).toFixed(1);

    const depositContainer = document.createElement('div');
    depositContainer.dataset.userId = userId;
    depositContainer.className = 'player-deposit-container player-deposit-new';

    const depositHeader = document.createElement('div');
    depositHeader.className = 'player-deposit-header';
    depositHeader.innerHTML = `
        <img src="${avatar}" alt="${username}" class="player-avatar" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-avatar.png';" style="border-color: ${userColor};">
        <div class="player-info">
            <div class="player-name" title="${username}">${username}</div>
            <div class="player-deposit-value" style="color: ${userColor}" title="Total Deposited: $${cumulativeValueForPercentage.toFixed(2)} | Chance: ${percentage}%">
                $${valueOfThisDeposit.toFixed(2)} | ${percentage}% 
            </div>
        </div>`;
        // Display valueOfThisDeposit in the main text, but full chance based on total contribution.

    const itemsGrid = document.createElement('div');
    itemsGrid.className = 'player-items-grid';

    if (itemsInThisDeposit.length > 0) {
        itemsInThisDeposit.sort((a, b) => (b.price || 0) - (a.price || 0));
        const displayItems = itemsInThisDeposit.slice(0, CONFIG.MAX_ITEMS_PER_DEPOSIT);
        displayItems.forEach(item => {
            if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.image) {
                console.warn("Skipping invalid item in deposit display:", item);
                return;
            }
            const itemElement = document.createElement('div');
            itemElement.className = 'player-deposit-item';
            itemElement.title = `$${item.price.toFixed(2)}`;
            itemElement.style.borderColor = userColor;
            itemElement.innerHTML = `
                <img src="${item.image}" alt="Skin Image" class="player-deposit-item-image" loading="lazy"
                     onerror="this.onerror=null; this.src='/img/default-item.png';">
                <div class="player-deposit-item-info">
                    <div class="player-deposit-item-value" style="color: ${userColor}">$${item.price.toFixed(2)}</div>
                </div>`;
            itemsGrid.appendChild(itemElement);
        });
        if (itemsInThisDeposit.length > CONFIG.MAX_ITEMS_PER_DEPOSIT) {
            const moreItems = document.createElement('div');
            moreItems.className = 'player-deposit-item-more';
            moreItems.style.color = userColor;
            moreItems.textContent = `+${itemsInThisDeposit.length - CONFIG.MAX_ITEMS_PER_DEPOSIT} more`;
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


function handleNewDeposit(data) {
    // This function now primarily updates currentRound and calls display functions
    if (!data || !data.roundId || !data.userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue) || data.totalValue === undefined || data.tickets === undefined) {
        console.error("Invalid participant update data received:", data); return;
    }
    if (!data.depositedItems) data.depositedItems = [];

    if (!currentRound) {
        // This case should ideally be handled by server sending full 'roundData' on connect or if client is out of sync.
        currentRound = { roundId: data.roundId, status: 'active', timeLeft: CONFIG.ROUND_DURATION, totalValue: 0, participants: [], items: [] };
        console.warn("Handling deposit for non-existent local round. Initializing round with received data.");
    } else if (currentRound.roundId !== data.roundId) {
        console.warn(`Deposit received for wrong round (${data.roundId}). Current is ${currentRound.roundId}. Ignoring.`); return;
    }

    if (!currentRound.participants) currentRound.participants = [];
    if (!currentRound.items) currentRound.items = [];

    // Clear pending offer flag for the user who just deposited, if it matches
    if (currentUser && currentUser.pendingDepositOfferId && (currentUser._id === data.userId || currentUser.id === data.userId)) {
       console.log(`Deposit processed for user ${currentUser.username}, clearing local pending offer flag.`);
       currentUser.pendingDepositOfferId = null; // Clear the flag
       updateUserUI(); // Update header indicator
       updateDepositButtonState(); // Re-enable deposit button if applicable
       if (DOMElements.deposit.depositModal?.style.display === 'flex') {
           resetDepositModalUI(); // Reset its state (e.g., hide "Accept on Steam" button)
       }
    }

    // Update or add participant in currentRound.participants
    let participantIndex = currentRound.participants.findIndex(p => p.user?._id === data.userId || p.user?.id === data.userId);

    if (participantIndex !== -1) { // Existing participant
        // The backend should send the new *total* itemsValue and tickets for the user in the round.
        // data.itemsValue from 'participantUpdated' should be the new total for the user.
        currentRound.participants[participantIndex].itemsValue = data.participantTotalValueInRound || (currentRound.participants[participantIndex].itemsValue + data.itemsValue); // Prefer explicit total from backend
        currentRound.participants[participantIndex].tickets = data.tickets; // This should be the new total tickets
    } else { // New participant
        currentRound.participants.push({
            user: { _id: data.userId, id: data.userId, username: data.username || 'Unknown User', avatar: data.avatar || '/img/default-avatar.png' },
            itemsValue: data.itemsValue, // Initial total value for new participant
            tickets: data.tickets
        });
    }

    currentRound.totalValue = data.totalValue; // Update total pot value from server based on this deposit
    // Add items from this specific deposit to the round's master item list (for roulette etc.)
    data.depositedItems.forEach(item => {
        if (item && typeof item.price === 'number' && !isNaN(item.price)) {
            currentRound.items.push({ ...item, owner: data.userId });
        } else {
            console.warn("Skipping invalid item while adding to round master list:", item);
        }
    });

    updateRoundUI(); // Update overall pot value and participant count display
    displayLatestDeposit(data); // Display this specific deposit event
    updateAllParticipantPercentages(); // Recalculate for all displayed participants based on updated currentRound
    updateDepositButtonState(); // Re-evaluate if deposit button should be enabled/disabled

    // Start client-side timer if it's the first participant and timer isn't active
    if (currentRound.status === 'active' && currentRound.participants.length === 1 && !timerActive) {
        console.log("First participant joined. Starting client timer visually.");
        timerActive = true;
        startClientTimer(currentRound.timeLeft || CONFIG.ROUND_DURATION);
    }
}


// --- Remaining functions (updateParticipantsUI, startClientTimer, roulette, provably fair, etc.)
// These functions would largely remain the same as in the provided "original" file,
// as they handle UI updates based on the `currentRound` state which is now correctly managed.
// For brevity, I'll skip re-pasting them unless specific changes were requested for them.
// Assume they are correctly implemented as before.

// ... (updateParticipantsUI, startClientTimer, createRouletteItems, handleWinnerAnnouncement, etc. are here) ...
// ... (provablyFair functions, loadPastRounds, createPagination, etc. are here) ...

// --- Chat Functions (Modified for Persistence) ---
function saveChatHistory() {
    try {
        // Store only the last CONFIG.MAX_CHAT_MESSAGES
        const messagesToStore = chatMessages.slice(0, CONFIG.MAX_CHAT_MESSAGES);
        localStorage.setItem(CONFIG.CHAT_LOCAL_STORAGE_KEY, JSON.stringify(messagesToStore));
    } catch (e) {
        console.warn("Could not save chat history to localStorage (possibly full or disabled):", e);
    }
}

function loadChatHistory() {
    const { messagesContainer } = DOMElements.chat;
    if (!messagesContainer) return;
    try {
        const storedHistory = localStorage.getItem(CONFIG.CHAT_LOCAL_STORAGE_KEY);
        if (storedHistory) {
            chatMessages = JSON.parse(storedHistory);
            if (!Array.isArray(chatMessages)) chatMessages = [];
            // Ensure it doesn't exceed max on load (though saveChatHistory should handle this)
            if (chatMessages.length > CONFIG.MAX_CHAT_MESSAGES) {
                chatMessages = chatMessages.slice(0, CONFIG.MAX_CHAT_MESSAGES);
            }
        } else {
            chatMessages = [];
        }
    } catch (e) {
        console.warn("Could not load chat history from localStorage:", e);
        chatMessages = [];
    }
    messagesContainer.innerHTML = ''; // Clear current messages
    // Display messages from history (oldest first visually, so iterate normally and prepend)
    chatMessages.slice().reverse().forEach(msgData => displayChatMessage(msgData, true));
}


function displayChatMessage(messageData, isFromHistory = false) {
    const { messagesContainer } = DOMElements.chat;
    if (!messagesContainer) return;

    const { type = 'user', username, avatar, message, userId, userSteamId } = messageData;

    const messageElement = document.createElement('div');
    messageElement.classList.add('chat-message');
    if (userId) messageElement.dataset.userId = userId;
    if (userSteamId) messageElement.dataset.userSteamId = userSteamId;

    if (type === 'system') {
        messageElement.classList.add('system-message');
        messageElement.textContent = message;
        if (isFromHistory) messageElement.style.animation = 'none';
    } else {
        const userAvatarSrc = avatar || '/img/default-avatar.png';
        const displayName = username || 'Anonymous';
        const userColor = getUserColor(userId || 'system-user');

        messageElement.innerHTML = `
            <img src="${userAvatarSrc}" alt="${displayName}" class="chat-message-avatar" style="border-color: ${userColor};">
            <div class="chat-message-content">
                <span class="chat-message-user" style="color: ${userColor};">${displayName}</span>
                <p class="chat-message-text"></p>
            </div>
        `;
        const textElement = messageElement.querySelector('.chat-message-text');
        if (textElement) textElement.textContent = message; // Use textContent to prevent XSS
        if (isFromHistory) messageElement.style.animation = 'none'; // No animation for history items
    }

    // Add new message to the top (due to flex-direction: column-reverse)
    messagesContainer.insertBefore(messageElement, messagesContainer.firstChild);

    // Manage message array for localStorage and limit display
    if (!isFromHistory) { // Only add to array if it's a new message
        chatMessages.unshift(messageData); // Add to the beginning
        // Trim chatMessages array if it exceeds the max length
        while (chatMessages.length > CONFIG.MAX_CHAT_MESSAGES) {
            chatMessages.pop(); // Remove the oldest message from the array
        }
        saveChatHistory(); // Save updated history
    }

    // Trim visual display in the DOM
    while (messagesContainer.children.length > CONFIG.MAX_CHAT_MESSAGES) {
        messagesContainer.removeChild(messagesContainer.lastChild); // Remove oldest from DOM
    }
}

function handleSendMessage() {
    const { messageInput, sendMessageBtn } = DOMElements.chat;
    if (!messageInput || !currentUser || isChatSendOnCooldown) return;
    const messageText = messageInput.value.trim();
    if (messageText) {
        socket.emit('chatMessage', messageText);
        messageInput.value = '';
        isChatSendOnCooldown = true;
        if (sendMessageBtn) {
            sendMessageBtn.disabled = true;
            const originalText = sendMessageBtn.textContent;
            let countdown = Math.floor(CONFIG.CHAT_SEND_COOLDOWN_MS / 1000);
            sendMessageBtn.textContent = `Wait ${countdown}s`;
            const intervalId = setInterval(() => {
                countdown--;
                if (countdown > 0) {
                    sendMessageBtn.textContent = `Wait ${countdown}s`;
                } else {
                    clearInterval(intervalId);
                    sendMessageBtn.textContent = originalText;
                    isChatSendOnCooldown = false;
                    if(currentUser) sendMessageBtn.disabled = false;
                }
            }, 1000);
        }
        setTimeout(() => { // Fallback to re-enable button
            isChatSendOnCooldown = false;
            if(currentUser && sendMessageBtn && !sendMessageBtn.textContent.startsWith("Wait")) {
                 sendMessageBtn.disabled = false;
            }
        }, CONFIG.CHAT_SEND_COOLDOWN_MS);
    }
}

function setupChatEventListeners() {
    const { messageInput, sendMessageBtn } = DOMElements.chat;
    sendMessageBtn?.addEventListener('click', handleSendMessage);
    messageInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });
}

function updateChatOnlineUsers(count) {
    onlineUserCount = count;
    const { onlineUsers } = DOMElements.chat;
    if (onlineUsers) {
        onlineUsers.textContent = onlineUserCount;
    }
}

function updateChatUI() {
    const { messageInput, sendMessageBtn, onlineUsers } = DOMElements.chat;
    if (currentUser) {
        if (messageInput) {
            messageInput.disabled = false;
            messageInput.placeholder = 'Type your message...';
        }
        if (sendMessageBtn) sendMessageBtn.disabled = isChatSendOnCooldown;
    } else {
        if (messageInput) {
            messageInput.disabled = true;
            messageInput.placeholder = 'Sign in to chat';
        }
        if (sendMessageBtn) sendMessageBtn.disabled = true;
    }
    if (onlineUsers) onlineUsers.textContent = onlineUserCount;
}

// --- Winning History Functions (Modified) ---
async function loadWinningHistory() {
    const modalElements = DOMElements.winningHistoryModal;
    if (!currentUser) {
        showNotification("Please log in to view your winning history.", "info");
        return;
    }
    showModal(modalElements.modal);
    modalElements.loadingIndicator.style.display = 'flex';
    modalElements.tableContainer.style.display = 'none';
    modalElements.noWinningsMessage.style.display = 'none';
    modalElements.tableBody.innerHTML = '';

    try {
        const response = await fetch('/api/user/winning-history');
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: `Failed to load winning history (${response.status})` }));
            throw new Error(errorData.error || `Failed to load winning history (${response.status})`);
        }
        const history = await response.json();

        modalElements.loadingIndicator.style.display = 'none';
        if (!history || history.length === 0) {
            modalElements.noWinningsMessage.style.display = 'block';
            modalElements.tableContainer.style.display = 'none';
        } else {
            modalElements.noWinningsMessage.style.display = 'none';
            modalElements.tableContainer.style.display = 'block';
            history.forEach(win => populateWinningHistoryRow(win));
        }
    } catch (error) {
        console.error("Error loading winning history:", error);
        modalElements.loadingIndicator.style.display = 'none';
        modalElements.tableContainer.style.display = 'block';
        modalElements.tableBody.innerHTML = `<tr><td colspan="4" class="error-message">Error: ${error.message}</td></tr>`;
        modalElements.noWinningsMessage.style.display = 'none';
    }
}

function populateWinningHistoryRow(win) {
    const tableBody = DOMElements.winningHistoryModal.tableBody;
    const row = tableBody.insertRow();

    row.insertCell().textContent = win.gameId || 'N/A';
    row.insertCell().textContent = win.dateWon ? new Date(win.dateWon).toLocaleString() : 'N/A';
    row.insertCell().textContent = `$${(win.amountWon || 0).toFixed(2)}`;

    const statusCell = row.insertCell();
    statusCell.style.textAlign = 'center';

    let tradeLinkHTML = '';
    const offerId = win.tradeOfferId;
    // Prefer constructing web link if possible, fallback to steam:// protocol if that's what's stored directly
    const steamOfferWebLink = offerId ? `https://steamcommunity.com/tradeoffer/${offerId}/` : null;
    const directTradeLink = win.tradeLink; // This might be a steam:// link or a web link

    switch (win.tradeStatus) {
        case 'accepted':
        case 'accepted_escrow':
            tradeLinkHTML = `<span class="trade-status accepted"><i class="fas fa-check-circle"></i> Accepted</span>`;
            if (win.tradeStatus === 'accepted_escrow') tradeLinkHTML += ` <small>(Escrow)</small>`;
            break;
        case 'pending_send': // Bot is preparing to send
            tradeLinkHTML = `<span class="trade-status pending"><i class="fas fa-spinner fa-spin"></i> Sending...</span>`;
            break;
        case 'sent': // Offer sent, awaiting user action
        case 'pending_confirmation': // Bot sent, but needs internal confirmation (less common for user view)
            if (steamOfferWebLink) {
                tradeLinkHTML = `<a href="${steamOfferWebLink}" class="trade-link pending" target="_blank" rel="noopener noreferrer" title="View offer #${offerId} on Steam">Offer Sent <i class="fas fa-external-link-alt"></i></a>`;
            } else if (directTradeLink) { // Fallback if only steam:// link is available
                tradeLinkHTML = `<a href="${directTradeLink}" class="trade-link pending" target="_blank" rel="noopener noreferrer" title="Open offer #${offerId}">Offer Sent <i class="fas fa-external-link-alt"></i></a>`;
            } else {
                tradeLinkHTML = `<span class="trade-status pending">Offer Sent (Check Steam)</span>`;
            }
            break;
        case 'declined':
            tradeLinkHTML = `<span class="trade-status failed">Offer Declined</span>`;
            break;
        case 'cancelled':
        case 'canceled':
            tradeLinkHTML = `<span class="trade-status failed">Offer Cancelled</span>`;
            break;
        case 'expired':
            tradeLinkHTML = `<span class="trade-status failed">Offer Expired</span>`;
            break;
        case 'error':
        case 'error_bot_offline':
        case 'error_no_tradelink':
        case 'error_no_items':
        case 'error_creating_offer':
        case 'failed_steam_error':
        case 'failed_invalid_tradelink':
        case 'failed_inventory_issue':
             tradeLinkHTML = `<span class="trade-status failed" title="${win.tradeStatus || 'Error processing trade'}">Error Processing</span>`;
            break;
        default:
            tradeLinkHTML = `<span class="trade-status">${win.tradeStatus ? win.tradeStatus.charAt(0).toUpperCase() + win.tradeStatus.slice(1) : 'Unknown'}</span>`;
    }
    statusCell.innerHTML = tradeLinkHTML;
}
// --- End Winning History Functions ---


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
        updateChatOnlineUsers(0);
    });
    socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
        showNotification('Connection Error. Please refresh.', 'error', 10000);
        updateDepositButtonState();
    });
    socket.on('roundCreated', (data) => {
        console.log('New round created:', data); currentRound = data;
        resetToJackpotView();
        updateRoundUI();
        updateDepositButtonState();
    });
    socket.on('participantUpdated', (data) => { // This event should provide the updated total value for the participant and the pot
        console.log('Participant updated:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            // The backend should ideally send the *full updated participant object* or enough data
            // for the frontend to correctly update its `currentRound.participants` array.
            // For now, we assume `handleNewDeposit` can correctly process `data`.
            handleNewDeposit(data);
        } else if (!currentRound && data.roundId) {
            console.warn("Participant update for unknown round. Requesting full round data.");
            socket.emit('requestRoundData');
        }
    });
    socket.on('roundRolling', (data) => {
        console.log('Round rolling event received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            timerActive = false; if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
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
        } else console.warn("Received winner for mismatched round ID. Current:", currentRound?.roundId, "Received:", data.roundId);
    });
    socket.on('roundCompleted', (data) => {
        console.log('Round completed event received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'completed';
            if(data.serverSeed) currentRound.serverSeed = data.serverSeed;
            if(data.clientSeed) currentRound.clientSeed = data.clientSeed;
            // Could also update totalPotValueForWinner if it's sent here.
        }
        updateDepositButtonState();
    });
    socket.on('roundError', (data) => {
        console.error('Round Error event received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'error';
            showNotification(`Round Error: ${data.error || 'Unknown error.'}`, 'error');
            updateDepositButtonState();
            resetToJackpotView();
        }
    });
    socket.on('roundData', (data) => { // For initial sync or manual request
        console.log('Received initial/updated round data:', data);
        if (!data || typeof data !== 'object') {
            console.error("Invalid round data received from server.");
            showNotification('Error syncing with server.', 'error');
             initiateNewRoundVisualReset(); return;
        }
        currentRound = data; // Overwrite local currentRound with comprehensive data from server
        updateRoundUI();
        updateDepositButtonState();

        // Re-render all participant deposits based on the full round data
        const container = DOMElements.jackpot.participantsContainer;
        if (container) {
            container.innerHTML = ''; // Clear previous blocks
            if (currentRound.participants && currentRound.participants.length > 0) {
                if (DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'none';
                // Create a map of items by their owner for easier lookup
                const itemsByOwner = new Map();
                if (currentRound.items) {
                    currentRound.items.forEach(item => {
                        const ownerId = item.owner?.toString() || item.owner; // Handle ObjectId or string
                        if (!itemsByOwner.has(ownerId)) itemsByOwner.set(ownerId, []);
                        itemsByOwner.get(ownerId).push(item);
                    });
                }

                currentRound.participants.forEach(p => {
                    if (p.user && (p.user._id || p.user.id)) {
                        const participantUserId = p.user._id || p.user.id;
                        // We need to simulate the `depositedItems` for displayLatestDeposit.
                        // This is tricky as `roundData` items aren't tied to specific *deposit events*
                        // but to the user's total contribution.
                        // For simplicity here, we'll just pass an empty array or a subset if available
                        // The main purpose is to show the participant block.
                        // A more complex solution would store each deposit event's items.
                        const itemsForThisDisplay = itemsByOwner.get(participantUserId.toString()) || [];

                        displayLatestDeposit({
                            roundId: currentRound.roundId,
                            userId: participantUserId,
                            username: p.user.username,
                            avatar: p.user.avatar,
                            itemsValue: p.itemsValue, // This is their total value
                            tickets: p.tickets,
                            totalValue: currentRound.totalValue, // Overall pot total
                            depositedItems: itemsForThisDisplay.slice(0,5) // Show some items, not necessarily just from one deposit event
                        });
                        // Remove animation from re-rendered blocks
                        const element = container.querySelector(`.player-deposit-container[data-user-id="${participantUserId}"]`);
                        if (element) element.classList.remove('player-deposit-new');
                    }
                });
                updateAllParticipantPercentages();
            } else {
                if (DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'block';
            }
        }


        if (currentRound.status === 'rolling' || currentRound.status === 'completed') {
             if (!isSpinning && currentRound.winner) {
                 console.log("Connected mid-round/post-completion with winner known, triggering animation/display.");
                 handleWinnerAnnouncement(currentRound);
             } else if (!isSpinning) {
                  console.log("Connected after round ended or is rolling without winner. Resetting view or waiting for winner.");
                  resetToJackpotView();
             }
        } else if (currentRound.status === 'active') {
             if (currentRound.participants?.length > 0 && currentRound.timeLeft > 0 && !timerActive) {
                 console.log(`Received active round data. Starting/syncing timer from ${currentRound.timeLeft}s.`);
                 timerActive = true; startClientTimer(currentRound.timeLeft);
             } else if (currentRound.timeLeft <= 0 && timerActive) {
                 console.log("Server data indicates time up, stopping client timer.");
                 timerActive = false; if (roundTimer) clearInterval(roundTimer); roundTimer = null;
                 updateTimerUI(0); updateDepositButtonState();
             } else if (currentRound.participants?.length === 0 && timerActive) {
                  console.log("Server data indicates no participants, stopping client timer.");
                  timerActive = false; if (roundTimer) clearInterval(roundTimer); roundTimer = null;
                  updateTimerUI(CONFIG.ROUND_DURATION); updateDepositButtonState();
             } else if (!timerActive) { // If timer wasn't active, just update display based on server time
                 updateTimerUI(currentRound.timeLeft);
             }
        } else if (currentRound.status === 'pending') {
            console.log("Received pending round state. Resetting visuals.");
            initiateNewRoundVisualReset();
            if(DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Waiting";
            updateDepositButtonState();
        } else if (!currentRound.status) { // Unspecified status
             console.warn("Received round data with no status. Resetting visuals.");
             initiateNewRoundVisualReset();
        }
    });

    socket.on('tradeOfferSent', (data) => {
         console.log('Trade offer sent event received:', data);
         if (currentUser && data.userId === (currentUser._id || currentUser.id) && data.offerURL) {
              showNotification(`Trade Offer Sent: <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">Click here to accept your winnings on Steam!</a> (#${data.offerId})`, 'success', 10000);
         } else if (currentUser && data.userId === (currentUser._id || currentUser.id)) {
              showNotification(`Trade Offer Sent: Check Steam for your winnings! (#${data.offerId})`, 'success', 8000);
         }
         // Potentially refresh winning history if modal is open
         if (DOMElements.winningHistoryModal.modal.style.display === 'flex') {
            loadWinningHistory();
        }
    });
    socket.on('notification', (data) => {
        console.log('Notification event received:', data);
        if (!data.userId || (currentUser && data.userId === (currentUser._id || currentUser.id))) {
            showNotification(data.message || 'Received notification from server.', data.type || 'info', data.duration || 4000);
        }
    });
    socket.on('chatMessage', (data) => {
        displayChatMessage(data);
    });
    socket.on('updateUserCount', (count) => {
        updateChatOnlineUsers(count);
    });
}

function setupEventListeners() {
    DOMElements.nav.homeLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.homePage); });
    DOMElements.nav.aboutLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.aboutPage); });
    DOMElements.nav.tosLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.tosPage); });
    DOMElements.nav.faqLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.faqPage); });
    DOMElements.nav.fairLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.fairPage); });
    DOMElements.user.loginButton?.addEventListener('click', () => {
        if (localStorage.getItem('ageVerified') === 'true') {
            window.location.href = '/auth/steam';
        } else {
            const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
            if(ageCheckbox) ageCheckbox.checked = false;
            if(ageAgreeButton) ageAgreeButton.disabled = true;
            showModal(DOMElements.ageVerification.modal);
        }
    });
    const { userProfile, userDropdownMenu, logoutButton, profileDropdownButton, winningHistoryDropdownButton } = DOMElements.user;
    userProfile?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (userDropdownMenu) {
            const isVisible = userDropdownMenu.style.display === 'block';
            userDropdownMenu.style.display = isVisible ? 'none' : 'block';
            userProfile?.setAttribute('aria-expanded', String(!isVisible));
            userProfile?.classList.toggle('open', !isVisible);
        }
    });
    userProfile?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }});
    logoutButton?.addEventListener('click', (e) => { e.stopPropagation(); handleLogout(); });
    logoutButton?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleLogout(); }});
    profileDropdownButton?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const menu = DOMElements.user.userDropdownMenu;
        const modal = DOMElements.profileModal.modal;
        if (currentUser && modal) {
            populateProfileModal(); showModal(modal);
        } else if (!currentUser) showNotification("Please log in to view your profile.", "info");
        else console.error("Profile modal element not found.");
        if (menu) menu.style.display = 'none';
        userProfile?.setAttribute('aria-expanded', 'false');
        userProfile?.classList.remove('open');
    });
    winningHistoryDropdownButton?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const menu = DOMElements.user.userDropdownMenu;
        if (currentUser) {
            loadWinningHistory();
        } else {
            showNotification("Please log in to view your winning history.", "info");
        }
        if (menu) menu.style.display = 'none';
        userProfile?.setAttribute('aria-expanded', 'false');
        userProfile?.classList.remove('open');
    });
    DOMElements.profileModal.saveBtn?.addEventListener('click', handleProfileSave);
    DOMElements.profileModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.profileModal.cancelBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.winningHistoryModal.closeBtnHeader?.addEventListener('click', () => hideModal(DOMElements.winningHistoryModal.modal));
    DOMElements.winningHistoryModal.closeBtnFooter?.addEventListener('click', () => hideModal(DOMElements.winningHistoryModal.modal));

    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => {
        const button = DOMElements.deposit.showDepositModalButton;
        if (button.disabled) {
            showNotification(button.title || 'Deposits are currently closed.', 'info'); return;
        }
        if (!currentUser) {
            showNotification('Login Required: Please log in first.', 'error'); return;
        }
         if (!currentUser.tradeUrl) {
             showNotification('Trade URL Required: Please open your profile (click your avatar) and set your Steam Trade URL before depositing.', 'error', 6000);
             if (DOMElements.profileModal.modal) {
                 populateProfileModal(); showModal(DOMElements.profileModal.modal);
             }
             return;
         }
        showModal(DOMElements.deposit.depositModal); loadUserInventory();
    });
    DOMElements.deposit.closeDepositModalButton?.addEventListener('click', () => hideModal(DOMElements.deposit.depositModal));
    DOMElements.deposit.depositButton?.addEventListener('click', requestDepositOffer);
    DOMElements.deposit.acceptDepositOfferBtn?.addEventListener('click', () => {
         if (currentDepositOfferURL) {
             window.open(currentDepositOfferURL, '_blank', 'noopener,noreferrer');
             const { depositStatusText } = DOMElements.deposit;
             if(depositStatusText) depositStatusText.textContent = "Check Steam tab for the offer...";
         } else {
             showNotification("Error: Could not find the trade offer URL.", "error");
         }
    });
    const { modal: ageModal, checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
    if (ageModal && ageCheckbox && ageAgreeButton) {
        ageCheckbox.addEventListener('change', () => { ageAgreeButton.disabled = !ageCheckbox.checked; });
        ageAgreeButton.addEventListener('click', () => {
            if (ageCheckbox.checked) {
                localStorage.setItem('ageVerified', 'true'); hideModal(ageModal);
                window.location.href = '/auth/steam';
            }
        });
        ageAgreeButton.disabled = !ageCheckbox.checked;
    }
    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound);
    window.addEventListener('click', (e) => {
        const profileModal = DOMElements.profileModal.modal;
        const winningHistoryModal = DOMElements.winningHistoryModal.modal;
        if (userDropdownMenu && userProfile && userDropdownMenu.style.display === 'block' &&
            !userProfile.contains(e.target) && !userDropdownMenu.contains(e.target)) {
            userDropdownMenu.style.display = 'none';
            userProfile.setAttribute('aria-expanded', 'false');
            userProfile.classList.remove('open');
        }
        if (e.target === DOMElements.deposit.depositModal) hideModal(DOMElements.deposit.depositModal);
        if (e.target === profileModal) hideModal(profileModal);
        if (e.target === winningHistoryModal) hideModal(winningHistoryModal);
    });
    document.addEventListener('keydown', function(event) {
        const profileModal = DOMElements.profileModal.modal;
        const depositModal = DOMElements.deposit.depositModal;
        const winningHistoryModal = DOMElements.winningHistoryModal.modal;
        if (event.key === 'Escape') {
             if (profileModal?.style.display === 'flex') hideModal(profileModal);
             else if (depositModal?.style.display === 'flex') hideModal(depositModal);
             else if (winningHistoryModal?.style.display === 'flex') hideModal(winningHistoryModal);
             else if (userDropdownMenu && userDropdownMenu.style.display === 'block') {
                 userDropdownMenu.style.display = 'none';
                 userProfile?.setAttribute('aria-expanded', 'false');
                 userProfile?.classList.remove('open');
                 userProfile?.focus();
             }
        }
    });
    setupChatEventListeners();
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
        statusDiv.style.display = 'none';
        statusDiv.innerHTML = '';
    }
}

async function handleProfileSave() {
    const { tradeUrlInput, saveBtn } = DOMElements.profileModal;
    if (!tradeUrlInput || !saveBtn || !currentUser) {
         showNotification("Not logged in or profile elements missing.", "error"); return;
    }
    const newTradeUrl = tradeUrlInput.value.trim();
    const urlPattern = /^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/i;
    if (newTradeUrl && !urlPattern.test(newTradeUrl)) {
        showNotification('Invalid Steam Trade URL format. Please check or leave empty to clear.', 'error', 6000); return;
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
        const response = await fetch('/api/user/tradeurl', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tradeUrl: newTradeUrl }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || `Failed to save trade URL (${response.status})`);
        currentUser.tradeUrl = newTradeUrl;
        showNotification(newTradeUrl ? 'Trade URL saved successfully!' : 'Trade URL cleared successfully!', 'success');
        updateDepositButtonState();
        hideModal(DOMElements.profileModal.modal);
    } catch (error) {
        console.error("Error saving trade URL:", error);
        showNotification(`Error saving Trade URL: ${error.message}`, 'error');
    } finally {
        saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
    }
}


document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed.");
    const ageVerified = localStorage.getItem('ageVerified') === 'true';
    checkLoginStatus(); // This also calls loadChatHistory and initializes selectedItemsList (if user exists)
    setupEventListeners();
    setupSocketConnection();
    showPage(DOMElements.pages.homePage);
    initiateNewRoundVisualReset();
    if (!ageVerified && DOMElements.ageVerification.modal) {
        const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
        if(ageCheckbox) ageCheckbox.checked = false;
        if(ageAgreeButton) ageAgreeButton.disabled = true;
        showModal(DOMElements.ageVerification.modal);
    }
    // updateChatUI() is called within checkLoginStatus
});

console.log("main.js updated with Winning History API call, deposit selection persistence, and chat enhancements.");
