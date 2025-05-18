// main.js - Rust Jackpot Frontend Logic (Refined)
// Part 1 of 2

// Ensure Socket.IO client library is loaded before this script
const socket = io();

// --- Configuration Constants ---
const CONFIG = {
    ROUND_DURATION: 90, // Default timer duration in seconds (should match backend)
    MAX_ITEMS_PER_DEPOSIT: 15, // Max selectable items per deposit action (should match backend)
    MAX_DISPLAY_DEPOSITS: 10, // Max vertical deposit blocks shown visually
    MAX_PARTICIPANTS_DISPLAY: 20, // Max participants allowed (should match backend)
    MAX_ITEMS_PER_POT_FRONTEND: 200, // Max items in pot (should match backend)
    ROULETTE_REPETITIONS: 15, // How many times the user avatars repeat in the roulette for visual length
    SPIN_DURATION_SECONDS: 7, // Duration of the roulette spin animation
    WINNER_INFO_DISPLAY_DURATION: 8000, // How long the inline winner info stays after spin (if no modal)
    ACCEPT_WINNINGS_MODAL_AUTO_CLOSE_MS: 300000, // 5 minutes for winnings modal auto-close
    CONFETTI_COUNT: 120,
    EASE_OUT_POWER: 4, // Lower for a slightly less aggressive ease-out
    LANDING_POSITION_VARIATION: 0.45, // How much the roulette can vary from perfect center (fraction of item width)
    MAX_CHAT_MESSAGES: 50, // Max chat messages to keep in DOM
    CHAT_SEND_COOLDOWN_MS: 3000, // 3 seconds cooldown for sending chat messages
    ROUND_ENDED_RESET_DELAY: 3000, // Delay before UI resets after winner display (if no modal)
};

const COLOR_PALETTE = [ // A palette for user distinction
    '#00bcd4', '#ff5722', '#9c27b0', '#4caf50', '#ffeb3b', '#2196f3', '#f44336', '#ff9800',
    '#e91e63', '#8bc34a', '#3f51b5', '#009688', '#cddc39', '#795548', '#607d8b',
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
    acceptWinningsModal: {
        modal: document.getElementById('acceptWinningsModal'),
        closeBtn: document.getElementById('closeAcceptWinningsModal'),
        offerIdDisplay: document.getElementById('acceptWinningsOfferId'),
        statusText: document.getElementById('acceptWinningsStatusText'),
        acceptOnSteamBtn: document.getElementById('acceptWinningsOnSteamBtn'),
        closeFooterBtn: document.getElementById('acceptWinningsModalCloseFooterBtn')
    },
    winningHistoryModal: {
        modal: document.getElementById('winningHistoryModal'),
        closeBtn: document.getElementById('closeWinningHistoryModal'),
        loadingIndicator: document.getElementById('winning-history-loading'),
        tableBody: document.getElementById('winningHistoryTableBody'),
        noWinningsMessage: document.getElementById('noWinningsMessage'),
        closeFooterBtn: document.getElementById('winningHistoryModalCloseFooterBtn')
    },
    jackpot: {
        potValue: document.getElementById('potValue'),
        timerValue: document.getElementById('timerValue'),
        timerForeground: document.querySelector('.timer-foreground'),
        participantCount: document.getElementById('participantCount'),
        participantsContainer: document.getElementById('itemsContainer'), // Main container for player deposit blocks
        emptyPotMessage: document.getElementById('emptyPotMessage'),
        jackpotHeader: document.getElementById('jackpotHeader'),
    },
    deposit: {
        showDepositModalButton: document.getElementById('showDepositModal'),
        depositModal: document.getElementById('depositModal'),
        closeDepositModalButton: document.getElementById('closeDepositModal'),
        depositButton: document.getElementById('depositButton'), // The "Request Deposit Offer" button
        inventoryItemsContainer: document.getElementById('inventory-items'),
        selectedItemsContainer: document.getElementById('selectedItems'),
        totalValueDisplay: document.getElementById('totalValue'),
        inventoryLoadingIndicator: document.getElementById('inventory-loading'),
        acceptDepositOfferBtn: document.getElementById('acceptDepositOfferBtn'), // "Accept on Steam" button in deposit modal
        depositStatusText: document.getElementById('depositStatusText'),
    },
    roulette: {
        inlineRouletteContainer: document.getElementById('inlineRoulette'),
        rouletteTrack: document.getElementById('rouletteTrack'),
        winnerInfoBox: document.getElementById('winnerInfo'), // Inline display after roulette
        winnerAvatar: document.getElementById('winnerAvatar'),
        winnerName: document.getElementById('winnerName'),
        winnerDeposit: document.getElementById('winnerDeposit'),
        winnerChance: document.getElementById('winnerChance'),
        confettiContainer: document.getElementById('confettiContainer'),
    },
    audio: {
        spinSound: document.getElementById('spinSound'),
        depositSound: document.getElementById('depositSound')
    },
    provablyFair: { // For the "Provably Fair" page section
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

// --- Global State Variables ---
let currentUser = null;
let currentRound = null; // Holds data for the active/pending/rolling/completed round
let selectedItemsList = []; // Items selected by user for deposit
let userInventory = []; // User's inventory fetched from backend
let isSpinning = false; // True when roulette animation is active
let timerActive = false; // True when client-side countdown is running
let roundTimer = null; // Interval ID for client-side timer
let animationFrameId = null; // For requestAnimationFrame
let userColorMap = new Map(); // Assigns colors to users for UI distinction
let notificationTimeout = null;
let currentDepositOfferURL = null; // URL for an active deposit offer
let currentWinningsOfferData = null; // { offerId, offerURL, status } for the winner
let acceptWinningsModalTimeout = null;
let onlineUserCount = 0;
let isChatSendOnCooldown = false;


// --- Utility Functions ---
function showModal(modalElement) {
    if (modalElement) modalElement.style.display = 'flex';
}
function hideModal(modalElement) {
    if (modalElement) modalElement.style.display = 'none';
    if (modalElement === DOMElements.deposit.depositModal) resetDepositModalUI();
    if (modalElement === DOMElements.acceptWinningsModal.modal) {
        resetAcceptWinningsModalUI();
        if (acceptWinningsModalTimeout) clearTimeout(acceptWinningsModalTimeout);
    }
}
window.hideModal = hideModal; // Make globally accessible for HTML onclick

function showPage(pageElement) {
    Object.values(DOMElements.pages).forEach(page => {
        if (page) page.style.display = 'none';
    });
    if (pageElement) pageElement.style.display = 'block';

    document.querySelectorAll('.main-nav a, .secondary-nav a, .primary-nav a')
        .forEach(link => link?.classList.remove('active'));
    let activeLink = Object.values(DOMElements.nav).find(link => link.id.startsWith(pageElement.id.split('-')[0]));
    if (activeLink) activeLink.classList.add('active');

    if (pageElement === DOMElements.pages.fairPage) loadPastRounds();
}
window.showPage = showPage; // Make globally accessible

function getUserColor(userId) {
    if (!userId) return '#7f8c8d'; // Default grey for unknown
    if (!userColorMap.has(userId)) {
        userColorMap.set(userId, COLOR_PALETTE[userColorMap.size % COLOR_PALETTE.length]);
    }
    return userColorMap.get(userId);
}

function showNotification(message, type = 'info', duration = 4000) {
    const bar = DOMElements.notificationBar;
    if (!bar) { console.log(`[${type.toUpperCase()}] ${message}`); return; }
    if (notificationTimeout) clearTimeout(notificationTimeout);
    bar.innerHTML = message; // Allows HTML in message, e.g. links
    bar.className = `notification-bar ${type} show`;
    notificationTimeout = setTimeout(() => {
        bar.classList.remove('show');
        notificationTimeout = null;
    }, duration);
}

// --- Animation Helpers ---
function shuffleArray(array) { // Fisher-Yates shuffle
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}
function easeOutAnimation(t) { // Standard easeOutQuint
    return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), CONFIG.EASE_OUT_POWER);
}

// --- User Authentication & UI ---
async function handleLogout() {
    try {
        const response = await fetch('/logout', { method: 'POST' });
        if (!response.ok) throw new Error((await response.json().catch(()=>({error: 'Logout failed'}))).error);
        currentUser = null;
        updateUserUI(); updateDepositButtonState(); updateChatUI();
        showNotification('Signed out successfully.', 'success');
    } catch (error) {
        showNotification(`Logout failed: ${error.message}`, 'error');
    } finally {
        if (DOMElements.user.userDropdownMenu) DOMElements.user.userDropdownMenu.style.display = 'none';
        DOMElements.user.userProfile?.setAttribute('aria-expanded', 'false');
    }
}

async function checkLoginStatus() {
    try {
        const response = await fetch('/api/user');
        if (response.ok) currentUser = await response.json();
        else currentUser = null;
    } catch (error) {
        currentUser = null;
        if (!error.message.includes("401")) showNotification(`Login check error: ${error.message}`, 'error');
    } finally {
        updateUserUI(); updateDepositButtonState(); updateChatUI();
    }
}

function updateUserUI() {
    const { loginButton, userProfile, userAvatar, userName, pendingOfferIndicator } = DOMElements.user;
    if (!loginButton || !userProfile) return;
    if (currentUser) {
        if (userAvatar) userAvatar.src = currentUser.avatar || '/img/default-avatar.png';
        if (userName) userName.textContent = currentUser.username || 'User';
        loginButton.style.display = 'none';
        userProfile.style.display = 'flex';
        if (pendingOfferIndicator) {
            const hasPending = !!currentUser.pendingDepositOfferId;
            pendingOfferIndicator.style.display = hasPending ? 'inline-block' : 'none';
            pendingOfferIndicator.title = hasPending ? `Pending deposit offer (#${currentUser.pendingDepositOfferId})! View in profile.` : '';
        }
    } else {
        loginButton.style.display = 'flex';
        userProfile.style.display = 'none';
        if (DOMElements.user.userDropdownMenu) DOMElements.user.userDropdownMenu.style.display = 'none';
        userProfile.setAttribute('aria-expanded', 'false');
        if (pendingOfferIndicator) pendingOfferIndicator.style.display = 'none';
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
    if (currentUser.pendingDepositOfferId) {
        const offerId = currentUser.pendingDepositOfferId;
        statusDiv.innerHTML = `<p>⚠️ Pending <a href="https://steamcommunity.com/tradeoffer/${offerId}/" target="_blank" rel="noopener noreferrer" class="profile-pending-link">deposit offer (#${offerId})</a> on Steam.</p>`;
        statusDiv.style.display = 'block';
    } else {
        statusDiv.style.display = 'none';
    }
}

async function handleProfileSave() {
    const { tradeUrlInput, saveBtn } = DOMElements.profileModal;
    if (!tradeUrlInput || !saveBtn || !currentUser) return;
    const newTradeUrl = tradeUrlInput.value.trim();
    if (newTradeUrl && !/^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/i.test(newTradeUrl)) {
        showNotification('Invalid Steam Trade URL format.', 'error'); return;
    }
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
        const response = await fetch('/api/user/tradeurl', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tradeUrl: newTradeUrl }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'Failed to save trade URL.');
        currentUser.tradeUrl = newTradeUrl; // Update local currentUser
        showNotification(newTradeUrl ? 'Trade URL saved!' : 'Trade URL cleared!', 'success');
        updateDepositButtonState(); // Re-check if deposit button should be enabled
        hideModal(DOMElements.profileModal.modal);
    } catch (error) {
        showNotification(`Error saving Trade URL: ${error.message}`, 'error');
    } finally {
        saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
    }
}

// --- Deposit Modal & Inventory Logic ---
function resetDepositModalUI() {
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit;
    if(depositButton) {
        depositButton.disabled = selectedItemsList.length === 0;
        depositButton.style.display = 'inline-block';
        depositButton.textContent = 'Request Deposit Offer';
    }
    if(acceptDepositOfferBtn) {
        acceptDepositOfferBtn.style.display = 'none';
        acceptDepositOfferBtn.removeAttribute('data-offer-url');
    }
    if(depositStatusText) {
        depositStatusText.textContent = '';
        depositStatusText.className = 'deposit-status-text';
    }
    currentDepositOfferURL = null;
}

async function loadUserInventory() {
    const { inventoryItemsContainer, inventoryLoadingIndicator } = DOMElements.deposit;
    resetDepositModalUI();
    selectedItemsList = [];
    if(DOMElements.deposit.selectedItemsContainer) DOMElements.deposit.selectedItemsContainer.innerHTML = '';
    updateTotalValue();

    if(inventoryLoadingIndicator) inventoryLoadingIndicator.style.display = 'flex';
    if(inventoryItemsContainer) inventoryItemsContainer.innerHTML = '';
    try {
        const response = await fetch('/api/inventory');
        if (!response.ok) throw new Error((await response.json().catch(()=>({error: 'Inventory load failed'}))).error);
        userInventory = await response.json();
        if (!Array.isArray(userInventory)) throw new Error('Invalid inventory data.');
        if (userInventory.length === 0) {
            if(inventoryItemsContainer) inventoryItemsContainer.innerHTML = '<p class="empty-inventory-message">Inventory empty or private.</p>';
        } else {
            displayInventoryItems();
        }
    } catch (error) {
        if(inventoryItemsContainer) inventoryItemsContainer.innerHTML = `<p class="error-message">Error loading inventory: ${error.message}</p>`;
    } finally {
        if(inventoryLoadingIndicator) inventoryLoadingIndicator.style.display = 'none';
    }
}

function displayInventoryItems() {
    const container = DOMElements.deposit.inventoryItemsContainer;
    if(!container) return;
    container.innerHTML = '';
    userInventory.forEach(item => {
        if (!item || typeof item.price !== 'number' || !item.assetId || !item.image) return;
        const itemElement = document.createElement('div');
        itemElement.className = 'inventory-item';
        itemElement.dataset.assetId = item.assetId;
        itemElement.title = `$${item.price.toFixed(2)}`;
        itemElement.innerHTML = `
            <img src="${item.image}" alt="Skin Image" loading="lazy" onerror="this.src='/img/default-item.png';">
            <div class="item-details"><div class="item-value">$${item.price.toFixed(2)}</div></div>`;
        if (selectedItemsList.some(selected => selected.assetId === item.assetId)) itemElement.classList.add('selected');
        itemElement.addEventListener('click', () => toggleItemSelection(itemElement, item));
        container.appendChild(itemElement);
    });
}

function toggleItemSelection(element, itemData) {
    const index = selectedItemsList.findIndex(i => i.assetId === itemData.assetId);
    if (index === -1) {
        if (selectedItemsList.length >= CONFIG.MAX_ITEMS_PER_DEPOSIT) {
            showNotification(`Max ${CONFIG.MAX_ITEMS_PER_DEPOSIT} items per deposit.`, 'info'); return;
        }
        selectedItemsList.push(itemData);
        element.classList.add('selected');
        addSelectedItemElement(itemData);
    } else {
        selectedItemsList.splice(index, 1);
        element.classList.remove('selected');
        removeSelectedItemElement(itemData.assetId);
    }
    updateTotalValue();
    if(DOMElements.deposit.depositButton) DOMElements.deposit.depositButton.disabled = selectedItemsList.length === 0;
}

function addSelectedItemElement(item) {
    const container = DOMElements.deposit.selectedItemsContainer;
    if(!container) return;
    const selectedElement = document.createElement('div');
    selectedElement.className = 'selected-item-display';
    selectedElement.dataset.assetId = item.assetId;
    selectedElement.title = `$${item.price.toFixed(2)}`;
    selectedElement.innerHTML = `
        <img src="${item.image}" alt="Selected Skin" loading="lazy" onerror="this.src='/img/default-item.png';">
        <div class="item-value">$${item.price.toFixed(2)}</div>
        <button class="remove-item-btn" data-asset-id="${item.assetId}" aria-label="Remove">&times;</button>`;
    selectedElement.querySelector('.remove-item-btn').addEventListener('click', (e) => {
        e.stopPropagation(); removeSelectedItem(e.target.dataset.assetId);
    });
    selectedElement.addEventListener('click', () => removeSelectedItem(item.assetId));
    container.appendChild(selectedElement);
}

function removeSelectedItemElement(assetId) {
    DOMElements.deposit.selectedItemsContainer?.querySelector(`.selected-item-display[data-asset-id="${assetId}"]`)?.remove();
}

function removeSelectedItem(assetId) {
    selectedItemsList = selectedItemsList.filter(item => item.assetId !== assetId);
    DOMElements.deposit.inventoryItemsContainer?.querySelector(`.inventory-item[data-asset-id="${assetId}"]`)?.classList.remove('selected');
    removeSelectedItemElement(assetId);
    updateTotalValue();
    if(DOMElements.deposit.depositButton) DOMElements.deposit.depositButton.disabled = selectedItemsList.length === 0;
}

function updateTotalValue() {
    const total = selectedItemsList.reduce((sum, item) => sum + (item.price || 0), 0);
    if(DOMElements.deposit.totalValueDisplay) DOMElements.deposit.totalValueDisplay.textContent = `$${total.toFixed(2)}`;
}

async function requestDepositOffer() {
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit;
    if (!depositButton || !acceptDepositOfferBtn || !depositStatusText) return;

    if (selectedItemsList.length === 0) { showNotification('No items selected.', 'info'); return; }

    if (!currentRound || !['pending', 'active'].includes(currentRound.status) || isSpinning) {
        let msg = 'Deposits currently closed.';
        if (isSpinning) msg = 'Round is currently rolling.';
        else if (currentRound && currentRound.status === 'rolling') msg = 'Round is rolling.';
        else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'error')) msg = 'Round has ended.';
        showNotification(msg, 'error');
        return;
    }

    if (currentUser?.pendingDepositOfferId) {
        showNotification('Existing pending deposit offer. View in profile.', 'error');
        populateProfileModal(); showModal(DOMElements.profileModal.modal); return;
    }
    const currentParticipants = currentRound.participants?.length || 0;
    const isNewP = !currentRound.participants?.some(p => p.user?._id === currentUser?._id);
    if (isNewP && currentParticipants >= CONFIG.MAX_PARTICIPANTS_DISPLAY) {
        showNotification(`Participant limit (${CONFIG.MAX_PARTICIPANTS_DISPLAY}) reached.`, 'error'); return;
    }
    const currentItemCountInPot = currentRound.items?.length || 0;
    if (currentItemCountInPot + selectedItemsList.length > CONFIG.MAX_ITEMS_PER_POT_FRONTEND) {
        showNotification(`Pot item limit (${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}) would be exceeded.`, 'error'); return;
    }

    depositButton.disabled = true; depositButton.textContent = 'Requesting...';
    acceptDepositOfferBtn.style.display = 'none';
    depositStatusText.textContent = 'Creating deposit offer...'; depositStatusText.className = 'deposit-status-text info';

    try {
        const assetIds = selectedItemsList.map(item => item.assetId);
        const response = await fetch('/api/deposit', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetIds }),
        });
        const result = await response.json();
        if (!response.ok) {
            if (response.status === 409 && result.offerURL && result.offerId) {
                depositStatusText.textContent = `You have a pending offer! Click 'Accept on Steam'.`;
                depositStatusText.className = 'deposit-status-text warning';
                currentDepositOfferURL = result.offerURL;
                acceptDepositOfferBtn.style.display = 'inline-block'; acceptDepositOfferBtn.disabled = false;
                depositButton.style.display = 'none';
                if (currentUser) currentUser.pendingDepositOfferId = result.offerId; updateUserUI();
                return;
            }
            throw new Error(result.error || `Failed to create offer (${response.status})`);
        }
        if (!result.success || !result.offerURL || !result.offerId) throw new Error(result.error || 'Invalid offer response.');

        depositStatusText.textContent = "Offer created! Accept on Steam."; depositStatusText.className = 'deposit-status-text success';
        currentDepositOfferURL = result.offerURL;
        depositButton.style.display = 'none';
        acceptDepositOfferBtn.style.display = 'inline-block'; acceptDepositOfferBtn.disabled = false;
        if (currentUser) currentUser.pendingDepositOfferId = result.offerId; updateUserUI();
    } catch (error) {
        depositStatusText.textContent = `Error: ${error.message}`; depositStatusText.className = 'deposit-status-text error';
        resetDepositModalUI();
        if (currentUser && currentUser.pendingDepositOfferId && error.message !== `You have a pending offer! Click 'Accept on Steam'.`) {
            currentUser.pendingDepositOfferId = null; updateUserUI();
        }
    }
}

// main.js - Rust Jackpot Frontend Logic (Refined)
// Part 2 of 2

// --- Round UI & Timer ---
function updateRoundUI() {
    const { potValue, participantCount } = DOMElements.jackpot;
    if (!currentRound || !potValue || !participantCount) return;

    potValue.textContent = `$${(currentRound.totalValue || 0).toFixed(2)}`;
    const participantNum = currentRound.participants?.length || 0;
    participantCount.textContent = `${participantNum}/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;

    if (!timerActive) {
        updateTimerUI(currentRound.timeLeft !== undefined ? currentRound.timeLeft : CONFIG.ROUND_DURATION);
    }
    updateDepositButtonState();
}

function updateTimerUI(timeLeft) {
    const { timerValue, timerForeground } = DOMElements.jackpot;
    if (!timerValue || !timerForeground) return;

    const timeToShow = Math.max(0, Math.round(timeLeft));
    let displayValue = timeToShow.toString();

    if (currentRound && currentRound.status === 'pending') {
        displayValue = "Ready"; // Or CONFIG.ROUND_DURATION.toString();
        updateTimerCircle(CONFIG.ROUND_DURATION, CONFIG.ROUND_DURATION);
    } else if (isSpinning || (currentRound && currentRound.status === 'rolling')) {
        displayValue = "Rolling";
    } else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'error')) {
        displayValue = "Ended";
    } else if (!timerActive && timeToShow <= 0 && currentRound && currentRound.status === 'active' && currentRound.participants?.length > 0) {
        displayValue = "0";
    } else if (!currentRound && !timerActive) {
        displayValue = "--";
    }

    timerValue.textContent = displayValue;

    if (currentRound && currentRound.status === 'active') {
        const totalDuration = (currentRound.startTime && currentRound.endTime)
            ? (new Date(currentRound.endTime).getTime() - new Date(currentRound.startTime).getTime()) / 1000
            : CONFIG.ROUND_DURATION;
        updateTimerCircle(timeToShow, Math.max(1, totalDuration));
    } else if (!currentRound || currentRound.status !== 'pending') { // Clear circle if not active or specifically pending
         updateTimerCircle(0, CONFIG.ROUND_DURATION); // Effectively empty
    }


    timerValue.classList.toggle('urgent-pulse', timerActive && timeToShow <= 10 && timeToShow > 0 && currentRound && currentRound.status === 'active');
    timerValue.classList.toggle('timer-pulse', timerActive && timeToShow > 10 && currentRound && currentRound.status === 'active');
}

function updateTimerCircle(timeLeft, totalTime) {
    const circle = DOMElements.jackpot.timerForeground;
    if (!circle || !(circle instanceof SVGCircleElement) || !circle.r?.baseVal?.value) return;
    const radius = circle.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    const progress = Math.min(1, Math.max(0, timeLeft / Math.max(1, totalTime)));
    circle.style.strokeDasharray = `${circumference}`;
    circle.style.strokeDashoffset = `${circumference * (1 - progress)}`;
}

function startClientTimer(initialTime = CONFIG.ROUND_DURATION) {
    if (roundTimer) clearInterval(roundTimer);
    if (!currentRound || currentRound.status !== 'active' || (currentRound.participants && currentRound.participants.length === 0)) {
        timerActive = false;
        updateTimerUI(currentRound ? currentRound.timeLeft : CONFIG.ROUND_DURATION);
        return;
    }

    let timeLeft = Math.max(0, initialTime);
    timerActive = true;
    updateTimerUI(timeLeft);

    roundTimer = setInterval(() => {
        if (!timerActive || !currentRound || currentRound.status !== 'active') {
            clearInterval(roundTimer); roundTimer = null; timerActive = false;
            updateDepositButtonState();
            return;
        }
        timeLeft--;
        if (currentRound) currentRound.timeLeft = timeLeft;
        updateTimerUI(timeLeft);
        updateDepositButtonState();
        if (timeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null; timerActive = false;
        }
    }, 1000);
}

function updateDepositButtonState() {
    const btn = DOMElements.deposit.showDepositModalButton;
    if (!btn) return;

    let disabled = true;
    let title = "Log in to deposit.";
    let buttonText = "DEPOSIT SKINS";

    if (currentUser) {
        if (!currentUser.tradeUrl) {
            title = "Set your Trade URL in profile to deposit.";
        } else if (isSpinning || (currentRound && currentRound.status === 'rolling')) {
            title = "Round is currently rolling.";
            buttonText = "ROLLING...";
        } else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'error')) {
            title = "Round has ended. Waiting for next round.";
            buttonText = "ROUND ENDED";
        } else if (currentRound && (currentRound.status === 'pending' || currentRound.status === 'active')) {
            disabled = false;
            title = "Deposit Skins";
            buttonText = (currentRound.status === 'pending') ? "DEPOSIT (NEW ROUND)" : "DEPOSIT SKINS";
        } else if (!currentRound) {
            title = "Loading round...";
            buttonText = "LOADING...";
        }
    }

    btn.disabled = disabled;
    btn.title = title;
    btn.textContent = buttonText;
}


// --- Participant & Item Display ---
function displayLatestDeposit(depositData) {
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (!container || !emptyMsg) return;

    const userId = depositData.userId || depositData.user?._id;
    if (!userId) { console.error("displayLatestDeposit: Invalid user ID", depositData); return; }

    const userColor = getUserColor(userId);
    const items = depositData.depositedItems || [];
    const participantDataInCurrentRound = currentRound?.participants?.find(p => (p.user?._id || p.user?.id) === userId);
    const cumulativeValueForUser = participantDataInCurrentRound?.itemsValue || depositData.itemsValue || 0;
    const currentTotalPotValue = Math.max(0.01, currentRound?.totalValue || 0.01);
    const percentage = ((cumulativeValueForUser / currentTotalPotValue) * 100).toFixed(1);

    let depositContainer = container.querySelector(`.player-deposit-container[data-user-id="${userId}"]`);
    let isNewBlock = false;
    if (!depositContainer) {
        isNewBlock = true;
        depositContainer = document.createElement('div');
        depositContainer.dataset.userId = userId;
        depositContainer.className = 'player-deposit-container player-deposit-new';
        const depositHeader = document.createElement('div');
        depositHeader.className = 'player-deposit-header';
        depositHeader.innerHTML = `
            <img src="${depositData.avatar || '/img/default-avatar.png'}" alt="${depositData.username || 'User'}" class="player-avatar" style="border-color: ${userColor};">
            <div class="player-info">
                <div class="player-name" title="${depositData.username || 'User'}">${depositData.username || 'User'}</div>
                <div class="player-deposit-value" style="color: ${userColor};" title="Value: $${cumulativeValueForUser.toFixed(2)} | Chance: ${percentage}%">
                    $${cumulativeValueForUser.toFixed(2)} | ${percentage}%
                </div>
            </div>`;
        const itemsGrid = document.createElement('div');
        itemsGrid.className = 'player-items-grid';
        depositContainer.append(depositHeader, itemsGrid);
        if (container.firstChild) container.insertBefore(depositContainer, container.firstChild);
        else container.appendChild(depositContainer);
    } else {
        const valueElem = depositContainer.querySelector('.player-deposit-value');
        if(valueElem) {
            valueElem.textContent = `$${cumulativeValueForUser.toFixed(2)} | ${percentage}%`;
            valueElem.title = `Value: $${cumulativeValueForUser.toFixed(2)} | Chance: ${percentage}%`;
        }
        if (container.firstChild !== depositContainer) {
            container.insertBefore(depositContainer, container.firstChild);
        }
    }

    const itemsGrid = depositContainer.querySelector('.player-items-grid');
    if (isNewBlock && itemsGrid) itemsGrid.innerHTML = '';

    if (itemsGrid) {
        items.sort((a, b) => (b.price || 0) - (a.price || 0)).slice(0, CONFIG.MAX_ITEMS_PER_DEPOSIT).forEach(item => {
            const itemElement = document.createElement('div');
            itemElement.className = 'player-deposit-item';
            itemElement.title = `$${(item.price || 0).toFixed(2)}`;
            itemElement.style.borderColor = userColor;
            itemElement.innerHTML = `
                <img src="${item.image}" alt="Deposited Item" class="player-deposit-item-image" onerror="this.src='/img/default-item.png';">
                <div class="player-deposit-item-info"><div class="player-deposit-item-value" style="color: ${userColor};">$${(item.price || 0).toFixed(2)}</div></div>`;
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

    if (isNewBlock) {
        setTimeout(() => depositContainer.classList.remove('player-deposit-new'), 500);
    }
    emptyMsg.style.display = 'none';

    const currentBlocks = container.querySelectorAll('.player-deposit-container');
    if (currentBlocks.length > CONFIG.MAX_DISPLAY_DEPOSITS) {
        currentBlocks[currentBlocks.length - 1].remove();
    }
    DOMElements.audio.depositSound?.play().catch(e => console.warn("Deposit sound play error:", e));
}

function updateAllParticipantPercentages() {
    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) return;
    const container = DOMElements.jackpot.participantsContainer;
    const currentTotalPotValue = Math.max(0.01, currentRound.totalValue || 0.01);

    currentRound.participants.forEach(pData => {
        const userId = pData.user?._id || pData.user?.id;
        if (!userId) return;
        const block = container.querySelector(`.player-deposit-container[data-user-id="${userId}"]`);
        if (block) {
            const valueElement = block.querySelector('.player-deposit-value');
            const userValue = pData.itemsValue || 0;
            const percentage = ((userValue / currentTotalPotValue) * 100).toFixed(1);
            if (valueElement) {
                valueElement.textContent = `$${userValue.toFixed(2)} | ${percentage}%`;
                valueElement.title = `Value: $${userValue.toFixed(2)} | Chance: ${percentage}%`;
            }
        }
    });
}

// --- Roulette Animation & Winner Display ---
function createRouletteItems() { /* ... (no changes from previous provided full version) ... */ }
function switchToRouletteView() { /* ... (no changes from previous provided full version) ... */ }
function startRouletteAnimation(winnerDataFromEvent) { /* ... (no changes from previous provided full version) ... */ }
function handleRouletteSpinAnimation(winnerId, winnerDisplayData) { /* ... (no changes from previous provided full version) ... */ }
function finalizeSpin(winningElementDOM, winnerData) { /* ... (no changes from previous provided full version) ... */ }
function handleSpinEndVisuals(winnerData) { /* ... (no changes from previous provided full version) ... */ }
function launchConfetti(mainColor) { /* ... (no changes from previous provided full version) ... */ }
function clearConfetti() { /* ... (no changes from previous provided full version) ... */ }
function lightenColor(hex, percent) { /* ... (no changes from previous provided full version) ... */ }
function darkenColor(hex, percent) { /* ... (no changes from previous provided full version) ... */ }

function resetToJackpotView() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null;
    if (roundTimer) clearInterval(roundTimer); roundTimer = null;
    timerActive = false; isSpinning = false;
    currentWinningsOfferData = null;
    if (acceptWinningsModalTimeout) clearTimeout(acceptWinningsModalTimeout);

    const { jackpotHeader } = DOMElements.jackpot;
    const { inlineRouletteContainer, winnerInfoBox, rouletteTrack } = DOMElements.roulette;

    DOMElements.audio.spinSound?.pause();
    if (DOMElements.audio.spinSound) DOMElements.audio.spinSound.currentTime = 0;

    if(inlineRouletteContainer) inlineRouletteContainer.style.opacity = '0';
    if(winnerInfoBox) winnerInfoBox.style.opacity = '0';
    clearConfetti();

    setTimeout(() => {
        if(jackpotHeader) jackpotHeader.classList.remove('roulette-mode');
        if(rouletteTrack) rouletteTrack.innerHTML = '';
        if(inlineRouletteContainer) inlineRouletteContainer.style.display = 'none';
        if(winnerInfoBox) { winnerInfoBox.style.display = 'none'; winnerInfoBox.style.animation = '';}

        ['.jackpot-value', '.jackpot-timer', '.jackpot-stats'].forEach(sel => {
            const el = jackpotHeader?.querySelector(sel);
            if (el) { el.style.display = 'flex'; el.style.opacity = '1'; }
        });
        if (DOMElements.deposit.showDepositModalButton?.parentElement) {
             DOMElements.deposit.showDepositModalButton.parentElement.style.display = 'flex';
        }
        updateDepositButtonState();
        if (socket?.connected) socket.emit('requestRoundData');
    }, CONFIG.ROUND_ENDED_RESET_DELAY);
}


function initiateNewRoundVisualReset() {
    if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Ready";
    updateTimerCircle(CONFIG.ROUND_DURATION, CONFIG.ROUND_DURATION);
    DOMElements.jackpot.timerValue?.classList.remove('urgent-pulse', 'timer-pulse');
    if (roundTimer) clearInterval(roundTimer); roundTimer = null; timerActive = false;

    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (container) container.innerHTML = '';
    if (emptyMsg && container) container.appendChild(emptyMsg);
    if (emptyMsg) emptyMsg.style.display = 'block';

    if(DOMElements.jackpot.potValue) DOMElements.jackpot.potValue.textContent = "$0.00";
    if(DOMElements.jackpot.participantCount) DOMElements.jackpot.participantCount.textContent = `0/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
    userColorMap.clear();
    updateDepositButtonState();
}

// --- Accept Winnings Modal ---
function resetAcceptWinningsModalUI() { /* ... (no changes from previous provided full version) ... */ }
function displayAcceptWinningsModal(offerData) { /* ... (no changes from previous provided full version) ... */ }
function resetToJackpotViewIfNeeded() { /* ... (no changes from previous provided full version) ... */ }

// --- Winning History ---
async function loadWinningHistory() { /* ... (no changes from previous provided full version) ... */ }

// --- Provably Fair & Past Rounds Logic ---
async function verifyRound() { /* ... (no changes from previous provided full version) ... */ }
async function loadPastRounds(page = 1) { /* ... (no changes from previous provided full version) ... */ }
window.populateVerificationFields = function(roundId, serverSeed, clientSeed) { /* ... (no changes from previous provided full version) ... */ };
function createPagination(currentPage, totalPages) { /* ... (no changes from previous provided full version) ... */ }

// --- Chat Functionality ---
function updateChatUI() { /* ... (no changes from previous provided full version) ... */ }
function displayChatMessage(data) { /* ... (no changes from previous provided full version) ... */ }
function handleSendMessage() { /* ... (no changes from previous provided full version) ... */ }
function setupChatEventListeners() { /* ... (no changes from previous provided full version) ... */ }
function updateChatOnlineUsers(count) { /* ... (no changes from previous provided full version) ... */ }


// --- Socket Event Handlers ---
function setupSocketConnection() {
    socket.on('connect', () => {
        showNotification('Connected.', 'success', 2000);
        socket.emit('requestRoundData');
    });
    socket.on('disconnect', (reason) => {
        showNotification('Disconnected. Trying to reconnect...', 'error', 5000);
        updateDepositButtonState(); updateChatOnlineUsers(0); timerActive = false;
        if (roundTimer) clearInterval(roundTimer); roundTimer = null;
    });
    socket.on('connect_error', () => showNotification('Connection Error. Refresh page.', 'error', 10000));

    socket.on('roundCreated', (data) => {
        currentRound = data;
        initiateNewRoundVisualReset();
        updateRoundUI(); // Will also call updateTimerUI for 'pending' state
    });
    socket.on('roundStatusUpdate', (data) => {
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = data.status;
            currentRound.startTime = data.startTime;
            currentRound.endTime = data.endTime;
            if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !timerActive) {
                startClientTimer(currentRound.timeLeft);
            } else if (currentRound.status === 'active' && currentRound.participants?.length === 0) {
                 if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
                 updateTimerUI(CONFIG.ROUND_DURATION);
            } else if (currentRound.status === 'pending') {
                if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
                updateTimerUI(CONFIG.ROUND_DURATION);
            }
            updateDepositButtonState();
        }
    });
    socket.on('participantUpdated', (data) => {
        if (currentRound && currentRound.roundId === data.roundId) {
            let pIndex = currentRound.participants.findIndex(p => (p.user?._id || p.user?.id) === data.userId);
            const participantUserObject = { _id: data.userId, id: data.userId, username: data.username, avatar: data.avatar };
            if (pIndex !== -1) {
                currentRound.participants[pIndex].itemsValue = data.itemsValue;
                currentRound.participants[pIndex].tickets = data.tickets;
            } else {
                currentRound.participants.push({ user: participantUserObject, itemsValue: data.itemsValue, tickets: data.tickets });
            }
            currentRound.totalValue = data.totalValue;
             (data.depositedItems || []).forEach(item => {
                if (!currentRound.items.find(i => i.assetId === item.assetId && (i.owner?.toString() === data.userId))) {
                     currentRound.items.push({ ...item, owner: data.userId });
                }
            });
            displayLatestDeposit(data);
            updateAllParticipantPercentages();
            updateRoundUI();
            if (currentUser && (currentUser._id === data.userId || currentUser.id === data.userId) && currentUser.pendingDepositOfferId) {
                 currentUser.pendingDepositOfferId = null; updateUserUI(); updateDepositButtonState();
                 if (DOMElements.deposit.depositModal?.style.display === 'flex') resetDepositModalUI();
            }
            if (currentRound.status === 'active' && currentRound.participants.length > 0 && !timerActive && currentRound.endTime) {
                 // Check if this deposit activated the round
                const isFirstDepositMakingActive = currentRound.participants.length === 1 && currentRound.startTime && currentRound.endTime;
                if(isFirstDepositMakingActive){
                    const timeRemaining = Math.max(0, (new Date(currentRound.endTime).getTime() - Date.now()) / 1000);
                    startClientTimer(timeRemaining);
                }
            }
        } else { socket.emit('requestRoundData'); }
    });
    socket.on('timerUpdate', (data) => {
        if (currentRound && currentRound.roundId === data.roundId && timerActive) {
            currentRound.timeLeft = data.timeLeft;
            updateTimerUI(data.timeLeft);
        } else if (currentRound && currentRound.roundId === data.roundId && !timerActive && currentRound.status === 'active' && currentRound.participants?.length > 0) {
            startClientTimer(data.timeLeft);
        }
    });
    socket.on('roundRolling', (data) => {
        if (currentRound && currentRound.roundId === data.roundId) {
            if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
            updateTimerUI(0);
            currentRound.status = 'rolling'; isSpinning = true;
            updateDepositButtonState();
            switchToRouletteView();
        }
    });
    socket.on('roundWinner', (data) => {
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.winner = data.winner;
            currentRound.serverSeed = data.serverSeed; currentRound.clientSeed = data.clientSeed;
            currentRound.provableHash = data.provableHash;
            startRouletteAnimation(data.winner);
        } else { socket.emit('requestRoundData'); }
    });
    socket.on('tradeOfferSent', (data) => {
        if (currentUser && data.userId === (currentUser._id || currentUser.id) && data.type === 'winning') {
            currentWinningsOfferData = data;
            if (!isSpinning) {
                displayAcceptWinningsModal(data);
            }
            showNotification(`Winnings Sent! <a href="${data.offerURL}" target="_blank" class="notification-link">Accept on Steam</a> (#${data.offerId})`, 'success', 15000);
        }
    });
    socket.on('roundCompleted', (data) => {
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound = data;
            if (!isSpinning && !currentWinningsOfferData && DOMElements.acceptWinningsModal.modal.style.display !== 'flex') {
                setTimeout(resetToJackpotView, CONFIG.ROUND_ENDED_RESET_DELAY / 2); // Quicker reset if no modals
            }
        }
    });
    socket.on('roundError', (data) => {
        showNotification(`Round Error (ID: ${data.roundId}): ${data.error || 'Unknown issue.'}`, 'error');
        resetToJackpotView();
    });
    socket.on('roundData', (data) => {
        const oldRoundId = currentRound?.roundId;
        currentRound = data;

        if (!oldRoundId || oldRoundId !== currentRound.roundId || currentRound.status === 'pending') {
            initiateNewRoundVisualReset();
        }

        updateRoundUI();

        const participantsContainer = DOMElements.jackpot.participantsContainer;
        if (participantsContainer) {
            participantsContainer.innerHTML = '';
            if (currentRound.participants && currentRound.participants.length > 0) {
                if(DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'none';
                currentRound.participants.forEach(p => {
                    const participantItems = currentRound.items?.filter(item => item.owner && (item.owner.toString() === (p.user._id || p.user.id).toString())) || [];
                    displayLatestDeposit({
                        userId: p.user._id || p.user.id, username: p.user.username, avatar: p.user.avatar,
                        itemsValue: p.itemsValue, depositedItems: participantItems
                    });
                    const element = participantsContainer.querySelector(`.player-deposit-container[data-user-id="${p.user._id || p.user.id}"]`);
                    if (element) element.classList.remove('player-deposit-new');
                });
                updateAllParticipantPercentages();
            } else {
                if (DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'block';
            }
        }

        if (currentRound.status === 'active') {
            if (currentRound.participants?.length > 0 && currentRound.timeLeft > 0) {
                if (!timerActive) startClientTimer(currentRound.timeLeft);
            } else {
                if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
                updateTimerUI(currentRound.timeLeft <=0 && currentRound.participants?.length > 0 ? 0 : CONFIG.ROUND_DURATION);
            }
        } else if (currentRound.status === 'pending') {
            if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
            updateTimerUI(CONFIG.ROUND_DURATION);
        } else if (['rolling', 'completed', 'error'].includes(currentRound.status)) {
            if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
            updateTimerUI(0);
        }

        if (currentRound.status === 'rolling' && currentRound.winner && !isSpinning) {
             startRouletteAnimation(currentRound.winner);
        } else if ((currentRound.status === 'completed' || currentRound.status === 'error') && !isSpinning && !currentWinningsOfferData && (!DOMElements.acceptWinningsModal.modal || DOMElements.acceptWinningsModal.modal.style.display !== 'flex')) {
             resetToJackpotView();
        }
        updateDepositButtonState();
    });

    socket.on('notification', (data) => {
        if (!data.userId || (currentUser && data.userId === (currentUser._id || currentUser.id))) {
            showNotification(data.message, data.type || 'info', data.duration);
        }
    });
    socket.on('chatMessage', (data) => displayChatMessage(data));
    socket.on('updateUserCount', (count) => updateChatOnlineUsers(count));
}

// --- Event Listeners Setup ---
function setupEventListeners() {
    Object.keys(DOMElements.nav).forEach(key => {
        DOMElements.nav[key]?.addEventListener('click', (e) => {
            e.preventDefault();
            const pageKey = key.replace('Link', 'Page');
            if (DOMElements.pages[pageKey]) showPage(DOMElements.pages[pageKey]);
        });
    });

    DOMElements.user.loginButton?.addEventListener('click', () => {
        if (localStorage.getItem('ageVerified') === 'true') window.location.href = '/auth/steam';
        else {
            if(DOMElements.ageVerification.checkbox) DOMElements.ageVerification.checkbox.checked = false;
            if(DOMElements.ageVerification.agreeButton) DOMElements.ageVerification.agreeButton.disabled = true;
            showModal(DOMElements.ageVerification.modal);
        }
    });
    DOMElements.user.userProfile?.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = DOMElements.user.userDropdownMenu;
        if(!menu) return;
        const isVisible = menu.style.display === 'block';
        menu.style.display = isVisible ? 'none' : 'block';
        DOMElements.user.userProfile.setAttribute('aria-expanded', String(!isVisible));
    });
    DOMElements.user.logoutButton?.addEventListener('click', (e) => { e.stopPropagation(); handleLogout(); });
    DOMElements.user.profileDropdownButton?.addEventListener('click', (e) => {
        e.stopPropagation(); if(DOMElements.user.userDropdownMenu) DOMElements.user.userDropdownMenu.style.display = 'none';
        if (currentUser) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
        else showNotification("Log in to view profile.", "info");
    });
    DOMElements.user.winningHistoryDropdownButton?.addEventListener('click', (e) => {
        e.stopPropagation(); if(DOMElements.user.userDropdownMenu) DOMElements.user.userDropdownMenu.style.display = 'none';
        if (currentUser) loadWinningHistory(); else showNotification("Log in to view history.", "info");
    });
    DOMElements.profileModal.saveBtn?.addEventListener('click', handleProfileSave);
    DOMElements.profileModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.profileModal.cancelBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));

    const awModal = DOMElements.acceptWinningsModal;
    [awModal.closeBtn, awModal.closeFooterBtn].forEach(btn => btn?.addEventListener('click', () => { hideModal(awModal.modal); resetToJackpotViewIfNeeded(); }));
    awModal.acceptOnSteamBtn?.addEventListener('click', () => {
        const url = awModal.acceptOnSteamBtn.getAttribute('data-offer-url');
        if (url) { window.open(url, '_blank'); if(awModal.statusText) awModal.statusText.textContent = "Offer opened in new tab."; setTimeout(() => { hideModal(awModal.modal); resetToJackpotViewIfNeeded(); }, 2000); }
        else showNotification("Error: Trade offer URL missing.", "error");
    });

    const whModal = DOMElements.winningHistoryModal;
    [whModal.closeBtn, whModal.closeFooterBtn].forEach(btn => btn?.addEventListener('click', () => hideModal(whModal.modal)));

    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => {
        const btn = DOMElements.deposit.showDepositModalButton;
        if (btn.disabled) { showNotification(btn.title || 'Deposits closed.', 'info'); return; }
        if (!currentUser) { showNotification('Log in to deposit.', 'error'); return; }
        if (!currentUser.tradeUrl) { showNotification('Set your Trade URL in profile first.', 'error', 6000); populateProfileModal(); showModal(DOMElements.profileModal.modal); return;}
        showModal(DOMElements.deposit.depositModal); loadUserInventory();
    });
    DOMElements.deposit.closeDepositModalButton?.addEventListener('click', () => hideModal(DOMElements.deposit.depositModal));
    DOMElements.deposit.depositButton?.addEventListener('click', requestDepositOffer);
    DOMElements.deposit.acceptDepositOfferBtn?.addEventListener('click', () => {
        if (currentDepositOfferURL) window.open(currentDepositOfferURL, '_blank');
        else showNotification("Error: Deposit offer URL missing.", "error");
    });

    const avModalElements = DOMElements.ageVerification;
    avModalElements.checkbox?.addEventListener('change', () => { if(avModalElements.agreeButton) avModalElements.agreeButton.disabled = !avModalElements.checkbox.checked; });
    avModalElements.agreeButton?.addEventListener('click', () => {
        if (avModalElements.checkbox?.checked) { localStorage.setItem('ageVerified', 'true'); hideModal(avModalElements.modal); window.location.href = '/auth/steam'; }
    });

    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound);

    window.addEventListener('click', (e) => {
        if (DOMElements.user.userDropdownMenu?.style.display === 'block' && !DOMElements.user.userProfile?.contains(e.target) && !DOMElements.user.userDropdownMenu.contains(e.target)) {
            DOMElements.user.userDropdownMenu.style.display = 'none'; DOMElements.user.userProfile?.setAttribute('aria-expanded', 'false');
        }
        [DOMElements.deposit.depositModal, DOMElements.profileModal.modal, awModal.modal, whModal.modal].forEach(modal => {
            if (modal && modal.style.display === 'flex' && e.target === modal) {
                hideModal(modal);
                if (modal === awModal.modal) resetToJackpotViewIfNeeded();
            }
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            let modalHidden = false;
            [awModal.modal, DOMElements.profileModal.modal, DOMElements.deposit.depositModal, whModal.modal].forEach(modal => {
                if (modal?.style.display === 'flex') { hideModal(modal); if (modal === awModal.modal) resetToJackpotViewIfNeeded(); modalHidden = true;}
            });
            if (!modalHidden && DOMElements.user.userDropdownMenu?.style.display === 'block') {
                DOMElements.user.userDropdownMenu.style.display = 'none'; DOMElements.user.userProfile?.setAttribute('aria-expanded', 'false');
            }
        }
    });
    setupChatEventListeners();
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    checkLoginStatus();
    setupEventListeners();
    setupSocketConnection();
    showPage(DOMElements.pages.homePage);
    initiateNewRoundVisualReset();
    if (localStorage.getItem('ageVerified') !== 'true' && DOMElements.ageVerification.modal) {
        if(DOMElements.ageVerification.checkbox) DOMElements.ageVerification.checkbox.checked = false;
        if(DOMElements.ageVerification.agreeButton) DOMElements.ageVerification.agreeButton.disabled = true;
        showModal(DOMElements.ageVerification.modal);
    }
    updateChatUI();
});
