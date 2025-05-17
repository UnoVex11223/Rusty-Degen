// main.js - Rust Jackpot Frontend Logic (Part 1 of 2)
// Modifications:
// - Refined timer update logic in updateTimerUI for accurate initial display and updates.
// - Added handling for 'timerUpdate' socket event from backend.
// - Ensured updateDepositButtonState reflects correct timer and round status.

const socket = io();

const CONFIG = {
    ROUND_DURATION: 99, // Timer duration in seconds
    MAX_ITEMS_PER_DEPOSIT: 20,
    MAX_DISPLAY_DEPOSITS: 10,
    MAX_PARTICIPANTS_DISPLAY: 20,
    MAX_ITEMS_PER_POT_FRONTEND: 200,
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
    MAX_CHAT_MESSAGES: 15,
    CHAT_SEND_COOLDOWN_MS: 2000,
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
        winningHistoryDropdownButton: document.getElementById('winningHistoryDropdownButton'),
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
    winningHistoryModal: {
        modal: document.getElementById('winningHistoryModal'),
        closeBtnHeader: document.getElementById('winningHistoryModalCloseBtn'),
        closeBtnFooter: document.getElementById('winningHistoryModalCloseFooterBtn'),
        loadingIndicator: document.getElementById('winning-history-loading'),
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
let currentRound = null; // This will hold data like { roundId, status, timeLeft, participants, items, totalValue, etc. }
let selectedItemsList = [];
let userInventory = [];
let isSpinning = false;
let timerActive = false; // Tracks if the client-side interval timer is running for countdown
let roundTimer = null; // Stores the interval ID for the client-side timer
let animationFrameId = null;
let userColorMap = new Map();
let notificationTimeout = null;
let spinStartTime = 0;
let currentDepositOfferURL = null;
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
    if (modalElement === DOMElements.winningHistoryModal.modal) {
        if (DOMElements.winningHistoryModal.tableBody) DOMElements.winningHistoryModal.tableBody.innerHTML = '';
        if (DOMElements.winningHistoryModal.noWinningsMessage) DOMElements.winningHistoryModal.noWinningsMessage.style.display = 'none';
        if (DOMElements.winningHistoryModal.loadingIndicator) DOMElements.winningHistoryModal.loadingIndicator.style.display = 'none';
    }
}
window.hideModal = hideModal;

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

function updateDepositButtonState() {
    const button = DOMElements.deposit.showDepositModalButton;
    if (!button) return;

    let disabled = false;
    let title = 'Deposit Rust skins into the pot';
    const roundTimeLeft = currentRound?.timeLeft; // Use optional chaining

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
    } else if (typeof roundTimeLeft === 'number' && roundTimeLeft <= 0) { // Check if timeLeft is defined and zero or less
        disabled = true;
        title = 'Deposits closed (Round ended/ending)';
    }
    // Note: The 'timerActive' flag is mostly for client-side animation.
    // The authoritative timeLeft comes from `currentRound.timeLeft` (from server).

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
        updateChatUI(); // Update chat before deposit button which might depend on round state
        // Request initial round data after login status is known.
        // This will also trigger the initial timer display update via socket.on('roundData').
        if (socket && socket.connected) {
            console.log("Requesting initial round data after checkLoginStatus.");
            socket.emit('requestRoundData');
        } else {
            console.warn("Socket not connected when checkLoginStatus finished. Round data request will occur on connect.");
             // If socket is not connected, we might want a default timer display before data arrives
            if (!currentRound) { // If no round data at all yet
                updateTimerUI(CONFIG.ROUND_DURATION); // Attempt to show default timer
                updateDepositButtonState(); // Update button based on this assumption
            }
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

// main.js - Rust Jackpot Frontend Logic (Part 2 of 2)

async function requestDepositOffer() {
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit;
    if (!depositButton || !acceptDepositOfferBtn || !depositStatusText) return;

    if (selectedItemsList.length === 0) {
        showNotification('No Items Selected: Please select items first.', 'info');
        return;
    }
    // Re-check currentRound status and timeLeft from currentRound for deposit button enabling
    const roundIsDepositable = currentRound && currentRound.status === 'active' && !isSpinning &&
                             (typeof currentRound.timeLeft === 'undefined' || currentRound.timeLeft > 0);

    if (!roundIsDepositable) {
        showNotification('Deposit Error: Deposits are currently closed for this round.', 'error');
        updateDepositButtonState(); // Refresh button state based on latest check
        return;
    }

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
        response = await fetch('/api/deposit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetIds }),
        });
        const result = await response.json();

        if (!response.ok) {
            if (response.status === 409 && result.offerURL && result.offerId) {
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
            currentUser.pendingDepositOfferId = null; updateUserUI(); updateDepositButtonState();
        }
    }
}

function updateRoundUI() {
    const { potValue, participantCount } = DOMElements.jackpot;
    if (!potValue || !participantCount) return; // currentRound can be null initially

    potValue.textContent = `$${(currentRound?.totalValue || 0).toFixed(2)}`;
    participantCount.textContent = `${currentRound?.participants?.length || 0}/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;

    // Timer display is primarily handled by updateTimerUI, which is called by socket events or startClientTimer
    // However, ensure a baseline display if currentRound exists
    if (currentRound) {
        updateTimerUI(currentRound.timeLeft);
    } else {
        updateTimerUI(CONFIG.ROUND_DURATION); // Default display before any round data
    }
}


function updateTimerUI(timeLeftParam) {
    const { timerValue, timerForeground } = DOMElements.jackpot;
    if (!timerValue || !timerForeground) {
        console.error("Timer DOM elements not found in updateTimerUI.");
        return;
    }

    // Use timeLeft from currentRound if available and timeLeftParam is undefined,
    // otherwise use timeLeftParam. This allows explicit setting (e.g. 99 initially).
    let timeLeftToConsider = (timeLeftParam === undefined && currentRound) ? currentRound.timeLeft : timeLeftParam;
    if (timeLeftToConsider === undefined) { // If still undefined, default to round duration or 0.
        timeLeftToConsider = (currentRound && currentRound.status === 'active' && currentRound.participants?.length === 0) ? CONFIG.ROUND_DURATION : 0;
    }


    const timeToShow = Math.max(0, Math.round(timeLeftToConsider));
    let displayValue;

    if (isSpinning || (currentRound && currentRound.status === 'rolling')) {
        displayValue = "Rolling";
    } else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'error')) {
        displayValue = "Ended";
    } else if (currentRound && currentRound.status === 'pending') {
        displayValue = "Waiting";
    } else if (currentRound && currentRound.status === 'active') {
        // If timer is actively counting on client, or server sent a specific time for an active round
        if ((timerActive && timeToShow > 0) || (!timerActive && timeToShow > 0 && currentRound.participants?.length > 0)) {
            displayValue = timeToShow.toString();
        } else if (!timerActive && currentRound.participants?.length === 0) { // Active, empty, client timer not started
            displayValue = CONFIG.ROUND_DURATION.toString();
        } else { // Active, but time is zero or less
            displayValue = "0";
        }
    } else if (!currentRound && timeLeftToConsider !== undefined) { // No current round data from server yet, but an initial time was provided
        displayValue = timeToShow.toString(); // Show initial time e.g. 99
    }
    else { // Fallback, no currentRound and no specific timeLeft given to function
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
            itemsValue: data.itemsValue, // Backend should send the new total itemsValue for the user in this round
            tickets: data.tickets // Backend should send total tickets for user
        };
    } else {
        currentRound.participants.push({
            user: { _id: data.userId, id: data.userId, username: data.username || 'Unknown User', avatar: data.avatar || '/img/default-avatar.png' },
            itemsValue: data.itemsValue, // This is the total value for this user in this round
            tickets: data.tickets
        });
    }
    currentRound.totalValue = data.totalValue; // Update total pot value from server
    data.depositedItems.forEach(item => { // Add items to master list IF NOT ALREADY THERE by assetId
        if (item && typeof item.price === 'number' && !isNaN(item.price) && !currentRound.items.find(i => i.assetId === item.assetId)) {
            currentRound.items.push({ ...item, owner: data.userId });
        }
    });

    updateRoundUI(); // This will call updateTimerUI with currentRound.timeLeft
    displayLatestDeposit(data);
    updateAllParticipantPercentages();
    updateDepositButtonState();

    // Server will dictate timer start via 'timerUpdate' or by setting 'endTime' in 'roundData'.
    // Client-side starting of timer based on first participant is now primarily for immediate visual feedback
    // but server 'timerUpdate' will be the authority.
    if (currentRound.status === 'active' && currentRound.participants.length > 0 && !timerActive && currentRound.timeLeft > 0) {
        console.log("Participants present. Visual timer might start if server sends 'timerUpdate' or if timeLeft indicates it should run.");
        // If server hasn't started its timer yet (e.g. timeLeft is still full duration), client doesn't start interval.
        // If server HAS started (timeLeft is less than full), client can start visual interval.
        if (currentRound.timeLeft < CONFIG.ROUND_DURATION) {
             startClientTimer(currentRound.timeLeft);
        }
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

function startClientTimer(initialTime) {
    const timerDisplay = DOMElements.jackpot.timerValue;
    if (!timerDisplay) return;
    if (roundTimer) clearInterval(roundTimer); // Clear any existing client-side interval

    let timeLeft = Math.max(0, initialTime);
    console.log(`Starting/Syncing client visual timer from ${timeLeft}s`);
    timerActive = true; // Indicates client-side interval is active
    updateTimerUI(timeLeft); // Initial display based on this time
    updateDepositButtonState();

    roundTimer = setInterval(() => {
        if (!timerActive) { // If timerActive is externally set to false (e.g. by server event)
            clearInterval(roundTimer); roundTimer = null;
            console.log("Client timer interval stopped (timerActive set to false).");
            return;
        }

        timeLeft--;
        if (currentRound) currentRound.timeLeft = timeLeft; // Keep local round data somewhat in sync for display

        updateTimerUI(timeLeft); // Update display with decremented time
        // updateDepositButtonState(); // This might be too frequent, rely on server state mostly

        if (timeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null;
            timerActive = false; // Client timer has run its course
            console.log("Client timer interval reached zero.");
            if (timerDisplay) updateTimerUI(0); // Explicitly show 0
            updateDepositButtonState(); // Deposits should be closed based on this
            // Server will ultimately decide when to roll through 'roundRolling' or 'roundWinner'
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
    timerActive = false; if (roundTimer) { clearInterval(roundTimer); roundTimer = null; } // Stop client-side interval
    currentRound.status = 'rolling'; // Ensure local status reflects this
    updateTimerUI(0); // Show "Rolling" or appropriate text
    updateDepositButtonState();

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
    const sound = DOMElements.audio.spinSound;
    if (sound) {
        sound.volume = 0.7; sound.currentTime = 0; sound.playbackRate = 1.0;
        sound.play().catch(e => console.error('Error playing spin sound:', e));
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
            for (let i = 0; i < items.length; i++) {
                 if (items[i]?.dataset?.userId === winnerId) winnerItemsIndices.push(i);
            }
        }
        let winningElement, targetIndex;
        if (winnerItemsIndices.length === 0) {
            targetIndex = Math.max(0, Math.min(items.length - 1, Math.floor(items.length * 0.75)));
            winningElement = items[targetIndex];
             if (!winningElement) {
                 isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
             }
        } else {
            targetIndex = winnerItemsIndices[Math.floor(Math.random() * winnerItemsIndices.length)];
            winningElement = items[targetIndex];
             if (!winningElement) {
                 isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
             }
        }
        handleRouletteSpinAnimation(winningElement, winnerParticipantData);
    }, 100);
}

function handleRouletteSpinAnimation(winningElement, winner) {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer?.querySelector('.roulette-container');
    if (!winningElement || !track || !container) {
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }
    const containerWidth = container.offsetWidth;
    const itemWidth = winningElement.offsetWidth || 60;
    const itemOffsetLeft = winningElement.offsetLeft;
    const centerOffset = (containerWidth / 2) - (itemWidth / 2);
    const perfectCenterScrollPosition = -(itemOffsetLeft - centerOffset);
    const initialVariation = (Math.random() * 2 - 1) * (itemWidth * CONFIG.LANDING_POSITION_VARIATION);
    const maxAllowedAbsVariation = itemWidth * 0.49;
    let finalVariation = (Math.abs(initialVariation) <= maxAllowedAbsVariation) ? initialVariation : Math.sign(initialVariation) * maxAllowedAbsVariation;
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
            animationFrameId = null;
            finalizeSpin(winningElement, winner);
        }
    }
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = requestAnimationFrame(animateRoulette);
}

function finalizeSpin(winningElement, winner) {
    if ((!isSpinning && winningElement?.classList.contains('winner-highlight')) || !winningElement || !winner?.user) {
        if (isSpinning) { isSpinning = false; updateDepositButtonState(); resetToJackpotView(); }
        return;
    }
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
        if (!isSpinning) return;
        isSpinning = false; updateDepositButtonState(); resetToJackpotView();
        return;
    }
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
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
                            isSpinning = false; updateDepositButtonState();
                            setTimeout(resetToJackpotView, CONFIG.WINNER_DISPLAY_DURATION);
                        }
                    }, typeDelay);
                }
            }, typeDelay);
        }, 500);
    } else {
        isSpinning = false; updateDepositButtonState(); resetToJackpotView();
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
    if (roundTimer) clearInterval(roundTimer); roundTimer = null; // Clear client-side interval
    timerActive = false; isSpinning = false; spinStartTime = 0; // Reset flags

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
        initiateNewRoundVisualReset();
        updateDepositButtonState();
        if (socket?.connected) {
            socket.emit('requestRoundData');
        }
    }, 500);
}

function initiateNewRoundVisualReset() {
    console.log("Initiating visual reset for new round display.");
    if (roundTimer) { clearInterval(roundTimer); roundTimer = null; } // Stop any client-side interval
    timerActive = false; // Reset client-side timer flag
    updateTimerUI(CONFIG.ROUND_DURATION); // Set timer display to full, using the refined logic
    if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.classList.remove('urgent-pulse', 'timer-pulse');

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
    updateDepositButtonState(); // Update button state after reset
}

function findWinnerFromData(winnerData) {
    const winnerId = winnerData?.winner?.id || winnerData?.winner?._id;
    if (!winnerId) return null;
    if (!currentRound || !currentRound.participants) {
        if (winnerData.winner) return { user: { ...winnerData.winner }, percentage: 0, value: 0 };
        return null;
    }
    const winnerParticipant = currentRound.participants.find(p => p.user?._id === winnerId || p.user?.id === winnerId);
    if (!winnerParticipant) {
        if (winnerData.winner) return { user: { ...winnerData.winner }, percentage: 0, value: 0 };
        return null;
    }
    const totalValue = Math.max(0.01, currentRound.totalValue || 0.01);
    const participantValue = winnerParticipant.itemsValue || 0;
    const percentage = (participantValue / totalValue) * 100;
    return { user: { ...(winnerParticipant.user) }, percentage: percentage || 0, value: participantValue };
}

async function verifyRound() {
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationResultDisplay } = DOMElements.provablyFair;
    if (!roundIdInput || !serverSeedInput || !clientSeedInput || !verificationResultDisplay) return;
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
            // ... (rest of verification display logic)
        } else {
            html += `<p style="color: var(--error-color); font-weight: bold;">❌ Verification Failed.</p>`;
            html += `<p><strong>Reason:</strong> ${result.reason || 'Mismatch detected.'}</p>`;
            // ... (rest of verification display logic)
        }
        resultEl.innerHTML = html; // Simplified for brevity, original detailed HTML can be kept
    } catch (error) {
        resultEl.style.display = 'block'; resultEl.className = 'verification-result error';
        resultEl.innerHTML = `<p>Verification Error: ${error.message}</p>`;
    }
}

async function loadPastRounds(page = 1) {
    // ... (existing implementation)
}
window.populateVerificationFields = function(roundId, serverSeed, clientSeed) {
    // ... (existing implementation)
};

function createPagination(currentPage, totalPages) {
    // ... (existing implementation)
}

async function showWinningHistory() {
    const modalElements = DOMElements.winningHistoryModal;
    if (!modalElements.modal || !currentUser) {
        showNotification("Please log in to view your winning history.", "info");
        return;
    }
    showModal(modalElements.modal);
    modalElements.loadingIndicator.style.display = 'flex';
    modalElements.tableBody.innerHTML = '';
    modalElements.noWinningsMessage.style.display = 'none';
    try {
        const response = await fetch('/api/user/winning-history');
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Failed to load winning history.' }));
            throw new Error(errorData.error || `Error ${response.status}`);
        }
        const winnings = await response.json();
        populateWinningHistoryTable(winnings);
    } catch (error) {
        console.error("Error fetching winning history:", error);
        showNotification(`Error: ${error.message}`, 'error');
        modalElements.tableBody.innerHTML = `<tr><td colspan="4" class="error-message" style="text-align:center;">${error.message}</td></tr>`;
    } finally {
        modalElements.loadingIndicator.style.display = 'none';
    }
}

function populateWinningHistoryTable(winnings) {
    const { tableBody, noWinningsMessage } = DOMElements.winningHistoryModal;
    tableBody.innerHTML = '';
    if (!winnings || winnings.length === 0) {
        noWinningsMessage.style.display = 'block';
        return;
    }
    noWinningsMessage.style.display = 'none';
    winnings.forEach(win => {
        const row = tableBody.insertRow();
        const gameIdCell = row.insertCell();
        const amountCell = row.insertCell();
        const dateCell = row.insertCell();
        const tradeCell = row.insertCell();
        gameIdCell.innerHTML = `<span class="game-id-cell" title="${win.gameId || 'N/A'}">#${win.roundDisplayId || 'N/A'}</span>`;
        amountCell.innerHTML = `<span class="amount-won-cell">$${(win.amountWon || 0).toFixed(2)}</span>`;
        dateCell.textContent = win.timestamp ? new Date(win.timestamp).toLocaleDateString() : 'N/A';
        if (win.tradeOfferURL && win.tradeOfferId) {
            const link = document.createElement('a');
            link.href = win.tradeOfferURL;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.className = `trade-offer-link status-${(win.tradeOfferStatus || 'unknown').toLowerCase()}`;
            link.innerHTML = `<i class="fas fa-external-link-alt"></i> #${win.tradeOfferId.slice(0, 8)}... <span class="trade-status-text">(${(win.tradeOfferStatus || 'unknown')})</span>`;
            if (win.tradeOfferStatus && win.tradeOfferStatus.toLowerCase() === 'accepted') {
                 link.style.setProperty('--status-color', 'var(--success-color)'); // For potential future use with ::before or icons
            }
            tradeCell.appendChild(link);
        } else if (win.tradeOfferId) {
            tradeCell.innerHTML = `<span class="no-trade-offer">#${win.tradeOfferId.slice(0,8)}... (${win.tradeOfferStatus || 'error'})</span>`;
        } else {
            tradeCell.innerHTML = `<span class="no-trade-offer">${win.tradeOfferStatus || 'N/A'}</span>`;
        }
    });
}

function updateChatUI() {
    // ... (existing implementation)
}
function displayChatMessage(messageData, isInitialLoad = false) {
    // ... (existing implementation, ensure MAX_CHAT_MESSAGES is used)
}
function handleSendMessage() {
    // ... (existing implementation)
}
function setupChatEventListeners() {
    // ... (existing implementation)
}
function updateChatOnlineUsers(count) {
    // ... (existing implementation)
}

function setupSocketConnection() {
    socket.on('connect', () => {
        console.log('Socket connected:', socket.id);
        showNotification('Connected to server.', 'success', 2000);
        // Request round data AFTER connection is confirmed and login status might be known
        if (currentUser !== undefined) { // If checkLoginStatus has run at least once
            socket.emit('requestRoundData');
        }
    });

    // NEW: Listen for timer updates from the server
    socket.on('timerUpdate', (data) => {
        if (currentRound && data.timeLeft !== undefined) {
            currentRound.timeLeft = data.timeLeft;
            updateTimerUI(data.timeLeft); // Update UI with server's time
            updateDepositButtonState(); // Re-evaluate deposit button based on new time

            // If client-side interval is not running but server indicates time is ticking down
            if (!timerActive && data.timeLeft > 0 && data.timeLeft < CONFIG.ROUND_DURATION && currentRound.status === 'active' && currentRound.participants?.length > 0) {
                console.log("Server timer update received, starting client visual timer to sync.");
                startClientTimer(data.timeLeft);
            } else if (data.timeLeft <= 0 && timerActive) { // Server says time is up, stop client interval
                console.log("Server timer update indicates time up, stopping client interval.");
                clearInterval(roundTimer);
                roundTimer = null;
                timerActive = false;
            }
        }
    });


    socket.on('roundData', (data) => {
        console.log('Received initial/updated round data:', data);
        if (!data || typeof data !== 'object') {
            console.error("Invalid round data received from server.");
            showNotification('Error syncing with server.', 'error');
            currentRound = null; // Explicitly nullify if data is bad
            initiateNewRoundVisualReset(); // Reset to a clean state
            return;
        }

        currentRound = data;
        isSpinning = (currentRound.status === 'rolling' || currentRound.status === 'completed' && currentRound.winner); // Update isSpinning based on status
        updateRoundUI(); // This will call updateTimerUI

        if (currentRound.status === 'active') {
            if (currentRound.participants?.length > 0 && typeof currentRound.timeLeft === 'number' && currentRound.timeLeft > 0) {
                // If round is active, has players, and time left, ensure client timer reflects this
                if (!timerActive || (roundTimer === null)) { // Start client timer if not already running and should be
                     console.log(`Round data: Active with participants and time left (${currentRound.timeLeft}s). Starting/syncing client timer.`);
                     startClientTimer(currentRound.timeLeft);
                }
            } else if (currentRound.participants?.length === 0 && timerActive) { // Active, but no players, stop client timer
                console.log("Round data: Active but no participants. Stopping client timer.");
                clearInterval(roundTimer); roundTimer = null; timerActive = false;
                updateTimerUI(CONFIG.ROUND_DURATION); // Show full duration
            } else if (typeof currentRound.timeLeft === 'number' && currentRound.timeLeft <= 0 && timerActive) {
                // Time is up according to server, stop client timer
                console.log("Round data: Time is up. Stopping client timer.");
                clearInterval(roundTimer); roundTimer = null; timerActive = false;
                updateTimerUI(0);
            } else if (currentRound.participants?.length === 0) { // Active, no participants, timer shouldn't be "active"
                 timerActive = false; if(roundTimer) clearInterval(roundTimer); roundTimer = null;
                 updateTimerUI(CONFIG.ROUND_DURATION);
            }
        } else if (currentRound.status === 'pending' || currentRound.status === 'completed' || currentRound.status === 'error' || currentRound.status === 'rolling') {
            // If round is not active, ensure client-side interval timer is stopped
            if (timerActive || roundTimer) {
                console.log(`Round status is ${currentRound.status}. Stopping client timer.`);
                clearInterval(roundTimer); roundTimer = null; timerActive = false;
            }
            if (currentRound.status === 'rolling' || (currentRound.status === 'completed' && currentRound.winner && !isSpinning)) {
                handleWinnerAnnouncement(currentRound);
            } else if (currentRound.status === 'pending'){
                 initiateNewRoundVisualReset(); // Calls updateTimerUI(CONFIG.ROUND_DURATION)
            }
        }
        updateDepositButtonState(); // Crucial call after all state updates

        // Re-render participant deposits
        const container = DOMElements.jackpot.participantsContainer;
        if(container) {
            container.innerHTML = ''; // Clear previous
             if (DOMElements.jackpot.emptyPotMessage && (!data.participants || data.participants.length === 0)) {
                DOMElements.jackpot.emptyPotMessage.style.display = 'block';
                if (!container.contains(DOMElements.jackpot.emptyPotMessage)) {
                    container.appendChild(DOMElements.jackpot.emptyPotMessage);
                }
            } else if (DOMElements.jackpot.emptyPotMessage) {
                DOMElements.jackpot.emptyPotMessage.style.display = 'none';
            }

            if (data.participants?.length > 0) {
                const validParticipants = data.participants.filter(p => p.user && (p.user._id || p.user.id));
                const sortedParticipants = [...validParticipants].sort((a, b) => {
                    // Find the latest deposit time for each participant for sorting
                    // This assumes items in data.items are sorted by deposit time or have a timestamp
                    // For simplicity, we'll just sort by value for now if timestamp isn't easily accessible per deposit group
                    return (b.itemsValue || 0) - (a.itemsValue || 0);
                });

                sortedParticipants.forEach(p => {
                    const participantItems = data.items?.filter(item => item.owner && (item.owner.toString() === (p.user._id || p.user.id).toString())) || [];
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
            }
        }
    });
    // ... (other socket event handlers: roundCreated, participantUpdated, roundRolling, etc.)
     socket.on('roundCreated', (data) => { console.log('New round created:', data); currentRound = data; resetToJackpotView(); /* This calls initiateNewRoundVisualReset */ });
     socket.on('participantUpdated', (data) => { if (currentRound && currentRound.roundId === data.roundId) { handleNewDeposit(data); } else if (!currentRound && data.roundId) { socket.emit('requestRoundData'); }});
     socket.on('roundRolling', (data) => { if (currentRound && currentRound.roundId === data.roundId) { timerActive = false; if (roundTimer) { clearInterval(roundTimer); roundTimer = null; } currentRound.status = 'rolling'; updateTimerUI(0); updateDepositButtonState(); } });
     socket.on('roundWinner', (data) => { if (currentRound && currentRound.roundId === data.roundId) { if (!currentRound.winner) currentRound.winner = data.winner; currentRound.status = 'rolling'; handleWinnerAnnouncement(data); }});
     socket.on('roundCompleted', (data) => { if (currentRound && currentRound.roundId === data.roundId) { currentRound.status = 'completed'; if(data.serverSeed) currentRound.serverSeed = data.serverSeed; if(data.clientSeed) currentRound.clientSeed = data.clientSeed; updateTimerUI(0); } updateDepositButtonState(); });
     socket.on('roundError', (data) => { if (currentRound && currentRound.roundId === data.roundId) { currentRound.status = 'error'; showNotification(`Round Error: ${data.error || 'Unknown error.'}`, 'error'); updateTimerUI(0); updateDepositButtonState(); resetToJackpotView(); } });
     socket.on('tradeOfferSent', (data) => { if (currentUser && data.userId === (currentUser._id || currentUser.id) && data.offerURL) { showNotification(`Trade Offer Sent: <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">Click here to accept your winnings on Steam!</a> (#${data.offerId})`, 'success', 10000); } else if (currentUser && data.userId === (currentUser._id || currentUser.id)) { showNotification(`Trade Offer Sent: Check Steam for your winnings! (#${data.offerId})`, 'success', 8000); } });
     socket.on('notification', (data) => { if (!data.userId || (currentUser && data.userId === (currentUser._id || currentUser.id))) { showNotification(data.message || 'Received notification from server.', data.type || 'info', data.duration || 4000); } });
     socket.on('chatMessage', (data) => { displayChatMessage(data); });
     socket.on('initialChatMessages', (messages) => { const container = DOMElements.chat.messagesContainer; if (container) container.innerHTML = ''; messages.forEach(msg => displayChatMessage(msg, true)); if (container && messages.length > 0) { container.scrollTop = container.scrollHeight; }});
     socket.on('updateUserCount', (count) => { updateChatOnlineUsers(count); });
}


function setupEventListeners() {
    DOMElements.nav.homeLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.homePage); });
    DOMElements.nav.aboutLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.aboutPage); });
    DOMElements.nav.tosLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.tosPage); });
    DOMElements.nav.faqLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.faqPage); });
    DOMElements.nav.fairLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.fairPage); });
    DOMElements.user.loginButton?.addEventListener('click', () => { if (localStorage.getItem('ageVerified') === 'true') { window.location.href = '/auth/steam'; } else { const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification; if(ageCheckbox) ageCheckbox.checked = false; if(ageAgreeButton) ageAgreeButton.disabled = true; showModal(DOMElements.ageVerification.modal); } });
    const { userProfile, userDropdownMenu, logoutButton, profileDropdownButton, winningHistoryDropdownButton } = DOMElements.user;
    userProfile?.addEventListener('click', (e) => { e.stopPropagation(); if (userDropdownMenu) { const isVisible = userDropdownMenu.style.display === 'block'; userDropdownMenu.style.display = isVisible ? 'none' : 'block'; userProfile?.setAttribute('aria-expanded', String(!isVisible)); userProfile?.classList.toggle('open', !isVisible); } });
    userProfile?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }});
    logoutButton?.addEventListener('click', (e) => { e.stopPropagation(); handleLogout(); });
    logoutButton?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleLogout(); }});
    profileDropdownButton?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const menu = DOMElements.user.userDropdownMenu; const modal = DOMElements.profileModal.modal; if (currentUser && modal) { populateProfileModal(); showModal(modal); } else if (!currentUser) showNotification("Please log in to view your profile.", "info"); if (menu) menu.style.display = 'none'; userProfile?.setAttribute('aria-expanded', 'false'); userProfile?.classList.remove('open'); });
    winningHistoryDropdownButton?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const menu = DOMElements.user.userDropdownMenu; if (currentUser) { showWinningHistory(); } else { showNotification("Please log in to view your winning history.", "info"); } if (menu) menu.style.display = 'none'; userProfile?.setAttribute('aria-expanded', 'false'); userProfile?.classList.remove('open'); });
    DOMElements.winningHistoryModal.closeBtnHeader?.addEventListener('click', () => hideModal(DOMElements.winningHistoryModal.modal));
    DOMElements.winningHistoryModal.closeBtnFooter?.addEventListener('click', () => hideModal(DOMElements.winningHistoryModal.modal));
    DOMElements.profileModal.saveBtn?.addEventListener('click', handleProfileSave);
    DOMElements.profileModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.profileModal.cancelBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => { const button = DOMElements.deposit.showDepositModalButton; if (button.disabled && button.title) { showNotification(button.title, 'info'); return; } if (!currentUser) { showNotification('Login Required: Please log in first.', 'error'); return; } if (!currentUser.tradeUrl) { showNotification('Trade URL Required: Please open your profile (click your avatar) and set your Steam Trade URL before depositing.', 'error', 6000); if (DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); } return; } showModal(DOMElements.deposit.depositModal); loadUserInventory(); });
    DOMElements.deposit.closeDepositModalButton?.addEventListener('click', () => hideModal(DOMElements.deposit.depositModal));
    DOMElements.deposit.depositButton?.addEventListener('click', requestDepositOffer);
    DOMElements.deposit.acceptDepositOfferBtn?.addEventListener('click', () => { if (currentDepositOfferURL) { window.open(currentDepositOfferURL, '_blank', 'noopener,noreferrer'); const { depositStatusText } = DOMElements.deposit; if(depositStatusText) depositStatusText.textContent = "Check Steam tab for the offer..."; } else { showNotification("Error: Could not find the trade offer URL.", "error"); } });
    const { modal: ageModal, checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
    if (ageModal && ageCheckbox && ageAgreeButton) { ageCheckbox.addEventListener('change', () => { ageAgreeButton.disabled = !ageCheckbox.checked; }); ageAgreeButton.addEventListener('click', () => { if (ageCheckbox.checked) { localStorage.setItem('ageVerified', 'true'); hideModal(ageModal); window.location.href = '/auth/steam'; } }); ageAgreeButton.disabled = !ageCheckbox.checked; }
    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound);
    window.addEventListener('click', (e) => { const profileModal = DOMElements.profileModal.modal; const whModal = DOMElements.winningHistoryModal.modal; if (userDropdownMenu && userProfile && userDropdownMenu.style.display === 'block' && !userProfile.contains(e.target) && !userDropdownMenu.contains(e.target)) { userDropdownMenu.style.display = 'none'; userProfile.setAttribute('aria-expanded', 'false'); userProfile.classList.remove('open'); } if (e.target === DOMElements.deposit.depositModal) hideModal(DOMElements.deposit.depositModal); if (e.target === profileModal) hideModal(profileModal); if (e.target === whModal) hideModal(whModal); });
    document.addEventListener('keydown', function(event) { const profileModal = DOMElements.profileModal.modal; const depositModal = DOMElements.deposit.depositModal; const whModal = DOMElements.winningHistoryModal.modal; if (event.key === 'Escape') { if (whModal?.style.display === 'flex') hideModal(whModal); else if (profileModal?.style.display === 'flex') hideModal(profileModal); else if (depositModal?.style.display === 'flex') hideModal(depositModal); else if (userDropdownMenu && userDropdownMenu.style.display === 'block') { userDropdownMenu.style.display = 'none'; userProfile?.setAttribute('aria-expanded', 'false'); userProfile?.classList.remove('open'); userProfile?.focus(); } } });
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
    if (!tradeUrlInput || !saveBtn || !currentUser) { showNotification("Not logged in or profile elements missing.", "error"); return; }
    const newTradeUrl = tradeUrlInput.value.trim();
    const urlPattern = /^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/i;
    if (newTradeUrl && !urlPattern.test(newTradeUrl)) { showNotification('Invalid Steam Trade URL format. Please check or leave empty to clear.', 'error', 6000); return; }
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

    // Initialize timer display to default before any data is fetched
    initiateNewRoundVisualReset();

    checkLoginStatus(); // This will eventually call requestRoundData
    setupEventListeners();
    setupSocketConnection();

    showPage(DOMElements.pages.homePage);
    // initiateNewRoundVisualReset(); // Called above already

    if (!ageVerified && DOMElements.ageVerification.modal) {
        const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
        if(ageCheckbox) ageCheckbox.checked = false;
        if(ageAgreeButton) ageAgreeButton.disabled = true;
        showModal(DOMElements.ageVerification.modal);
    }
    updateChatUI();
});

console.log("main.js updated: Timer logic refined, deposit button logic checked.");
