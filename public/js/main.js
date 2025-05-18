// main.js - Rust Jackpot Frontend Logic (Modified)
// Modifications focus on:
// - Ensuring a direct transition to the main animation when the timer ends.
// - Correctly sequencing the winner announcement: animation -> winning screen -> accept winnings pop-up.
// - Removing any logic that might create an unwanted "rolling thing pop-up" separate from the main animation sequence.

// Ensure Socket.IO client library is loaded before this script
const socket = io();

// --- Configuration Constants ---
const CONFIG = {
    ROUND_DURATION: 99, // Default timer duration in seconds, backend is source of truth
    MAX_ITEMS_PER_DEPOSIT: 20,
    MAX_DISPLAY_DEPOSITS: 10,
    MAX_PARTICIPANTS_DISPLAY: 20, // Should match backend
    MAX_ITEMS_PER_POT_FRONTEND: 200, // Should match backend
    ROULETTE_REPETITIONS: 20, // How many times the full set of participants visually repeats in the roulette
    SPIN_DURATION_SECONDS: 6.5, // Duration of the main roulette spin animation
    WINNER_INFO_DISPLAY_DURATION: 7000, // How long the "winning screen" (winnerInfoBox) shows if no winnings modal
    ACCEPT_WINNINGS_MODAL_AUTO_CLOSE_MS: 300000, // 5 minutes for the "Accept Winnings" modal
    CONFETTI_COUNT: 150,
    EASE_OUT_POWER: 5, // Higher for more aggressive ease-out
    BOUNCE_ENABLED: false, // Keep bounce disabled for a cleaner stop as per common preference
    BOUNCE_OVERSHOOT_FACTOR: 0.07,
    BOUNCE_DAMPING: 0.35,
    BOUNCE_FREQUENCY: 3.5,
    LANDING_POSITION_VARIATION: 0.60, // Randomness in where the winning item lands (0 to 1 item width)
    MAX_CHAT_MESSAGES: 100, // Increased chat message history
    CHAT_SEND_COOLDOWN_MS: 2000, // 2 seconds chat cooldown
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
    acceptWinningsModal: { // This is the pop-up for the winner to accept the trade offer
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
        participantsContainer: document.getElementById('itemsContainer'), // Pot items display
        emptyPotMessage: document.getElementById('emptyPotMessage'),
        jackpotHeader: document.getElementById('jackpotHeader'), // Container for value, timer, stats
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
        acceptDepositOfferBtn: document.getElementById('acceptDepositOfferBtn'), // For deposit offers
        depositStatusText: document.getElementById('depositStatusText'),
    },
    roulette: { // This is "the animation" area
        inlineRouletteContainer: document.getElementById('inlineRoulette'), // Main container for the animation
        rouletteTrack: document.getElementById('rouletteTrack'),       // The track that slides
        winnerInfoBox: document.getElementById('winnerInfo'),          // This is the "winning screen"
        winnerAvatar: document.getElementById('winnerAvatar'),
        winnerName: document.getElementById('winnerName'),
        winnerDeposit: document.getElementById('winnerDeposit'),
        winnerChance: document.getElementById('winnerChance'),
        returnToJackpotButton: document.getElementById('returnToJackpot'), // This button is not used per styles
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

// Global state variables
let currentUser = null;
let currentRound = null; // Holds data for the current round (synced with backend)
let selectedItemsList = []; // Items selected by user in deposit modal
let userInventory = []; // User's inventory items fetched from backend
let isSpinning = false; // True if roulette animation is active
let timerActive = false; // True if client-side countdown timer is running
let roundTimer = null; // Interval ID for client-side timer
let animationFrameId = null; // For requestAnimationFrame
let userColorMap = new Map(); // Stores colors for users in chat/pot
let notificationTimeout = null;
let spinStartTime = 0; // Timestamp for roulette animation start
let currentDepositOfferURL = null; // URL for pending deposit offer
let currentWinningsOfferData = null; // Data for the winnings trade offer {offerURL, offerId, status}
let acceptWinningsModalTimeout = null; // Timeout for auto-closing winnings modal
let onlineUserCount = 0;
let isChatSendOnCooldown = false;

// --- Utility Functions ---
function showModal(modalElement) {
    if (modalElement) modalElement.style.display = 'flex';
}

function hideModal(modalElement) {
    if (modalElement) modalElement.style.display = 'none';
    if (modalElement === DOMElements.deposit.depositModal) {
        resetDepositModalUI();
    }
    if (modalElement === DOMElements.acceptWinningsModal.modal) {
        resetAcceptWinningsModalUI();
        if (acceptWinningsModalTimeout) clearTimeout(acceptWinningsModalTimeout);
        // When winnings modal is closed by user, reset to jackpot view
        resetToJackpotViewIfNeeded();
    }
}
window.hideModal = hideModal; // Make available globally for HTML inline calls

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
window.showPage = showPage; // Make available globally

function getUserColor(userId) {
    if (!userId) return '#cccccc';
    if (!userColorMap.has(userId)) {
        const colorIndex = userColorMap.size % COLOR_PALETTE.length;
        userColorMap.set(userId, COLOR_PALETTE[colorIndex]);
    }
    return userColorMap.get(userId);
}

function showNotification(message, type = 'info', duration = 4000) {
    if (!DOMElements.notificationBar) {
        console.warn("Notification bar element (#notification-bar) not found. Using console.log as fallback.");
        console.log(`[${type.toUpperCase()}] ${message}`);
        return;
    }
    const bar = DOMElements.notificationBar;
    if (notificationTimeout) clearTimeout(notificationTimeout);
    bar.innerHTML = message; // Allow HTML for links
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

function easeOutAnimation(t) { // For roulette easing
    const clampedT = Math.max(0, Math.min(1, t));
    return 1 - Math.pow(1 - clampedT, CONFIG.EASE_OUT_POWER);
}

function calculateBounce(t) { // Not used if CONFIG.BOUNCE_ENABLED is false
    if (!CONFIG.BOUNCE_ENABLED) return 0;
    const clampedT = Math.max(0, Math.min(1, t));
    const decay = Math.exp(-clampedT / CONFIG.BOUNCE_DAMPING);
    const oscillations = Math.sin(clampedT * Math.PI * 2 * CONFIG.BOUNCE_FREQUENCY);
    return -decay * oscillations;
}

// --- User Authentication and Profile ---
async function handleLogout() {
    console.log("Attempting logout...");
    try {
        const response = await fetch('/logout', { method: 'POST' });
        if (!response.ok) {
             const result = await response.json().catch(() => ({ error: 'Logout request failed.' }));
            throw new Error(result.error || `Logout request failed with status ${response.status}.`);
        }
        const result = await response.json();
         if (!result.success) throw new Error(result.error || 'Logout unsuccessful.');

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

function resetAcceptWinningsModalUI() {
    const { statusText, acceptOnSteamBtn, offerIdDisplay } = DOMElements.acceptWinningsModal;
    if (statusText) {
        statusText.textContent = '';
        statusText.className = 'deposit-status-text'; // Reset class
    }
    if (acceptOnSteamBtn) {
        acceptOnSteamBtn.disabled = true;
        acceptOnSteamBtn.removeAttribute('data-offer-url');
    }
    if(offerIdDisplay) offerIdDisplay.textContent = '';
    currentWinningsOfferData = null; // Clear the data
    if (acceptWinningsModalTimeout) {
        clearTimeout(acceptWinningsModalTimeout);
        acceptWinningsModalTimeout = null;
    }
}

// This function displays the "Accept Winnings" pop-up for the winner
function displayAcceptWinningsModal(offerData) {
    const { modal, offerIdDisplay, statusText, acceptOnSteamBtn } = DOMElements.acceptWinningsModal;
    if (!offerData || !offerData.offerURL || !offerData.offerId) {
        console.error("Invalid offer data for winnings modal:", offerData);
        showNotification("Error displaying winnings information. Trade details missing.", "error");
        return;
    }

    currentWinningsOfferData = offerData; // Store for later use, e.g. if modal needs re-showing

    if (offerIdDisplay) offerIdDisplay.textContent = `Trade Offer ID: #${offerData.offerId}`;
    if (statusText) {
        let statusMessage = `Status: ${offerData.status || 'Sent'}.`;
        if (offerData.status?.toLowerCase().includes('escrow') || offerData.status?.toLowerCase().includes('pending')) {
            statusMessage += " This may require confirmation on Steam.";
        }
        statusText.textContent = statusMessage;
        statusText.className = 'deposit-status-text info'; // Use appropriate class
    }
    if (acceptOnSteamBtn) {
        acceptOnSteamBtn.disabled = false;
        acceptOnSteamBtn.setAttribute('data-offer-url', offerData.offerURL);
    }

    // If the inline winner info box ("winning screen") is visible, hide it or ensure this modal is clearly on top.
    // For now, the modal will appear over it.
    if (DOMElements.roulette.winnerInfoBox && DOMElements.roulette.winnerInfoBox.style.display === 'flex') {
         // Optionally hide winnerInfoBox: DOMElements.roulette.winnerInfoBox.style.display = 'none';
         // Or ensure acceptWinningsModal has a higher z-index (already set in CSS).
    }
    
    console.log("[Winnings Modal] Showing 'Accept Winnings' modal for offer:", offerData.offerId);
    showModal(modal);

    // Auto-close functionality
    if (acceptWinningsModalTimeout) clearTimeout(acceptWinningsModalTimeout);
    acceptWinningsModalTimeout = setTimeout(() => {
        if (modal.style.display === 'flex') { // Check if still open
            console.log("[Winnings Modal] Auto-closing winnings modal for offer:", currentWinningsOfferData?.offerId);
            hideModal(modal); // This will also call resetToJackpotViewIfNeeded via its hideModal override
        }
    }, CONFIG.ACCEPT_WINNINGS_MODAL_AUTO_CLOSE_MS);
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
    } else if (isSpinning) { // isSpinning is true during the roulette animation
        disabled = true; title = 'Deposits closed during winner selection';
    } else if (!currentRound || currentRound.status !== 'active') {
        disabled = true; title = 'Deposits are currently closed';
        if (currentRound) {
            switch (currentRound.status) {
                case 'rolling': title = 'Deposits closed during winner selection'; break; // 'rolling' is preparing for animation
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

// main.js - Rust Jackpot Frontend Logic (Modified) - Part 2 of 2

// --- Inventory and Deposit Logic ---
async function loadUserInventory() {
    const { inventoryItemsContainer, selectedItemsContainer, inventoryLoadingIndicator, totalValueDisplay } = DOMElements.deposit;
    if (!inventoryItemsContainer || !selectedItemsContainer || !inventoryLoadingIndicator || !totalValueDisplay) {
        console.error("Inventory DOM elements missing for loadUserInventory.");
        return;
    }

    resetDepositModalUI(); // Clear previous state, selection, and status messages
    selectedItemsList = [];
    selectedItemsContainer.innerHTML = '';
    updateTotalValue(); // Display $0.00

    inventoryLoadingIndicator.style.display = 'flex';
    inventoryItemsContainer.innerHTML = ''; // Clear previous items

    try {
        const response = await fetch('/api/inventory');
        if (!response.ok) {
            let errorMsg = 'Inventory load failed.';
            try {
                const errorData = await response.json();
                errorMsg = errorData.error || `Inventory load failed (${response.status})`;
            } catch (e) { /* Ignore if response is not JSON */ }
            if (response.status === 401 || response.status === 403) errorMsg = 'Please log in first.';
            throw new Error(errorMsg);
        }
        userInventory = await response.json();
        inventoryLoadingIndicator.style.display = 'none';

        if (!Array.isArray(userInventory)) throw new Error('Invalid inventory data received.');

        if (userInventory.length === 0) {
            inventoryItemsContainer.innerHTML = '<p class="empty-inventory-message">Your Rust inventory is empty or items are not tradable/above minimum value. Ensure your inventory is public on Steam.</p>';
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
    container.innerHTML = ''; // Clear previous

    userInventory.forEach(item => {
        if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.assetId || !item.image) {
            console.warn("Skipping invalid inventory item from display:", item);
            return;
        }

        const itemElement = document.createElement('div');
        itemElement.className = 'inventory-item';
        itemElement.dataset.assetId = item.assetId;
        itemElement.dataset.image = item.image; // Store image for selected display
        itemElement.dataset.price = item.price.toFixed(2);
        itemElement.title = `$${item.price.toFixed(2)}`; // Tooltip for price

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

    if (index === -1) { // Item not selected, try to select
        if (selectedItemsList.length >= CONFIG.MAX_ITEMS_PER_DEPOSIT) {
            showNotification(`Selection Limit: You can select a maximum of ${CONFIG.MAX_ITEMS_PER_DEPOSIT} items per deposit.`, 'info');
            return;
        }
        selectedItemsList.push(item);
        element.classList.add('selected');
        addSelectedItemElement(item);
    } else { // Item selected, deselect
        selectedItemsList.splice(index, 1);
        element.classList.remove('selected');
        removeSelectedItemElement(assetId);
    }
    updateTotalValue();
    resetDepositModalUI(); // Update deposit button state based on selection
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
    selectedElement.title = `$${item.price.toFixed(2)}`; // Tooltip

    selectedElement.innerHTML = `
        <img src="${item.image}" alt="Selected Skin Image" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-item.png';">
        <div class="item-value">$${item.price.toFixed(2)}</div>
        <button class="remove-item-btn" title="Remove Item" data-asset-id="${item.assetId}" aria-label="Remove Item">&times;</button>
        `;

    selectedElement.querySelector('.remove-item-btn')?.addEventListener('click', (e) => {
        e.stopPropagation(); // Prevent triggering click on parent
        const assetIdToRemove = e.target.dataset.assetId;
        if (assetIdToRemove) {
            removeSelectedItem(assetIdToRemove); // This will deselect from inventory list and remove this element
            updateTotalValue();
            resetDepositModalUI();
        }
    });

    // Clicking the item itself in the "selected" area also deselects it
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

// Helper to fully remove/deselect an item
function removeSelectedItem(assetId) {
    selectedItemsList = selectedItemsList.filter(item => item.assetId !== assetId);
    // Deselect from inventory view
    const inventoryElement = DOMElements.deposit.inventoryItemsContainer?.querySelector(`.inventory-item[data-asset-id="${assetId}"]`);
    if (inventoryElement) inventoryElement.classList.remove('selected');
    // Remove from selected items display
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
    if (!currentRound || currentRound.status !== 'active' || isSpinning) { // isSpinning check important
        showNotification('Deposit Error: Deposits are currently closed.', 'error'); return;
    }
    if (currentUser?.pendingDepositOfferId) {
        showNotification('Deposit Error: You already have a pending deposit offer. Check your profile or Steam.', 'error');
        if (DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
        return;
    }

    const participantsLength = currentRound.participants?.length || 0;
    const isNewParticipant = !currentRound.participants?.some(p => p.user?._id === currentUser?._id || p.user?.id === currentUser?._id); // Check both _id and id
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
    let response; // To check status outside try block if needed

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
            // Handle case where user already has a pending offer (status 409)
            if (response.status === 409 && result.offerURL && result.offerId) {
                console.warn("User already has a pending offer from server:", result.offerId);
                depositStatusText.textContent = `You already have a pending offer! Click 'Accept on Steam' to view it.`;
                depositStatusText.className = 'deposit-status-text warning';
                currentDepositOfferURL = result.offerURL; // Store URL
                acceptDepositOfferBtn.setAttribute('data-offer-url', result.offerURL); // Set for button
                acceptDepositOfferBtn.style.display = 'inline-block';
                acceptDepositOfferBtn.disabled = false;
                depositButton.style.display = 'none'; // Hide initial deposit button
                if (currentUser && !currentUser.pendingDepositOfferId) { // Update local user state if not already set
                    currentUser.pendingDepositOfferId = result.offerId;
                    updateUserUI(); // Update main user UI (e.g., pending indicator)
                    updateDepositButtonState(); // Update main deposit button on jackpot page
                }
                return; // Early exit, offer already exists
            } else {
                // Other errors
                throw new Error(result.error || `Failed to create offer (${response.status})`);
            }
        } else if (!result.success || !result.offerURL || !result.offerId) {
            // Success response but missing crucial data
            throw new Error(result.error || 'Backend did not return a valid offer URL and ID.');
        } else {
            // Successful offer creation
            console.log("Deposit offer created:", result.offerId);
            depositStatusText.textContent = "Offer created! Click 'Accept on Steam' below to complete.";
            depositStatusText.className = 'deposit-status-text success';
            currentDepositOfferURL = result.offerURL;
            acceptDepositOfferBtn.setAttribute('data-offer-url', result.offerURL);
            depositButton.style.display = 'none';
            acceptDepositOfferBtn.style.display = 'inline-block';
            acceptDepositOfferBtn.disabled = false;
            if(currentUser) { // Update current user state
                currentUser.pendingDepositOfferId = result.offerId;
                updateUserUI();
                updateDepositButtonState();
            }
        }
    } catch (error) {
        console.error('Error requesting deposit offer:', error);
        depositStatusText.textContent = `Error: ${error.message}`;
        depositStatusText.className = 'deposit-status-text error';
        // Only reset UI fully if it's not a "pending offer exists" type of situation
        if (!(response && response.status === 409)) {
            resetDepositModalUI(); // This re-enables the "Request Deposit Offer" button
        }
        // If there was an error and we previously thought user had a pending offer, clear that assumption
        if (currentUser && currentUser.pendingDepositOfferId && !(response && response.status === 409)) {
            console.log("Clearing potentially stale pending offer ID due to error during new request.");
            currentUser.pendingDepositOfferId = null;
            updateUserUI();
            updateDepositButtonState();
        }
    }
}

// --- Round Logic and UI Updates ---
function updateRoundUI() {
    const { potValue, participantCount } = DOMElements.jackpot;
    if (!currentRound || !potValue || !participantCount) return;

    potValue.textContent = `$${(currentRound.totalValue || 0).toFixed(2)}`;

    // Timer is updated by its own interval or by timerUpdate events
    // Only update here if timer isn't active (e.g., initial load)
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

    // Determine display text based on round state
    if (currentRound && (currentRound.status === 'pending' || (currentRound.status === 'active' && currentRound.participants?.length === 0 && !timerActive))) {
        // If pending, or active but empty and timer not yet started by a deposit
        displayValue = currentRound.status === 'pending' ? "Waiting" : CONFIG.ROUND_DURATION.toString();
    } else if (timerActive || (currentRound && currentRound.status === 'active' && timeToShow > 0)) {
        // If timer is explicitly active or round is active with time left
        displayValue = timeToShow.toString();
    } else if (isSpinning || (currentRound && currentRound.status === 'rolling')) {
        // If animation is happening or backend confirms rolling
        displayValue = "Rolling";
    } else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'error')) {
        displayValue = "Ended";
    } else if (!timerActive && timeToShow <= 0 && currentRound && currentRound.status === 'active') {
        // Timer finished, but not yet rolling (backend might be processing)
        displayValue = "0"; 
    } else if (!currentRound) { // No round data at all
        displayValue = "--"; 
    }


    timerValue.textContent = displayValue;
    updateTimerCircle(timeToShow, currentRound?.participants?.length > 0 ? CONFIG.ROUND_DURATION : 0); // Use 0 total time if no participants to show full circle

    // Visual cues for timer
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
        // If totalTime is 0 (e.g. waiting for first deposit), show full circle
        const progress = totalTime > 0 ? Math.min(1, Math.max(0, timeLeft / totalTime)) : 1;
        const offset = circumference * (1 - progress);
        circle.style.strokeDasharray = `${circumference}`;
        circle.style.strokeDashoffset = `${Math.max(0, offset)}`; // Ensure offset isn't negative
    }
}

// Update percentages for all displayed participant blocks
function updateAllParticipantPercentages() {
    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) return;
    const container = DOMElements.jackpot.participantsContainer;
    if (!container) return;

    const depositBlocks = container.querySelectorAll('.player-deposit-container');
    const currentTotalPotValue = Math.max(0.01, currentRound.totalValue || 0.01); // Avoid division by zero

    depositBlocks.forEach(block => {
        const userId = block.dataset.userId;
        if (!userId) return;

        const participantData = currentRound.participants.find(p => p.user?._id === userId || p.user?.id === userId);
        if (!participantData) return; // Should not happen if block exists

        const cumulativeValue = participantData.itemsValue || 0;
        const percentage = ((cumulativeValue / currentTotalPotValue) * 100).toFixed(1);
        const valueElement = block.querySelector('.player-deposit-value');

        if (valueElement) {
            const userColor = getUserColor(userId);
            valueElement.textContent = `$${cumulativeValue.toFixed(2)} | ${percentage}%`;
            valueElement.title = `Deposited: $${cumulativeValue.toFixed(2)} | Chance: ${percentage}%`;
            valueElement.style.color = userColor; // Keep color consistent
        }
    });
}


// Displays a new deposit entry or updates an existing one
function displayLatestDeposit(data) { // data from 'participantUpdated' event
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (!container) return;

    // Ensure essential data is present
    const userId = data.userId || data.user?._id; // Prefer _id if available from populated user
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
    const value = data.itemsValue; // This is the new total value for this participant in this round
    const items = data.depositedItems || []; // These are the items JUST deposited
    const userColor = getUserColor(userId);

    // Calculate percentage based on the LATEST pot total value from the event
    const currentTotalPotValue = Math.max(0.01, data.totalValue || currentRound?.totalValue || 0.01);
    const percentage = ((value / currentTotalPotValue) * 100).toFixed(1);

    // Check if an element for this user already exists
    let depositContainer = container.querySelector(`.player-deposit-container[data-user-id="${userId}"]`);
    let isNewEntry = !depositContainer;

    if (isNewEntry) {
        depositContainer = document.createElement('div');
        depositContainer.dataset.userId = userId;
        depositContainer.className = 'player-deposit-container player-deposit-new'; // Add new class for animation
    } else {
        // If updating, clear previous items grid for this user to rebuild with new total
        const existingItemsGrid = depositContainer.querySelector('.player-items-grid');
        if (existingItemsGrid) existingItemsGrid.innerHTML = ''; // Clear old items
        // Add a subtle update animation if needed
        depositContainer.classList.add('player-deposit-updated');
        setTimeout(() => depositContainer.classList.remove('player-deposit-updated'), 500);
    }

    // Build or update header
    let depositHeader = depositContainer.querySelector('.player-deposit-header');
    if (!depositHeader) {
        depositHeader = document.createElement('div');
        depositHeader.className = 'player-deposit-header';
        depositContainer.appendChild(depositHeader);
    }
    depositHeader.innerHTML = `
        <img src="${avatar}" alt="${username}" class="player-avatar" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-avatar.png';" style="border-color: ${userColor};">
        <div class="player-info">
            <div class="player-name" title="${username}">${username}</div>
            <div class="player-deposit-value" style="color: ${userColor}" title="Deposited: $${value.toFixed(2)} | Chance: ${percentage}%">
                $${value.toFixed(2)} | ${percentage}%
            </div>
        </div>`;

    // Build or rebuild items grid for THIS deposit
    let itemsGrid = depositContainer.querySelector('.player-items-grid');
    if (!itemsGrid) {
        itemsGrid = document.createElement('div');
        itemsGrid.className = 'player-items-grid';
        depositContainer.appendChild(itemsGrid);
    } else {
        itemsGrid.innerHTML = ''; // Clear previous items for this user if updating
    }


    if (items.length > 0) { // 'items' are the newly deposited items for this event
        items.sort((a, b) => (b.price || 0) - (a.price || 0)); // Sort new items by price
        const displayItems = items.slice(0, CONFIG.MAX_ITEMS_PER_DEPOSIT); // Show max N items

        displayItems.forEach(item => {
            if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.image) {
                console.warn("Skipping invalid item in deposit display (displayLatestDeposit):", item);
                return;
            }
            const itemElement = document.createElement('div');
            itemElement.className = 'player-deposit-item';
            itemElement.title = `$${item.price.toFixed(2)}`;
            itemElement.style.borderColor = userColor; // Use user's color for item border
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


    if (isNewEntry) {
        if (container.firstChild) {
            container.insertBefore(depositContainer, container.firstChild); // Add to top
        } else {
            container.appendChild(depositContainer);
        }
        setTimeout(() => { // Remove animation class after a bit
            depositContainer.classList.remove('player-deposit-new');
        }, 500);
    }


    if (emptyMsg) emptyMsg.style.display = 'none'; // Hide "empty pot" message

    // Remove oldest deposit blocks if exceeding display limit
    const currentDepositBlocks = container.querySelectorAll('.player-deposit-container');
    if (currentDepositBlocks.length > CONFIG.MAX_DISPLAY_DEPOSITS) {
        const blocksToRemove = currentDepositBlocks.length - CONFIG.MAX_DISPLAY_DEPOSITS;
        for (let i = 0; i < blocksToRemove; i++) {
            const oldestBlock = container.querySelector('.player-deposit-container:last-child');
            if (oldestBlock && oldestBlock !== depositContainer) { // Don't remove the one just added/updated
                oldestBlock.style.transition = 'opacity 0.3s ease-out, transform 0.3s ease-out';
                oldestBlock.style.opacity = '0';
                oldestBlock.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    if (oldestBlock.parentNode === container) { // Check if still child before removing
                        oldestBlock.remove();
                    }
                }, 300);
            }
        }
    }
}


// This function is called when 'participantUpdated' event is received from server
function handleNewDeposit(data) { // Renamed for clarity, as it handles updates too
    if (!data || !data.roundId || !data.userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue) || data.totalValue === undefined || data.tickets === undefined) {
        console.error("Invalid participant update data received from socket:", data);
        return;
    }
    if (!data.depositedItems) data.depositedItems = []; // Ensure it's an array for displayLatestDeposit

    if (!currentRound) { // If client has no current round, initialize it
        // This situation should be rare if 'roundData' or 'roundCreated' is received first
        currentRound = {
            roundId: data.roundId,
            status: 'active', // Assume active if a deposit comes through
            timeLeft: CONFIG.ROUND_DURATION, // Default, will be updated by 'timerUpdate'
            totalValue: 0, participants: [], items: []
        };
        console.warn("Handling deposit for non-existent local round. Initializing round with received data. Waiting for full sync.");
        socket.emit('requestRoundData'); // Request full sync to be sure
    } else if (currentRound.roundId !== data.roundId) {
        console.warn(`[Participant Update] Received for wrong round (${data.roundId}). Client is on ${currentRound.roundId}. Requesting full sync.`);
        socket.emit('requestRoundData'); // Request full sync
        return;
    }
    
    if(currentRound.status === 'pending') { // If round was pending, first deposit makes it active
        currentRound.status = 'active';
        console.log(`Round ${currentRound.roundId} is now active due to first deposit.`);
        // Backend will start the timer and send 'timerUpdate' and 'roundStatusUpdate'
    }


    // Update local currentRound state with the new/updated participant data
    if (!currentRound.participants) currentRound.participants = [];
    if (!currentRound.items) currentRound.items = []; // All items in the pot

    // If this deposit is from the currently logged-in user, clear their pending offer flag
    if (currentUser && currentUser.pendingDepositOfferId && (currentUser._id === data.userId || currentUser.id === data.userId)) {
       console.log(`Deposit processed for current user ${currentUser.username}, clearing local pendingDepositOfferId.`);
       currentUser.pendingDepositOfferId = null;
       updateUserUI(); // Update header indicator
       updateDepositButtonState(); // Update main deposit button on jackpot page
       if (DOMElements.deposit.depositModal?.style.display === 'flex') { // If deposit modal is open
           resetDepositModalUI(); // Reset buttons and status text
           selectedItemsList = []; // Clear client-side selection
           if(DOMElements.deposit.selectedItemsContainer) DOMElements.deposit.selectedItemsContainer.innerHTML = '';
           updateTotalValue();
           // Optionally hide the modal: hideModal(DOMElements.deposit.depositModal);
       }
    }

    // Find or add participant in local currentRound.participants array
    let participantIndex = currentRound.participants.findIndex(p => p.user?._id === data.userId || p.user?.id === data.userId);
    if (participantIndex !== -1) { // Participant exists, update their values
        currentRound.participants[participantIndex] = {
            ...currentRound.participants[participantIndex], // Keep existing user object if already populated
            itemsValue: data.itemsValue, // This is their NEW total value for the round
            tickets: data.tickets        // This is their NEW total tickets for the round
        };
    } else { // New participant for this round
        currentRound.participants.push({
            user: { _id: data.userId, id: data.userId, username: data.username || 'Unknown User', avatar: data.avatar || '/img/default-avatar.png' },
            itemsValue: data.itemsValue,
            tickets: data.tickets
        });
    }

    // Update total pot value
    currentRound.totalValue = data.totalValue;

    // Add the newly deposited items to the client's master list of items in the pot for this round
    // The 'data.depositedItems' are the items *just* added in this specific deposit action.
    data.depositedItems.forEach(item => {
        if (item && typeof item.price === 'number' && !isNaN(item.price)) {
            // Add with owner info for potential future use (like if roulette needs owner)
            currentRound.items.push({ ...item, owner: data.userId });
        } else {
            console.warn("Skipping invalid item while adding to client's round master item list:", item);
        }
    });

    updateRoundUI(); // Update pot value, participant count display
    displayLatestDeposit(data); // Visually add/update the deposit block in the UI
    updateAllParticipantPercentages(); // Recalculate and display percentages for all
    updateDepositButtonState(); // Re-check if deposit button should be enabled/disabled

    // If this was the first participant, backend should start the timer and send 'timerUpdate'.
    // Client-side timer start is mainly for immediate visual feedback, but relies on backend.
    if (currentRound.status === 'active' && currentRound.participants.length === 1 && !timerActive) {
        console.log("First participant joined. Client will wait for 'timerUpdate' from server to start its timer accurately.");
        // Backend will emit 'roundStatusUpdate' and 'timerUpdate' when round becomes active and timer starts.
    }
}


// This ensures the main display of participant blocks reflects the current state
// Usually called after a full 'roundData' sync.
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
    
    // Check if there are any .player-deposit-container elements already rendered
    const hasDepositBlocks = container.querySelector('.player-deposit-container') !== null;

    if (!hasDepositBlocks && participantNum === 0) { // If no blocks AND participant count is 0
        emptyMsg.style.display = 'block';
        if (!container.contains(emptyMsg)) { // Add if not already there (e.g., after clearing)
            container.appendChild(emptyMsg);
        }
    } else { // If there are blocks or participants, hide empty message
        emptyMsg.style.display = 'none';
    }
}


// Client-side visual timer, primarily driven by server 'timerUpdate' events
function startClientTimer(initialTime = CONFIG.ROUND_DURATION) {
    const timerDisplay = DOMElements.jackpot.timerValue;
    if (!timerDisplay) return;
    if (roundTimer) clearInterval(roundTimer); // Clear any existing client timer

    let timeLeft = Math.max(0, initialTime);
    console.log(`[Timer] Client visual timer starting/syncing from ${timeLeft}s for round ${currentRound?.roundId}`);
    timerActive = true; 
    updateTimerUI(timeLeft); // Initial display
    updateDepositButtonState(); // Update button state based on timer activity

    roundTimer = setInterval(() => {
        if (!timerActive || !currentRound || currentRound.status !== 'active') { 
            clearInterval(roundTimer); roundTimer = null; timerActive = false;
            console.log("[Timer] Client visual timer interval stopped (timerActive is false or round not active).");
            updateDepositButtonState(); // Ensure button state is correct
            return;
        }
        timeLeft--;
        if (currentRound) currentRound.timeLeft = timeLeft; // Keep local state somewhat in sync
        updateTimerUI(timeLeft);
        updateDepositButtonState();

        if (timeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null; timerActive = false;
            console.log(`[Timer] Client visual timer reached zero for round ${currentRound?.roundId}. Backend will handle round end.`);
            if (timerDisplay) timerDisplay.textContent = "0"; // Show 0 briefly
            // Backend will emit 'roundRolling' when it actually starts processing the end.
            updateDepositButtonState();
        }
    }, 1000);
}

// --- Roulette Animation Logic ---
// This is "the animation" the user wants to see directly after the timer.
function createRouletteItems() {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer; // The main animation area
    if (!track || !container) {
        console.error("Roulette track or inline roulette element missing for createRouletteItems.");
        return false; // Indicate failure
    }
    track.innerHTML = ''; // Clear previous items
    track.style.transition = 'none'; // Reset transitions for new setup
    track.style.transform = 'translateX(0)'; // Reset position

    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) {
        console.error('No participants data available in currentRound to create roulette items.');
        track.innerHTML = '<div class="roulette-message">Waiting for participants...</div>';
        return false; 
    }
    // While items are in currentRound.items, the roulette visually shows participant avatars based on their chance.
    // If you wanted to show items, this logic would need to change to use currentRound.items.
    // For now, it uses participant avatars weighted by tickets/value.

    let ticketPool = []; // This will hold one entry for each "visual block" in the roulette
    const totalTicketsInRound = currentRound.participants.reduce((sum, p) => sum + (p.tickets || 0), 0);
    // Determine number of visual blocks for the roulette animation strip
    // More blocks make the spin look smoother and longer.
    const targetVisualBlocks = Math.max(150, (currentRound.items?.length || 50) * 2, currentRound.participants.length * CONFIG.ROULETTE_REPETITIONS);

    if (totalTicketsInRound <= 0) {
        // Fallback if tickets are zero (e.g. if using value directly without tickets field)
        console.warn("Total tickets in round is zero. Building roulette based on item value percentage of total pot value.");
        const totalValueNonZero = Math.max(0.01, currentRound.totalValue || 0.01);
        currentRound.participants.forEach(p => {
            const userShareOfValue = p.itemsValue || 0;
            // Assign visual blocks proportional to their value share
            const visualBlocksForUser = Math.max(1, Math.ceil((userShareOfValue / totalValueNonZero) * targetVisualBlocks));
            for (let i = 0; i < visualBlocksForUser; i++) {
                ticketPool.push({ user: p.user }); // Add user ref for each block
            }
        });
    } else {
        // Standard: assign visual blocks proportional to tickets
        currentRound.participants.forEach(p => {
            const tickets = p.tickets || 0;
            const visualBlocksForUser = Math.max(1, Math.ceil((tickets / totalTicketsInRound) * targetVisualBlocks));
            for (let i = 0; i < visualBlocksForUser; i++) {
                ticketPool.push({ user: p.user });
            }
        });
    }

    if (ticketPool.length === 0) {
        console.error("Ticket pool calculation resulted in zero items for roulette. Participants:", currentRound.participants);
        track.innerHTML = '<div class="roulette-message">Error building roulette items.</div>';
        return false; 
    }

    // Shuffle the pool to make the visual distribution random
    ticketPool = shuffleArray([...ticketPool]);
    
    // Ensure enough items for a smooth, long animation effect, by repeating the shuffled pool if necessary
    const rouletteInnerContainer = container.querySelector('.roulette-container');
    const containerWidth = rouletteInnerContainer?.offsetWidth || container.offsetWidth || 1000; // Get width of visible area
    const itemWidthWithMargin = 90 + 10; // Item width (90px) + margin (5px left + 5px right = 10px)
    const itemsInView = Math.ceil(containerWidth / itemWidthWithMargin);
    const minItemsForAnimation = Math.max(300, itemsInView * CONFIG.ROULETTE_REPETITIONS * 1.5); // Ensure enough items
    
    let finalRouletteItems = [];
    while (finalRouletteItems.length < minItemsForAnimation && ticketPool.length > 0) {
        finalRouletteItems.push(...ticketPool); // Repeat the shuffled pool to get enough visual items
    }
    // Trim to a reasonable max if it became excessively long, or ensure minimum length
    finalRouletteItems = finalRouletteItems.slice(0, Math.max(minItemsForAnimation, finalRouletteItems.length)); 
    if (finalRouletteItems.length < itemsInView * 3 && ticketPool.length > 0) { // Absolute minimum if pool was very small
        while(finalRouletteItems.length < itemsInView * 3) finalRouletteItems.push(...ticketPool);
    }


    console.log(`Targeting ${finalRouletteItems.length} visual blocks for roulette animation.`);

    const fragment = document.createDocumentFragment();
    finalRouletteItems.forEach(participantRepresentation => { 
        const participantUser = participantRepresentation.user;
        if (!participantUser || (!participantUser._id && !participantUser.id)) { // Check for valid user object
            console.warn(`Skipping roulette item creation due to invalid participant user data:`, participantUser);
            return; // Skip this block if user data is malformed
        }
        const userId = participantUser._id || participantUser.id; // Get user's unique ID
        const userColor = getUserColor(userId);
        const avatar = participantUser.avatar || '/img/default-avatar.png';

        const itemElement = document.createElement('div');
        itemElement.className = 'roulette-item';
        itemElement.dataset.userId = userId.toString(); // Store user ID for identifying winner
        itemElement.style.borderColor = userColor; // Use user's color for item highlight
        itemElement.innerHTML = `
            <img class="roulette-avatar" src="${avatar}" alt="Participant Avatar" loading="lazy"
                 onerror="this.onerror=null; this.src='/img/default-avatar.png';" >`;
        fragment.appendChild(itemElement);
    });
    track.appendChild(fragment);
    console.log(`Created ${track.children.length} items for roulette animation.`);
    return true; // Success
}


// This function is called when 'roundWinner' event is received from the backend.
// It prepares and starts the roulette animation.
function handleWinnerAnnouncement(eventOrRoundData) {
    console.log("[Winner Announce Event Handler] Received data:", eventOrRoundData);

    let winnerForAnimation;
    let roundIdForAnimation;

    // Determine if we got a full round object or just winner event data
    if (eventOrRoundData.hasOwnProperty('participants') && eventOrRoundData.hasOwnProperty('items')) {
        // This looks like a full 'roundData' object that also contains winner info (e.g. from a sync)
        console.log("[Winner Announce] Processing as full round data object (likely sync).");
        currentRound = eventOrRoundData; // Update client's master round object
        winnerForAnimation = currentRound.winner;
        roundIdForAnimation = currentRound.roundId;
        // If it was a full sync, ensure participant visual blocks are up-to-date
        // (This part might be redundant if 'roundData' already handles this, but good for safety)
        if (DOMElements.jackpot.participantsContainer && currentRound.participants) {
            DOMElements.jackpot.participantsContainer.innerHTML = ''; // Clear existing
            if (currentRound.participants.length > 0) {
                if(DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'none';
                currentRound.participants.forEach(p => {
                     const pItems = currentRound.items?.filter(itm => itm.owner === (p.user._id || p.user.id)) || [];
                     displayLatestDeposit({ // Use displayLatestDeposit to render each participant
                        userId: p.user._id || p.user.id, username: p.user.username, avatar: p.user.avatar,
                        itemsValue: p.itemsValue, depositedItems: pItems, totalValue: currentRound.totalValue, tickets: p.tickets
                     });
                     // Ensure the 'new' animation class is removed if displayLatestDeposit adds it
                     const elem = DOMElements.jackpot.participantsContainer.querySelector(`.player-deposit-container[data-user-id="${p.user._id || p.user.id}"]`);
                     if (elem) elem.classList.remove('player-deposit-new');
                });
                updateAllParticipantPercentages();
            } else {
                if(DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'block';
            }
        }

    } else if (eventOrRoundData.winner && eventOrRoundData.roundId) {
        // This is likely the 'roundWinner' event specifically for animation
        console.log("[Winner Announce] Processing as 'roundWinner' event object.");
        if (!currentRound || currentRound.roundId !== eventOrRoundData.roundId) {
            // Mismatch or no current round; this is problematic for getting participant list for roulette.
            console.warn(`[Winner Announce] 'roundWinner' event for round ${eventOrRoundData.roundId}, but client currentRound is ${currentRound?.roundId}. Requesting full sync first.`);
            // It's crucial that currentRound.participants is accurate for createRouletteItems.
            // So, if there's a mismatch, we MUST get full data.
            socket.emit('requestRoundData'); // Ask for a full sync.
            // We cannot proceed with animation until participant data is confirmed for THIS round.
            // The 'roundData' handler will then need to re-trigger animation if winner is known.
            return; // Abort animation start for now.
        }
        // If round IDs match, update currentRound with winner and seed info from this event.
        currentRound.winner = eventOrRoundData.winner;
        currentRound.serverSeed = eventOrRoundData.serverSeed;
        currentRound.clientSeed = eventOrRoundData.clientSeed;
        currentRound.provableHash = eventOrRoundData.provableHash;
        currentRound.status = 'rolling'; // Ensure status reflects animation phase
        winnerForAnimation = eventOrRoundData.winner;
        roundIdForAnimation = eventOrRoundData.roundId;
    } else {
        console.error("[Winner Announce] Invalid data structure for winner announcement:", eventOrRoundData);
        resetToJackpotView(); // Critical error, reset.
        return;
    }

    if (!winnerForAnimation || !winnerForAnimation.id) {
        console.error("[Winner Announce] Winner details (especially ID) are missing from processed data.", winnerForAnimation);
        resetToJackpotView();
        return;
    }

    console.log(`[Winner Announce] Proceeding with winner: ${winnerForAnimation.username} for round ${roundIdForAnimation}. Client currentRound ID: ${currentRound?.roundId}`);

    if (timerActive) { // Stop client timer if it was running
        timerActive = false; clearInterval(roundTimer); roundTimer = null;
        console.log("[Winner Announce] Stopped client timer visually.");
    }
    isSpinning = true; // Set global flag
    updateDepositButtonState(); // Deposits should be disabled
    
    // Transition to the animation view.
    // This is where any "rolling thing pop up" would be avoided.
    // `switchToRouletteView` should just prepare the main animation area.
    switchToRouletteView();

    // Small delay to allow UI transition before starting animation logic
    setTimeout(() => {
        if (currentRound && currentRound.participants && currentRound.participants.length > 0) {
            console.log("[Winner Announce] Participants found in currentRound. Attempting to start animation with winner:", winnerForAnimation.username);
            startRouletteAnimation(winnerForAnimation); // Pass the winner data from the event
        } else {
            console.error("[Winner Announce] No participants in currentRound. Cannot start roulette animation. currentRound:", currentRound);
            showNotification("Error preparing animation: Participant data missing on client.", "error");
            // Try to get data again, then re-attempt animation or reset.
            socket.emit('requestRoundData');
            setTimeout(() => { 
                 if (currentRound && currentRound.participants && currentRound.participants.length > 0) {
                    console.log("[Winner Announce] Participants data received after re-fetch. Starting animation with winner:", winnerForAnimation.username);
                    startRouletteAnimation(winnerForAnimation);
                 } else {
                    console.error("[Winner Announce] Still no participant data after re-fetch. Resetting view.");
                    resetToJackpotView();
                 }
            }, 1500); // Wait for potential roundData
        }
    }, 500); // Delay for UI transition (e.g., fade out of jackpot header parts)
}


// Transitions the UI to show the roulette animation area.
// This should NOT show any intermediate "rolling pop-up", just prepare the animation view.
function switchToRouletteView() {
    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer; // The main animation area
    if (!header || !rouletteContainer) {
        console.error("Missing jackpot header or inline roulette container elements for view switch.");
        return;
    }

    // Fade out elements in the jackpot header (pot value, timer, participant count)
    const valueDisplay = header.querySelector('.jackpot-value');
    const timerDisplay = header.querySelector('.jackpot-timer');
    const statsDisplay = header.querySelector('.jackpot-stats');

    [valueDisplay, timerDisplay, statsDisplay].forEach(el => {
        if (el) {
            el.style.transition = 'opacity 0.5s ease, transform 0.5s ease'; // Added transform
            el.style.opacity = '0';
            el.style.transform = 'scale(0.9)'; // Optional shrink effect
            setTimeout(() => { if(el) el.style.display = 'none'; }, 500); // Hide after fade
        }
    });

    header.classList.add('roulette-mode'); // Modifies header style for animation phase

    // Fade in the roulette animation container
    rouletteContainer.style.display = 'flex'; // Make it visible for transition
    rouletteContainer.style.opacity = '0';
    rouletteContainer.style.transform = 'translateY(20px)'; // Start slightly down

    setTimeout(() => { // Start fade-in after a brief moment for header elements to start fading
        rouletteContainer.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
        rouletteContainer.style.opacity = '1';
        rouletteContainer.style.transform = 'translateY(0)';
    }, 100);

    // Hide deposit button during animation
    const depositBtnContainer = DOMElements.deposit.showDepositModalButton.parentElement;
    if (depositBtnContainer) {
        depositBtnContainer.style.transition = 'opacity 0.3s ease';
        depositBtnContainer.style.opacity = '0';
        setTimeout(() => { if(depositBtnContainer) depositBtnContainer.style.display = 'none'; }, 300);
    }
    // The "Return to Jackpot" button is already hidden by CSS, no need to manage here.
}


// Starts the actual roulette spinning animation
function startRouletteAnimation(winnerDataFromEvent) { // winnerDataFromEvent is the winner object from 'roundWinner'
    if (animationFrameId) { // Cancel any ongoing animation frame
        cancelAnimationFrame(animationFrameId); animationFrameId = null;
        console.log("Cancelled previous animation frame before starting new one.");
    }

    const winnerId = winnerDataFromEvent?.id?.toString(); // Get ID from the event data
    if (!winnerId) {
        console.error("[Animation Start] Invalid winner data (missing ID) passed to startRouletteAnimation:", winnerDataFromEvent);
        resetToJackpotView(); return;
    }

    isSpinning = true; updateDepositButtonState(); spinStartTime = 0; // Reset spin start time
    if (DOMElements.roulette.winnerInfoBox) DOMElements.roulette.winnerInfoBox.style.display = 'none'; // Hide previous winner info
    clearConfetti(); // Clear previous confetti
    
    // Create the visual items for the roulette track.
    // This relies on currentRound.participants being up-to-date.
    if (!createRouletteItems()) { 
        console.error("[Animation Start] Failed to create roulette items. Aborting animation.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    // Find the winner's details from the client's `currentRound` data for display purposes.
    // `findWinnerFromData` uses `winnerDataFromEvent` to identify the winner in `currentRound.participants`.
    const winnerParticipantDisplayData = findWinnerFromData({ winner: winnerDataFromEvent }); 
    if (!winnerParticipantDisplayData || !winnerParticipantDisplayData.user || !winnerParticipantDisplayData.user.username) {
        console.error('[Animation Start] Could not find or construct valid winner display data from currentRound. Winner from event:', winnerDataFromEvent, 'Client currentRound participants:', currentRound?.participants);
        showNotification("Error: Could not prepare winner animation details. Round data might be inconsistent.", "error");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }
    
    console.log('[Animation Start] Starting animation for Winner:', winnerParticipantDisplayData.user.username, `(ID: ${winnerId})`);
    const sound = DOMElements.audio.spinSound;
    if (sound) {
        sound.volume = 0.7; sound.currentTime = 0; sound.playbackRate = 1.0;
        sound.play().catch(e => console.error('Error playing spin sound:', e));
    }

    // Small delay to ensure DOM is ready after createRouletteItems
    setTimeout(() => { 
        const track = DOMElements.roulette.rouletteTrack;
        const items = track?.querySelectorAll('.roulette-item'); // Get all visual blocks
        if (!track || !items || items.length === 0) {
            console.error('[Animation Start] Cannot spin, no items rendered on track after createRouletteItems.');
            isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
        }

        // Determine a target index for the winning item on the visual strip
        // Prefer a winner in the latter part of the strip for a better visual effect.
        const minIndexPercent = 0.65, maxIndexPercent = 0.85; // Target zone for winner
        const minIndex = Math.floor(items.length * minIndexPercent);
        const maxIndex = Math.floor(items.length * maxIndexPercent);

        let winnerItemsIndices = []; // Find all occurrences of the winner in the target zone
        for (let i = minIndex; i <= maxIndex; i++) {
            if (items[i]?.dataset?.userId === winnerId) winnerItemsIndices.push(i);
        }
        
        let targetIndex;
        if (winnerItemsIndices.length > 0) { // If winner found in preferred zone
            targetIndex = winnerItemsIndices[Math.floor(Math.random() * winnerItemsIndices.length)]; // Pick one randomly
        } else { // Winner not in preferred zone, search the whole track
            console.warn(`[Animation Start] Winner ID ${winnerId} not found in preferred roulette range [${minIndex}-${maxIndex}]. Searching full track.`);
            winnerItemsIndices = []; // Reset for full search
            for (let i = 0; i < items.length; i++) {
                 if (items[i]?.dataset?.userId === winnerId) winnerItemsIndices.push(i);
            }
            if (winnerItemsIndices.length > 0) { // If found anywhere
                targetIndex = winnerItemsIndices[Math.floor(Math.random() * winnerItemsIndices.length)];
            } else { // Winner ID is not on the track at all (should be extremely rare if data is consistent)
                console.error(`[Animation Start] CRITICAL: Winner ID ${winnerId} (${winnerDataFromEvent.username}) not found anywhere on roulette track. Items on track: ${items.length}. Track userIds (sample):`, Array.from(items).slice(0,10).map(it => it.dataset.userId));
                // Fallback: pick a random item in the preferred zone or middle if that fails
                targetIndex = Math.max(0, Math.min(items.length - 1, Math.floor(items.length * 0.75)));
                showNotification("Animation error: Winner visual not found. Displaying approximate result.", "warning");
            }
        }
        
        const winningElement = items[targetIndex]; // The visual block that will land under the ticker
        if (!winningElement) {
            console.error(`[Animation Start] Selected winning element at index ${targetIndex} is invalid!`);
            isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
        }

        console.log(`[Animation Start] Selected winning element for ${winnerParticipantDisplayData.user.username} at index ${targetIndex} of ${items.length} items.`);
        // Start the actual scrolling animation
        handleRouletteSpinAnimation(winningElement, winnerParticipantDisplayData); // Pass winner display data
    }, 100); // Small delay for DOM updates
}


// Handles the physics/timing of the roulette scroll animation
function handleRouletteSpinAnimation(winningElement, winnerDisplayData) { // winnerDisplayData has {user, value, percentage}
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer?.querySelector('.roulette-container'); // The visible window
    if (!winningElement || !track || !container) {
        console.error("Missing elements for roulette animation loop (handleRouletteSpinAnimation).");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const containerWidth = container.offsetWidth;
    const itemWidth = winningElement.offsetWidth || 90; // Fallback item width
    const itemOffsetLeft = winningElement.offsetLeft; // Position of the winning item within the track

    // Calculate the scroll position to center the winningElement under the ticker
    const centerOffset = (containerWidth / 2) - (itemWidth / 2); // Position of ticker relative to container start
    const perfectCenterScrollPosition = -(itemOffsetLeft - centerOffset);

    // Add a slight random variation to where it lands, to make it feel less mechanical
    // Variation is a percentage of item width, e.g., up to 30% left/right of perfect center.
    const variationAmount = (Math.random() * 2 - 1) * (itemWidth * CONFIG.LANDING_POSITION_VARIATION);
    // Ensure variation doesn't push it completely off-center from the target item
    const maxAllowedAbsVariation = itemWidth * 0.49; // Almost half item width
    let finalVariation;
    if (Math.abs(variationAmount) <= maxAllowedAbsVariation) {
        finalVariation = variationAmount;
    } else { // Cap the variation
        finalVariation = Math.sign(variationAmount) * maxAllowedAbsVariation;
    }
    const targetScrollPosition = perfectCenterScrollPosition + finalVariation;
    const finalTargetPosition = targetScrollPosition; // This is where the track should stop

    const startPosition = parseFloat(track.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1] || '0');
    const duration = CONFIG.SPIN_DURATION_SECONDS * 1000;
    const bounceDuration = CONFIG.BOUNCE_ENABLED ? 1200 : 0; // Duration for bounce settle, if enabled
    const totalAnimationTime = duration + bounceDuration;
    const totalDistance = finalTargetPosition - startPosition;
    const overshootAmount = totalDistance * CONFIG.BOUNCE_OVERSHOOT_FACTOR; // For bounce effect

    let startTime = performance.now(); spinStartTime = startTime; // Record start time for progress calculation
    track.style.transition = 'none'; // Ensure direct transform manipulation

    function animateRoulette(timestamp) {
        if (!isSpinning) { // Check global flag to stop animation if needed
            console.log("Animation loop stopped: isSpinning flag is false.");
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            animationFrameId = null; return;
        }
        const elapsed = timestamp - startTime;
        let currentPosition, animationFinished = false;

        if (elapsed <= duration) { // Main spin phase
            const animationPhaseProgress = elapsed / duration;
            const easedProgress = easeOutAnimation(animationPhaseProgress); // Apply easing
            currentPosition = startPosition + totalDistance * easedProgress;
        } else if (CONFIG.BOUNCE_ENABLED && elapsed <= totalAnimationTime) { // Bounce phase (if enabled)
            const bouncePhaseProgress = (elapsed - duration) / bounceDuration;
            const bounceDisplacementFactor = calculateBounce(bouncePhaseProgress); // Get bounce offset
            currentPosition = finalTargetPosition - (overshootAmount * bounceDisplacementFactor);
        } else { // Animation complete
            currentPosition = finalTargetPosition; animationFinished = true;
        }
        track.style.transform = `translateX(${currentPosition}px)`;

        if (!animationFinished) {
            animationFrameId = requestAnimationFrame(animateRoulette);
        } else {
            console.log("Roulette animation finished naturally in loop.");
            animationFrameId = null;
            finalizeSpin(winningElement, winnerDisplayData); // Proceed to show winner details
        }
    }
    if (animationFrameId) cancelAnimationFrame(animationFrameId); // Clear any previous frame
    animationFrameId = requestAnimationFrame(animateRoulette); // Start the animation loop
}

// Called after the roulette animation stops, to highlight the winner and prepare for info display.
function finalizeSpin(winningElement, winnerDisplayData) { // winnerDisplayData has {user, value, percentage}
    // Check if already finalized or data is invalid
    if ((!isSpinning && winningElement?.classList.contains('winner-highlight')) || !winningElement || !winnerDisplayData?.user) {
        console.log("FinalizeSpin called, but seems already finalized or data invalid. isSpinning:", isSpinning);
        if (isSpinning) { // If somehow still true, ensure it's set false
            isSpinning = false; updateDepositButtonState();
            // If winnings offer is already present, show its modal, otherwise schedule reset.
            if (currentWinningsOfferData) {
                displayAcceptWinningsModal(currentWinningsOfferData);
            } else {
                 setTimeout(resetToJackpotView, CONFIG.WINNER_INFO_DISPLAY_DURATION);
            }
        }
        return;
    }
    console.log("Finalizing spin: Applying highlight to winner element for", winnerDisplayData.user.username);

    const winnerId = winnerDisplayData.user.id || winnerDisplayData.user._id;
    const userColor = getUserColor(winnerId);

    // Highlight the winning item in the roulette strip
    winningElement.classList.add('winner-highlight');
    // Dynamic style for pulsing shadow with user's color (prevents CSS global scope issues)
    const styleId = 'winner-pulse-style';
    document.getElementById(styleId)?.remove(); // Remove old style if exists
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        .winner-highlight {
            z-index: 5; border-width: 3px !important; border-color: ${userColor} !important;
            animation: winnerPulse 1.5s infinite; --winner-color: ${userColor};
            transform: scale(1.05); /* Slightly larger */
        }
        @keyframes winnerPulse {
            0%, 100% { box-shadow: 0 0 15px var(--winner-color), 0 0 5px var(--winner-color) inset; transform: scale(1.05); }
            50% { box-shadow: 0 0 25px var(--winner-color), 0 0 10px var(--winner-color) inset; transform: scale(1.1); }
        }`;
    document.head.appendChild(style);

    // Short delay before showing the winner info box ("winning screen")
    setTimeout(() => {
        handleSpinEnd(winningElement, winnerDisplayData);
    }, 300); 
}

// This function is called after the animation is complete and winner is highlighted.
// It displays the "winning screen" (winnerInfoBox) and then handles the "accept winnings" pop-up.
function handleSpinEnd(winningElement, winnerDisplayData) { // winnerDisplayData has {user, value, percentage}
    if (!winningElement || !winnerDisplayData?.user) {
        console.error("handleSpinEnd called with invalid data/element. Resetting.");
        if (!isSpinning && !currentWinningsOfferData) { // If not spinning and no modal pending
            resetToJackpotView();
        }
        if(isSpinning) isSpinning = false;
        updateDepositButtonState();
        return;
    }
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; } // Stop animation loop

    console.log("[Spin End] Displaying winner. isSpinning:", isSpinning, "currentWinningsOfferData:", currentWinningsOfferData);
    isSpinning = false; // Mark animation as officially over
    updateDepositButtonState(); // Re-enable deposits for next round (handled by resetToJackpotView)

    const { winnerInfoBox, winnerAvatar, winnerName, winnerDeposit, winnerChance } = DOMElements.roulette;

    // 1. Display the "Winning Screen" (winnerInfoBox)
    if (winnerInfoBox && winnerAvatar && winnerName && winnerDeposit && winnerChance) {
        console.log("[Spin End] Displaying inline 'winning screen' (winnerInfoBox) for:", winnerDisplayData.user.username);
        const winnerId = winnerDisplayData.user.id || winnerDisplayData.user._id;
        const userColor = getUserColor(winnerId);
        winnerAvatar.src = winnerDisplayData.user.avatar || '/img/default-avatar.png';
        winnerAvatar.alt = winnerDisplayData.user.username || 'Winner';
        winnerAvatar.style.borderColor = userColor;
        winnerAvatar.style.boxShadow = `0 0 15px ${userColor}`;
        winnerName.textContent = winnerDisplayData.user.username || 'Winner';
        winnerName.style.color = userColor;
        
        // These values come from `findWinnerFromData` which should use `currentRound` participant data
        const depositValueStr = `$${(winnerDisplayData.value || 0).toFixed(2)}`; 
        const chanceValueStr = `${(winnerDisplayData.percentage || 0).toFixed(2)}%`; 
        
        winnerDeposit.textContent = ''; // Clear for typing effect
        winnerChance.textContent = '';  // Clear for typing effect
        winnerInfoBox.style.display = 'flex'; // Show the box
        winnerInfoBox.style.opacity = '0';
        winnerInfoBox.style.animation = 'fadeIn 0.5s ease forwards'; // Fade it in

        // Typing animation for stats
        setTimeout(() => { // Delay typing effect slightly
            let depositIndex = 0; let chanceIndex = 0; const typeDelay = 35;
            if (window.typeDepositInterval) clearInterval(window.typeDepositInterval); // Clear previous if any
            if (window.typeChanceInterval) clearInterval(window.typeChanceInterval);

            window.typeDepositInterval = setInterval(() => {
                if (depositIndex < depositValueStr.length) {
                    winnerDeposit.textContent += depositValueStr[depositIndex]; depositIndex++;
                } else {
                    clearInterval(window.typeDepositInterval); window.typeDepositInterval = null;
                    // Start typing chance after deposit amount is done
                    window.typeChanceInterval = setInterval(() => {
                        if (chanceIndex < chanceValueStr.length) {
                            winnerChance.textContent += chanceValueStr[chanceIndex]; chanceIndex++;
                        } else {
                            clearInterval(window.typeChanceInterval); window.typeChanceInterval = null;
                            // After stats are typed, launch confetti
                            setTimeout(() => { launchConfetti(userColor); }, 200);
                            console.log("[Spin End] Inline 'winning screen' display complete.");
                            
                            // 2. Check for and Display the "Accept Winnings" Pop-up
                            // This happens AFTER the "winning screen" (winnerInfoBox) is displayed.
                            // currentWinningsOfferData is set when 'tradeOfferSent' is received.
                            if (currentWinningsOfferData && currentWinningsOfferData.userId === winnerId) {
                                console.log("[Spin End] Winnings trade offer data is available. Displaying 'Accept Winnings' modal for offer:", currentWinningsOfferData.offerId);
                                displayAcceptWinningsModal(currentWinningsOfferData);
                                // The WINNER_INFO_DISPLAY_DURATION timeout for resetToJackpotView will be ignored
                                // if acceptWinningsModal is shown, as that modal's close will handle reset.
                            } else {
                                console.log("[Spin End] No winnings trade offer data YET, or offer not for this winner. 'winning screen' will show for its duration.");
                                // If no winnings modal pops up, the "winning screen" (winnerInfoBox) will timeout
                                // and then reset the view.
                                if (!currentWinningsOfferData) { // Only set this timeout if modal is not imminent
                                     setTimeout(resetToJackpotViewIfNeeded, CONFIG.WINNER_INFO_DISPLAY_DURATION);
                                }
                            }
                        }
                    }, typeDelay);
                }
            }, typeDelay);
        }, 500); // Delay before starting typing effect on winnerInfoBox
    } else {
        console.error("[Spin End] Winner info display elements (winnerInfoBox, etc.) missing. Cannot show 'winning screen'.");
        // If "winning screen" can't show, still try to show "accept winnings" modal if data exists.
        if (currentWinningsOfferData && currentWinningsOfferData.userId === (winnerDisplayData.user.id || winnerDisplayData.user._id)) {
            displayAcceptWinningsModal(currentWinningsOfferData);
        } else {
            resetToJackpotView(); // Fallback to reset if nothing can be shown
        }
    }
}


function launchConfetti(mainColor = '#00e676') {
    const container = DOMElements.roulette.confettiContainer;
    if (!container) return;
    clearConfetti(); // Clear any previous confetti first
    
    // Simple helper for color variations
    const varyColor = (hex, percent) => {
        hex = hex.replace('#', '');
        let r = parseInt(hex.substring(0,2), 16);
        let g = parseInt(hex.substring(2,4), 16);
        let b = parseInt(hex.substring(4,6), 16);
        const factor = 1 + (Math.random() * percent * 2 - percent) / 100; // e.g. -20% to +20%
        r = Math.min(255, Math.max(0, Math.floor(r * factor)));
        g = Math.min(255, Math.max(0, Math.floor(g * factor)));
        b = Math.min(255, Math.max(0, Math.floor(b * factor)));
        return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
    };

    const colors = [mainColor, varyColor(mainColor, 20), varyColor(mainColor, -20), '#FFFFFF', '#FFD700']; // Gold, White

    for (let i = 0; i < CONFIG.CONFETTI_COUNT; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'confetti-piece';
        confetti.style.left = `${Math.random() * 100}%`; // Spread horizontally
        const animDuration = 2 + Math.random() * 3; // Duration 2-5s
        const animDelay = Math.random() * 1.5;    // Delay up to 1.5s
        confetti.style.setProperty('--duration', `${animDuration}s`);
        confetti.style.setProperty('--delay', `${animDelay}s`);
        confetti.style.setProperty('--color', colors[Math.floor(Math.random() * colors.length)]);
        
        const size = Math.random() * 8 + 4; // Size 4px to 12px
        confetti.style.width = `${size}px`; confetti.style.height = `${size}px`;
        
        const rotationStart = Math.random() * 360;
        const rotationEnd = rotationStart + (Math.random() - 0.5) * 720; // Rotate a bit
        const fallX = (Math.random() - 0.5) * 100; // Horizontal drift
        confetti.style.setProperty('--fall-x', `${fallX}px`);
        confetti.style.setProperty('--rotation-start', `${rotationStart}deg`);
        confetti.style.setProperty('--rotation-end', `${rotationEnd}deg`);
        
        if (Math.random() < 0.5) confetti.style.borderRadius = '50%'; // Some circles, some squares
        container.appendChild(confetti);
    }
}

function clearConfetti() {
    if (DOMElements.roulette.confettiContainer) DOMElements.roulette.confettiContainer.innerHTML = '';
    // Remove winner pulse style from head if it exists
    document.getElementById('winner-pulse-style')?.remove();
    // Clear highlight from roulette items
    document.querySelectorAll('.roulette-item.winner-highlight').forEach(el => {
        el.classList.remove('winner-highlight');
        el.style.transform = ''; // Reset any specific transform
        // Reset border to default or user color if applicable
        if (el.dataset?.userId) el.style.borderColor = getUserColor(el.dataset.userId); 
        else el.style.borderColor = 'transparent'; // Fallback
    });
}


// Resets the UI from roulette/winner display back to the main jackpot view for a new round.
function resetToJackpotView() {
    console.log("[Reset View] Resetting to jackpot view for new round...");
    // Clear any ongoing animations or timeouts
    if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null;
    if (window.soundFadeInInterval) clearInterval(window.soundFadeInInterval); window.soundFadeInInterval = null;
    if (window.soundFadeOutInterval) clearInterval(window.soundFadeOutInterval); window.soundFadeOutInterval = null;
    if (window.typeDepositInterval) clearInterval(window.typeDepositInterval); window.typeDepositInterval = null;
    if (window.typeChanceInterval) clearInterval(window.typeChanceInterval); window.typeChanceInterval = null;
    if (roundTimer) clearInterval(roundTimer); roundTimer = null; // Clear client-side round timer

    timerActive = false; isSpinning = false; spinStartTime = 0;
    currentWinningsOfferData = null; // Clear any pending winnings data
    if (acceptWinningsModalTimeout) clearTimeout(acceptWinningsModalTimeout); // Clear auto-close for winnings modal

    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer;
    const winnerInfoBox = DOMElements.roulette.winnerInfoBox; // The "winning screen"
    const track = DOMElements.roulette.rouletteTrack;

    if (!header || !rouletteContainer || !winnerInfoBox || !track) {
        console.error("[Reset View] Missing elements for resetToJackpotView. UI may not reset correctly.");
        // Attempt to still reset what we can
        currentRound = null; 
        initiateNewRoundVisualReset(); 
        updateDepositButtonState();
        socket.emit('requestRoundData'); // Try to resync
        return;
    }

    // Stop sounds
    const sound = DOMElements.audio.spinSound;
    if (sound) { sound.pause(); sound.currentTime = 0; sound.volume = 1.0; sound.playbackRate = 1.0; }

    // Hide animation elements smoothly
    rouletteContainer.style.transition = 'opacity 0.5s ease, transform 0.3s ease';
    rouletteContainer.style.opacity = '0';
    rouletteContainer.style.transform = 'scale(0.95)'; // Slight shrink out
    if (winnerInfoBox.style.display !== 'none') {
        winnerInfoBox.style.transition = 'opacity 0.3s ease';
        winnerInfoBox.style.opacity = '0';
    }
    clearConfetti(); // Remove confetti and winner highlight styles

    // Restore deposit button visibility
    const depositBtnContainer = DOMElements.deposit.showDepositModalButton.parentElement;
    if (depositBtnContainer) {
        depositBtnContainer.style.display = 'flex'; // Or 'block' depending on its layout
        setTimeout(() => { depositBtnContainer.style.opacity = '1'; }, 50); // Fade in
    }


    // After animations out, reset styles and display main jackpot header elements
    setTimeout(() => {
        header.classList.remove('roulette-mode');
        track.style.transition = 'none'; track.style.transform = 'translateX(0)'; track.innerHTML = ''; // Clear track
        rouletteContainer.style.display = 'none'; rouletteContainer.style.transform = ''; // Reset transform
        winnerInfoBox.style.display = 'none'; winnerInfoBox.style.opacity = ''; winnerInfoBox.style.animation = '';

        // Restore jackpot header elements
        const valueDisplay = header.querySelector('.jackpot-value');
        const timerDisplay = header.querySelector('.jackpot-timer');
        const statsDisplay = header.querySelector('.jackpot-stats');

        [valueDisplay, timerDisplay, statsDisplay].forEach((el, index) => {
            if (el) {
                el.style.display = 'flex'; // Or original display type
                el.style.transform = 'scale(0.9)'; // Start small for fade-in
                el.style.opacity = '0';
                setTimeout(() => {
                    el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
                    el.style.opacity = '1';
                    el.style.transform = 'scale(1)';
                }, 50 + index * 50); // Staggered fade-in
            }
        });
        
        // Reset client state for the new round
        currentRound = null; // Server will send new round data via 'roundCreated' or 'roundData'
        initiateNewRoundVisualReset(); // Clear pot visuals, reset timer display etc.
        updateDepositButtonState(); // Update button based on new (likely pending) state

        // Request fresh round data from server to ensure sync for the new round
        if (socket?.connected) {
            console.log("[Reset View] Requesting fresh round data from server.");
            socket.emit('requestRoundData'); 
        } else {
            console.warn("[Reset View] Socket not connected, cannot request fresh round data.");
            // UI might show "Waiting" or similar until connection re-established
        }
    }, 500); // Wait for roulette elements to fade out
}

// Resets visual elements for a brand new round (pot, timer text, etc.)
// Called by resetToJackpotView and when 'roundCreated' is received.
function initiateNewRoundVisualReset() {
    console.log("[Visual Reset] Initiating visual reset for new round display.");
    
    if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Waiting"; 
    updateTimerCircle(CONFIG.ROUND_DURATION, CONFIG.ROUND_DURATION); // Show full circle for waiting
    if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.classList.remove('urgent-pulse', 'timer-pulse');
    if (roundTimer) clearInterval(roundTimer); roundTimer = null; timerActive = false;

    // Clear participant display area
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (container && emptyMsg) {
        container.innerHTML = ''; // Clear all old deposit blocks
        if (!container.contains(emptyMsg)) container.appendChild(emptyMsg); // Add empty message back
        emptyMsg.style.display = 'block'; // Ensure it's visible
    }

    // Reset pot value and participant count displays
    if (DOMElements.jackpot.potValue) DOMElements.jackpot.potValue.textContent = "$0.00";
    if (DOMElements.jackpot.participantCount) DOMElements.jackpot.participantCount.textContent = `0/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
    
    userColorMap.clear(); // Clear color assignments for new round participants
    updateDepositButtonState(); // Update deposit button (likely to "closed" or "waiting")
}


// Helper to determine winner details from currentRound for display
// `winnerDataWrapper` is expected to be like { winner: { id: '...', username: '...', avatar: '...' } }
function findWinnerFromData(winnerDataWrapper) { 
    const winnerFromEvent = winnerDataWrapper?.winner; // The winner object from 'roundWinner' or full 'roundData'
    const winnerId = winnerFromEvent?.id?.toString(); // Get the winner's ID (string)

    if (!winnerId) {
        console.error("[Find Winner] Missing winner ID in data provided:", winnerDataWrapper);
        // Fallback if critical winner ID is missing from the event/data that triggered this
        return { 
            user: { 
                id: 'unknown', _id: 'unknown', username: 'Error', 
                avatar: '/img/default-avatar.png', steamId: ''
            }, 
            percentage: 0, value: 0       
        };
    }

    // If currentRound or its participants are not available, use event data directly (minimal info)
    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) {
        console.warn(`[Find Winner] currentRound.participants is empty or currentRound is null. Using minimal data from event for winner: ${winnerFromEvent.username}`);
        return { 
            user: { // Construct a user object from what we have in winnerFromEvent
                id: winnerId, 
                _id: winnerId, // Common to have both for convenience
                username: winnerFromEvent.username || 'Winner', 
                avatar: winnerFromEvent.avatar || '/img/default-avatar.png',
                steamId: winnerFromEvent.steamId || '' // If available
            }, 
            percentage: 0, // Cannot calculate percentage without full participant list
            value: 0        // Cannot determine their specific deposit value without full list
        };
    }

    // Try to find the full participant object from our local currentRound.participants
    const winnerParticipant = currentRound.participants.find(p => 
        p.user && (p.user._id?.toString() === winnerId || p.user.id?.toString() === winnerId)
    );

    if (!winnerParticipant || !winnerParticipant.user) {
        // This means the winner ID from the event was not found in our local participant list.
        // This could happen if client's participant list is stale.
        console.warn(`[Find Winner] Winner ID ${winnerId} (${winnerFromEvent.username}) not found in local currentRound.participants. Client list might be stale. Using event data for user info.`);
        return { 
            user: { // Still use event data for user info as it's directly from server about the winner
                id: winnerId, _id: winnerId,
                username: winnerFromEvent.username || 'Winner', 
                avatar: winnerFromEvent.avatar || '/img/default-avatar.png',
                steamId: winnerFromEvent.steamId || ''
            }, 
            percentage: 0, // Cannot accurately calculate based on stale local data
            value: 0 
        };
    }
    
    // Winner found locally, calculate their stats based on local currentRound
    const totalValueAtWinTime = Math.max(0.01, currentRound.totalValue || 0.01); // Use totalValue from currentRound
    const participantValue = winnerParticipant.itemsValue || 0;
    const percentage = (participantValue / totalValueAtWinTime) * 100;
    
    console.log(`[Find Winner] Found participant ${winnerParticipant.user.username} locally. Value: $${participantValue.toFixed(2)}, Chance: ${percentage.toFixed(2)}%`);
    return {
        user: { ...(winnerParticipant.user) }, // Return the full user object from local data
        percentage: percentage || 0,
        value: participantValue
    };
}

// --- Provably Fair & Round History ---
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
        console.warn("Rounds history table/pagination elements missing for loadPastRounds."); return;
    }
    try {
        tableBody.innerHTML = '<tr><td colspan="5" class="loading-message">Loading round history...</td></tr>';
        paginationContainer.innerHTML = '';
        const response = await fetch(`/api/rounds?page=${page}&limit=10`);
        if (!response.ok) throw new Error(`Failed to load round history (${response.status})`);
        const data = await response.json();
        if (!data || !Array.isArray(data.rounds) || typeof data.currentPage !== 'number' || typeof data.totalPages !== 'number') {
            throw new Error('Invalid rounds data received from server for past rounds.');
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
                const timeToFormat = round.completedTime || round.endTime; // Prefer completedTime
                if (timeToFormat) {
                    try {
                        const d = new Date(timeToFormat);
                        if (!isNaN(d.getTime())) date = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
                    } catch (e) { console.error("Date formatting error for past round:", e); }
                }
                const serverSeedStr = (round.serverSeed || '').replace(/'/g, "\\'"); // Escape for JS string
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
                                ${!round.serverSeed ? 'disabled title="Seed not revealed yet"' : 'title="Verify this round"'}>
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

// Expose to global scope for inline HTML onclick
window.populateVerificationFields = function(roundId, serverSeed, clientSeed) {
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationSection } = DOMElements.provablyFair;
    if (roundIdInput) roundIdInput.value = roundId || '';
    if (serverSeedInput) serverSeedInput.value = serverSeed || '';
    if (clientSeedInput) clientSeedInput.value = clientSeed || '';
    if (verificationSection) verificationSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // Notify if seeds are not yet available (e.g., round not old enough for serverSeed reveal)
    if (!serverSeed && roundId && roundId !== 'N/A') {
        showNotification(`Info: Server Seed for Round #${roundId} is revealed after the round ends and is processed.`, 'info');
    }
};


function createPagination(currentPage, totalPages) {
    const container = DOMElements.provablyFair.roundsPagination;
    if (!container) return; container.innerHTML = ''; // Clear previous
    if (totalPages <= 1) return; // No pagination if 1 or 0 pages

    const maxPagesToShow = 5; // Number of page buttons to show (e.g., 1 ... 4 5 6 ... 10)
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

    // Previous button
    container.appendChild(createButton('« Prev', currentPage - 1, false, currentPage <= 1));

    if (totalPages <= maxPagesToShow) { // Show all pages if total is small
        for (let i = 1; i <= totalPages; i++) container.appendChild(createButton(i, i, i === currentPage));
    } else { // More complex pagination with ellipsis
        let pages = [];
        pages.push(1); // Always show first page

        // Calculate range for middle pages
        const rangePadding = Math.floor((maxPagesToShow - 3) / 2); // -3 for first, last, and one ellipsis potential
        let rangeStart = Math.max(2, currentPage - rangePadding);
        let rangeEnd = Math.min(totalPages - 1, currentPage + rangePadding);

        // Adjust range if it's too small due to being near start/end
        const rangeLength = rangeEnd - rangeStart + 1;
        const neededMiddlePages = maxPagesToShow - 2; // Need to show first, last, and X middle pages
        
        if (rangeLength < neededMiddlePages -1) { // -1 because we might have one ellipsis
             if (currentPage - rangeStart < rangeEnd - currentPage) { // Closer to start
                 rangeEnd = Math.min(totalPages - 1, rangeStart + (neededMiddlePages -1 -1));
             } else { // Closer to end
                 rangeStart = Math.max(2, rangeEnd - (neededMiddlePages -1 -1));
             }
        }


        if (rangeStart > 2) pages.push('...'); // Ellipsis after first page
        for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);
        if (rangeEnd < totalPages - 1) pages.push('...'); // Ellipsis before last page
        
        pages.push(totalPages); // Always show last page

        // Remove duplicate ellipsis or pages
        pages = pages.filter((page, index, self) => page !== '...' || self[index-1] !== '...');
        pages = pages.filter((page, index, self) => typeof page === 'number' || self.indexOf(page) === index);


        pages.forEach(page => {
            if (page === '...') container.appendChild(createButton('...', null, false, true, true));
            else container.appendChild(createButton(page, page, page === currentPage));
        });
    }
    // Next button
    container.appendChild(createButton('Next »', currentPage + 1, false, currentPage >= totalPages));
}

// --- Chat Functionality ---
function updateChatUI() {
    const { messageInput, sendMessageBtn, onlineUsers } = DOMElements.chat;
    if (currentUser) {
        if (messageInput) {
            messageInput.disabled = false;
            messageInput.placeholder = 'Type your message...';
        }
        if (sendMessageBtn) sendMessageBtn.disabled = isChatSendOnCooldown; // Disable if on cooldown
    } else {
        if (messageInput) {
            messageInput.disabled = true;
            messageInput.placeholder = 'Sign in to chat';
        }
        if (sendMessageBtn) sendMessageBtn.disabled = true;
    }
    if (onlineUsers) onlineUsers.textContent = onlineUserCount; // Update online count
}

function displayChatMessage(messageData) {
    const { messagesContainer } = DOMElements.chat;
    if (!messagesContainer) return;

    const { type = 'user', username, avatar, message, userId, userSteamId } = messageData;
    const messageElement = document.createElement('div');
    messageElement.classList.add('chat-message');
    if (userId) messageElement.dataset.userId = userId;
    if (userSteamId) messageElement.dataset.userSteamId = userSteamId; // For potential profile links

    if (type === 'system') { // System messages (e.g., user connect/disconnect)
        messageElement.classList.add('system-message');
        messageElement.textContent = message;
    } else { // Regular user messages
        const userAvatarSrc = avatar || '/img/default-avatar.png';
        const displayName = username || 'Anonymous';
        const userColor = getUserColor(userId || 'system-user'); // Get consistent color
        messageElement.innerHTML = `
            <img src="${userAvatarSrc}" alt="${displayName}" class="chat-message-avatar" style="border-color: ${userColor};">
            <div class="chat-message-content">
                <span class="chat-message-user" style="color: ${userColor};">${displayName}</span>
                <p class="chat-message-text"></p>
            </div>
        `;
        // Set text content safely to prevent XSS
        const textElement = messageElement.querySelector('.chat-message-text');
        if (textElement) textElement.textContent = message;
    }
    // Add new message to the top (since container is flex-direction: column-reverse)
    messagesContainer.insertBefore(messageElement, messagesContainer.firstChild);

    // Limit number of messages displayed
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
        messageInput.value = ''; // Clear input
        
        // Cooldown visual
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
                    if(currentUser) sendMessageBtn.disabled = false; // Re-enable if still logged in
                }
            }, 1000);
        }
        // Ensure cooldown flag is reset even if interval logic fails
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
        if (e.key === 'Enter' && !e.shiftKey) { // Send on Enter, allow Shift+Enter for newline
            e.preventDefault(); // Prevent default newline in input
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

// --- Winning History Modal Logic ---
async function loadWinningHistory() { 
    const { modal, tableBody, loadingIndicator, noWinningsMessage } = DOMElements.winningHistoryModal;
    if (!currentUser) {
        showNotification("Please log in to view your winning history.", "info");
        return;
    }
    showModal(modal); // Show the modal first
    if (loadingIndicator) loadingIndicator.style.display = 'flex';
    if (tableBody) tableBody.innerHTML = ''; // Clear previous entries
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
            } else if (offerURL && (offerStatus === 'Sent' || offerStatus === 'Escrow' || offerStatus === 'PendingConfirmation' || offerStatus === 'Unknown' || offerStatus === 'Pending Send')) {
                // If offer is active or needs action, provide a link
                tradeCell.innerHTML = `<a href="${offerURL}" target="_blank" rel="noopener noreferrer" class="trade-link pending" title="View trade offer on Steam">
                                          <i class="fas fa-external-link-alt"></i> View Offer (#${offerId})
                                      </a>`;
            } else if (offerStatus === 'No Items Won'){ // Special case if all items were taxed
                 tradeCell.innerHTML = `<span class="trade-status info"><i class="fas fa-info-circle"></i> No Items (Tax)</span>`;
            }
            else { // For failed, declined, expired, etc.
                tradeCell.innerHTML = `<span class="trade-status ${offerStatus.toLowerCase().includes('fail') || offerStatus.toLowerCase().includes('decline') ? 'failed' : 'info'}" title="Offer ID: ${offerId || 'N/A'}">
                                          <i class="fas ${offerStatus.toLowerCase().includes('fail') || offerStatus.toLowerCase().includes('decline') ? 'fa-times-circle' : 'fa-question-circle'}"></i>
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
            noWinningsMessage.classList.add('error'); // Add error class for styling
        } else if (tableBody) {
            // Fallback if noWinningsMessage element isn't there for some reason
            tableBody.innerHTML = `<tr><td colspan="4" class="error-message">Error loading history: ${error.message}</td></tr>`;
        }
        showNotification(`Error loading winning history: ${error.message}`, 'error');
    }
}

// --- Socket.IO Event Handlers ---
function setupSocketConnection() {
    socket.on('connect', () => {
        console.log('Socket connected:', socket.id);
        showNotification('Connected to server.', 'success', 2000);
        socket.emit('requestRoundData'); // Request current round state on connect
    });
    socket.on('disconnect', (reason) => {
        console.log('Socket disconnected:', reason);
        showNotification('Disconnected from server. Attempting to reconnect...', 'error', 5000);
        updateDepositButtonState(); // Disable deposits
        updateChatOnlineUsers(0); // Show 0 online
        timerActive = false; // Stop client timer
        if (roundTimer) clearInterval(roundTimer); roundTimer = null;
        // Optionally, reset more of the UI to a "disconnected" state
    });
    socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
        showNotification('Connection Error. Please refresh the page.', 'error', 10000);
        updateDepositButtonState(); // Disable deposits
    });

    // Handles creation of a brand new round (e.g., after a previous one completed)
    socket.on('roundCreated', (data) => { 
        console.log('[Socket Event] roundCreated:', data);
        currentRound = data; // Set as the current round
        initiateNewRoundVisualReset(); // Clear old pot, reset timer display, etc.
        updateRoundUI(); // Update general UI elements like pot value, participant count
        updateDepositButtonState(); // Enable/disable deposit button based on new round state
        userColorMap.clear(); // Clear user color mapping for the new round
        
        // Specifically set timer display for a 'pending' round
        if(data.status === 'pending' && DOMElements.jackpot.timerValue) {
            DOMElements.jackpot.timerValue.textContent = "Waiting"; // Display "Waiting"
            updateTimerCircle(CONFIG.ROUND_DURATION, CONFIG.ROUND_DURATION); // Show full circle
        } else if (data.status === 'active' && data.participants?.length === 0){
            // If somehow created as active but empty, show default duration
            updateTimerUI(CONFIG.ROUND_DURATION); 
        }
    });
    
    // Handles updates to the current round's status (e.g., pending -> active)
    socket.on('roundStatusUpdate', (data) => { 
        console.log('[Socket Event] roundStatusUpdate:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = data.status;
            currentRound.startTime = data.startTime; // Update start time if provided
            
            if (currentRound.status === 'active' && currentRound.participants?.length === 0 && !timerActive) {
                // If round becomes active but is empty (e.g. server forced it active), show default timer
                updateTimerUI(CONFIG.ROUND_DURATION);
            } else if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !timerActive) {
                // If round becomes active AND has participants, server will send timerUpdate, but we can anticipate
                startClientTimer(currentRound.timeLeft || CONFIG.ROUND_DURATION);
            }
            updateDepositButtonState(); // Update based on new status
        }
    });

    // Handles a new deposit/participant update
    socket.on('participantUpdated', (data) => {
        console.log('[Socket Event] participantUpdated:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            handleNewDeposit(data); // Process and display the new deposit
        } else if (!currentRound && data.roundId) {
            // Client might be out of sync if it has no currentRound but receives participant update
            console.warn("[Socket Event] Participant update received, but client has no currentRound. Requesting full round data.");
            socket.emit('requestRoundData');
        } else if (currentRound && currentRound.roundId !== data.roundId) {
            // Participant update is for a different round than client's current
            console.warn(`[Socket Event] Participant update for round ${data.roundId}, but client is on ${currentRound.roundId}. Requesting sync.`);
            socket.emit('requestRoundData');
        }
    });
    
    // Handles timer ticks from the server
    socket.on('timerUpdate', (data) => {
        // console.log('[Socket Event] timerUpdate:', data); // Can be spammy
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.timeLeft = data.timeLeft;
            if (!timerActive && data.timeLeft > 0 && currentRound.status === 'active' && currentRound.participants?.length > 0) {
                // If timer wasn't active but should be (e.g., after first deposit or reconnect)
                startClientTimer(data.timeLeft);
            } else if (timerActive) {
                // If client timer is already running, this keeps it in sync or corrects it
                // The internal client timer will continue its countdown, but this ensures accuracy
                updateTimerUI(data.timeLeft); // Update visual based on server's time
            } else if (currentRound.status === 'active' && currentRound.participants?.length === 0) {
                 updateTimerUI(CONFIG.ROUND_DURATION); // Show default if active but empty
            }
             if (data.timeLeft <=0 && timerActive) { // Server says time is up
                clearInterval(roundTimer); roundTimer = null; timerActive = false;
            }
        }
    });

    // When the server signals the round is 'rolling' (i.e., timer hit zero, preparing for winner)
    socket.on('roundRolling', (data) => {
        console.log('[Socket Event] roundRolling:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            timerActive = false; if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
            if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Rolling";
            if (DOMElements.jackpot.timerForeground) updateTimerCircle(0, CONFIG.ROUND_DURATION); // Show empty circle
            currentRound.status = 'rolling';
            isSpinning = true; // Set flag to indicate animation phase has begun
            updateDepositButtonState(); // Disable deposits
            // The actual animation starts when 'roundWinner' is received.
            // 'roundRolling' just signals the state change. Frontend prepares the view.
            // No "rolling pop-up" here; switchToRouletteView (called by roundWinner handler) handles view change.
        }
    });
    
    // When the server announces the winner and provides data for the animation
    socket.on('roundWinner', (data) => { 
        console.log('[Socket Event] roundWinner (triggers animation):', data);
        // It's crucial that currentRound is set and matches data.roundId,
        // or that 'data' itself contains enough info (like participants) if currentRound is stale.
        // handleWinnerAnnouncement will try to use currentRound.participants if available.
        if (currentRound && currentRound.roundId !== data.roundId) {
             console.warn(`[Socket Event] 'roundWinner' for round ${data.roundId}, client on ${currentRound.roundId}. Syncing first.`);
             socket.emit('requestRoundData'); // Request full data, the 'roundData' handler will then process winner if still applicable
             return;
        }
        if (!currentRound) { // If client has no round context at all
            currentRound = { roundId: data.roundId, status: 'rolling', participants: [], items: [] }; // Minimal setup
            console.warn(`[Socket Event] 'roundWinner' received but no local currentRound. Animation might be partial. Requesting sync.`);
            socket.emit('requestRoundData'); // Attempt to get full data
        }
        // Update currentRound with winner info from this event
        currentRound.status = 'rolling'; // Explicitly set, as animation is about to start
        currentRound.winner = data.winner; 
        currentRound.serverSeed = data.serverSeed; 
        currentRound.clientSeed = data.clientSeed;
        currentRound.provableHash = data.provableHash;
        
        handleWinnerAnnouncement(data); // Pass the event data to start the animation
    });
    
    // When the round is fully completed and finalized on the server
    socket.on('roundCompleted', (data) => { 
        console.log('[Socket Event] roundCompleted (final state from server):', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'completed';
            // Update any final details if provided, but mostly this confirms the end.
            currentRound.winner = data.winner || currentRound.winner;
            currentRound.serverSeed = data.serverSeed || currentRound.serverSeed;
            currentRound.clientSeed = data.clientSeed || currentRound.clientSeed;
            currentRound.provableHash = data.provableHash || currentRound.provableHash;
            currentRound.totalValue = data.totalValue !== undefined ? data.totalValue : currentRound.totalValue;
            
            console.log("[Socket Event] Round completed. Client isSpinning:", isSpinning, "currentWinningsOfferData:", currentWinningsOfferData, "AcceptWinningsModal Open:", DOMElements.acceptWinningsModal.modal.style.display === 'flex');
            
            // If the client is NOT currently in an animation (isSpinning=false)
            // AND the "Accept Winnings" modal is NOT currently displayed,
            // THEN it's safe to reset the main jackpot view for the next round.
            if (!isSpinning && DOMElements.acceptWinningsModal.modal.style.display !== 'flex') {
                console.log("[Socket Event] Round completed, client not spinning, no winnings modal. Scheduling resetToJackpotView.");
                // Delay slightly to ensure any final winner UI has a moment.
                setTimeout(resetToJackpotViewIfNeeded, 1000); 
            } else if (isSpinning) {
                // If client thinks it's still spinning, the spin end logic (handleSpinEnd/finalizeSpin)
                // should eventually handle the view reset or the display of the winnings modal.
                console.log("[Socket Event] Round completed, but client still thinks it's spinning. Spin end logic will handle UI.");
            } else if (DOMElements.acceptWinningsModal.modal.style.display === 'flex') {
                 // If winnings modal is open, its closure will trigger the reset.
                 console.log("[Socket Event] Round completed, winnings modal is open. Modal closure will handle view reset.");
            }
        }
        updateDepositButtonState(); // Ensure deposit button is correctly disabled for completed round
    });
    
    socket.on('roundError', (data) => {
        console.error('[Socket Event] roundError:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'error';
            showNotification(`Round Error: ${data.error || 'Unknown error.'}`, 'error');
            resetToJackpotView(); // Reset UI to allow a new round to start
        } else { // Error for a different round or no current round context
            showNotification(`Server Error (Round ${data.roundId}): ${data.error || 'Unknown error.'}`, 'error');
            // Consider if a generic reset is needed if client is stuck
            if (isSpinning || (currentRound && currentRound.status === 'rolling')) resetToJackpotView();
        }
    });

    // Handles full round data sync from server (e.g., on connect, or if client requests it)
    socket.on('roundData', (data) => { 
        console.log('[Socket Event] roundData (full sync received):', data);
        if (!data || typeof data !== 'object' || !data.roundId) {
            console.error("[Socket Event] Invalid full round data received from server for 'roundData' event.");
            showNotification('Error syncing with server. Attempting to reset.', 'error');
             initiateNewRoundVisualReset(); // Clear current view
             socket.emit('requestRoundData'); // Try to get good data again
            return;
        }

        const oldRoundId = currentRound?.roundId;
        currentRound = data; // THIS IS THE NEW SOURCE OF TRUTH FOR CLIENT'S currentRound
        console.log(`[Socket Event] Client currentRound updated to ID: ${currentRound.roundId}, Status: ${currentRound.status}`);

        // If round ID changed or the participant display is empty, perform a full visual reset of the pot area.
        if (oldRoundId !== currentRound.roundId || DOMElements.jackpot.participantsContainer.innerHTML === '' || (currentRound.participants && currentRound.participants.length === 0)) {
            initiateNewRoundVisualReset(); 
        }
        
        updateRoundUI(); // Update pot value, timer text, participant count header
        updateDepositButtonState(); // Update deposit button based on new state

        // Re-render all participant blocks based on the new full data
        const participantsContainer = DOMElements.jackpot.participantsContainer;
        if(participantsContainer) {
             // `initiateNewRoundVisualReset` should have cleared the container if round ID changed or it was empty.
             // Now, populate it with the fresh participant data.
             if (currentRound.participants && currentRound.participants.length > 0) {
                if(DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'none';
                
                currentRound.participants.forEach(p => {
                    const userId = p.user?._id || p.user?.id;
                    if (!userId) { console.warn("Skipping participant display due to missing user ID in 'roundData'", p); return; }

                    // Get all items belonging to this participant from the master items list in currentRound
                    const participantItems = currentRound.items?.filter(item => item.owner && (item.owner.toString() === userId.toString())) || [];
                    
                    displayLatestDeposit({ // Use displayLatestDeposit to render each participant
                        userId: userId,
                        username: p.user.username,
                        avatar: p.user.avatar,
                        itemsValue: p.itemsValue, // Their total value for this round
                        tickets: p.tickets,       // Their total tickets
                        totalValue: currentRound.totalValue, // Overall pot total
                        depositedItems: participantItems // Pass ALL their items for this round for display
                    });
                    // Ensure the 'new deposit' animation class is removed as this is a full state render
                    const element = participantsContainer.querySelector(`.player-deposit-container[data-user-id="${userId}"]`);
                    if (element) element.classList.remove('player-deposit-new');
                });
                updateAllParticipantPercentages(); // Recalculate all percentages based on new total
            } else { // No participants in the round
                 if (DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'block';
            }
        }


        // Handle timer state based on received full round data
        if (currentRound.status === 'active') {
            if (currentRound.participants.length > 0 && currentRound.timeLeft > 0) {
                if (!timerActive) startClientTimer(currentRound.timeLeft); // Start/sync timer if active with participants
                else updateTimerUI(currentRound.timeLeft); // Or just update if already running
            } else if (currentRound.participants.length === 0) { 
                // Active but empty: stop client timer, show default duration
                if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
                updateTimerUI(CONFIG.ROUND_DURATION); 
            } else if (currentRound.timeLeft <= 0) { 
                // Active but time is up (should transition to rolling soon)
                if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
                updateTimerUI(0); // Show 0
            }
        } else if (currentRound.status === 'pending') {
            if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
            updateTimerUI(CONFIG.ROUND_DURATION); // Show default for pending
            if(DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Waiting";
        } else if (currentRound.status === 'rolling' || currentRound.status === 'completed' || currentRound.status === 'error') {
            if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
            updateTimerUI(0); // Show 0 or "Ended" based on status
            
            // If round data says rolling AND has a winner AND client isn't already spinning, start animation
            if (currentRound.status === 'rolling' && currentRound.winner && !isSpinning) {
                console.log("[Socket Event] 'roundData' indicates round is rolling with winner known, client not spinning. Triggering animation.");
                handleWinnerAnnouncement(currentRound); // Pass the full currentRound as it contains winner and participants
            } else if ((currentRound.status === 'completed' || currentRound.status === 'error') && !isSpinning) {
                 // If round is already completed/errored and client isn't spinning, ensure view is reset.
                 console.log("[Socket Event] 'roundData' indicates round is completed/error, client not spinning. Ensuring view is reset.");
                resetToJackpotViewIfNeeded();
            }
        }
    });


    // This event triggers the "Accept on Steam" pop-up for the winner
    socket.on('tradeOfferSent', (data) => {
         console.log('[Socket Event] tradeOfferSent received:', data);
         if (currentUser && data.userId === (currentUser._id || currentUser.id) && data.offerURL && data.type === 'winning') {
              // It's a winning trade offer for the currently logged-in user
              currentWinningsOfferData = { // Store the data needed for the modal
                  offerURL: data.offerURL, 
                  offerId: data.offerId, 
                  status: data.status,
                  userId: data.userId // Store winner ID to ensure modal shows for correct user
                };
              console.log("[Socket Event] Winnings trade offer data stored for current user:", currentWinningsOfferData);
              
              // If client is not in the middle of the spinning animation, show the modal immediately.
              // If it IS spinning, the modal will be shown by handleSpinEnd after animation.
              if (!isSpinning) {
                  console.log("[Socket Event] Not spinning, displaying 'Accept Winnings' modal directly for offer:", data.offerId);
                  displayAcceptWinningsModal(currentWinningsOfferData);
              } else {
                  console.log("[Socket Event] Currently spinning. 'Accept Winnings' modal will be shown by handleSpinEnd for offer:", data.offerId);
                  // The handleSpinEnd function will check currentWinningsOfferData
              }
              // General notification that a trade offer was sent
              showNotification(`Winnings Sent! <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">Accept on Steam</a> (Offer #${data.offerId})`, 'success', 15000);
         } else if (currentUser && data.userId === (currentUser._id || currentUser.id) && data.type !== 'winning') { 
              // Other types of trade offers for the user (e.g. if deposits had this event)
              showNotification(`Trade Offer Update: <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">View Offer on Steam</a> (#${data.offerId}) - Status: ${data.status}`, 'info', 10000);
         } else if (data.type === 'winning' && data.userId !== (currentUser?._id || currentUser?.id)) {
             // Winnings offer for another player, just a general notification for all if desired
             console.log(`Winnings offer sent to another player: ${data.username || data.userId}`);
         }
    });
    
    socket.on('notification', (data) => { // Generic notifications from server
        console.log('[Socket Event] notification:', data);
        // Show notification if it's global (no userId) or targeted to current user
        if (!data.userId || (currentUser && data.userId === (currentUser._id || currentUser.id))) { 
            showNotification(data.message || 'Received notification from server.', data.type || 'info', data.duration || 4000);
        }
    });
    socket.on('chatMessage', (data) => { // New chat message from server
        displayChatMessage(data);
    });
    socket.on('updateUserCount', (count) => { // Update online user count for chat
        updateChatOnlineUsers(count);
    });
}


// --- Event Listeners Setup ---
function setupEventListeners() {
    // Navigation
    DOMElements.nav.homeLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.homePage); });
    DOMElements.nav.aboutLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.aboutPage); });
    DOMElements.nav.tosLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.tosPage); });
    DOMElements.nav.faqLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.faqPage); });
    DOMElements.nav.fairLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.fairPage); });

    // User Authentication & Profile Dropdown
    DOMElements.user.loginButton?.addEventListener('click', () => {
        if (localStorage.getItem('ageVerified') === 'true') {
            window.location.href = '/auth/steam'; // Redirect to Steam login
        } else {
            // Show age verification modal first
            const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
            if(ageCheckbox) ageCheckbox.checked = false;
            if(ageAgreeButton) ageAgreeButton.disabled = true;
            showModal(DOMElements.ageVerification.modal);
        }
    });

    const { userProfile, userDropdownMenu, logoutButton, profileDropdownButton, winningHistoryDropdownButton } = DOMElements.user;
    userProfile?.addEventListener('click', (e) => { // Toggle dropdown
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
        if (menu) menu.style.display = 'none'; // Close dropdown
        userProfile?.setAttribute('aria-expanded', 'false'); userProfile?.classList.remove('open');
    });

    winningHistoryDropdownButton?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const menu = DOMElements.user.userDropdownMenu;
        if (currentUser) {
            loadWinningHistory(); // Fetch and display winning history
        } else {
            showNotification("Please log in to view your winning history.", "info");
        }
        if (menu) menu.style.display = 'none'; // Close dropdown
        userProfile?.setAttribute('aria-expanded', 'false'); userProfile?.classList.remove('open');
    });


    // Profile Modal
    DOMElements.profileModal.saveBtn?.addEventListener('click', handleProfileSave);
    DOMElements.profileModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.profileModal.cancelBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));

    // Accept Winnings Modal (Winner's pop-up)
    const awModal = DOMElements.acceptWinningsModal;
    awModal.closeBtn?.addEventListener('click', () => {
        hideModal(awModal.modal); // hideModal will call resetToJackpotViewIfNeeded
    });
    awModal.closeFooterBtn?.addEventListener('click', () => {
        hideModal(awModal.modal); // hideModal will call resetToJackpotViewIfNeeded
    });
    awModal.acceptOnSteamBtn?.addEventListener('click', () => {
        const url = awModal.acceptOnSteamBtn.getAttribute('data-offer-url');
        if (url) {
            window.open(url, '_blank', 'noopener,noreferrer'); // Open trade offer
            if(awModal.statusText) awModal.statusText.textContent = "Check Steam tab for the offer. Closing this window...";
            setTimeout(() => { // Give user a moment, then close modal
                hideModal(awModal.modal); // This will also call resetToJackpotViewIfNeeded
            } , 2000);
        } else {
            showNotification("Error: Could not find the winnings trade offer URL.", "error");
        }
    });

    // Winning History Modal
    const whModal = DOMElements.winningHistoryModal;
    whModal.closeBtn?.addEventListener('click', () => hideModal(whModal.modal));
    whModal.closeFooterBtn?.addEventListener('click', () => hideModal(whModal.modal));


    // Deposit Modal
    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => {
        const button = DOMElements.deposit.showDepositModalButton;
        if (button.disabled) { // If main deposit button is disabled, show its title as notification
            showNotification(button.title || 'Deposits are currently closed.', 'info'); return;
        }
        if (!currentUser) {
            showNotification('Login Required: Please log in first to deposit items.', 'error'); return;
        }
         if (!currentUser.tradeUrl) { // Check for trade URL
             console.log("Trade URL missing for deposit. Prompting user to set it in profile.");
             showNotification('Trade URL Required: Please open your profile (click your avatar) and set your Steam Trade URL before depositing items.', 'error', 6000);
             if (DOMElements.profileModal.modal) { // Open profile modal to set URL
                 populateProfileModal(); showModal(DOMElements.profileModal.modal);
             }
             return;
         }
        showModal(DOMElements.deposit.depositModal); loadUserInventory(); // Load inventory into modal
    });
    DOMElements.deposit.closeDepositModalButton?.addEventListener('click', () => hideModal(DOMElements.deposit.depositModal));
    DOMElements.deposit.depositButton?.addEventListener('click', requestDepositOffer); // "Request Deposit Offer" in modal
    DOMElements.deposit.acceptDepositOfferBtn?.addEventListener('click', () => { // "Accept on Steam" for DEPOSITS
         if (currentDepositOfferURL) {
             console.log("Opening Steam deposit trade offer:", currentDepositOfferURL);
             window.open(currentDepositOfferURL, '_blank', 'noopener,noreferrer');
             const { depositStatusText } = DOMElements.deposit;
             if(depositStatusText) depositStatusText.textContent = "Check Steam tab for the deposit offer...";
             // Modal usually stays open until user acts on Steam or offer changes state
         } else {
             console.error("No deposit offer URL found for accept button (deposit modal).");
             showNotification("Error: Could not find the deposit trade offer URL.", "error");
         }
    });

    // Age Verification Modal
    const { modal: ageModal, checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
    if (ageModal && ageCheckbox && ageAgreeButton) {
        ageCheckbox.addEventListener('change', () => { ageAgreeButton.disabled = !ageCheckbox.checked; });
        ageAgreeButton.addEventListener('click', () => {
            if (ageCheckbox.checked) {
                localStorage.setItem('ageVerified', 'true'); hideModal(ageModal);
                console.log("Age verification agreed. Proceeding to Steam login.");
                window.location.href = '/auth/steam'; // Redirect to Steam login
            }
        });
        ageAgreeButton.disabled = !ageCheckbox.checked; // Initial state
    }

    // Provably Fair Verification
    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound);

    // Global click listener for closing dropdowns/modals
    window.addEventListener('click', (e) => {
        const profileModalEl = DOMElements.profileModal.modal;
        const acceptWinningsModalEl = DOMElements.acceptWinningsModal.modal; 
        const winningHistoryModalEl = DOMElements.winningHistoryModal.modal; 

        // Close user dropdown if click is outside
        if (userDropdownMenu && userProfile && userDropdownMenu.style.display === 'block' &&
            !userProfile.contains(e.target) && !userDropdownMenu.contains(e.target)) {
            userDropdownMenu.style.display = 'none';
            userProfile.setAttribute('aria-expanded', 'false');
            userProfile.classList.remove('open');
        }
        // Close modals if click is on overlay (modal background)
        if (e.target === DOMElements.deposit.depositModal) hideModal(DOMElements.deposit.depositModal);
        if (e.target === profileModalEl) hideModal(profileModalEl);
        if (e.target === acceptWinningsModalEl) { hideModal(acceptWinningsModalEl); /* resetToJackpotViewIfNeeded called by hideModal */ }
        if (e.target === winningHistoryModalEl) hideModal(winningHistoryModalEl);
    });

    // Global keydown listener for Escape key to close modals/dropdowns
    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
             if (DOMElements.acceptWinningsModal.modal?.style.display === 'flex') { hideModal(DOMElements.acceptWinningsModal.modal); }
             else if (DOMElements.profileModal.modal?.style.display === 'flex') hideModal(DOMElements.profileModal.modal);
             else if (DOMElements.deposit.depositModal?.style.display === 'flex') hideModal(DOMElements.deposit.depositModal);
             else if (DOMElements.winningHistoryModal.modal?.style.display === 'flex') hideModal(DOMElements.winningHistoryModal.modal); 
             else if (DOMElements.ageVerification.modal?.style.display === 'flex') hideModal(DOMElements.ageVerification.modal);
             else if (userDropdownMenu && userDropdownMenu.style.display === 'block') { // Close user dropdown
                 userDropdownMenu.style.display = 'none';
                 userProfile?.setAttribute('aria-expanded', 'false');
                 userProfile?.classList.remove('open');
                 userProfile?.focus(); // Return focus to profile button
             }
        }
    });

    setupChatEventListeners(); // Setup listeners for chat input and send button
}

// This function is called when certain modals are closed (like Accept Winnings)
// or after the winner info box display duration if no modal takes over.
function resetToJackpotViewIfNeeded() {
    // Only reset if the game is not currently in the spinning animation phase
    // AND if the current round is completed or errored (meaning it's over).
    // Also, ensure the accept winnings modal isn't the active thing keeping us from resetting.
    if (!isSpinning && 
        (!currentRound || currentRound.status === 'completed' || currentRound.status === 'error') &&
        DOMElements.acceptWinningsModal.modal.style.display !== 'flex' ) {
        console.log("[Reset If Needed] Conditions met. Calling resetToJackpotView.");
        resetToJackpotView();
    } else {
         console.log("[Reset If Needed] Conditions NOT met for full reset. isSpinning:", isSpinning, "currentRound status:", currentRound?.status, "AcceptWinningsModal visible:", DOMElements.acceptWinningsModal.modal.style.display === 'flex');
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

    // Display pending deposit offer status
    const statusDiv = modalElements.pendingOfferStatus;
    if (!statusDiv) return; // Should not happen if DOM is correct
    if (currentUser.pendingDepositOfferId) {
        const offerId = currentUser.pendingDepositOfferId;
        const offerURL = `https://steamcommunity.com/tradeoffer/${offerId}/`;
        statusDiv.innerHTML = `<p>⚠️ You have a <a href="${offerURL}" target="_blank" rel="noopener noreferrer" class="profile-pending-link">pending deposit offer (#${offerId})</a> awaiting action on Steam.</p>`;
        statusDiv.style.display = 'block';
    } else {
        statusDiv.style.display = 'none';
        statusDiv.innerHTML = ''; // Clear content
    }
}

async function handleProfileSave() {
    const { tradeUrlInput, saveBtn } = DOMElements.profileModal;
    if (!tradeUrlInput || !saveBtn || !currentUser) {
         showNotification("Not logged in or profile elements missing.", "error"); return;
    }
    const newTradeUrl = tradeUrlInput.value.trim();
    // Validate Steam Trade URL format (allow empty to clear)
    const urlPattern = /^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/i;
    if (newTradeUrl && !urlPattern.test(newTradeUrl)) {
        showNotification('Invalid Steam Trade URL format. It should look like "https://steamcommunity.com/tradeoffer/new/?partner=...&token=...". Please check or leave empty to clear.', 'error', 8000); return;
    }

    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
        const response = await fetch('/api/user/tradeurl', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tradeUrl: newTradeUrl }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || `Failed to save trade URL (${response.status})`);

        currentUser.tradeUrl = newTradeUrl; // Update local user object
        showNotification(newTradeUrl ? 'Trade URL saved successfully!' : 'Trade URL cleared successfully!', 'success');
        updateDepositButtonState(); // Main deposit button state might change
        hideModal(DOMElements.profileModal.modal);
    } catch (error) {
        console.error("Error saving trade URL:", error);
        showNotification(`Error saving Trade URL: ${error.message}`, 'error');
    } finally {
        saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
    }
}


// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed for Rusty Degen.");
    const ageVerified = localStorage.getItem('ageVerified') === 'true';

    checkLoginStatus(); // Fetch user status from backend
    setupEventListeners(); // Setup all UI event listeners
    setupSocketConnection(); // Establish and handle WebSocket events

    showPage(DOMElements.pages.homePage); // Default to home page
    initiateNewRoundVisualReset(); // Prepare UI for a new/pending round

    // Age verification check
    if (!ageVerified && DOMElements.ageVerification.modal) {
        const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
        if(ageCheckbox) ageCheckbox.checked = false;
        if(ageAgreeButton) ageAgreeButton.disabled = true;
        showModal(DOMElements.ageVerification.modal);
    }

    updateChatUI(); // Initial chat UI state
});

console.log("main.js updated for direct animation flow, winner screen, and accept winnings pop-up sequence.");
