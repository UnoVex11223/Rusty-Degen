// main.js - Rust Jackpot Frontend Logic (Refined)
// Part 1 of 2

// Ensure Socket.IO client library is loaded before this script
const socket = io();

// --- Configuration Constants ---
const CONFIG = {
    ROUND_DURATION: 90, // Default timer duration in seconds. Player deposit starts countdown from this value.
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
    depositButton.disabled = selectedItemsList.length === 0;
    depositButton.style.display = 'inline-block';
    depositButton.textContent = 'Request Deposit Offer';
    acceptDepositOfferBtn.style.display = 'none';
    acceptDepositOfferBtn.removeAttribute('data-offer-url');
    depositStatusText.textContent = '';
    depositStatusText.className = 'deposit-status-text';
    currentDepositOfferURL = null;
}

async function loadUserInventory() {
    const { inventoryItemsContainer, inventoryLoadingIndicator } = DOMElements.deposit;
    resetDepositModalUI(); // Reset buttons and status text
    selectedItemsList = []; // Clear previous selection
    DOMElements.deposit.selectedItemsContainer.innerHTML = '';
    updateTotalValue();     // Update total value display to $0.00

    inventoryLoadingIndicator.style.display = 'flex';
    inventoryItemsContainer.innerHTML = '';
    try {
        const response = await fetch('/api/inventory');
        if (!response.ok) throw new Error((await response.json().catch(()=>({error: 'Inventory load failed'}))).error);
        userInventory = await response.json();
        if (!Array.isArray(userInventory)) throw new Error('Invalid inventory data.');
        if (userInventory.length === 0) {
            inventoryItemsContainer.innerHTML = '<p class="empty-inventory-message">Inventory empty or private.</p>';
        } else {
            displayInventoryItems();
        }
    } catch (error) {
        inventoryItemsContainer.innerHTML = `<p class="error-message">Error loading inventory: ${error.message}</p>`;
    } finally {
        inventoryLoadingIndicator.style.display = 'none';
    }
}

function displayInventoryItems() {
    const container = DOMElements.deposit.inventoryItemsContainer;
    container.innerHTML = ''; // Clear previous items
    userInventory.forEach(item => {
        if (!item || typeof item.price !== 'number' || !item.assetId || !item.image) return;
        const itemElement = document.createElement('div');
        itemElement.className = 'inventory-item';
        itemElement.dataset.assetId = item.assetId; // Store all item data for easy access
        itemElement.title = `$${item.price.toFixed(2)}`;
        itemElement.innerHTML = \`
            <img src="\${item.image}" alt="Skin Image" loading="lazy" onerror="this.src='/img/default-item.png';">
            <div class="item-details"><div class="item-value">$${item.price.toFixed(2)}</div></div>\`;
        if (selectedItemsList.some(selected => selected.assetId === item.assetId)) itemElement.classList.add('selected');
        itemElement.addEventListener('click', () => toggleItemSelection(itemElement, item));
        container.appendChild(itemElement);
    });
}

function toggleItemSelection(element, itemData) {
    const index = selectedItemsList.findIndex(i => i.assetId === itemData.assetId);
    if (index === -1) { // Select item
        if (selectedItemsList.length >= CONFIG.MAX_ITEMS_PER_DEPOSIT) {
            showNotification(\`Max \${CONFIG.MAX_ITEMS_PER_DEPOSIT} items per deposit.\`, 'info'); return;
        }
        selectedItemsList.push(itemData);
        element.classList.add('selected');
        addSelectedItemElement(itemData);
    } else { // Deselect item
        selectedItemsList.splice(index, 1);
        element.classList.remove('selected');
        removeSelectedItemElement(itemData.assetId);
    }
    updateTotalValue();
    DOMElements.deposit.depositButton.disabled = selectedItemsList.length === 0;
}

function addSelectedItemElement(item) {
    const container = DOMElements.deposit.selectedItemsContainer;
    const selectedElement = document.createElement('div');
    selectedElement.className = 'selected-item-display';
    selectedElement.dataset.assetId = item.assetId;
    selectedElement.title = `$${item.price.toFixed(2)}`;
    selectedElement.innerHTML = \`
        <img src="\${item.image}" alt="Selected Skin" loading="lazy" onerror="this.src='/img/default-item.png';">
        <div class="item-value">$${item.price.toFixed(2)}</div>
        <button class="remove-item-btn" data-asset-id="\${item.assetId}" aria-label="Remove">&times;</button>\`;
    selectedElement.querySelector('.remove-item-btn').addEventListener('click', (e) => {
        e.stopPropagation(); removeSelectedItem(e.target.dataset.assetId);
    });
    selectedElement.addEventListener('click', () => removeSelectedItem(item.assetId)); // Click item itself to remove
    container.appendChild(selectedElement);
}

function removeSelectedItemElement(assetId) {
    DOMElements.deposit.selectedItemsContainer.querySelector(\`.selected-item-display[data-asset-id="\${assetId}"]\`)?.remove();
}

function removeSelectedItem(assetId) { // Handles full deselection logic
    selectedItemsList = selectedItemsList.filter(item => item.assetId !== assetId);
    DOMElements.deposit.inventoryItemsContainer.querySelector(\`.inventory-item[data-asset-id="\${assetId}"]\`)?.classList.remove('selected');
    removeSelectedItemElement(assetId);
    updateTotalValue();
    DOMElements.deposit.depositButton.disabled = selectedItemsList.length === 0;
}

function updateTotalValue() {
    const total = selectedItemsList.reduce((sum, item) => sum + (item.price || 0), 0);
    DOMElements.deposit.totalValueDisplay.textContent = `$${total.toFixed(2)}`;
}

async function requestDepositOffer() {
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit;
    if (selectedItemsList.length === 0) { showNotification('No items selected.', 'info'); return; }
    
    // Ensure currentRound is defined and status is 'pending' or 'active' before allowing deposit
    if (!currentRound || !['pending', 'active'].includes(currentRound.status) || isSpinning) {
        showNotification('Deposits currently closed.', 'error');
        return;
    }

    if (currentUser?.pendingDepositOfferId) {
        showNotification('Existing pending deposit offer. View in profile.', 'error');
        populateProfileModal(); showModal(DOMElements.profileModal.modal); return;
    }
    
    const currentParticipants = currentRound.participants?.length || 0;
    const isNewP = !currentRound.participants?.some(p => p.user?._id === currentUser?._id);
    if (isNewP && currentParticipants >= CONFIG.MAX_PARTICIPANTS_DISPLAY) {
        showNotification(\`Participant limit (\${CONFIG.MAX_PARTICIPANTS_DISPLAY}) reached.\`, 'error'); return;
    }
    if ((currentRound.items?.length || 0) + selectedItemsList.length > CONFIG.MAX_ITEMS_PER_POT_FRONTEND) {
        showNotification(\`Pot item limit (\${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}) would be exceeded.\`, 'error'); return;
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
            if (response.status === 409 && result.offerURL && result.offerId) { // Existing pending offer
                depositStatusText.textContent = \`You have a pending offer! Click 'Accept on Steam'.\`;
                depositStatusText.className = 'deposit-status-text warning';
                currentDepositOfferURL = result.offerURL;
                acceptDepositOfferBtn.style.display = 'inline-block'; acceptDepositOfferBtn.disabled = false;
                depositButton.style.display = 'none';
                if (currentUser) currentUser.pendingDepositOfferId = result.offerId; updateUserUI();
                return;
            }
            throw new Error(result.error || \`Failed to create offer (\${response.status})\`);
        }
        if (!result.success || !result.offerURL || !result.offerId) throw new Error(result.error || 'Invalid offer response.');

        depositStatusText.textContent = "Offer created! Accept on Steam."; depositStatusText.className = 'deposit-status-text success';
        currentDepositOfferURL = result.offerURL;
        depositButton.style.display = 'none';
        acceptDepositOfferBtn.style.display = 'inline-block'; acceptDepositOfferBtn.disabled = false;
        if (currentUser) currentUser.pendingDepositOfferId = result.offerId; updateUserUI();
    } catch (error) {
        depositStatusText.textContent = \`Error: \${error.message}\`; depositStatusText.className = 'deposit-status-text error';
        resetDepositModalUI(); 
        if (currentUser && currentUser.pendingDepositOfferId && error.message !== \`You have a pending offer! Click 'Accept on Steam'.\`) {
            currentUser.pendingDepositOfferId = null; updateUserUI();
        }
    }
}

// --- Round UI & Timer ---
function updateRoundUI() { 
    const { potValue, participantCount } = DOMElements.jackpot;
    if (!currentRound || !potValue || !participantCount) return;

    potValue.textContent = `$${(currentRound.totalValue || 0).toFixed(2)}`;
    const participantNum = currentRound.participants?.length || 0;
    participantCount.textContent = \`\${participantNum}/\${CONFIG.MAX_PARTICIPANTS_DISPLAY}\`;

    if (!timerActive) {
        // If timer is not active, decide what to show based on round state
        if (currentRound.status === 'pending' || (currentRound.status === 'active' && participantNum === 0)) {
            updateTimerUI(CONFIG.ROUND_DURATION, true); // Show initial full duration or "Waiting" text
        } else if (currentRound.status === 'active' && participantNum > 0) {
            updateTimerUI(currentRound.timeLeft !== undefined ? currentRound.timeLeft : 0);
        } else {
             updateTimerUI(0); // For completed, error, rolling states if timer section somehow visible
        }
    }
    updateDepositButtonState();
}

function updateTimerUI(timeLeft, isInitialDisplay = false) {
    const { timerValue, timerForeground } = DOMElements.jackpot;
    if (!timerValue || !timerForeground) return;

    let displayValue = "";
    const timeToShow = Math.max(0, Math.round(timeLeft));

    if (isSpinning || (currentRound && currentRound.status === 'rolling')) {
        // When rolling, the jackpot header (containing timer) is usually hidden.
        // If it were visible, we'd want it to be blank or indicate rolling.
        // Since it's hidden by switchToRouletteView, this text won't be seen.
        displayValue = ""; // Or some other indicator if the header wasn't hidden
    } else if (currentRound && currentRound.status === 'pending') {
        displayValue = "Waiting"; // Show "Waiting" if round is pending (no deposits yet)
    } else if (currentRound && currentRound.status === 'active' && (currentRound.participants?.length === 0 || isInitialDisplay)) {
        // If active but no participants OR it's an initial display call for an empty active round
        displayValue = CONFIG.ROUND_DURATION.toString(); // Show full time before countdown starts
    } else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'error')) {
        displayValue = "Ended";
    } else if (timerActive || (currentRound && currentRound.status === 'active')) {
        displayValue = timeToShow.toString(); // Show countdown
    } else {
        displayValue = "--"; // Default for unknown states
    }
    
    timerValue.textContent = displayValue;

    // Determine total duration for the progress circle
    // If the round is active and has participants, base it on the expected end time vs start time
    // Otherwise, default to CONFIG.ROUND_DURATION
    let totalDurationForCircle = CONFIG.ROUND_DURATION;
    if (currentRound?.status === 'active' && currentRound.participants?.length > 0 && currentRound.startTime && currentRound.endTime) {
        const durationMs = new Date(currentRound.endTime).getTime() - new Date(currentRound.startTime).getTime();
        totalDurationForCircle = Math.max(1, durationMs / 1000);
    } else if (currentRound?.status === 'pending' || (currentRound?.status === 'active' && currentRound.participants?.length === 0)) {
        totalDurationForCircle = CONFIG.ROUND_DURATION; // Full duration for circle when waiting for first deposit
    }
    
    let progressTime = timeToShow;
    if (currentRound?.status === 'pending' || (currentRound?.status === 'active' && currentRound.participants?.length === 0 && displayValue === CONFIG.ROUND_DURATION.toString())) {
        progressTime = CONFIG.ROUND_DURATION; // Show full circle for initial state
    }

    updateTimerCircle(progressTime, Math.max(1, totalDurationForCircle));

    timerValue.classList.toggle('urgent-pulse', timerActive && timeToShow <= 10 && timeToShow > 0);
    timerValue.classList.toggle('timer-pulse', timerActive && timeToShow > 10);
}

// main.js - Rust Jackpot Frontend Logic (Refined)
// Part 2 of 2

function updateTimerCircle(timeLeft, totalTime) {
    const circle = DOMElements.jackpot.timerForeground;
    if (!circle || !(circle instanceof SVGCircleElement) || !circle.r?.baseVal?.value) return;
    const radius = circle.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    const progress = Math.min(1, Math.max(0, timeLeft / Math.max(1, totalTime))); // Prevent division by zero
    circle.style.strokeDasharray = `${circumference}`;
    circle.style.strokeDashoffset = `${circumference * (1 - progress)}`;
}

function startClientTimer(initialTime = CONFIG.ROUND_DURATION) {
    if (roundTimer) clearInterval(roundTimer);
    let timeLeft = Math.max(0, initialTime);
    timerActive = true;
    updateTimerUI(timeLeft); // Initial UI update for the timer

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
            // Backend 'roundRolling' event will trigger the roulette animation.
            // Frontend just reflects the timer hitting zero.
        }
    }, 1000);
}

// --- Participant & Item Display ---
function displayLatestDeposit(depositData) {
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (!container || !emptyMsg) return;

    const userId = depositData.userId || depositData.user?._id;
    if (!userId) { console.error("displayLatestDeposit: Invalid user ID in data", depositData); return; }

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
        depositContainer.querySelector('.player-deposit-value').textContent = `$${cumulativeValueForUser.toFixed(2)} | ${percentage}%`;
        depositContainer.querySelector('.player-deposit-value').title = `Value: $${cumulativeValueForUser.toFixed(2)} | Chance: ${percentage}%`;
        if (container.firstChild !== depositContainer) {
            container.insertBefore(depositContainer, container.firstChild);
        }
    }

    const itemsGrid = depositContainer.querySelector('.player-items-grid');
    if (isNewBlock) itemsGrid.innerHTML = '';

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
function createRouletteItems() {
    const track = DOMElements.roulette.rouletteTrack;
    if (!track) { console.error("Roulette track missing."); return false; }
    track.innerHTML = ''; track.style.transform = 'translateX(0)';

    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) {
        track.innerHTML = '<div class="roulette-message">Waiting for participants...</div>'; return false;
    }

    let ticketPool = [];
    const totalTicketsInRound = Math.max(1, currentRound.participants.reduce((sum, p) => sum + (p.tickets || 0), 0));

    currentRound.participants.forEach(p => {
        const visualBlocksForUser = Math.max(1, Math.ceil(((p.tickets || 0) / totalTicketsInRound) * 100));
        for (let i = 0; i < visualBlocksForUser; i++) {
            ticketPool.push({ user: p.user, color: getUserColor(p.user._id || p.user.id) });
        }
    });

    if (ticketPool.length === 0) {
        currentRound.participants.forEach(p => {
            ticketPool.push({ user: p.user, color: getUserColor(p.user._id || p.user.id) });
        });
    }
    if (ticketPool.length === 0) {
         track.innerHTML = '<div class="roulette-message">Error preparing items.</div>'; return false;
    }

    let finalRouletteItems = [];
    const minVisualItems = CONFIG.ROULETTE_REPETITIONS * ticketPool.length > 150 ? CONFIG.ROULETTE_REPETITIONS * ticketPool.length : 150;
    while (finalRouletteItems.length < minVisualItems) {
        finalRouletteItems.push(...shuffleArray([...ticketPool]));
    }

    const fragment = document.createDocumentFragment();
    finalRouletteItems.forEach(itemRep => {
        const itemElement = document.createElement('div');
        itemElement.className = 'roulette-item';
        itemElement.dataset.userId = itemRep.user._id || itemRep.user.id;
        itemElement.style.borderColor = itemRep.color;
        itemElement.innerHTML = `<img class="roulette-avatar" src="${itemRep.user.avatar || '/img/default-avatar.png'}" alt="Avatar">`;
        fragment.appendChild(itemElement);
    });
    track.appendChild(fragment);
    return true;
}

function switchToRouletteView() {
    const { jackpotHeader } = DOMElements.jackpot;
    const { inlineRouletteContainer } = DOMElements.roulette;
    if (!jackpotHeader || !inlineRouletteContainer) return;

    // Hide timer, pot value, participants count directly
    ['.jackpot-value', '.jackpot-timer', '.jackpot-stats'].forEach(sel => {
        const el = jackpotHeader.querySelector(sel);
        if (el) { el.style.display = 'none'; el.style.opacity = '0';}
    });

    jackpotHeader.classList.add('roulette-mode'); // This might adjust padding/height
    inlineRouletteContainer.style.display = 'flex'; // Show roulette
    inlineRouletteContainer.style.opacity = '0';
    setTimeout(() => {
        inlineRouletteContainer.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        inlineRouletteContainer.style.opacity = '1';
    }, 50); // Short delay for styles to apply before transition

    DOMElements.deposit.showDepositModalButton.parentElement.style.display = 'none';
}

function startRouletteAnimation(winnerDataFromEvent) {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    const winnerId = winnerDataFromEvent?.id?.toString();
    if (!winnerId) { resetToJackpotView(); return; }

    isSpinning = true; updateDepositButtonState();
    if (DOMElements.roulette.winnerInfoBox) DOMElements.roulette.winnerInfoBox.style.display = 'none';
    clearConfetti();

    if (!createRouletteItems()) {
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const winnerParticipant = currentRound?.participants?.find(p => (p.user?._id || p.user?.id) === winnerId);
    if (!winnerParticipant || !winnerParticipant.user) {
        console.warn(`Winner ${winnerDataFromEvent.username} not found in local participants list. Using event data for display.`);
        const minimalWinnerForDisplay = {
            user: { ...winnerDataFromEvent },
            itemsValue: winnerDataFromEvent.totalValue || 0,
            tickets: 0
        };
        handleRouletteSpinAnimation(winnerId, minimalWinnerForDisplay);
        return;
    }
    handleRouletteSpinAnimation(winnerId, winnerParticipant);
}


function handleRouletteSpinAnimation(winnerId, winnerDisplayData) {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer.querySelector('.roulette-container');
    const items = track?.querySelectorAll('.roulette-item');

    if (!track || !container || !items || items.length === 0) {
        console.error("Roulette animation elements missing or no items.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    let targetWinningElement = null;
    const preferredRangeStart = Math.floor(items.length * 0.7);
    for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].dataset.userId === winnerId && i >= preferredRangeStart) {
            targetWinningElement = items[i];
            break;
        }
    }
    if (!targetWinningElement) {
        for (let i = 0; i < items.length; i++) {
            if (items[i].dataset.userId === winnerId) { targetWinningElement = items[i]; break; }
        }
    }
    if (!targetWinningElement) {
        console.error(`CRITICAL: Winner ID ${winnerId} not found on track! Using a random item.`);
        targetWinningElement = items[Math.floor(items.length * 0.75)];
    }

    const itemWidth = targetWinningElement.offsetWidth;
    const itemOffsetLeft = targetWinningElement.offsetLeft;
    const centerOffset = (container.offsetWidth / 2) - (itemWidth / 2);
    const perfectCenterScrollPosition = -(itemOffsetLeft - centerOffset);
    const variation = (Math.random() - 0.5) * (itemWidth * CONFIG.LANDING_POSITION_VARIATION);
    const targetScrollPosition = perfectCenterScrollPosition + variation;
    const startPosition = parseFloat(track.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1] || '0');
    const duration = CONFIG.SPIN_DURATION_SECONDS * 1000;
    let startTime = performance.now();
    track.style.transition = 'none';

    DOMElements.audio.spinSound?.play().catch(e => console.warn("Spin sound error:", e));

    function animate(timestamp) {
        if (!isSpinning) { cancelAnimationFrame(animationFrameId); animationFrameId = null; return; }
        const elapsed = timestamp - startTime;
        const progress = Math.min(1, elapsed / duration);
        const easedProgress = easeOutAnimation(progress);
        track.style.transform = `translateX(${startPosition + (targetScrollPosition - startPosition) * easedProgress}px)`;
        if (progress < 1) {
            animationFrameId = requestAnimationFrame(animate);
        } else {
            animationFrameId = null;
            finalizeSpin(targetWinningElement, winnerDisplayData);
        }
    }
    animationFrameId = requestAnimationFrame(animate);
}


function finalizeSpin(winningElementDOM, winnerData) {
    if (!isSpinning && winningElementDOM?.classList.contains('winner-highlight')) return;
    if (!winningElementDOM || !winnerData || !winnerData.user) {
        isSpinning = false; updateDepositButtonState();
        if (currentWinningsOfferData) displayAcceptWinningsModal(currentWinningsOfferData);
        else setTimeout(resetToJackpotView, CONFIG.WINNER_INFO_DISPLAY_DURATION);
        return;
    }
    const winnerId = winnerData.user._id || winnerData.user.id;
    const userColor = getUserColor(winnerId);
    winningElementDOM.classList.add('winner-highlight');
    const styleId = 'winner-pulse-style'; document.getElementById(styleId)?.remove();
    const style = document.createElement('style'); style.id = styleId;
    style.textContent = `
        .winner-highlight { border-width: 3px !important; border-color: ${userColor} !important; animation: winnerPulse 1s infinite alternate; }
        @keyframes winnerPulse {
            from { box-shadow: 0 0 10px ${userColor}, 0 0 5px ${userColor}; transform: scale(1.05); }
            to { box-shadow: 0 0 25px ${userColor}, 0 0 15px ${userColor}; transform: scale(1.12); }
        }`;
    document.head.appendChild(style);
    setTimeout(() => handleSpinEndVisuals(winnerData), 300);
}

function handleSpinEndVisuals(winnerData) {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    isSpinning = false; updateDepositButtonState();

    const { winnerInfoBox, winnerAvatar, winnerName, winnerDeposit, winnerChance } = DOMElements.roulette;
    const winnerId = winnerData.user._id || winnerData.user.id;
    const userColor = getUserColor(winnerId);

    // Trade offer is sent by backend. The 'tradeOfferSent' socket event will trigger the modal.
    // Here we just show the inline winner info.

    if (winnerInfoBox) {
        winnerAvatar.src = winnerData.user.avatar || '/img/default-avatar.png';
        winnerAvatar.style.borderColor = userColor;
        winnerName.textContent = winnerData.user.username || 'Winner!';
        winnerName.style.color = userColor;
        const potValueAtWin = Math.max(0.01, currentRound?.totalValue || 0.01);
        const userValueForChance = currentRound?.participants?.find(p => (p.user._id || p.user.id) === winnerId)?.itemsValue || 0;
        winnerDeposit.textContent = `$${(userValueForChance).toFixed(2)}`;
        winnerChance.textContent = `${((userValueForChance / potValueAtWin) * 100).toFixed(2)}%`;
        winnerInfoBox.style.display = 'flex'; winnerInfoBox.style.opacity = '0';
        winnerInfoBox.style.animation = 'fadeIn 0.5s ease forwards';
        
        // Wait for 'tradeOfferSent' to display modal OR timeout to reset view.
        // The modal display will take precedence.
        setTimeout(() => {
             if (DOMElements.acceptWinningsModal.modal.style.display !== 'flex') { // If modal not shown by tradeOfferSent
                resetToJackpotView();
             }
        }, CONFIG.WINNER_INFO_DISPLAY_DURATION);
    }
    launchConfetti(userColor);
}

function launchConfetti(mainColor) {
    const container = DOMElements.roulette.confettiContainer;
    if (!container) return;
    clearConfetti();
    const colors = [mainColor, '#FFFFFF', '#FFD700', lightenColor(mainColor, 30), darkenColor(mainColor, 20)];
    for (let i = 0; i < CONFIG.CONFETTI_COUNT; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        piece.style.setProperty('--color', colors[Math.floor(Math.random() * colors.length)]);
        piece.style.left = `${Math.random() * 100}%`;
        const animDuration = 2 + Math.random() * 2.5;
        piece.style.animation = `confettiFall ${animDuration}s linear ${Math.random() * 1}s forwards`;
        container.appendChild(piece);
    }
}
function clearConfetti() {
    if (DOMElements.roulette.confettiContainer) DOMElements.roulette.confettiContainer.innerHTML = '';
    document.getElementById('winner-pulse-style')?.remove();
    DOMElements.roulette.rouletteTrack?.querySelectorAll('.winner-highlight').forEach(el => el.classList.remove('winner-highlight'));
}

function lightenColor(hex, percent) {
    hex = hex.replace('#', '');
    let r = parseInt(hex.substring(0,2), 16), g = parseInt(hex.substring(2,4), 16), b = parseInt(hex.substring(4,6), 16);
    r = Math.min(255, r + Math.floor(r * (percent/100)));
    g = Math.min(255, g + Math.floor(g * (percent/100)));
    b = Math.min(255, b + Math.floor(b * (percent/100)));
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}
function darkenColor(hex, percent) {
    hex = hex.replace('#', '');
    let r = parseInt(hex.substring(0,2), 16), g = parseInt(hex.substring(2,4), 16), b = parseInt(hex.substring(4,6), 16);
    r = Math.max(0, r - Math.floor(r * (percent/100)));
    g = Math.max(0, g - Math.floor(g * (percent/100)));
    b = Math.max(0, b - Math.floor(b * (percent/100)));
    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}


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
        if(DOMElements.deposit.showDepositModalButton?.parentElement) {
            DOMElements.deposit.showDepositModalButton.parentElement.style.display = 'flex';
        }
        initiateNewRoundVisualReset();
        if (socket?.connected) socket.emit('requestRoundData');
    }, 500);
}

function initiateNewRoundVisualReset() {
    if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Waiting"; // Or CONFIG.ROUND_DURATION.toString()
    updateTimerCircle(CONFIG.ROUND_DURATION, CONFIG.ROUND_DURATION); // Show full circle initially
    DOMElements.jackpot.timerValue?.classList.remove('urgent-pulse', 'timer-pulse');
    if (roundTimer) clearInterval(roundTimer); roundTimer = null; timerActive = false;

    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (container) container.innerHTML = '';
    if (emptyMsg && container) container.appendChild(emptyMsg);
    if (emptyMsg) emptyMsg.style.display = 'block';

    DOMElements.jackpot.potValue.textContent = "$0.00";
    DOMElements.jackpot.participantCount.textContent = `0/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
    userColorMap.clear();
    updateDepositButtonState();
}

// --- Accept Winnings Modal ---
function resetAcceptWinningsModalUI() {
    const { statusText, acceptOnSteamBtn, offerIdDisplay } = DOMElements.acceptWinningsModal;
    statusText.textContent = ''; statusText.className = 'deposit-status-text';
    acceptOnSteamBtn.disabled = true; acceptOnSteamBtn.removeAttribute('data-offer-url');
    offerIdDisplay.textContent = '';
    currentWinningsOfferData = null;
    if (acceptWinningsModalTimeout) clearTimeout(acceptWinningsModalTimeout);
}

function displayAcceptWinningsModal(offerData) {
    const { modal, offerIdDisplay, statusText, acceptOnSteamBtn } = DOMElements.acceptWinningsModal;
    if (!offerData || !offerData.offerURL || !offerData.offerId) {
        showNotification("Error displaying winnings info: Details missing.", "error"); return;
    }
    currentWinningsOfferData = offerData;
    offerIdDisplay.textContent = `Trade Offer ID: #${offerData.offerId}`;
    statusText.textContent = `Status: ${offerData.status || 'Sent'}.`;
    statusText.className = `deposit-status-text ${offerData.status?.toLowerCase().includes('escrow') ? 'warning' : 'info'}`;
    acceptOnSteamBtn.disabled = false; acceptOnSteamBtn.setAttribute('data-offer-url', offerData.offerURL);

    if (DOMElements.roulette.winnerInfoBox?.style.display === 'flex') {
        DOMElements.roulette.winnerInfoBox.style.display = 'none';
    }
    showModal(modal);
    acceptWinningsModalTimeout = setTimeout(() => {
        if (modal.style.display === 'flex') {
            hideModal(modal); resetToJackpotViewIfNeeded();
        }
    }, CONFIG.ACCEPT_WINNINGS_MODAL_AUTO_CLOSE_MS);
}

function resetToJackpotViewIfNeeded() {
    if (!isSpinning && (!currentRound || currentRound.status === 'completed' || currentRound.status === 'error')) {
        resetToJackpotView();
    }
}

// --- Winning History ---
async function loadWinningHistory() {
    const { modal, tableBody, loadingIndicator, noWinningsMessage } = DOMElements.winningHistoryModal;
    if (!currentUser) { showNotification("Log in to view winning history.", "info"); return; }
    showModal(modal);
    loadingIndicator.style.display = 'flex'; tableBody.innerHTML = ''; noWinningsMessage.style.display = 'none';
    try {
        const response = await fetch('/api/user/winning-history');
        if (!response.ok) throw new Error((await response.json().catch(()=>({error: 'Failed to load history'}))).error);
        const history = await response.json();
        if (!Array.isArray(history) || history.length === 0) { noWinningsMessage.style.display = 'block'; return; }
        history.forEach(win => {
            const row = tableBody.insertRow();
            row.insertCell().textContent = `#${win.gameId}`;
            row.insertCell().textContent = new Date(win.dateWon).toLocaleString() || 'N/A';
            row.insertCell().textContent = `$${(win.amountWon || 0).toFixed(2)}`;
            const tradeCell = row.insertCell();
            const offerURL = win.tradeOfferId ? `https://steamcommunity.com/tradeoffer/${win.tradeOfferId}/` : null;
            if (win.tradeStatus === 'Accepted') tradeCell.innerHTML = `<span class="trade-status accepted"><i class="fas fa-check-circle"></i> Accepted</span>`;
            else if (offerURL && ['Sent', 'Escrow', 'PendingConfirmation', 'Pending Send', 'Unknown'].includes(win.tradeStatus)) {
                tradeCell.innerHTML = `<a href="${offerURL}" target="_blank" rel="noopener noreferrer" class="trade-link pending" title="View offer"><i class="fas fa-external-link-alt"></i> View (#${win.tradeOfferId})</a>`;
            } else if (win.tradeStatus === 'No Items Won') {
                tradeCell.innerHTML = `<span class="trade-status info"><i class="fas fa-info-circle"></i> Taxed</span>`;
            } else {
                tradeCell.innerHTML = `<span class="trade-status ${win.tradeStatus?.toLowerCase().includes('fail') ? 'failed' : 'info'}" title="Offer ID: ${win.tradeOfferId || 'N/A'}"><i class="fas ${win.tradeStatus?.toLowerCase().includes('fail') ? 'fa-times-circle' : 'fa-question-circle'}"></i> ${win.tradeStatus}</span>`;
            }
        });
    } catch (error) {
        noWinningsMessage.textContent = `Error: ${error.message}`; noWinningsMessage.style.display = 'block';
        showNotification(`Error loading winning history: ${error.message}`, 'error');
    } finally {
        loadingIndicator.style.display = 'none';
    }
}


// --- Provably Fair & Past Rounds Logic (Simplified) ---
async function verifyRound() {
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationResultDisplay: resultEl } = DOMElements.provablyFair;
    const [roundId, serverSeed, clientSeed] = [roundIdInput.value.trim(), serverSeedInput.value.trim(), clientSeedInput.value.trim()];
    if (!roundId || !serverSeed || !clientSeed || serverSeed.length !== 64 || !/^[a-f0-9]{64}$/i.test(serverSeed)) {
        resultEl.innerHTML = `<p>Invalid input. Ensure all fields are correct (Server Seed must be 64 hex chars).</p>`;
        resultEl.className = 'verification-result error'; resultEl.style.display = 'block'; return;
    }
    resultEl.innerHTML = '<p>Verifying...</p>'; resultEl.className = 'verification-result loading'; resultEl.style.display = 'block';
    try {
        const response = await fetch('/api/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roundId, serverSeed, clientSeed })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Verification failed (${response.status})`);
        resultEl.className = `verification-result ${result.verified ? 'success' : 'error'}`;
        let html = `<h4>Round #${result.roundId || roundId} Verification</h4>`;
        html += `<p><strong>Status:</strong> ${result.verified ? '✅ Verified Fair' : '❌ Verification Failed'}</p>`;
        if (result.reason) html += `<p><strong>Reason:</strong> ${result.reason}</p>`;
        if (result.verified) {
            html += `<p>Winner: ${result.winnerUsername || 'N/A'}, Winning Ticket: ${result.winningTicket}/${result.totalTickets}</p>`;
        }
        html += `<details><summary>Technical Details</summary>
                    <p>Server Seed Hash (Original): <code class="seed-value">${result.serverSeedHash || 'N/A'}</code></p>
                    <p>Server Seed (Used): <code class="seed-value">${result.serverSeed || 'N/A'}</code></p>
                    <p>Client Seed (Used): <code class="seed-value">${result.clientSeed || 'N/A'}</code></p>
                    <p>Final Hash (SHA256(Server+Client)): <code class="seed-value">${result.finalHash || 'N/A'}</code></p>
                 </details>`;
        resultEl.innerHTML = html;
    } catch (error) {
        resultEl.innerHTML = `<p>Error: ${error.message}</p>`; resultEl.className = 'verification-result error';
    }
}

async function loadPastRounds(page = 1) {
    const { roundsTableBody: tableBody, roundsPagination: pagination } = DOMElements.provablyFair;
    tableBody.innerHTML = '<tr><td colspan="5" class="loading-message">Loading...</td></tr>'; pagination.innerHTML = '';
    try {
        const response = await fetch(`/api/rounds?page=${page}&limit=10`);
        if (!response.ok) throw new Error(`Failed to load rounds (${response.status})`);
        const data = await response.json();
        tableBody.innerHTML = '';
        if (!data.rounds?.length) {
            tableBody.innerHTML = `<tr><td colspan="5" class="no-rounds-message">No past rounds.</td></tr>`; return;
        }
        data.rounds.forEach(round => {
            const row = tableBody.insertRow();
            row.insertCell().textContent = `#${round.roundId}`;
            row.insertCell().textContent = new Date(round.completedTime || round.endTime).toLocaleString() || 'N/A';
            row.insertCell().textContent = `$${(round.totalValue || 0).toFixed(2)}`;
            row.insertCell().textContent = round.winner?.username || (round.status === 'error' ? 'ERROR' : 'N/A');
            const actionsCell = row.insertCell();
            const verifyBtn = document.createElement('button');
            verifyBtn.className = 'btn btn-secondary btn-small btn-verify';
            verifyBtn.textContent = 'Verify Info';
            verifyBtn.disabled = !round.serverSeed;
            verifyBtn.title = round.serverSeed ? "Populate fields with this round's data" : "Seeds not yet revealed";
            verifyBtn.onclick = () => window.populateVerificationFields(round.roundId, round.serverSeed, round.clientSeed);
            actionsCell.appendChild(verifyBtn);
        });
        createPagination(data.currentPage, data.totalPages);
    } catch (error) {
        tableBody.innerHTML = `<tr><td colspan="5" class="error-message">Error: ${error.message}</td></tr>`;
    }
}
window.populateVerificationFields = function(roundId, serverSeed, clientSeed) {
    DOMElements.provablyFair.roundIdInput.value = roundId || '';
    DOMElements.provablyFair.serverSeedInput.value = serverSeed || '';
    DOMElements.provablyFair.clientSeedInput.value = clientSeed || '';
    DOMElements.provablyFair.verificationSection.scrollIntoView({ behavior: 'smooth' });
    if (!serverSeed) showNotification(`Info: Seeds for Round #${roundId} are revealed after completion.`, 'info');
};
function createPagination(currentPage, totalPages) {
    const container = DOMElements.provablyFair.roundsPagination; container.innerHTML = '';
    if (totalPages <= 1) return;
    const displayRange = (start, end) => {
        for (let i = start; i <= end; i++) {
            const btn = document.createElement('button'); btn.className = `page-button ${i === currentPage ? 'active' : ''}`;
            btn.textContent = i; btn.onclick = () => loadPastRounds(i); container.appendChild(btn);
        }
    };
    if (currentPage > 1) { const prev = document.createElement('button'); prev.className = 'page-button'; prev.textContent = '«'; prev.onclick = () => loadPastRounds(currentPage - 1); container.appendChild(prev); }
    if (totalPages <= 7) displayRange(1, totalPages);
    else {
        displayRange(1, 1);
        if (currentPage > 3) container.insertAdjacentHTML('beforeend', '<span class="page-ellipsis">...</span>');
        let startPage = Math.max(2, currentPage - 1); let endPage = Math.min(totalPages - 1, currentPage + 1);
        if (currentPage <= 3) { startPage = 2; endPage = Math.min(totalPages - 1, 4); }
        if (currentPage >= totalPages - 2) { startPage = Math.max(2, totalPages - 3); endPage = totalPages - 1; }
        displayRange(startPage, endPage);
        if (currentPage < totalPages - 2) container.insertAdjacentHTML('beforeend', '<span class="page-ellipsis">...</span>');
        displayRange(totalPages, totalPages);
    }
    if (currentPage < totalPages) { const next = document.createElement('button'); next.className = 'page-button'; next.textContent = '»'; next.onclick = () => loadPastRounds(currentPage + 1); container.appendChild(next); }
}

// --- Chat Functionality ---
function updateChatUI() {
    const { messageInput, sendMessageBtn } = DOMElements.chat;
    const canChat = !!currentUser;
    if (messageInput) { messageInput.disabled = !canChat; messageInput.placeholder = canChat ? 'Type your message...' : 'Sign in to chat'; }
    if (sendMessageBtn) sendMessageBtn.disabled = !canChat || isChatSendOnCooldown;
    DOMElements.chat.onlineUsers.textContent = onlineUserCount;
}
function displayChatMessage(data) {
    const container = DOMElements.chat.messagesContainer;
    const msgEl = document.createElement('div'); msgEl.classList.add('chat-message');
    if (data.type === 'system') {
        msgEl.classList.add('system-message'); msgEl.textContent = data.message;
    } else {
        const userColor = getUserColor(data.userId);
        msgEl.innerHTML = `
            <img src="${data.avatar || '/img/default-avatar.png'}" alt="Avatar" class="chat-message-avatar" style="border-color: ${userColor};">
            <div class="chat-message-content">
                <span class="chat-message-user" style="color: ${userColor};">${data.username || 'User'}</span>
                <p class="chat-message-text"></p>
            </div>`;
        msgEl.querySelector('.chat-message-text').textContent = data.message;
    }
    container.insertBefore(msgEl, container.firstChild);
    if (container.children.length > CONFIG.MAX_CHAT_MESSAGES) container.removeChild(container.lastChild);
}
function handleSendMessage() {
    const input = DOMElements.chat.messageInput;
    const btn = DOMElements.chat.sendMessageBtn;
    if (!input || !currentUser || isChatSendOnCooldown) return;
    const message = input.value.trim();
    if (message) {
        socket.emit('chatMessage', message); input.value = '';
        isChatSendOnCooldown = true; btn.disabled = true;
        let countdown = Math.floor(CONFIG.CHAT_SEND_COOLDOWN_MS / 1000);
        const originalText = btn.textContent; btn.textContent = `Wait ${countdown}s`;
        const cdInterval = setInterval(() => {
            countdown--;
            if (countdown > 0) btn.textContent = `Wait ${countdown}s`;
            else { clearInterval(cdInterval); btn.textContent = originalText; isChatSendOnCooldown = false; if(currentUser) btn.disabled = false;}
        }, 1000);
    }
}
function setupChatEventListeners() {
    DOMElements.chat.sendMessageBtn?.addEventListener('click', handleSendMessage);
    DOMElements.chat.messageInput?.addEventListener('keypress', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); }});
}
function updateChatOnlineUsers(count) { onlineUserCount = count; updateChatUI(); }


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

    socket.on('roundCreated', (data) => { // Server sends this when a new round is made (status: 'pending')
        currentRound = data;
        initiateNewRoundVisualReset(); // Resets UI for a new round
        updateRoundUI(); // Updates pot, participants, and timer display
        // Timer shows "Waiting" or initial CONFIG.ROUND_DURATION based on updateTimerUI logic
        // No active countdown starts here.
    });

    socket.on('roundStatusUpdate', (data) => { // e.g. when round becomes active due to first deposit
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = data.status;
            currentRound.startTime = data.startTime;
            currentRound.endTime = data.endTime; // Backend should set this when round becomes active

            if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !timerActive) {
                // The backend now provides the correct timeLeft (CONFIG.ROUND_DURATION) via roundData or participantUpdated
                // Or, if the timer was already running and this is just a status sync:
                const timeToStart = currentRound.timeLeft !== undefined ? currentRound.timeLeft : CONFIG.ROUND_DURATION;
                startClientTimer(timeToStart);
            } else if (currentRound.status === 'active' && currentRound.participants?.length === 0) {
                 updateTimerUI(CONFIG.ROUND_DURATION, true); // Show full duration if active but empty
            }
            updateDepositButtonState();
        }
    });

    socket.on('participantUpdated', (data) => { // A user deposited items
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
            (data.depositedItems || []).forEach(item => currentRound.items.push({ ...item, owner: data.userId }));

            displayLatestDeposit(data);
            updateAllParticipantPercentages();
            updateRoundUI();
            if (currentUser && (currentUser._id === data.userId || currentUser.id === data.userId) && currentUser.pendingDepositOfferId) {
                 currentUser.pendingDepositOfferId = null; updateUserUI(); updateDepositButtonState();
                 if (DOMElements.deposit.depositModal?.style.display === 'flex') resetDepositModalUI();
            }
            // If this was the first participant deposit for a 'pending' or empty 'active' round, and timer isn't running
            if (currentRound.status === 'active' && currentRound.participants.length === 1 && !timerActive) {
                 // The backend should have set currentRound.endTime correctly.
                 // Or, we expect timeLeft in `data` or from `currentRound` to be CONFIG.ROUND_DURATION.
                const timeToStartCountdown = data.timeLeftForRound !== undefined ? data.timeLeftForRound : CONFIG.ROUND_DURATION;
                startClientTimer(timeToStartCountdown);
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

    socket.on('roundRolling', (data) => { // Winner selection process started, timer hit 0
        if (currentRound && currentRound.roundId === data.roundId) {
            if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
            updateTimerUI(0); // Show "0" or effectively hide timer display text
            currentRound.status = 'rolling'; isSpinning = true;
            updateDepositButtonState();
            switchToRouletteView(); // This hides the main jackpot header (timer, pot value, etc.)
        }
    });

    socket.on('roundWinner', (data) => { // Winner decided, animation should start
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
            // If roulette animation is done and winner info box is hidden OR not displayed, show modal.
            // Otherwise, modal will be shown after winner info box timeout.
            if (!isSpinning || (DOMElements.roulette.winnerInfoBox && DOMElements.roulette.winnerInfoBox.style.display === 'none')) {
                displayAcceptWinningsModal(data);
            }
            showNotification(`Winnings Sent! <a href="${data.offerURL}" target="_blank" class="notification-link">Accept on Steam</a> (#${data.offerId})`, 'success', 15000);
        }
    });

    socket.on('roundCompleted', (data) => {
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound = data;
            if (!isSpinning && !currentWinningsOfferData && DOMElements.acceptWinningsModal.modal.style.display !== 'flex') {
                setTimeout(resetToJackpotView, 1000); // Reset if no spin/modal showing
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
        if (oldRoundId !== currentRound.roundId || DOMElements.jackpot.participantsContainer.innerHTML === '' || ['pending', 'completed', 'error'].includes(currentRound.status) ) {
            initiateNewRoundVisualReset();
        }
        updateRoundUI();
        const participantsContainer = DOMElements.jackpot.participantsContainer;
        if (participantsContainer) {
            if (!['rolling', 'completed', 'error'].includes(currentRound.status)) { // Don't clear if rolling/done
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
        }

        if (currentRound.status === 'active') {
            if (currentRound.participants?.length > 0 && currentRound.timeLeft > 0) {
                if (!timerActive) startClientTimer(currentRound.timeLeft);
            } else if (currentRound.participants?.length === 0 || currentRound.timeLeft <= 0) {
                if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
                 updateTimerUI(currentRound.timeLeft <=0 ? 0 : CONFIG.ROUND_DURATION, currentRound.participants?.length === 0);
            }
        } else if (['pending', 'rolling', 'completed', 'error'].includes(currentRound.status)) {
            if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
            updateTimerUI(currentRound.status === 'pending' ? CONFIG.ROUND_DURATION : 0, currentRound.status === 'pending');
        }
         if (currentRound.status === 'rolling' && currentRound.winner && !isSpinning) {
             switchToRouletteView(); // Ensure view is switched if missed
             startRouletteAnimation(currentRound.winner);
         } else if ((currentRound.status === 'completed' || currentRound.status === 'error') && !isSpinning && !currentWinningsOfferData) {
             resetToJackpotView();
         }
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
            DOMElements.ageVerification.checkbox.checked = false;
            DOMElements.ageVerification.agreeButton.disabled = true;
            showModal(DOMElements.ageVerification.modal);
        }
    });
    DOMElements.user.userProfile?.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = DOMElements.user.userDropdownMenu;
        const isVisible = menu.style.display === 'block';
        menu.style.display = isVisible ? 'none' : 'block';
        DOMElements.user.userProfile.setAttribute('aria-expanded', String(!isVisible));
    });
    DOMElements.user.logoutButton?.addEventListener('click', (e) => { e.stopPropagation(); handleLogout(); });
    DOMElements.user.profileDropdownButton?.addEventListener('click', (e) => {
        e.stopPropagation(); DOMElements.user.userDropdownMenu.style.display = 'none';
        if (currentUser) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
        else showNotification("Log in to view profile.", "info");
    });
    DOMElements.user.winningHistoryDropdownButton?.addEventListener('click', (e) => {
        e.stopPropagation(); DOMElements.user.userDropdownMenu.style.display = 'none';
        if (currentUser) loadWinningHistory(); else showNotification("Log in to view history.", "info");
    });
    DOMElements.profileModal.saveBtn?.addEventListener('click', handleProfileSave);
    DOMElements.profileModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.profileModal.cancelBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));

    const awModal = DOMElements.acceptWinningsModal;
    [awModal.closeBtn, awModal.closeFooterBtn].forEach(btn => btn?.addEventListener('click', () => { hideModal(awModal.modal); resetToJackpotViewIfNeeded(); }));
    awModal.acceptOnSteamBtn?.addEventListener('click', () => {
        const url = awModal.acceptOnSteamBtn.getAttribute('data-offer-url');
        if (url) { window.open(url, '_blank'); awModal.statusText.textContent = "Offer opened in new tab."; setTimeout(() => { hideModal(awModal.modal); resetToJackpotViewIfNeeded(); }, 2000); }
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

    const avModal = DOMElements.ageVerification;
    avModal.checkbox?.addEventListener('change', () => { avModal.agreeButton.disabled = !avModal.checkbox.checked; });
    avModal.agreeButton?.addEventListener('click', () => {
        if (avModal.checkbox.checked) { localStorage.setItem('ageVerified', 'true'); hideModal(avModal.modal); window.location.href = '/auth/steam'; }
    });

    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound);

    window.addEventListener('click', (e) => {
        if (DOMElements.user.userDropdownMenu?.style.display === 'block' && !DOMElements.user.userProfile.contains(e.target) && !DOMElements.user.userDropdownMenu.contains(e.target)) {
            DOMElements.user.userDropdownMenu.style.display = 'none'; DOMElements.user.userProfile.setAttribute('aria-expanded', 'false');
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
                DOMElements.user.userDropdownMenu.style.display = 'none'; DOMElements.user.userProfile.setAttribute('aria-expanded', 'false');
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
    initiateNewRoundVisualReset(); // Initialize timer to "Waiting" or CONFIG.ROUND_DURATION
    if (localStorage.getItem('ageVerified') !== 'true' && DOMElements.ageVerification.modal) {
        DOMElements.ageVerification.checkbox.checked = false; DOMElements.ageVerification.agreeButton.disabled = true;
        showModal(DOMElements.ageVerification.modal);
    }
    updateChatUI();
});
