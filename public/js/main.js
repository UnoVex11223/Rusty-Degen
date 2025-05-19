// main.js - Rust Jackpot Frontend Logic
// Modifications:
// - Added "Accept Winnings" modal functionality.
// - Added "Winning History" modal functionality.
// - Removed test functions (testRouletteAnimation, testDeposit) and associated UI.
// - Updated profile modal to display total deposited/won.
// - Removed display of skin names, showing only image and price.
// - Retained profile dropdown and modal logic from previous updates.
// - ADDED: Frontend chat functionality, integrated with socket.io.
// - REMOVED: "Details" button from Provably Fair round history.
// - ADDED: Frontend visual cooldown for chat send button.
// - APPLIED USER REQUESTED FIXES for issue 1 and issue 2.

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
    MAX_CHAT_MESSAGES: 10, // Max chat messages to display
    CHAT_SEND_COOLDOWN_MS: 2000, // Frontend visual cooldown for chat send button (e.g., 2 seconds)
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
    acceptWinningsModal: { // Added
        modal: document.getElementById('acceptWinningsModal'),
        closeBtn: document.getElementById('closeAcceptWinningsModal'),
        offerIdDisplay: document.getElementById('acceptWinningsOfferId'),
        statusText: document.getElementById('acceptWinningsStatusText'),
        acceptOnSteamBtn: document.getElementById('acceptWinningsOnSteamBtn'),
        closeFooterBtn: document.getElementById('acceptWinningsModalCloseFooterBtn')
    },
    winningHistoryModal: { // Added
        modal: document.getElementById('winningHistoryModal'),
        closeBtn: document.getElementById('closeWinningHistoryModal'),
        loadingIndicator: document.getElementById('winning-history-loading'),
        tableContainer: document.getElementById('winningHistoryTableContainer'),
        tableBody: document.getElementById('winningHistoryTableBody'),
        noWinningsMessage: document.getElementById('noWinningsMessage'),
        closeFooterBtn: document.getElementById('winningHistoryModalCloseFooterBtn')
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
let selectedItemsList = [];
let userInventory = [];
let isSpinning = false;
let timerActive = false;
let roundTimer = null;
let animationFrameId = null;
let userColorMap = new Map();
let notificationTimeout = null;
let spinStartTime = 0;
let currentDepositOfferURL = null;
let currentWinningsOfferURL = null; // Added
let pendingWinningsOffer = null; // Added for queued winnings when spinning
let onlineUserCount = 0;
let isChatSendOnCooldown = false;

function showModal(modalElement) {
    if (modalElement) modalElement.style.display = 'flex';
}

function hideModal(modalElement) {
    if (modalElement) modalElement.style.display = 'none';
    if (modalElement === DOMElements.deposit.depositModal) {
        resetDepositModalUI();
    }
    if (modalElement === DOMElements.acceptWinningsModal.modal) { // Added
        resetAcceptWinningsModalUI();
    }
}
window.hideModal = hideModal; // Make it globally accessible

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
    bar.innerHTML = message;
    bar.className = 'notification-bar';
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
        const response = await fetch('/logout', {
            method: 'POST',
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
        currentUser = null;
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

function resetDepositModalUI() {
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit;
    if (depositButton) {
        depositButton.disabled = selectedItemsList.length === 0;
        depositButton.style.display = 'inline-block';
        depositButton.textContent = 'Request Deposit Offer';
    }
    if (acceptDepositOfferBtn) {
        acceptDepositOfferBtn.style.display = 'none';
        acceptDepositOfferBtn.removeAttribute('data-offer-url');
    }
    if (depositStatusText) {
        depositStatusText.textContent = '';
        depositStatusText.className = 'deposit-status-text';
    }
    currentDepositOfferURL = null;
}

function resetAcceptWinningsModalUI() { // Added
    const { statusText, acceptOnSteamBtn, offerIdDisplay } = DOMElements.acceptWinningsModal;
    if (statusText) {
        statusText.textContent = '';
        statusText.className = 'deposit-status-text'; // Re-use class if suitable
    }
    if (acceptOnSteamBtn) {
        acceptOnSteamBtn.disabled = true;
        acceptOnSteamBtn.removeAttribute('data-offer-url');
    }
    if(offerIdDisplay) offerIdDisplay.textContent = '';
    currentWinningsOfferURL = null;
}

function processPendingWinningsOffer() { // Added
    if (!pendingWinningsOffer) return;
    const { offerURL, offerId, status } = pendingWinningsOffer;
    const { modal, offerIdDisplay, statusText, acceptOnSteamBtn } = DOMElements.acceptWinningsModal;
    currentWinningsOfferURL = offerURL;
    if (offerIdDisplay) offerIdDisplay.textContent = `Trade Offer ID: #${offerId}`;
    if (statusText) {
        statusText.textContent = `Status: ${status || 'Sent'}. Click below to accept.`;
        statusText.className = 'deposit-status-text info';
    }
    if (acceptOnSteamBtn) {
        acceptOnSteamBtn.disabled = false;
        acceptOnSteamBtn.setAttribute('data-offer-url', offerURL);
    }
    showModal(modal);
    pendingWinningsOffer = null;
}


function updateDepositButtonState() {
    const button = DOMElements.deposit.showDepositModalButton;
    if (!button) return;

    let disabled = false;
    let title = 'Deposit Rust skins into the pot';

    if (!currentUser) {
        disabled = true;
        title = 'Log in to deposit';
    } else if (currentUser.pendingDepositOfferId) {
         disabled = true;
         title = 'Accept or cancel your pending deposit offer first (check profile)';
    } else if (!currentUser.tradeUrl) {
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
    button.classList.toggle('deposit-disabled', disabled);
}

async function checkLoginStatus() {
    try {
        const response = await fetch('/api/user');
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                currentUser = null;
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
        console.error("Inventory DOM elements missing.");
        return;
    }

    resetDepositModalUI();
    selectedItemsList = [];
    selectedItemsContainer.innerHTML = '';
    updateTotalValue();

    inventoryLoadingIndicator.style.display = 'flex';
    inventoryItemsContainer.innerHTML = '';

    try {
        const response = await fetch('/api/inventory');
        if (!response.ok) {
            let errorMsg = 'Inventory load failed.';
            try {
                const errorData = await response.json();
                errorMsg = errorData.error || `Inventory load failed (${response.status})`;
            } catch (e) { /* Ignore */ }
            if (response.status === 401 || response.status === 403) errorMsg = 'Please log in first.';
            throw new Error(errorMsg);
        }
        userInventory = await response.json();
        inventoryLoadingIndicator.style.display = 'none';

        if (!Array.isArray(userInventory)) throw new Error('Invalid inventory data received.');

        if (userInventory.length === 0) {
            inventoryItemsContainer.innerHTML = '<p class="empty-inventory-message">Inventory empty or unavailable. Ensure it\'s public on Steam.</p>';
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
    container.innerHTML = '';

    userInventory.forEach(item => {
        if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.assetId || !item.image) {
            console.warn("Skipping invalid inventory item:", item);
            return;
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
        selectedItemsList.push(item);
        element.classList.add('selected');
        addSelectedItemElement(item);
    } else {
        selectedItemsList.splice(index, 1);
        element.classList.remove('selected');
        removeSelectedItemElement(assetId);
    }
    updateTotalValue();
    resetDepositModalUI();
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
            removeSelectedItem(assetIdToRemove);
            updateTotalValue();
            resetDepositModalUI();
        }
    });

    selectedElement.addEventListener('click', () => {
        removeSelectedItem(item.assetId);
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
            resetDepositModalUI();
        }
        if (currentUser && currentUser.pendingDepositOfferId && !(response && response.status === 409)) {
            console.log("Clearing potentially stale pending offer ID due to error.");
            currentUser.pendingDepositOfferId = null; updateUserUI(); updateDepositButtonState();
        }
    }
}

// main.js - Rust Jackpot Frontend Logic - Part 2 of 2

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
    const value = data.itemsValue;
    const items = data.depositedItems || [];
    const userColor = getUserColor(userId);

    const participantData = currentRound?.participants?.find(p => (p.user?._id === userId || p.user?.id === userId));
    const cumulativeValue = participantData ? participantData.itemsValue : value;
    const currentTotalPotValue = Math.max(0.01, currentRound?.totalValue || 0.01);
    const percentage = ((cumulativeValue / currentTotalPotValue) * 100).toFixed(1);

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

function handleNewDeposit(data) {
    if (!data || !data.roundId || !data.userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue) || data.totalValue === undefined || data.tickets === undefined) {
        console.error("Invalid participant update data received:", data);
        return;
    }
    if (!data.depositedItems) data.depositedItems = [];

    if (!currentRound) {
        currentRound = { roundId: data.roundId, status: 'active', timeLeft: CONFIG.ROUND_DURATION, totalValue: 0, participants: [], items: [] };
        console.warn("Handling deposit for non-existent local round. Initializing round with received data.");
    } else if (currentRound.roundId !== data.roundId) {
        console.warn(`Deposit received for wrong round (${data.roundId}). Current is ${currentRound.roundId}. Ignoring.`);
        return;
    }

    if (!currentRound.participants) currentRound.participants = [];
    if (!currentRound.items) currentRound.items = [];

    if (currentUser && currentUser.pendingDepositOfferId && (currentUser._id === data.userId || currentUser.id === data.userId)) {
       console.log(`Deposit processed for user ${currentUser.username}, clearing local pending offer flag.`);
       currentUser.pendingDepositOfferId = null;
       updateUserUI();
       updateDepositButtonState();
       if (DOMElements.deposit.depositModal?.style.display === 'flex') {
           resetDepositModalUI();
           selectedItemsList = [];
           if(DOMElements.deposit.selectedItemsContainer) DOMElements.deposit.selectedItemsContainer.innerHTML = '';
           updateTotalValue();
       }
    }

    let participantIndex = currentRound.participants.findIndex(p => p.user?._id === data.userId || p.user?.id === data.userId);

    if (participantIndex !== -1) {
        currentRound.participants[participantIndex] = {
            ...currentRound.participants[participantIndex],
            itemsValue: data.itemsValue, // Backend now sends updated total itemsValue for participant
            tickets: data.tickets
        };
    } else {
        currentRound.participants.push({
            user: { _id: data.userId, id: data.userId, username: data.username || 'Unknown User', avatar: data.avatar || '/img/default-avatar.png' },
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
    updateAllParticipantPercentages();
    updateDepositButtonState();

    if (currentRound.status === 'active' && currentRound.participants.length === 1 && !timerActive) {
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
        console.error("Participants count/empty message/container elements missing for UI update.");
        return;
    }

    const participantNum = currentRound?.participants?.length || 0;
    participantCount.textContent = `${participantNum}/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
    const hasDepositBlocks = container.querySelector('.player-deposit-container') !== null;

    if (!hasDepositBlocks && participantNum === 0) {
        emptyMsg.style.display = 'block';
        if (!container.contains(emptyMsg)) {
            container.appendChild(emptyMsg);
        }
    } else {
        emptyMsg.style.display = 'none';
    }
}


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
            clearInterval(roundTimer); roundTimer = null;
            console.log("Client timer interval stopped (timerActive is false).");
            return;
        }
        timeLeft--;
        if (currentRound) currentRound.timeLeft = timeLeft;
        updateTimerUI(timeLeft);
        updateDepositButtonState();
        if (timeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null; timerActive = false;
            console.log("Client timer reached zero.");
            if (timerDisplay) timerDisplay.textContent = "0";
            updateDepositButtonState();
        }
    }, 1000);
}


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
    const targetVisualBlocks = 150;
    if (totalTicketsInRound <= 0) {
        console.warn("Total tickets in round is zero. Building roulette based on value percentage.");
        const totalValueNonZero = Math.max(0.01, currentRound.totalValue || 0.01);
        currentRound.participants.forEach(p => {
            const visualBlocks = Math.max(3, Math.ceil(((p.itemsValue || 0) / totalValueNonZero) * targetVisualBlocks));
            for (let i = 0; i < visualBlocks; i++) ticketPool.push(p);
        });
    } else {
        currentRound.participants.forEach(p => {
            const tickets = p.tickets || 0;
            const visualBlocksForUser = Math.max(3, Math.ceil((tickets / totalTicketsInRound) * targetVisualBlocks));
            for (let i = 0; i < visualBlocksForUser; i++) ticketPool.push(p);
        });
    }

    if (ticketPool.length === 0) {
        console.error("Ticket pool calculation resulted in zero items for roulette.");
        track.innerHTML = '<div class="roulette-message">Error building roulette items.</div>';
        return;
    }

    ticketPool = shuffleArray([...ticketPool]);
    const rouletteInnerContainer = container.querySelector('.roulette-container');
    const containerWidth = rouletteInnerContainer?.offsetWidth || container.offsetWidth || 1000;
    const itemWidthWithMargin = 60 + 10;
    const itemsInView = Math.ceil(containerWidth / itemWidthWithMargin);
    const itemsForSpinBuffer = 400;
    const totalItemsNeededForAnimation = itemsForSpinBuffer + (itemsInView * 2);
    const itemsToCreate = Math.max(totalItemsNeededForAnimation, 500);
    console.log(`Targeting ${itemsToCreate} roulette items for smooth animation.`);

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < itemsToCreate; i++) {
        const participant = ticketPool[i % ticketPool.length];
        if (!participant || !participant.user) {
            console.warn(`Skipping roulette item creation at index ${i} due to invalid participant data.`);
            continue;
        }
        const userId = participant.user._id || participant.user.id;
        const userColor = getUserColor(userId);
        const avatar = participant.user.avatar || '/img/default-avatar.png';

        const itemElement = document.createElement('div');
        itemElement.className = 'roulette-item';
        itemElement.dataset.userId = userId;
        itemElement.style.borderColor = userColor;
        itemElement.innerHTML = `
            <img class="roulette-avatar" src="${avatar}" alt="Participant Avatar" loading="lazy"
                 onerror="this.onerror=null; this.src='/img/default-avatar.png';" >`;
        fragment.appendChild(itemElement);
    }
    track.appendChild(fragment);
    console.log(`Created ${track.children.length} items for roulette animation.`);
}


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
    const winnerId = winnerDetails?.id || winnerDetails?._id;
    if (!winnerId) {
        console.error("Invalid winner data received in announcement:", data);
        resetToJackpotView();
        return;
    }

    console.log(`Winner announced: ${winnerDetails.username}. Preparing roulette...`);
    if (timerActive) {
        timerActive = false; clearInterval(roundTimer); roundTimer = null;
        console.log("Stopped client timer due to winner announcement.");
    }

    switchToRouletteView();
    setTimeout(() => {
        startRouletteAnimation({ winner: winnerDetails });
    }, 500);
}


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
    rouletteContainer.style.display = 'flex';
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


function startRouletteAnimation(winnerData) {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId); animationFrameId = null;
        console.log("Cancelled previous animation frame.");
    }

    const winnerId = winnerData?.winner?.id || winnerData?.winner?._id;
    if (!winnerId) {
        console.error("Invalid winner data passed to startRouletteAnimation.");
        resetToJackpotView(); return;
    }

    isSpinning = true; updateDepositButtonState(); spinStartTime = 0;
    if (DOMElements.roulette.winnerInfoBox) DOMElements.roulette.winnerInfoBox.style.display = 'none';
    clearConfetti();
    createRouletteItems();

    const winnerParticipantData = findWinnerFromData(winnerData);
    if (!winnerParticipantData) {
        console.error('Could not find full winner details in startRouletteAnimation.');
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    console.log('Starting animation for Winner:', winnerParticipantData.user.username);
    const sound = DOMElements.audio.spinSound;
    if (sound) {
        sound.volume = 0.7; sound.currentTime = 0; sound.playbackRate = 1.0;
        sound.play().catch(e => console.error('Error playing spin sound:', e));
    } else {
        console.warn("Spin sound element not found.");
    }

    setTimeout(() => {
        const track = DOMElements.roulette.rouletteTrack;
        const items = track?.querySelectorAll('.roulette-item');
        if (!track || !items || items.length === 0) {
            console.error('Cannot spin, no items rendered on track.');
            isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
        }

        const minIndexPercent = 0.65, maxIndexPercent = 0.85;
        const minIndex = Math.floor(items.length * minIndexPercent);
        const maxIndex = Math.floor(items.length * maxIndexPercent);

        let winnerItemsIndices = [];
        for (let i = minIndex; i <= maxIndex; i++) {
            if (items[i]?.dataset?.userId === winnerId) winnerItemsIndices.push(i);
        }
        if (winnerItemsIndices.length === 0) {
            console.warn(`No winner items found in preferred range [${minIndex}-${maxIndex}]. Expanding search.`);
            for (let i = 0; i < items.length; i++) {
                 if (items[i]?.dataset?.userId === winnerId) winnerItemsIndices.push(i);
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
        console.log(`Selected winning element at index ${targetIndex} of ${items.length} total items for user ${winnerParticipantData.user.username}`);
        handleRouletteSpinAnimation(winningElement, winnerParticipantData);
    }, 100);
}


function handleRouletteSpinAnimation(winningElement, winner) {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer?.querySelector('.roulette-container');
    if (!winningElement || !track || !container) {
        console.error("Missing elements for roulette animation loop.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const containerWidth = container.offsetWidth;
    const itemWidth = winningElement.offsetWidth || 60;
    const itemOffsetLeft = winningElement.offsetLeft;
    const centerOffset = (containerWidth / 2) - (itemWidth / 2);
    const perfectCenterScrollPosition = -(itemOffsetLeft - centerOffset);
    const initialVariation = (Math.random() * 2 - 1) * (itemWidth * CONFIG.LANDING_POSITION_VARIATION);
    const maxAllowedAbsVariation = itemWidth * 0.49;
    let finalVariation;
    if (Math.abs(initialVariation) <= maxAllowedAbsVariation) {
        finalVariation = initialVariation;
    } else {
        finalVariation = Math.sign(initialVariation) * maxAllowedAbsVariation;
    }
    const targetScrollPosition = perfectCenterScrollPosition + finalVariation;
    const finalTargetPosition = targetScrollPosition;

    const startPosition = parseFloat(track.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1] || '0');
    const duration = CONFIG.SPIN_DURATION_SECONDS * 1000;
    const bounceDuration = CONFIG.BOUNCE_ENABLED ? 1200 : 0;
    const totalAnimationTime = duration + bounceDuration;
    const totalDistance = finalTargetPosition - startPosition;
    const overshootAmount = totalDistance * CONFIG.BOUNCE_OVERSHOOT_FACTOR;

    let startTime = performance.now(); spinStartTime = startTime;
    track.style.transition = 'none';

    function animateRoulette(timestamp) {
        if (!isSpinning) {
            console.log("Animation loop stopped: isSpinning false.");
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            animationFrameId = null; return;
        }
        const elapsed = timestamp - startTime;
        let currentPosition, animationFinished = false;

        if (elapsed <= duration) {
            const animationPhaseProgress = elapsed / duration;
            const easedProgress = easeOutAnimation(animationPhaseProgress);
            currentPosition = startPosition + totalDistance * easedProgress;
        } else if (CONFIG.BOUNCE_ENABLED && elapsed <= totalAnimationTime) {
            const bouncePhaseProgress = (elapsed - duration) / bounceDuration;
            const bounceDisplacementFactor = calculateBounce(bouncePhaseProgress);
            currentPosition = finalTargetPosition - (overshootAmount * bounceDisplacementFactor);
        } else {
            currentPosition = finalTargetPosition; animationFinished = true;
        }
        track.style.transform = `translateX(${currentPosition}px)`;

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


function finalizeSpin(winningElement, winner) {
    if ((!isSpinning && winningElement?.classList.contains('winner-highlight')) || !winningElement || !winner?.user) {
        console.log("FinalizeSpin called, but seems already finalized or data invalid.");
        if (isSpinning) {
            isSpinning = false; updateDepositButtonState();
            // processPendingWinningsOffer(); // Original line from file
            // USER REQUEST: The processPendingWinningsOffer should be in handleSpinEnd
        }
        return;
    }
    console.log("Finalizing spin: Applying highlight to winner element.");

    const winnerId = winner.user.id || winner.user._id;
    const userColor = getUserColor(winnerId);
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


function handleSpinEnd(winningElement, winner) {
    if (!winningElement || !winner?.user) {
        console.error("handleSpinEnd called with invalid data/element.");
        if (!isSpinning) return;
        isSpinning = false; updateDepositButtonState();
        // processPendingWinningsOffer(); // Original line from file
        // USER REQUEST: Logic below handles this
        resetToJackpotView();
        return;
    }
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }

    console.log("Handling spin end: Displaying winner info and confetti.");
    const { winnerInfoBox, winnerAvatar, winnerName, winnerDeposit, winnerChance } = DOMElements.roulette;

    if (winnerInfoBox && winnerAvatar && winnerName && winnerDeposit && winnerChance) {
        const winnerId = winner.user.id || winner.user._id;
        const userColor = getUserColor(winnerId);
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
        winnerInfoBox.style.display = 'flex';
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
                            isSpinning = false; updateDepositButtonState(); // Moved from original location per user request
                            // processPendingWinningsOffer(); // Original line from file

                            // USER REQUEST: Process any pending winnings offers
                            if (pendingWinningsOffer && pendingWinningsOffer.waitingForAnimation) {
                                console.log("Animation complete, processing pending winnings offer");
                                if (pendingWinningsOffer.offerURL) {
                                    showWinningsPopup(
                                        pendingWinningsOffer.offerURL,
                                        pendingWinningsOffer.offerId,
                                        pendingWinningsOffer.status
                                    );
                                }
                                pendingWinningsOffer = null;
                            }

                            console.log("isSpinning set to false after winner display/confetti.");
                            setTimeout(resetToJackpotView, CONFIG.WINNER_DISPLAY_DURATION);
                        }
                    }, typeDelay);
                }
            }, typeDelay);
        }, 500); // This 500ms timeout was already here
    } else {
        console.error("Winner info display elements missing. Cannot display winner details.");
        isSpinning = false; updateDepositButtonState();
        // processPendingWinningsOffer(); // Original line from file
        // USER REQUEST: Process any pending winnings offers if error occurs here as well
        if (pendingWinningsOffer && pendingWinningsOffer.waitingForAnimation) {
            console.log("Animation error path, processing pending winnings offer");
            if (pendingWinningsOffer.offerURL) {
                showWinningsPopup(
                    pendingWinningsOffer.offerURL,
                    pendingWinningsOffer.offerId,
                    pendingWinningsOffer.status
                );
            }
            pendingWinningsOffer = null;
        }
        resetToJackpotView();
    }
}


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
        confetti.className = 'confetti-piece';
        confetti.style.left = `${Math.random() * 100}%`;
        const animDuration = 2 + Math.random() * 3;
        const animDelay = Math.random() * 1.5;
        confetti.style.setProperty('--duration', `${animDuration}s`);
        confetti.style.setProperty('--delay', `${animDelay}s`);
        confetti.style.setProperty('--color', colors[Math.floor(Math.random() * colors.length)]);
        const size = Math.random() * 8 + 4;
        confetti.style.width = `${size}px`; confetti.style.height = `${size}px`;
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

function resetToJackpotView() {
    console.log("Resetting to jackpot view...");
    if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null;
    if (window.soundFadeInInterval) clearInterval(window.soundFadeInInterval); window.soundFadeInInterval = null;
    if (window.soundFadeOutInterval) clearInterval(window.soundFadeOutInterval); window.soundFadeOutInterval = null;
    if (window.typeDepositInterval) clearInterval(window.typeDepositInterval); window.typeDepositInterval = null;
    if (window.typeChanceInterval) clearInterval(window.typeChanceInterval); window.typeChanceInterval = null;
    if (roundTimer) clearInterval(roundTimer); roundTimer = null;

    timerActive = false; isSpinning = false; spinStartTime = 0;

    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer;
    const winnerInfoBox = DOMElements.roulette.winnerInfoBox;
    const track = DOMElements.roulette.rouletteTrack;

    if (!header || !rouletteContainer || !winnerInfoBox || !track) {
        console.error("Missing elements for resetToJackpotView. Cannot fully reset UI."); return;
    }

    const sound = DOMElements.audio.spinSound;
    if (sound) { sound.pause(); sound.currentTime = 0; sound.volume = 1.0; sound.playbackRate = 1.0; }

    rouletteContainer.style.transition = 'opacity 0.5s ease';
    rouletteContainer.style.opacity = '0';
    if (winnerInfoBox.style.display !== 'none') {
        winnerInfoBox.style.transition = 'opacity 0.3s ease';
        winnerInfoBox.style.opacity = '0';
    }
    clearConfetti();

    // USER REQUEST: Fix for Issue 1 - Clear deposited items after winning animation
    const container = DOMElements.jackpot.participantsContainer;
    if (container) {
        container.innerHTML = ''; // Completely clear the container
        // Reinsert empty message if needed
        const emptyMsg = DOMElements.jackpot.emptyPotMessage;
        if (emptyMsg) {
            container.appendChild(emptyMsg); //
            emptyMsg.style.display = 'block'; //
        }
    }

    // Reset the current round data to clear any lingering state
    if (currentRound) {
        currentRound.participants = []; //
        currentRound.items = []; //
        currentRound.totalValue = 0; //
    }
    updateParticipantsUI(); //


    setTimeout(() => {
        header.classList.remove('roulette-mode');
        track.style.transition = 'none'; track.style.transform = 'translateX(0)'; track.innerHTML = '';
        rouletteContainer.style.display = 'none';
        winnerInfoBox.style.display = 'none'; winnerInfoBox.style.opacity = ''; winnerInfoBox.style.animation = '';

        const valueDisplay = header.querySelector('.jackpot-value');
        const timerDisplay = header.querySelector('.jackpot-timer');
        const statsDisplay = header.querySelector('.jackpot-stats');

        [valueDisplay, timerDisplay, statsDisplay].forEach((el, index) => {
            if (el) {
                const computedStyle = window.getComputedStyle(el);
                el.style.display = computedStyle.display !== 'none' ? computedStyle.display : 'flex';
                el.style.opacity = '0';
                setTimeout(() => {
                    el.style.transition = 'opacity 0.5s ease';
                    el.style.opacity = '1';
                }, 50 + index * 50);
            }
        });
        initiateNewRoundVisualReset(); // This was already called, but seems appropriate after clearing specific round data
        updateDepositButtonState();
        if (socket?.connected) {
            console.log("Requesting fresh round data after reset to jackpot view.");
            socket.emit('requestRoundData');
        } else {
            console.warn("Socket not connected, skipping requestRoundData after reset.");
        }
    }, 500);
}


function initiateNewRoundVisualReset() {
    console.log("Initiating visual reset for new round display (or after a round ends).");
    updateTimerUI(CONFIG.ROUND_DURATION);
    if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.classList.remove('urgent-pulse', 'timer-pulse');
    if (roundTimer) clearInterval(roundTimer); roundTimer = null; timerActive = false;

    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (container && emptyMsg) {
        container.innerHTML = '';
        if (!container.contains(emptyMsg)) container.appendChild(emptyMsg);
        emptyMsg.style.display = 'block';
    }

    if (DOMElements.jackpot.potValue) DOMElements.jackpot.potValue.textContent = "$0.00";
    if (DOMElements.jackpot.participantCount) DOMElements.jackpot.participantCount.textContent = `0/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
    userColorMap.clear();
    updateDepositButtonState();
}


function findWinnerFromData(winnerData) {
    const winnerId = winnerData?.winner?.id || winnerData?.winner?._id;
    if (!winnerId) {
        console.error("Missing winner ID in findWinnerFromData:", winnerData);
        return null;
    }
    if (!currentRound || !currentRound.participants) {
        console.warn("Missing currentRound/participants data for findWinnerFromData. Using provided winner data as is.");
        if (winnerData.winner) return { user: { ...winnerData.winner }, percentage: 0, value: 0 };
        return null;
    }
    const winnerParticipant = currentRound.participants.find(p => p.user?._id === winnerId || p.user?.id === winnerId);
    if (!winnerParticipant) {
        console.warn(`Winner ID ${winnerId} not found in local participants. Using provided winner data.`);
        if (winnerData.winner) return { user: { ...winnerData.winner }, percentage: 0, value: 0 };
        return null;
    }
    const totalValue = Math.max(0.01, currentRound.totalValue || 0.01);
    const participantValue = winnerParticipant.itemsValue || 0;
    const percentage = (participantValue / totalValue) * 100;
    return {
        user: { ...(winnerParticipant.user) },
        percentage: percentage || 0,
        value: participantValue
    };
}


async function verifyRound() {
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationResultDisplay } = DOMElements.provablyFair;
    if (!roundIdInput || !serverSeedInput || !clientSeedInput || !verificationResultDisplay) {
        console.error("Verify form elements missing."); return;
    }
    const roundId = roundIdInput.value.trim(), serverSeed = serverSeedInput.value.trim(), clientSeed = clientSeedInput.value.trim();
    const resultEl = verificationResultDisplay;
    let validationError = null;

    if (!roundId || !serverSeed || !clientSeed) validationError = 'Please fill in all fields (Round ID, Server Seed, Client Seed).';
    else if (serverSeed.length !== 64 || !/^[a-f0-9]{64}$/i.test(serverSeed)) validationError = 'Invalid Server Seed format (should be 64 hexadecimal characters).';
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
            if (result.totalValue !== undefined) html += `<p><strong>Final Pot Value (After Tax):</strong> $${result.totalValue.toFixed(2)}</p>`;
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
        resultEl.style.display = 'block'; resultEl.className = 'verification-result error';
        resultEl.innerHTML = `<p>Verification Error: ${error.message}</p>`;
        console.error('Error verifying round:', error);
    }
}

async function loadPastRounds(page = 1) {
    const tableBody = DOMElements.provablyFair.roundsTableBody;
    const paginationContainer = DOMElements.provablyFair.roundsPagination;
    if (!tableBody || !paginationContainer) {
        console.warn("Rounds history table/pagination elements missing."); return;
    }
    try {
        tableBody.innerHTML = '<tr><td colspan="5" class="loading-message">Loading round history...</td></tr>';
        paginationContainer.innerHTML = '';
        const response = await fetch(`/api/rounds?page=${page}&limit=10`);
        if (!response.ok) throw new Error(`Failed to load round history (${response.status})`);
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
                        if (!isNaN(d.getTime())) date = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
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
                        <button class="btn btn-secondary btn-small btn-verify"
                                onclick="window.populateVerificationFields('${roundIdStr}', '${serverSeedStr}', '${clientSeedStr}')"
                                ${!round.serverSeed ? 'disabled title="Seed not revealed yet"' : ''}>
                            Verify
                        </button>
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

    const maxPagesToShow = 5;
    const createButton = (text, page, isActive = false, isDisabled = false, isEllipsis = false) => {
        if (isEllipsis) {
            const span = document.createElement('span');
            span.className = 'page-ellipsis'; span.textContent = '...'; return span;
        }
        const button = document.createElement('button');
        button.className = `page-button ${isActive ? 'active' : ''}`;
        button.textContent = text; button.disabled = isDisabled;
        if (!isDisabled && typeof page === 'number') button.addEventListener('click', (e) => { e.preventDefault(); loadPastRounds(page); });
        return button;
    };

    container.appendChild(createButton('« Prev', currentPage - 1, false, currentPage <= 1));

    if (totalPages <= maxPagesToShow) {
        for (let i = 1; i <= totalPages; i++) container.appendChild(createButton(i, i, i === currentPage));
    } else {
        let pages = []; pages.push(1);
        const rangePadding = Math.floor((maxPagesToShow - 3) / 2);
        let rangeStart = Math.max(2, currentPage - rangePadding);
        let rangeEnd = Math.min(totalPages - 1, currentPage + rangePadding);
        const rangeLength = rangeEnd - rangeStart + 1;
        const needed = (maxPagesToShow - 3);
        if (rangeLength < needed) {
             if (currentPage - rangeStart < rangeEnd - currentPage) rangeEnd = Math.min(totalPages - 1, rangeStart + needed -1);
             else rangeStart = Math.max(2, rangeEnd - needed + 1);
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

function displayChatMessage(messageData) {
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
        if (textElement) textElement.textContent = message;
    }
    messagesContainer.insertBefore(messageElement, messagesContainer.firstChild);
    while (messagesContainer.children.length > CONFIG.MAX_CHAT_MESSAGES) {
        messagesContainer.removeChild(messagesContainer.lastChild);
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
        setTimeout(() => {
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

async function loadWinningHistory() { // Added
    const { modal, tableBody, loadingIndicator, noWinningsMessage } = DOMElements.winningHistoryModal;
    if (!currentUser) {
        showNotification("Please log in to view your winning history.", "info");
        return;
    }
    showModal(modal);
    if (loadingIndicator) loadingIndicator.style.display = 'flex';
    if (tableBody) tableBody.innerHTML = '';
    if (noWinningsMessage) noWinningsMessage.style.display = 'none';

    try {
        const response = await fetch('/api/user/winning-history');
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Failed to load winning history.' }));
            throw new Error(errorData.error || `Failed to load history (${response.status})`);
        }
        const history = await response.json();

        if (loadingIndicator) loadingIndicator.style.display = 'none';

        if (!Array.isArray(history) || history.length === 0) {
            if (noWinningsMessage) noWinningsMessage.style.display = 'block';
            return;
        }

        history.forEach(win => {
            const row = tableBody.insertRow();
            row.insertCell().textContent = `#${win.gameId}`;

            let dateWonText = 'N/A';
            if (win.dateWon) {
                try {
                    const d = new Date(win.dateWon);
                    if (!isNaN(d.getTime())) dateWonText = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                } catch (e) { console.error("Error formatting date for winning history:", e); }
            }
            row.insertCell().textContent = dateWonText;
            row.insertCell().textContent = `$${(win.amountWon || 0).toFixed(2)}`;

            const tradeCell = row.insertCell();
            const offerId = win.tradeOfferId;
            const offerStatus = win.tradeStatus || 'Unknown';
            const offerURL = offerId ? `https://steamcommunity.com/tradeoffer/${offerId}/` : null;

            if (offerStatus === 'Accepted') {
                tradeCell.innerHTML = `<span class="trade-status accepted"><i class="fas fa-check-circle"></i> Accepted</span>`;
            } else if (offerURL && (offerStatus === 'Sent' || offerStatus === 'Escrow' || offerStatus === 'PendingConfirmation' || offerStatus === 'Unknown')) {
                tradeCell.innerHTML = `<a href="${offerURL}" target="_blank" rel="noopener noreferrer" class="trade-link pending" title="View trade offer on Steam">
                                          <i class="fas fa-external-link-alt"></i> View Offer (#${offerId})
                                      </a>`;
            } else if (offerStatus === 'No Items Won'){
                 tradeCell.innerHTML = `<span class="trade-status info"><i class="fas fa-info-circle"></i> No Items (Tax)</span>`;
            }
            else {
                tradeCell.innerHTML = `<span class="trade-status ${offerStatus.toLowerCase().includes('fail') ? 'failed' : 'info'}" title="Offer ID: ${offerId || 'N/A'}">
                                          <i class="fas ${offerStatus.toLowerCase().includes('fail') ? 'fa-times-circle' : 'fa-question-circle'}"></i>
                                          ${offerStatus}
                                      </span>`;
            }
        });

    } catch (error) {
        console.error("Error loading winning history:", error);
        if (loadingIndicator) loadingIndicator.style.display = 'none';
        if (noWinningsMessage) {
            noWinningsMessage.textContent = `Error loading history: ${error.message}`;
            noWinningsMessage.style.display = 'block';
            noWinningsMessage.classList.add('error');
        } else if (tableBody) {
            tableBody.innerHTML = `<tr><td colspan="4" class="error-message">Error loading history: ${error.message}</td></tr>`;
        }
        showNotification(`Error loading winning history: ${error.message}`, 'error');
    }
}

// USER REQUEST: Add this helper function
function showWinningsPopup(offerURL, offerId, status) { //
    const { modal, offerIdDisplay, statusText, acceptOnSteamBtn } = DOMElements.acceptWinningsModal; //
    currentWinningsOfferURL = offerURL; //
    if (offerIdDisplay) offerIdDisplay.textContent = `Trade Offer ID: #${offerId}`; //
    if (statusText) { //
        statusText.textContent = `Status: ${status || 'Sent'}. Click below to accept.`; //
        statusText.className = 'deposit-status-text info'; //
    }
    if (acceptOnSteamBtn) { //
        acceptOnSteamBtn.disabled = false; //
        acceptOnSteamBtn.setAttribute('data-offer-url', offerURL); //
    }
    showModal(modal); //
}


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
    socket.on('participantUpdated', (data) => {
        console.log('Participant updated:', data);
        if (currentRound && currentRound.roundId === data.roundId) handleNewDeposit(data);
        else if (!currentRound && data.roundId) {
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
    socket.on('roundWinner', (data) => { //
        console.log('Round winner received:', data); //
        if (currentRound && currentRound.roundId === data.roundId) { //
            if (!currentRound.winner) currentRound.winner = data.winner; //
            currentRound.status = 'rolling'; //
            // Check if current user is the winner and handle accordingly
            if (currentUser &&  //
                (data.winner.id === currentUser._id || data.winner.id === currentUser.id || //
                 data.winner._id === currentUser._id || data.winner._id === currentUser.id)) { //
                console.log('Current user is the winner! Will show acceptance popup after animation.'); //
                // Set a flag to show the acceptance popup after animation completes
                pendingWinningsOffer = {  //
                    waitingForAnimation: true, //
                    roundId: data.roundId //
                }; //
                // Show a notification now
                showNotification('You won! Accept your winnings after the animation.', 'success', 10000); //
            } //
            handleWinnerAnnouncement(data); //
        } else console.warn("Received winner for mismatched round ID. Current:", currentRound?.roundId, "Received:", data.roundId); //
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
            resetToJackpotView();
        }
    });

    socket.on('roundData', (data) => {
        console.log('Received initial/updated round data:', data);
        if (!data || typeof data !== 'object') {
            console.error("Invalid round data received from server.");
            showNotification('Error syncing with server.', 'error');
             initiateNewRoundVisualReset(); return;
        }
        currentRound = data;
        updateRoundUI();
        updateDepositButtonState();

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
             } else if (!timerActive) {
                 updateTimerUI(currentRound.timeLeft);
             }
        } else if (currentRound.status === 'pending') {
            console.log("Received pending round state. Resetting visuals.");
            initiateNewRoundVisualReset();
            if(DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Waiting";
            updateDepositButtonState();
        } else if (!currentRound.status) {
             console.warn("Received round data with no status. Resetting visuals.");
             initiateNewRoundVisualReset();
        }

        const container = DOMElements.jackpot.participantsContainer;
        if(container && data.participants?.length > 0) {
            console.log("Rendering existing deposits from full round data.");
            container.innerHTML = '';
            if (DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'none';
            const validParticipants = data.participants.filter(p => p.user && (p.user._id || p.user.id));
            const sortedParticipants = [...validParticipants].sort((a,b) => (b.itemsValue || 0) - (a.itemsValue || 0));
            sortedParticipants.forEach(p => {
                const participantItems = data.items?.filter(item => item.owner === (p.user._id || p.user.id)) || [];
                displayLatestDeposit({
                    userId: p.user._id || p.user.id,
                    username: p.user.username,
                    avatar: p.user.avatar,
                    itemsValue: p.itemsValue,
                    depositedItems: participantItems
                });
                const element = container.querySelector(`.player-deposit-container[data-user-id="${p.user._id || p.user.id}"]`);
                if (element) element.classList.remove('player-deposit-new');
            });
             updateAllParticipantPercentages();
        } else if (container && (!data.participants || data.participants.length === 0)) {
            initiateNewRoundVisualReset();
        }
    });

    socket.on('tradeOfferSent', (data) => { //
         console.log('Trade offer sent event received:', data); //
         if (currentUser && data.userId === (currentUser._id || currentUser.id) && data.offerURL) { //
              if (data.type === 'winning') { // Check if it's a winning offer
                  if (isSpinning || (pendingWinningsOffer && pendingWinningsOffer.waitingForAnimation)) { //
                      // Store the data to be processed after animation
                      pendingWinningsOffer = {  //
                           offerURL: data.offerURL, //
                           offerId: data.offerId, //
                           status: data.status, //
                          waitingForAnimation: true //
                      }; //
                      console.log('Winner offer received but animation playing, will show popup after animation'); //
                  } else { //
                      // Show popup immediately if no animation playing
                      showWinningsPopup(data.offerURL, data.offerId, data.status); //
                  } //
                  // Show a notification as well for users who might miss the modal
                  showNotification(`Winnings Sent! <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">Accept on Steam</a> (#${data.offerId})`, 'success', 15000); //
              } else { //
                   // Handle deposit offers...
                   // This part is for existing deposit notifications if any, or general use.
                   // The specific deposit modal handles its own notifications mostly.
                  showNotification(`Trade Offer Update: <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">View Offer on Steam</a> (#${data.offerId}) - Status: ${data.status}`, 'info', 10000);
              }
         } else if (currentUser && data.userId === (currentUser._id || currentUser.id)) { //
              // Fallback notification...
              // Fallback if URL is missing but it's for the current user
              showNotification(`Trade Offer Sent: Check Steam for your items! (Offer #${data.offerId})`, 'success', 8000);
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

    // Event listener for Winning History
    winningHistoryDropdownButton?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const menu = DOMElements.user.userDropdownMenu;
        if (currentUser) {
            loadWinningHistory(); // This function will also show the modal
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

    // Accept Winnings Modal Listeners
    const awModal = DOMElements.acceptWinningsModal;
    awModal.closeBtn?.addEventListener('click', () => hideModal(awModal.modal));
    awModal.closeFooterBtn?.addEventListener('click', () => hideModal(awModal.modal));
    awModal.acceptOnSteamBtn?.addEventListener('click', () => {
        const url = awModal.acceptOnSteamBtn.getAttribute('data-offer-url');
        if (url) {
            window.open(url, '_blank', 'noopener,noreferrer');
            if(awModal.statusText) awModal.statusText.textContent = "Check Steam tab for the offer. Closing this window...";
            setTimeout(() => hideModal(awModal.modal), 2000);
        } else {
            showNotification("Error: Could not find the winnings trade offer URL.", "error");
        }
    });

    // Winning History Modal Listeners
    const whModal = DOMElements.winningHistoryModal;
    whModal.closeBtn?.addEventListener('click', () => hideModal(whModal.modal));
    whModal.closeFooterBtn?.addEventListener('click', () => hideModal(whModal.modal));


    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => {
        const button = DOMElements.deposit.showDepositModalButton;
        if (button.disabled) {
            showNotification(button.title || 'Deposits are currently closed.', 'info'); return;
        }
        if (!currentUser) {
            showNotification('Login Required: Please log in first.', 'error'); return;
        }
         if (!currentUser.tradeUrl) {
             console.log("Trade URL missing for user. Prompting user to set it in profile.");
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
             console.log("Opening Steam trade offer:", currentDepositOfferURL);
             window.open(currentDepositOfferURL, '_blank', 'noopener,noreferrer');
             const { depositStatusText } = DOMElements.deposit;
             if(depositStatusText) depositStatusText.textContent = "Check Steam tab for the offer...";
         } else {
             console.error("No deposit offer URL found for accept button.");
             showNotification("Error: Could not find the trade offer URL.", "error");
         }
    });

    const { modal: ageModal, checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
    if (ageModal && ageCheckbox && ageAgreeButton) {
        ageCheckbox.addEventListener('change', () => { ageAgreeButton.disabled = !ageCheckbox.checked; });
        ageAgreeButton.addEventListener('click', () => {
            if (ageCheckbox.checked) {
                localStorage.setItem('ageVerified', 'true'); hideModal(ageModal);
                console.log("Age verification agreed. Proceeding to Steam login.");
                window.location.href = '/auth/steam';
            }
        });
        ageAgreeButton.disabled = !ageCheckbox.checked;
    }

    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound);

    window.addEventListener('click', (e) => {
        const profileModalEl = DOMElements.profileModal.modal;
        const acceptWinningsModalEl = DOMElements.acceptWinningsModal.modal; // Added
        const winningHistoryModalEl = DOMElements.winningHistoryModal.modal; // Added

        if (userDropdownMenu && userProfile && userDropdownMenu.style.display === 'block' &&
            !userProfile.contains(e.target) && !userDropdownMenu.contains(e.target)) {
            userDropdownMenu.style.display = 'none';
            userProfile.setAttribute('aria-expanded', 'false');
            userProfile.classList.remove('open');
        }
        if (e.target === DOMElements.deposit.depositModal) hideModal(DOMElements.deposit.depositModal);
        if (e.target === profileModalEl) hideModal(profileModalEl);
        if (e.target === acceptWinningsModalEl) hideModal(acceptWinningsModalEl); // Added
        if (e.target === winningHistoryModalEl) hideModal(winningHistoryModalEl); // Added
    });

    document.addEventListener('keydown', function(event) {
        const profileModalEl = DOMElements.profileModal.modal;
        const depositModalEl = DOMElements.deposit.depositModal;
        const acceptWinningsModalEl = DOMElements.acceptWinningsModal.modal; // Added
        const winningHistoryModalEl = DOMElements.winningHistoryModal.modal; // Added

        if (event.key === 'Escape') {
             if (profileModalEl?.style.display === 'flex') hideModal(profileModalEl);
             else if (depositModalEl?.style.display === 'flex') hideModal(depositModalEl);
             else if (acceptWinningsModalEl?.style.display === 'flex') hideModal(acceptWinningsModalEl); // Added
             else if (winningHistoryModalEl?.style.display === 'flex') hideModal(winningHistoryModalEl); // Added
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

    checkLoginStatus();
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

    updateChatUI();
});

console.log("main.js updated with Winnings Modal and Winning History logic, and user requested fixes for issue 1 & 2.");
