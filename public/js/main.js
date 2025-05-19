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
    ROULETTE_REPETITIONS: 20, // Note: This seems unused in current roulette logic.
    SPIN_DURATION_SECONDS: 6.5,
    WINNER_DISPLAY_DURATION: 7000, // How long winner info box stays after confetti
    CONFETTI_COUNT: 150,
    EASE_OUT_POWER: 5,
    BOUNCE_ENABLED: false, // Roulette bounce effect
    BOUNCE_OVERSHOOT_FACTOR: 0.07,
    BOUNCE_DAMPING: 0.35,
    BOUNCE_FREQUENCY: 3.5,
    LANDING_POSITION_VARIATION: 0.60, // How much the roulette can vary from perfect center
    MAX_CHAT_MESSAGES: 100, // Max chat messages to display (Increased from 10 for better history)
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
    // This modal will be used for the "Accept My Winnings" button initially,
    // and then re-used for "Accept on Steam" after trade offer is sent.
    acceptWinningsModal: {
        modal: document.getElementById('acceptWinningsModal'),
        headerTitle: document.querySelector('#acceptWinningsModal .modal-header h2'), // To change title
        bodyContent: document.querySelector('#acceptWinningsModal .modal-body'), // To change body
        closeBtn: document.getElementById('closeAcceptWinningsModal'),
        offerIdDisplay: document.getElementById('acceptWinningsOfferId'), // Might be reused or hidden
        statusText: document.getElementById('acceptWinningsStatusText'),
        // This button will be dynamically changed or swapped
        actionButton: document.getElementById('acceptWinningsOnSteamBtn'), // Will rename/repurpose this
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
        participantsContainer: document.getElementById('itemsContainer'), // Where player deposits are shown
        emptyPotMessage: document.getElementById('emptyPotMessage'),
        jackpotHeader: document.getElementById('jackpotHeader'),
    },
    deposit: {
        showDepositModalButton: document.getElementById('showDepositModal'),
        depositModal: document.getElementById('depositModal'),
        closeDepositModalButton: document.getElementById('closeDepositModal'),
        depositButton: document.getElementById('depositButton'), // Request Deposit Offer button
        inventoryItemsContainer: document.getElementById('inventory-items'),
        selectedItemsContainer: document.getElementById('selectedItems'),
        totalValueDisplay: document.getElementById('totalValue'),
        inventoryLoadingIndicator: document.getElementById('inventory-loading'),
        acceptDepositOfferBtn: document.getElementById('acceptDepositOfferBtn'), // Accept on Steam (for deposit)
        depositStatusText: document.getElementById('depositStatusText'),
    },
    roulette: {
        inlineRouletteContainer: document.getElementById('inlineRoulette'),
        rouletteTrack: document.getElementById('rouletteTrack'),
        winnerInfoBox: document.getElementById('winnerInfo'), // Box that shows after spin
        winnerAvatar: document.getElementById('winnerAvatar'),
        winnerName: document.getElementById('winnerName'),
        winnerDeposit: document.getElementById('winnerDeposit'), // Deposited value by winner
        winnerChance: document.getElementById('winnerChance'), // Chance of winner
        returnToJackpotButton: document.getElementById('returnToJackpot'), // Likely unused
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
let currentRound = null; // Stores data for the current round from backend
let selectedItemsList = []; // For deposit modal
let userInventory = []; // For deposit modal
let isSpinning = false; // True when roulette animation is active
let timerActive = false; // True when client-side countdown is active
let roundTimer = null; // Interval ID for client-side timer
let animationFrameId = null; // For roulette animation
let userColorMap = new Map();
let notificationTimeout = null;
// let spinStartTime = 0; // Already declared (seems it was duplicated in original)
let currentDepositOfferURL = null; // URL for pending deposit offer
// let currentWinningsOfferURL = null; // Removed, use pendingWinningsOffer object
let pendingWinningsOffer = null; // Stores details if winner announced while animation playing or for accept button
                                 // Structure: { roundId, winnerInfo, totalValue, action: 'showAcceptWinningsButton' | 'showAcceptOnSteamLink', offerURL?, offerId?, status? }
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
    if (modalElement === DOMElements.acceptWinningsModal.modal) {
        resetAcceptWinningsModalUI(); // Modified to handle different states
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
    return userColorMap.get(userId) || '#cccccc'; // Default fallback
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

// --- Easing and Animation Functions (for roulette) ---
function easeOutAnimation(t) { // Standard easeOutQuint
    const clampedT = Math.max(0, Math.min(1, t));
    return 1 - Math.pow(1 - clampedT, CONFIG.EASE_OUT_POWER);
}

function calculateBounce(t) { // Not currently used if CONFIG.BOUNCE_ENABLED is false
    if (!CONFIG.BOUNCE_ENABLED) return 0;
    const clampedT = Math.max(0, Math.min(1, t));
    const decay = Math.exp(-clampedT / CONFIG.BOUNCE_DAMPING);
    const oscillations = Math.sin(clampedT * Math.PI * 2 * CONFIG.BOUNCE_FREQUENCY);
    return -decay * oscillations;
}

// Color utility functions (already present)
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
        updateChatUI(); // Update chat after logout
        showNotification('You have been successfully signed out.', 'success');
    } catch (error) {
        console.error('Logout Error:', error);
        showNotification(`Logout failed: ${error.message}`, 'error');
    } finally {
        // Ensure dropdown is closed
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
        depositButton.style.display = 'inline-block'; // Ensure it's block or flex
        depositButton.textContent = 'Request Deposit Offer';
    }
    if (acceptDepositOfferBtn) {
        acceptDepositOfferBtn.style.display = 'none';
        acceptDepositOfferBtn.removeAttribute('data-offer-url');
    }
    if (depositStatusText) {
        depositStatusText.textContent = '';
        depositStatusText.className = 'deposit-status-text'; // Reset class
    }
    currentDepositOfferURL = null;
}

// Modified to handle different states for the "Accept Winnings" modal
function resetAcceptWinningsModalUI(state = 'initial') {
    const { modal, headerTitle, bodyContent, statusText, actionButton, offerIdDisplay, closeFooterBtn } = DOMElements.acceptWinningsModal;
    if (!modal) return;

    if (statusText) {
        statusText.textContent = '';
        statusText.className = 'deposit-status-text'; // Re-use class if suitable, or new one
    }
    if (offerIdDisplay) offerIdDisplay.textContent = '';

    if (actionButton) {
        actionButton.style.display = 'none'; // Hide by default
        actionButton.disabled = true;
        actionButton.removeAttribute('data-offer-url');
        actionButton.onclick = null; // Remove previous onclick handlers
    }
    if(headerTitle) headerTitle.textContent = "Winnings!"; // Default title
    if(bodyContent) bodyContent.innerHTML = ""; // Clear body
}


// This function is to show the "Accept My Winnings" button
function showAcceptWinningsButtonPopup(roundId, winnerUsername, totalValueWon) {
    const { modal, headerTitle, bodyContent, actionButton, statusText, offerIdDisplay, closeFooterBtn } = DOMElements.acceptWinningsModal;
    resetAcceptWinningsModalUI(); // Clear previous state

    if(headerTitle) headerTitle.textContent = "Congratulations!";
    if(bodyContent) {
        bodyContent.innerHTML = `
            <p>Congratulations, ${winnerUsername || 'Winner'}!</p>
            <p>You've won the jackpot with a total value of <strong>$${(totalValueWon || 0).toFixed(2)}</strong>!</p>
            <p>Click the button below to have the items sent to your Steam account via a trade offer.</p>
            <p><small>(Site fee has already been deducted from the pot value shown)</small></p>
        `;
    }
    if(offerIdDisplay) offerIdDisplay.style.display = 'none'; // Not relevant here
    if(statusText) statusText.textContent = "Ready to accept your skins?";

    if (actionButton) {
        actionButton.textContent = 'Accept My Winnings';
        actionButton.classList.remove('btn-success'); // In case it was styled for "Accept on Steam"
        actionButton.classList.add('btn-primary');    // Style like a primary action
        actionButton.style.display = 'inline-block';
        actionButton.disabled = false;
        actionButton.onclick = async () => { // Arrow function for 'this' context if needed, or bind
            actionButton.disabled = true;
            actionButton.textContent = 'Processing...';
            if(statusText) statusText.textContent = "Sending request to server...";
            try {
                // Note: Backend currently finds round by user, might need roundId if multiple wins are possible
                const response = await fetch('/api/round/accept-winnings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // body: JSON.stringify({ roundId: roundId }) // Send roundId if backend needs it
                });
                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.error || 'Failed to accept winnings.');
                }
                if(statusText) statusText.textContent = "Winnings accepted! Waiting for trade offer from bot...";
                // The 'tradeOfferSent' socket event will then trigger the next modal state
                // No need to hide modal here, wait for tradeOfferSent
            } catch (error) {
                showNotification(`Error accepting winnings: ${error.message}`, 'error');
                if(statusText) statusText.textContent = `Error: ${error.message}`;
                actionButton.disabled = false;
                actionButton.textContent = 'Accept My Winnings';
            }
        };
    }
    showModal(modal);
}

// This function is for showing the "Accept on Steam" link (current functionality)
function showAcceptOnSteamLinkPopup(offerURL, offerId, tradeStatus) {
    const { modal, headerTitle, bodyContent, actionButton, statusText, offerIdDisplay, closeFooterBtn } = DOMElements.acceptWinningsModal;
    resetAcceptWinningsModalUI();

    if(headerTitle) headerTitle.textContent = "Winnings Sent!";
     if(bodyContent) {
        bodyContent.innerHTML = `
            <p>A Steam trade offer for your winnings has been sent to your account.</p>
            <p>Please click the button below to open the trade offer on Steam and accept your items.</p>
        `;
    }
    if(offerIdDisplay) {
        offerIdDisplay.textContent = `Trade Offer ID: #${offerId || 'N/A'}`;
        offerIdDisplay.style.display = 'block';
    }
    if(statusText) statusText.textContent = `Status: ${tradeStatus || 'Sent'}.`;


    if (actionButton) {
        actionButton.textContent = 'Accept on Steam';
        actionButton.classList.add('btn-success'); // Style for Steam action
        actionButton.classList.remove('btn-primary');
        actionButton.style.display = 'inline-block';
        actionButton.disabled = !offerURL;
        if (offerURL) {
            actionButton.setAttribute('data-offer-url', offerURL);
            actionButton.onclick = () => {
                window.open(offerURL, '_blank', 'noopener,noreferrer');
                if(statusText) statusText.textContent = "Check Steam tab for the offer. Closing this window...";
                setTimeout(() => hideModal(modal), 2000);
            };
        }
    }
    showModal(modal);
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
                case 'completed_pending_acceptance': // New status
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
        // This condition might be redundant if status changes to 'rolling' promptly
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
            if (response.status === 401 || response.status === 403) { // Unauthorized or Forbidden
                currentUser = null;
            } else {
                // For other errors, log them but don't necessarily disrupt user flow too much
                console.error(`Server error fetching user: ${response.status}`);
                currentUser = null; // Treat as logged out on error
            }
        } else {
            currentUser = await response.json();
            console.log('User logged in:', currentUser?.username);
        }
    } catch (error) { // Network errors, etc.
        console.error('Error checking login status:', error);
        currentUser = null;
        // Avoid spamming notifications for typical "not logged in" scenarios if they are frequent
        if (error.message && !error.message.includes("401") && !error.message.includes("403") && !(error instanceof TypeError)) {
             // showNotification(`Error checking login: ${error.message}`, 'error');
        }
    } finally {
        updateUserUI();
        updateDepositButtonState();
        updateChatUI(); // Update chat based on login status
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

        // Update pending offer indicator in header
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
        if (userDropdownMenu) userDropdownMenu.style.display = 'none'; // Close dropdown on logout
        userProfile.setAttribute('aria-expanded', 'false');
        userProfile.classList.remove('open');
        if (pendingOfferIndicator) pendingOfferIndicator.style.display = 'none';
    }
}

// main.js - Rust Jackpot Frontend Logic - Part 2 of 2

async function loadUserInventory() {
    const { inventoryItemsContainer, selectedItemsContainer, inventoryLoadingIndicator, totalValueDisplay } = DOMElements.deposit;
    if (!inventoryItemsContainer || !selectedItemsContainer || !inventoryLoadingIndicator || !totalValueDisplay) {
        console.error("Inventory DOM elements missing.");
        return;
    }

    resetDepositModalUI(); // Resets buttons and status text
    selectedItemsList = []; // Clear selected items list
    selectedItemsContainer.innerHTML = ''; // Clear visual selected items
    updateTotalValue(); // Update total value display to $0.00

    inventoryLoadingIndicator.style.display = 'flex';
    inventoryItemsContainer.innerHTML = ''; // Clear previous inventory items

    try {
        const response = await fetch('/api/inventory');
        if (!response.ok) {
            let errorMsg = 'Inventory load failed.';
            try {
                const errorData = await response.json();
                errorMsg = errorData.error || `Inventory load failed (${response.status})`;
            } catch (e) { /* Ignore if parsing errorData fails */ }
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
    container.innerHTML = ''; // Clear previous items

    userInventory.forEach(item => {
        if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.assetId || !item.image) {
            console.warn("Skipping invalid inventory item:", item);
            return;
        }

        const itemElement = document.createElement('div');
        itemElement.className = 'inventory-item';
        itemElement.dataset.assetId = item.assetId;
        // Storing all item data for easy access on selection
        itemElement.dataset.itemData = JSON.stringify(item);
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
        itemElement.addEventListener('click', () => {
            // Retrieve full item data when clicked
            const fullItemData = JSON.parse(itemElement.dataset.itemData);
            toggleItemSelection(itemElement, fullItemData);
        });
        container.appendChild(itemElement);
    });
}


function toggleItemSelection(element, itemObject) { // itemObject is the full item from userInventory
    if (typeof itemObject.price !== 'number' || isNaN(itemObject.price)) {
        console.error("Attempted to select item with invalid price:", itemObject);
        showNotification('Selection Error: Cannot select item with invalid price.', 'error');
        return;
    }

    const assetId = itemObject.assetId;
    const index = selectedItemsList.findIndex(i => i.assetId === assetId);

    if (index === -1) { // If not selected, add it
        if (selectedItemsList.length >= CONFIG.MAX_ITEMS_PER_DEPOSIT) {
            showNotification(`Selection Limit: You can select a maximum of ${CONFIG.MAX_ITEMS_PER_DEPOSIT} items per deposit.`, 'info');
            return;
        }
        selectedItemsList.push(itemObject); // Add the full item object
        element.classList.add('selected');
        addSelectedItemElement(itemObject);
    } else { // If selected, remove it
        selectedItemsList.splice(index, 1);
        element.classList.remove('selected');
        removeSelectedItemElement(assetId);
    }
    updateTotalValue();
    resetDepositModalUI(); // Update button states
}

function addSelectedItemElement(item) { // item is the full item object
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
        e.stopPropagation(); // Prevent click on parent div from re-triggering toggle
        const assetIdToRemove = e.target.dataset.assetId;
        if (assetIdToRemove) {
            removeSelectedItem(assetIdToRemove); // This will handle removing from list and UI
            updateTotalValue();
            resetDepositModalUI();
        }
    });

    // Optional: Clicking the item in selected list also removes it
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
    // Update visual state in the main inventory list
    const inventoryElement = DOMElements.deposit.inventoryItemsContainer?.querySelector(`.inventory-item[data-asset-id="${assetId}"]`);
    if (inventoryElement) inventoryElement.classList.remove('selected');
    removeSelectedItemElement(assetId); // Remove from the "selected items" display
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
    if (!currentRound || currentRound.status !== 'active' || isSpinning) {
        showNotification('Deposit Error: Deposits are currently closed.', 'error'); return;
    }
    if (currentUser?.pendingDepositOfferId) {
        showNotification('Deposit Error: You already have a pending deposit offer. Check your profile or Steam.', 'error');
        if (DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
        return;
    }

    // Participant & Pot Limits (already present, seems correct)
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
    let response; // To access response status later

    try {
        const assetIds = selectedItemsList.map(item => item.assetId);
        console.log("Requesting deposit offer for assetIds:", assetIds);
        response = await fetch('/api/deposit', { // Assign to outer scope response
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetIds }),
        });
        const result = await response.json();

        if (!response.ok) {
            if (response.status === 409 && result.offerURL && result.offerId) { // Conflict - pending offer exists
                console.warn("User already has a pending offer:", result.offerId);
                depositStatusText.textContent = `You already have a pending offer! Click 'Accept on Steam' to view it.`;
                depositStatusText.className = 'deposit-status-text warning';
                currentDepositOfferURL = result.offerURL;
                acceptDepositOfferBtn.style.display = 'inline-block';
                acceptDepositOfferBtn.disabled = false;
                acceptDepositOfferBtn.setAttribute('data-offer-url', currentDepositOfferURL);
                depositButton.style.display = 'none';
                if (currentUser && !currentUser.pendingDepositOfferId) { // Update local user state
                    currentUser.pendingDepositOfferId = result.offerId;
                    updateUserUI(); // Update main user display (e.g., pending indicator)
                    updateDepositButtonState(); // Update main deposit button state
                }
                return; // Exit, user needs to handle existing offer
            } else { // Other non-OK errors
                throw new Error(result.error || `Failed to create offer (${response.status})`);
            }
        } else if (!result.success || !result.offerURL || !result.offerId) { // OK response but missing data
            throw new Error(result.error || 'Backend did not return a valid offer URL and ID.');
        } else { // Success
            console.log("Deposit offer created:", result.offerId);
            depositStatusText.textContent = "Offer created! Click 'Accept on Steam' below to complete.";
            depositStatusText.className = 'deposit-status-text success';
            currentDepositOfferURL = result.offerURL;
            depositButton.style.display = 'none'; // Hide request button
            acceptDepositOfferBtn.style.display = 'inline-block'; // Show accept button
            acceptDepositOfferBtn.disabled = false;
            acceptDepositOfferBtn.setAttribute('data-offer-url', currentDepositOfferURL);
            if(currentUser) { // Update local user state with new pending offer
                currentUser.pendingDepositOfferId = result.offerId;
                updateUserUI();
                updateDepositButtonState();
            }
        }
    } catch (error) {
        console.error('Error requesting deposit offer:', error);
        depositStatusText.textContent = `Error: ${error.message}`;
        depositStatusText.className = 'deposit-status-text error';
        // Reset UI only if it's not a "pending offer exists" (409) situation
        if (!(response && response.status === 409)) {
            resetDepositModalUI();
        }
        // Clear local pending offer if an error occurred and it wasn't a 409
        if (currentUser && currentUser.pendingDepositOfferId && !(response && response.status === 409)) {
            console.log("Clearing potentially stale pending offer ID due to error.");
            currentUser.pendingDepositOfferId = null;
            updateUserUI();
            updateDepositButtonState();
        }
    }
}


function updateRoundUI() {
    const { potValue, participantCount } = DOMElements.jackpot;
    if (!currentRound || !potValue || !participantCount) {
        // If currentRound is null (e.g., after reset and before new data), set to default.
        if (potValue) potValue.textContent = "$0.00";
        if (participantCount) participantCount.textContent = `0/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
        updateTimerUI(currentRound ? (currentRound.timeLeft !== undefined ? currentRound.timeLeft : CONFIG.ROUND_DURATION) : CONFIG.ROUND_DURATION);
        return;
    }

    potValue.textContent = `$${(currentRound.totalValue || 0).toFixed(2)}`;

    // Timer is updated by its own interval or by server push
    if (!timerActive) { // If timer isn't actively counting down on client, sync display
        updateTimerUI(currentRound.timeLeft !== undefined ? currentRound.timeLeft : CONFIG.ROUND_DURATION);
    }

    const participantNum = currentRound.participants?.length || 0;
    participantCount.textContent = `${participantNum}/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
    updateParticipantsUI(); // Ensure participant blocks and empty message are consistent
}


function updateTimerUI(timeLeft) {
    const { timerValue, timerForeground } = DOMElements.jackpot;
    if (!timerValue || !timerForeground) return;

    const timeToShow = Math.max(0, Math.round(timeLeft));
    let displayValue = timeToShow.toString();

    // Determine display text based on round state
    if (currentRound && currentRound.status === 'active') {
        if (!timerActive && currentRound.participants?.length === 0) {
            displayValue = CONFIG.ROUND_DURATION.toString(); // Show full duration if waiting for first player
        } else {
            displayValue = timeToShow.toString(); // Show current countdown
        }
    } else if (isSpinning || (currentRound && currentRound.status === 'rolling')) {
        displayValue = "Rolling";
    } else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'completed_pending_acceptance' || currentRound.status === 'error')) {
        displayValue = "Ended";
    } else if (currentRound && currentRound.status === 'pending') {
        displayValue = "Waiting";
    } else if (!currentRound) { // No round data yet
        displayValue = CONFIG.ROUND_DURATION.toString(); // Or "--" or "Loading"
    }


    timerValue.textContent = displayValue;
    updateTimerCircle(timeToShow, CONFIG.ROUND_DURATION);

    // Pulse animations for timer text
    if (timerActive && timeToShow <= 10 && timeToShow > 0 && currentRound && currentRound.status === 'active') {
        timerValue.classList.add('urgent-pulse');
        timerValue.classList.remove('timer-pulse');
    } else {
        timerValue.classList.remove('urgent-pulse');
        if (timerActive && timeToShow > 10 && currentRound && currentRound.status === 'active') {
            timerValue.classList.add('timer-pulse');
        } else {
            timerValue.classList.remove('timer-pulse');
        }
    }
}

function updateTimerCircle(timeLeft, totalTime) {
    const circle = DOMElements.jackpot.timerForeground;
    if (!circle || !(circle instanceof SVGCircleElement) || !circle.r?.baseVal?.value) {
        // console.warn("Timer circle element is not a valid SVG circle or not found.");
        return;
    }

    const radius = circle.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    // Ensure progress is between 0 and 1. Handle totalTime being 0 to avoid division by zero.
    const progress = Math.min(1, Math.max(0, timeLeft / Math.max(1, totalTime)));
    const offset = circumference * (1 - progress);

    circle.style.strokeDasharray = `${circumference}`;
    circle.style.strokeDashoffset = `${Math.max(0, offset)}`; // Ensure offset is not negative
}

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
        const percentage = ((cumulativeValue / currentTotalPotValue) * 100).toFixed(1); // Keep one decimal place
        const valueElement = block.querySelector('.player-deposit-value');

        if (valueElement) {
            const userColor = getUserColor(userId); // Get consistent color
            valueElement.textContent = `$${cumulativeValue.toFixed(2)} | ${percentage}%`;
            valueElement.title = `Deposited: $${cumulativeValue.toFixed(2)} | Chance: ${percentage}%`;
            valueElement.style.color = userColor; // Apply color
        }
    });
}


function displayLatestDeposit(data) { // data is participantUpdated from backend
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (!container) return;

    const userId = data.userId || data.user?._id; // Get user ID
    if (!userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue)) {
        console.error("Invalid data passed to displayLatestDeposit:", data);
        return;
    }

    const depositSfx = DOMElements.audio.depositSound;
    if (depositSfx) {
        depositSfx.volume = 0.6; // Adjust volume as needed
        depositSfx.currentTime = 0; // Rewind if already playing
        depositSfx.play().catch(e => console.error("Error playing deposit sound:", e));
    }

    const username = data.username || data.user?.username || 'Unknown User';
    const avatar = data.avatar || data.user?.avatar || '/img/default-avatar.png';
    // const value = data.itemsValue; // This is now the CUMULATIVE value for the participant in this round
    const itemsJustDeposited = data.depositedItems || []; // Items from THIS specific deposit
    const userColor = getUserColor(userId);

    // Get participant's LATEST total deposited value and percentage from currentRound state
    const participantData = currentRound?.participants?.find(p => (p.user?._id === userId || p.user?.id === userId));
    const cumulativeValueForDisplay = participantData ? participantData.itemsValue : data.itemsValue; // Fallback if not found in currentRound
    const currentTotalPotValue = Math.max(0.01, currentRound?.totalValue || 0.01);
    const percentageForDisplay = ((cumulativeValueForDisplay / currentTotalPotValue) * 100).toFixed(1);


    const depositContainer = document.createElement('div');
    depositContainer.dataset.userId = userId; // Store userId for updates
    depositContainer.className = 'player-deposit-container player-deposit-new'; // Animation class

    const depositHeader = document.createElement('div');
    depositHeader.className = 'player-deposit-header';
    depositHeader.innerHTML = `
        <img src="${avatar}" alt="${username}" class="player-avatar" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-avatar.png';" style="border-color: ${userColor};">
        <div class="player-info">
            <div class="player-name" title="${username}">${username}</div>
            <div class="player-deposit-value" style="color: ${userColor}" title="Deposited: $${cumulativeValueForDisplay.toFixed(2)} | Chance: ${percentageForDisplay}%">
                $${cumulativeValueForDisplay.toFixed(2)} | ${percentageForDisplay}%
            </div>
        </div>`;

    const itemsGrid = document.createElement('div');
    itemsGrid.className = 'player-items-grid';

    if (itemsJustDeposited.length > 0) {
        // Sort items by price for display (optional, but nice)
        itemsJustDeposited.sort((a, b) => (b.price || 0) - (a.price || 0));
        const displayItems = itemsJustDeposited.slice(0, CONFIG.MAX_ITEMS_PER_DEPOSIT); // Limit displayed items per deposit block

        displayItems.forEach(item => {
            if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.image) {
                console.warn("Skipping invalid item in deposit display:", item);
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

        if (itemsJustDeposited.length > CONFIG.MAX_ITEMS_PER_DEPOSIT) {
            const moreItems = document.createElement('div');
            moreItems.className = 'player-deposit-item-more';
            moreItems.style.color = userColor;
            moreItems.textContent = `+${itemsJustDeposited.length - CONFIG.MAX_ITEMS_PER_DEPOSIT} more`;
            itemsGrid.appendChild(moreItems);
        }
    }

    depositContainer.appendChild(depositHeader);
    depositContainer.appendChild(itemsGrid);

    // Insert new deposit at the top
    if (container.firstChild) {
        container.insertBefore(depositContainer, container.firstChild);
    } else {
        container.appendChild(depositContainer);
    }

    if (emptyMsg) emptyMsg.style.display = 'none'; // Hide "No items" message

    // Remove animation class after a short delay
    setTimeout(() => {
        depositContainer.classList.remove('player-deposit-new');
    }, 500); // Animation duration

    // Limit number of visible deposit blocks
    const currentDepositBlocks = container.querySelectorAll('.player-deposit-container');
    if (currentDepositBlocks.length > CONFIG.MAX_DISPLAY_DEPOSITS) {
        const blocksToRemove = currentDepositBlocks.length - CONFIG.MAX_DISPLAY_DEPOSITS;
        for (let i = 0; i < blocksToRemove; i++) {
            const oldestBlock = container.querySelector('.player-deposit-container:last-child');
            if (oldestBlock && oldestBlock !== depositContainer) { // Don't remove the one just added
                oldestBlock.style.transition = 'opacity 0.3s ease-out';
                oldestBlock.style.opacity = '0';
                setTimeout(() => {
                    if (oldestBlock.parentNode === container) { // Check if still child before removing
                        oldestBlock.remove();
                    }
                }, 300); // Matches transition
            }
        }
    }
}


function handleNewDeposit(data) { // data is from 'participantUpdated'
    if (!data || !data.roundId || !data.userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue) || data.totalValue === undefined || data.tickets === undefined) {
        console.error("Invalid participant update data received:", data);
        return;
    }
    if (!data.depositedItems) data.depositedItems = []; // Ensure array exists

    if (!currentRound) {
        // This case should ideally be handled by an initial 'roundData' emit
        currentRound = { roundId: data.roundId, status: 'active', timeLeft: CONFIG.ROUND_DURATION, totalValue: 0, participants: [], items: [] };
        console.warn("Handling deposit for non-existent local round. Initializing round with received data.");
    } else if (currentRound.roundId !== data.roundId) {
        console.warn(`Deposit received for wrong round (${data.roundId}). Current is ${currentRound.roundId}. Ignoring.`);
        return; // Ignore if not for the current round
    }

    // Ensure local currentRound parts are arrays
    if (!currentRound.participants) currentRound.participants = [];
    if (!currentRound.items) currentRound.items = [];

    // Clear pending deposit offer ID for the user if this deposit matches them
    if (currentUser && currentUser.pendingDepositOfferId && (currentUser._id === data.userId || currentUser.id === data.userId)) {
       console.log(`Deposit processed for user ${currentUser.username}, clearing local pending offer flag.`);
       currentUser.pendingDepositOfferId = null;
       updateUserUI(); // Update header indicator
       updateDepositButtonState(); // Update main deposit button
       if (DOMElements.deposit.depositModal?.style.display === 'flex') { // If deposit modal is open
           resetDepositModalUI(); // Reset its buttons
           selectedItemsList = []; // Clear selection
           if(DOMElements.deposit.selectedItemsContainer) DOMElements.deposit.selectedItemsContainer.innerHTML = '';
           updateTotalValue(); // Update value in modal
       }
    }

    // Update or add participant in local currentRound
    let participantIndex = currentRound.participants.findIndex(p => p.user?._id === data.userId || p.user?.id === data.userId);

    if (participantIndex !== -1) { // Existing participant
        currentRound.participants[participantIndex] = {
            ...currentRound.participants[participantIndex], // Keep existing user object if only value/tickets changed
            user: currentRound.participants[participantIndex].user || { _id: data.userId, id: data.userId, username: data.username, avatar: data.avatar }, // Ensure user object is there
            itemsValue: data.itemsValue, // This IS the new total for this participant in this round
            tickets: data.tickets        // This IS the new total tickets for this participant
        };
    } else { // New participant
        currentRound.participants.push({
            user: { _id: data.userId, id: data.userId, username: data.username || 'Unknown User', avatar: data.avatar || '/img/default-avatar.png' },
            itemsValue: data.itemsValue, // Initial total value for this new participant
            tickets: data.tickets
        });
    }

    currentRound.totalValue = data.totalValue; // Update overall round total value

    // Add newly deposited items to the master list for the round (for roulette visuals, etc.)
    // data.depositedItems are ONLY the items from THIS specific deposit action
    data.depositedItems.forEach(item => {
        if (item && typeof item.price === 'number' && !isNaN(item.price)) {
            currentRound.items.push({ ...item, owner: data.userId }); // Add owner info
        } else {
            console.warn("Skipping invalid item while adding to round master list:", item);
        }
    });

    updateRoundUI(); // Update general round info (pot value, participant count, timer)
    displayLatestDeposit(data); // Display this specific deposit visually
    updateAllParticipantPercentages(); // Recalculate and update percentages for ALL displayed blocks
    updateDepositButtonState(); // Check if deposit button should be disabled (e.g., max participants)

    // Start timer if it's the first participant and timer isn't already running
    if (currentRound.status === 'active' && currentRound.participants.length === 1 && !timerActive) {
        console.log("First participant joined. Starting client timer visually.");
        // Timer should ideally be started/synced by server's 'timerUpdate' or initial 'roundData'
        // For now, we'll start it visually here based on currentRound.timeLeft or default.
        startClientTimer(currentRound.timeLeft || CONFIG.ROUND_DURATION);
    }
}


function updateParticipantsUI() { // Called by updateRoundUI
    const { participantCount } = DOMElements.jackpot;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    const container = DOMElements.jackpot.participantsContainer;

    if (!participantCount || !emptyMsg || !container) {
        console.error("Participants count/empty message/container elements missing for UI update.");
        return;
    }

    const participantNum = currentRound?.participants?.length || 0;
    participantCount.textContent = `${participantNum}/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;

    // Check if there are any .player-deposit-container elements currently rendered
    const hasDepositBlocks = container.querySelector('.player-deposit-container') !== null;

    if (!hasDepositBlocks && participantNum === 0) { // No blocks and no participants means pot is empty
        emptyMsg.style.display = 'block';
        // Ensure emptyMsg is in the container if it's not (e.g., after manual clear)
        if (!container.contains(emptyMsg)) {
            // container.innerHTML = ''; // Clear anything else first
            // container.appendChild(emptyMsg);
        }
    } else { // If there are blocks or participants, hide empty message
        emptyMsg.style.display = 'none';
    }
}


function startClientTimer(initialTime = CONFIG.ROUND_DURATION) {
    const timerDisplay = DOMElements.jackpot.timerValue;
    if (!timerDisplay) return; // Ensure element exists
    if (roundTimer) clearInterval(roundTimer); // Clear any existing timer

    let timeLeft = Math.max(0, initialTime); // Ensure timeLeft is not negative
    console.log(`Starting/Syncing client timer from ${timeLeft}s`);
    timerActive = true; // Set timer as active
    updateTimerUI(timeLeft); // Initial UI update
    updateDepositButtonState(); // Update deposit button based on timer state

    roundTimer = setInterval(() => {
        if (!timerActive) { // If timer is externally stopped (e.g., round ends)
            clearInterval(roundTimer); roundTimer = null;
            console.log("Client timer interval stopped (timerActive is false).");
            return;
        }
        timeLeft--;
        if (currentRound) currentRound.timeLeft = timeLeft; // Update local round state (optional)
        updateTimerUI(timeLeft); // Update visual display
        updateDepositButtonState(); // Update deposit button (might close deposits near end)

        if (timeLeft <= 0) { // Timer reached zero
            clearInterval(roundTimer); roundTimer = null; timerActive = false;
            console.log("Client timer reached zero.");
            if (timerDisplay) timerDisplay.textContent = "0"; // Ensure it shows 0
            updateDepositButtonState(); // Deposits should definitely be closed
            // Backend will send 'roundRolling' then 'roundWinner'
        }
    }, 1000);
}

function createRouletteItems() {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer; // The outer container for roulette
    if (!track || !container) {
        console.error("Roulette track or inline roulette element missing.");
        return;
    }
    track.innerHTML = ''; // Clear previous items
    track.style.transition = 'none'; // Disable transition for repositioning
    track.style.transform = 'translateX(0)'; // Reset position

    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) {
        console.error('No participants data available to create roulette items.');
        track.innerHTML = '<div class="roulette-message" style="color: white; text-align: center; padding: 20px;">Waiting for participants...</div>';
        return;
    }

    let ticketPool = [];
    // Calculate total tickets based on participant data in currentRound
    // Backend sends tickets per participant, or we can estimate based on value
    const totalTicketsInRound = currentRound.participants.reduce((sum, p) => sum + (p.tickets || Math.floor((p.itemsValue || 0) / 0.01) || 1), 0);
    const targetVisualBlocks = 150; // Desired number of items in visual roulette for decent look

    if (totalTicketsInRound <= 0) {
        console.warn("Total tickets in round is zero or participants have no tickets/value. Building roulette based on participant presence.");
        // Fallback: give each participant some blocks if tickets/value is missing
        currentRound.participants.forEach(p => {
            const visualBlocks = Math.max(3, Math.ceil(targetVisualBlocks / currentRound.participants.length));
            for (let i = 0; i < visualBlocks; i++) ticketPool.push(p); // Push participant object
        });
    } else {
        currentRound.participants.forEach(p => {
            const tickets = p.tickets || Math.floor((p.itemsValue || 0) / 0.01) || 1; // Use tickets if available, else value
            const visualBlocksForUser = Math.max(3, Math.ceil((tickets / totalTicketsInRound) * targetVisualBlocks));
            for (let i = 0; i < visualBlocksForUser; i++) ticketPool.push(p); // Push participant object
        });
    }

    if (ticketPool.length === 0) {
        console.error("Ticket pool calculation resulted in zero items for roulette.");
        track.innerHTML = '<div class="roulette-message" style="color: red; text-align: center; padding: 20px;">Error building roulette items.</div>';
        return;
    }

    ticketPool = shuffleArray([...ticketPool]); // Shuffle for visual variety

    // Determine how many items are needed for a smooth visual spin
    // This depends on item width and container width
    const rouletteInnerContainer = container.querySelector('.roulette-container'); // The actual track container
    const containerWidth = rouletteInnerContainer?.offsetWidth || container.offsetWidth || 1000; // Fallback width
    const itemWidthWithMargin = (60 + 10); // Approx. item width (50px) + margin (10px)
    const itemsInView = Math.ceil(containerWidth / itemWidthWithMargin);
    const itemsForSpinBuffer = Math.max(150, itemsInView * CONFIG.ROULETTE_REPETITIONS); // Ensure enough items for multiple spins past view
    // CONFIG.ROULETTE_REPETITIONS was 20, this ensures many items.
    const itemsToCreate = Math.max(itemsForSpinBuffer, 200); // Ensure a minimum reasonable number
    console.log(`Targeting ${itemsToCreate} roulette items for smooth animation (Container: ${containerWidth}px, Item+Margin: ${itemWidthWithMargin}px).`);


    const fragment = document.createDocumentFragment();
    for (let i = 0; i < itemsToCreate; i++) {
        const participant = ticketPool[i % ticketPool.length]; // Cycle through the shuffled pool
        if (!participant || !participant.user) {
            console.warn(`Skipping roulette item creation at index ${i} due to invalid participant data.`);
            continue;
        }
        const userId = participant.user._id || participant.user.id;
        const userColor = getUserColor(userId);
        const avatar = participant.user.avatar || '/img/default-avatar.png';

        const itemElement = document.createElement('div');
        itemElement.className = 'roulette-item';
        itemElement.dataset.userId = userId; // Store user ID for identification
        itemElement.style.borderColor = userColor; // Style with user's color
        itemElement.innerHTML = `
            <img class="roulette-avatar" src="${avatar}" alt="Participant Avatar" loading="lazy"
                 onerror="this.onerror=null; this.src='/img/default-avatar.png';" >`;
        fragment.appendChild(itemElement);
    }
    track.appendChild(fragment);
    console.log(`Created ${track.children.length} items for roulette animation.`);
}


function handleWinnerAnnouncement(data) { // data is from roundWinner or roundWinnerPendingAcceptance
    if (isSpinning) {
        console.warn("Received winner announcement but animation is already spinning. Ignoring.");
        return;
    }
    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) {
        console.error("Missing participant data for winner announcement. Requesting fresh data.");
        socket.emit('requestRoundData'); // Ask for fresh data
        // Set a timeout to retry, giving server time to respond
        setTimeout(() => {
            if (currentRound?.participants?.length > 0) {
                console.log("Retrying winner announcement after receiving data.");
                handleWinnerAnnouncement(data); // Retry with the original winner data
            } else {
                console.error("Still no participant data after requesting. Cannot start spin. Resetting.");
                resetToJackpotView();
            }
        }, 1500); // Wait 1.5 seconds
        return;
    }

    const winnerDetails = data.winner; // Assuming data.winner is the populated winner object
    const winnerId = winnerDetails?.id || winnerDetails?._id;
    if (!winnerId) {
        console.error("Invalid winner data received in announcement:", data);
        resetToJackpotView(); // Reset to a safe state
        return;
    }

    console.log(`Winner announced: ${winnerDetails.username}. Preparing roulette...`);
    if (timerActive) { // Stop client timer if it's running
        timerActive = false; clearInterval(roundTimer); roundTimer = null;
        console.log("Stopped client timer due to winner announcement.");
    }

    switchToRouletteView(); // Prepare UI for roulette
    // Small delay to allow UI transition before starting intense animation
    setTimeout(() => {
        startRouletteAnimation({ winner: winnerDetails }); // Pass the winner object
    }, 500); // Delay to allow view switch
}

function switchToRouletteView() {
    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer;
    if (!header || !rouletteContainer) {
        console.error("Missing roulette UI elements for view switch.");
        return;
    }

    // Fade out header elements (pot value, timer, stats)
    const valueDisplay = header.querySelector('.jackpot-value');
    const timerDisplay = header.querySelector('.jackpot-timer');
    const statsDisplay = header.querySelector('.jackpot-stats');

    [valueDisplay, timerDisplay, statsDisplay].forEach(el => {
        if (el) {
            el.style.transition = 'opacity 0.5s ease'; // Smooth fade
            el.style.opacity = '0';
            setTimeout(() => { el.style.display = 'none'; }, 500); // Hide after fade
        }
    });

    header.classList.add('roulette-mode'); // Apply class for roulette mode styles
    rouletteContainer.style.display = 'flex'; // Show roulette
    rouletteContainer.style.opacity = '0'; // Start transparent for fade-in
    rouletteContainer.style.transform = 'translateY(20px)'; // Start slightly down for slide-in

    // Animate roulette container into view
    setTimeout(() => {
        rouletteContainer.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
        rouletteContainer.style.opacity = '1';
        rouletteContainer.style.transform = 'translateY(0)';
    }, 600); // Stagger start after header elements fade

    // Ensure return button is hidden (if it exists and is not used)
    if (DOMElements.roulette.returnToJackpotButton) {
        DOMElements.roulette.returnToJackpotButton.style.display = 'none';
    }
}


function startRouletteAnimation(winnerData) { // winnerData contains { winner: {id, username, avatar, ...} }
    if (animationFrameId) { // Cancel any ongoing animation
        cancelAnimationFrame(animationFrameId); animationFrameId = null;
        console.log("Cancelled previous animation frame.");
    }

    const winnerId = winnerData?.winner?.id || winnerData?.winner?._id;
    if (!winnerId) {
        console.error("Invalid winner data passed to startRouletteAnimation.");
        resetToJackpotView(); return;
    }

    isSpinning = true; updateDepositButtonState();
    // spinStartTime = 0; // Reset spin start time (handled in animateRoulette)
    if (DOMElements.roulette.winnerInfoBox) DOMElements.roulette.winnerInfoBox.style.display = 'none'; // Hide previous winner info
    clearConfetti(); // Clear any old confetti
    createRouletteItems(); // Create a fresh set of items for the track

    // Find the full participant object for the winner from currentRound for more details if needed
    const winnerParticipantData = findWinnerFromData(winnerData); // Gets user, percentage, value
    if (!winnerParticipantData) {
        console.error('Could not find full winner details in startRouletteAnimation.');
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    console.log('Starting animation for Winner:', winnerParticipantData.user.username);
    const sound = DOMElements.audio.spinSound;
    if (sound) {
        sound.volume = 0.7; sound.currentTime = 0; sound.playbackRate = 1.0; // Reset sound
        sound.play().catch(e => console.error('Error playing spin sound:', e));
    } else {
        console.warn("Spin sound element not found.");
    }

    // Short delay to ensure DOM has rendered roulette items
    setTimeout(() => {
        const track = DOMElements.roulette.rouletteTrack;
        const items = track?.querySelectorAll('.roulette-item');
        if (!track || !items || items.length === 0) {
            console.error('Cannot spin, no items rendered on track.');
            isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
        }

        // --- Determine Winning Element ---
        // Prefer items towards the end of the generated track for a longer spin feel
        const minIndexPercent = 0.65, maxIndexPercent = 0.85; // Target 65%-85% range of items
        const minIndex = Math.floor(items.length * minIndexPercent);
        const maxIndex = Math.floor(items.length * maxIndexPercent);

        let winnerItemsIndices = [];
        for (let i = minIndex; i <= maxIndex; i++) {
            if (items[i]?.dataset?.userId === winnerId) winnerItemsIndices.push(i);
        }
        // If no winner items in preferred range, search entire track
        if (winnerItemsIndices.length === 0) {
            console.warn(`No winner items found in preferred range [${minIndex}-${maxIndex}]. Expanding search.`);
            for (let i = 0; i < items.length; i++) {
                 if (items[i]?.dataset?.userId === winnerId) winnerItemsIndices.push(i);
            }
        }

        let winningElement, targetIndex;
        if (winnerItemsIndices.length === 0) { // Should be rare if winner is a participant
            console.error(`No items found matching winner ID ${winnerId}. Using fallback index (approx 75%).`);
            targetIndex = Math.max(0, Math.min(items.length - 1, Math.floor(items.length * 0.75)));
            winningElement = items[targetIndex];
             if (!winningElement) { // Critical error if even fallback fails
                 console.error('Fallback winning element is invalid! Cannot proceed with spin.');
                 isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
             }
        } else { // Pick one of the winner's items randomly from the found indices
            targetIndex = winnerItemsIndices[Math.floor(Math.random() * winnerItemsIndices.length)];
            winningElement = items[targetIndex];
             if (!winningElement) { // Should not happen if indices are valid
                 console.error(`Selected winning element at index ${targetIndex} is invalid!`);
                 isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
             }
        }
        console.log(`Selected winning element at index ${targetIndex} (of ${items.length}) for user ${winnerParticipantData.user.username}`);
        handleRouletteSpinAnimation(winningElement, winnerParticipantData); // Pass full winner participant data
    }, 100); // Small delay
}


function handleRouletteSpinAnimation(winningElement, winner) { // winner is participant object
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer?.querySelector('.roulette-container');
    if (!winningElement || !track || !container) {
        console.error("Missing elements for roulette animation loop.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const containerWidth = container.offsetWidth;
    const itemWidth = winningElement.offsetWidth || 60; // Use actual or default width
    const itemOffsetLeft = winningElement.offsetLeft; // Position of winning item within the track

    // Calculate where the track needs to scroll to center the winningElement
    const centerOffset = (containerWidth / 2) - (itemWidth / 2); // Offset to center item
    const perfectCenterScrollPosition = -(itemOffsetLeft - centerOffset); // Negative because track moves left

    // Add slight random variation to the landing position, but not too much
    const initialVariation = (Math.random() * 2 - 1) * (itemWidth * CONFIG.LANDING_POSITION_VARIATION);
    const maxAllowedAbsVariation = itemWidth * 0.49; // Keep it less than half item width
    let finalVariation;
    if (Math.abs(initialVariation) <= maxAllowedAbsVariation) {
        finalVariation = initialVariation;
    } else { // Cap the variation
        finalVariation = Math.sign(initialVariation) * maxAllowedAbsVariation;
    }
    const targetScrollPosition = perfectCenterScrollPosition + finalVariation;
    const finalTargetPosition = targetScrollPosition; // Store for bounce logic if enabled

    // Animation parameters
    const startPosition = parseFloat(track.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1] || '0'); // Current track position
    const duration = CONFIG.SPIN_DURATION_SECONDS * 1000;
    const bounceDuration = CONFIG.BOUNCE_ENABLED ? 1200 : 0; // Duration for bounce animation
    const totalAnimationTime = duration + bounceDuration;
    const totalDistance = finalTargetPosition - startPosition;
    const overshootAmount = totalDistance * CONFIG.BOUNCE_OVERSHOOT_FACTOR; // For bounce effect

    let startTime = performance.now();
    // spinStartTime = startTime; // Global var if needed elsewhere, not critical here
    track.style.transition = 'none'; // Ensure direct transform manipulation

    function animateRoulette(timestamp) {
        if (!isSpinning) { // Check if spin was cancelled
            console.log("Animation loop stopped: isSpinning false.");
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
            const bounceDisplacementFactor = calculateBounce(bouncePhaseProgress); // Get bounce curve
            currentPosition = finalTargetPosition - (overshootAmount * bounceDisplacementFactor);
        } else { // Animation complete
            currentPosition = finalTargetPosition; animationFinished = true;
        }
        track.style.transform = `translateX(${currentPosition}px)`;

        if (!animationFinished) {
            animationFrameId = requestAnimationFrame(animateRoulette);
        } else {
            console.log("Animation finished naturally in loop.");
            animationFrameId = null;
            finalizeSpin(winningElement, winner); // Proceed to finalize
        }
    }
    if (animationFrameId) cancelAnimationFrame(animationFrameId); // Clear previous frame
    animationFrameId = requestAnimationFrame(animateRoulette); // Start animation
}

function finalizeSpin(winningElement, winner) { // winner is participant object
    // Check if already finalized or if data is invalid to prevent multiple calls
    if ((!isSpinning && winningElement?.classList.contains('winner-highlight')) || !winningElement || !winner?.user) {
        console.log("FinalizeSpin called, but seems already finalized or data invalid.");
        if (isSpinning) { // If somehow still spinning, stop it
            isSpinning = false; updateDepositButtonState();
        }
        return;
    }
    console.log("Finalizing spin: Applying highlight to winner element.");

    const winnerId = winner.user.id || winner.user._id;
    const userColor = getUserColor(winnerId); // Get consistent color
    winningElement.classList.add('winner-highlight'); // Add highlight class

    // Dynamic style for pulsing highlight with user's color
    const styleId = 'winner-pulse-style';
    document.getElementById(styleId)?.remove(); // Remove old style if exists
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        .winner-highlight {
            z-index: 5; border-width: 3px; border-color: ${userColor};
            animation: winnerPulse 1.5s infinite; --winner-color: ${userColor};
            transform: scale(1.05); /* Initial slight scale up */
        }
        @keyframes winnerPulse {
            0%, 100% { box-shadow: 0 0 15px var(--winner-color); transform: scale(1.05); }
            50% { box-shadow: 0 0 25px var(--winner-color), 0 0 10px var(--winner-color); transform: scale(1.1); }
        }`;
    document.head.appendChild(style);

    // Short delay before showing winner info box and confetti, allows highlight to be visible
    setTimeout(() => {
        handleSpinEnd(winningElement, winner);
    }, 300); // 300ms delay
}


function handleSpinEnd(winningElement, winner) { // winner is participant object
    if (!winningElement || !winner?.user) {
        console.error("handleSpinEnd called with invalid data/element.");
        if (!isSpinning) return; // If already stopped, nothing more to do
        isSpinning = false; updateDepositButtonState();
        resetToJackpotView(); // Fallback to reset
        return;
    }
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; } // Ensure animation loop is stopped

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

        // Use participant's total value and percentage from the round data
        const depositValueStr = `$${(winner.value || 0).toFixed(2)}`; // winner.value is participant's total deposit
        const chanceValueStr = `${(winner.percentage || 0).toFixed(2)}%`; // winner.percentage

        winnerDeposit.textContent = ''; // Clear for typing effect
        winnerChance.textContent = '';  // Clear for typing effect

        winnerInfoBox.style.display = 'flex'; // Show the box
        winnerInfoBox.style.opacity = '0'; // Start transparent for fade-in
        winnerInfoBox.style.animation = 'fadeIn 0.5s ease forwards'; // Apply fade-in animation

        // Typing animation for details
        setTimeout(() => {
            let depositIndex = 0; let chanceIndex = 0; const typeDelay = 35; // Typing speed
            if (window.typeDepositInterval) clearInterval(window.typeDepositInterval);
            if (window.typeChanceInterval) clearInterval(window.typeChanceInterval);

            window.typeDepositInterval = setInterval(() => {
                if (depositIndex < depositValueStr.length) {
                    winnerDeposit.textContent += depositValueStr[depositIndex]; depositIndex++;
                } else {
                    clearInterval(window.typeDepositInterval); window.typeDepositInterval = null;
                    // Start typing chance after deposit is done
                    window.typeChanceInterval = setInterval(() => {
                        if (chanceIndex < chanceValueStr.length) {
                            winnerChance.textContent += chanceValueStr[chanceIndex]; chanceIndex++;
                        } else {
                            clearInterval(window.typeChanceInterval); window.typeChanceInterval = null;
                            // After all typing, launch confetti and handle next steps
                            setTimeout(() => { launchConfetti(userColor); }, 200); // Short delay for confetti
                            
                            isSpinning = false; updateDepositButtonState(); // Crucial: Set isSpinning to false HERE
                            console.log("isSpinning set to false after winner details displayed.");

                            // Now, handle what to show: "Accept My Winnings" or "Accept on Steam"
                            if (pendingWinningsOffer) {
                                if (pendingWinningsOffer.action === 'showAcceptWinningsButton' && pendingWinningsOffer.winnerInfo) {
                                    console.log("Animation complete, showing 'Accept My Winnings' popup");
                                    showAcceptWinningsButtonPopup(
                                        pendingWinningsOffer.roundId,
                                        pendingWinningsOffer.winnerInfo.username,
                                        pendingWinningsOffer.totalValue
                                    );
                                } else if (pendingWinningsOffer.action === 'showAcceptOnSteamLink' && pendingWinningsOffer.offerURL) {
                                    console.log("Animation complete path (or direct), processing 'Accept on Steam' link");
                                    showAcceptOnSteamLinkPopup(
                                        pendingWinningsOffer.offerURL,
                                        pendingWinningsOffer.offerId,
                                        pendingWinningsOffer.status
                                    );
                                }
                                pendingWinningsOffer = null; // Clear after handling
                            }
                            // Schedule the reset to main jackpot view after a delay
                            setTimeout(resetToJackpotView, CONFIG.WINNER_DISPLAY_DURATION);
                        }
                    }, typeDelay);
                }
            }, typeDelay);
        }, 500); // Delay before starting typing animation (allows winner box to fade in)
    } else {
        console.error("Winner info display elements missing. Cannot display winner details.");
        isSpinning = false; updateDepositButtonState(); // Still ensure state is reset
        if (pendingWinningsOffer) { // Handle pending offer even if UI elements are missing for some reason
             if (pendingWinningsOffer.action === 'showAcceptWinningsButton' && pendingWinningsOffer.winnerInfo) {
                showAcceptWinningsButtonPopup(pendingWinningsOffer.roundId, pendingWinningsOffer.winnerInfo.username, pendingWinningsOffer.totalValue);
            } else if (pendingWinningsOffer.action === 'showAcceptOnSteamLink' && pendingWinningsOffer.offerURL) {
                showAcceptOnSteamLinkPopup(pendingWinningsOffer.offerURL, pendingWinningsOffer.offerId, pendingWinningsOffer.status);
            }
            pendingWinningsOffer = null;
        }
        resetToJackpotView(); // Fallback
    }
}


function launchConfetti(mainColor = '#00e676') {
    const container = DOMElements.roulette.confettiContainer;
    if (!container) return;
    clearConfetti(); // Clear previous confetti before launching new ones

    const baseColor = mainColor;
    const complementaryColor = getComplementaryColor(baseColor);
    const lighterColor = lightenColor(baseColor, 30);
    const darkerColor = darkenColor(baseColor, 30); // Might not be used if too dark
    const colors = [baseColor, lighterColor, complementaryColor, '#ffffff', lightenColor(complementaryColor, 20)];

    for (let i = 0; i < CONFIG.CONFETTI_COUNT; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'confetti-piece';
        confetti.style.left = `${Math.random() * 100}%`; // Random horizontal start

        // Random animation duration and delay for variety
        const animDuration = 2 + Math.random() * 3; // Duration 2-5 seconds
        const animDelay = Math.random() * 1.5;    // Delay up to 1.5 seconds
        confetti.style.setProperty('--duration', `${animDuration}s`);
        confetti.style.setProperty('--delay', `${animDelay}s`);

        confetti.style.setProperty('--color', colors[Math.floor(Math.random() * colors.length)]); // Random color from palette

        const size = Math.random() * 8 + 4; // Size 4px to 12px
        confetti.style.width = `${size}px`; confetti.style.height = `${size}px`;

        // Random rotation and horizontal drift for falling effect
        const rotationStart = Math.random() * 360;
        const rotationEnd = rotationStart + (Math.random() - 0.5) * 720; // Rotate a couple of times
        const fallX = (Math.random() - 0.5) * 100; // Horizontal drift
        confetti.style.setProperty('--fall-x', `${fallX}px`);
        confetti.style.setProperty('--rotation-start', `${rotationStart}deg`);
        confetti.style.setProperty('--rotation-end', `${rotationEnd}deg`);

        if (Math.random() < 0.5) confetti.style.borderRadius = '50%'; // Some round, some square
        container.appendChild(confetti);
    }
}

function clearConfetti() {
    if (DOMElements.roulette.confettiContainer) DOMElements.roulette.confettiContainer.innerHTML = '';
    // Remove winner pulse style from head
    document.getElementById('winner-pulse-style')?.remove();
    // Clear highlight from any roulette items
    document.querySelectorAll('.roulette-item.winner-highlight').forEach(el => {
        el.classList.remove('winner-highlight');
        el.style.transform = ''; // Reset transform if any
        // Reset border color to default or user's color if applicable
        if (el.dataset?.userId) el.style.borderColor = getUserColor(el.dataset.userId);
        else el.style.borderColor = 'transparent'; // Default or remove
    });
}

function resetToJackpotView() {
    console.log("Resetting to jackpot view...");
    // Clear any animation frames or intervals
    if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null;
    if (window.soundFadeInInterval) clearInterval(window.soundFadeInInterval); window.soundFadeInInterval = null;
    if (window.soundFadeOutInterval) clearInterval(window.soundFadeOutInterval); window.soundFadeOutInterval = null;
    if (window.typeDepositInterval) clearInterval(window.typeDepositInterval); window.typeDepositInterval = null;
    if (window.typeChanceInterval) clearInterval(window.typeChanceInterval); window.typeChanceInterval = null;
    if (roundTimer) clearInterval(roundTimer); roundTimer = null; // Stop client timer

    timerActive = false; isSpinning = false;
    // spinStartTime = 0; // Reset if used

    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer;
    const winnerInfoBox = DOMElements.roulette.winnerInfoBox;
    const track = DOMElements.roulette.rouletteTrack;

    if (!header || !rouletteContainer || !winnerInfoBox || !track) {
        console.error("Missing elements for resetToJackpotView. Cannot fully reset UI."); return;
    }

    // Stop and reset sounds
    const sound = DOMElements.audio.spinSound;
    if (sound) { sound.pause(); sound.currentTime = 0; sound.volume = 1.0; sound.playbackRate = 1.0; }

    // Fade out roulette and winner info if visible
    rouletteContainer.style.transition = 'opacity 0.5s ease';
    rouletteContainer.style.opacity = '0';
    if (winnerInfoBox.style.display !== 'none') {
        winnerInfoBox.style.transition = 'opacity 0.3s ease';
        winnerInfoBox.style.opacity = '0';
    }
    clearConfetti(); // Clear confetti and winner highlight styles

    // USER REQUEST FIX from previous interaction: Clear pot items
    const potContainer = DOMElements.jackpot.participantsContainer;
    if (potContainer) {
        potContainer.innerHTML = ''; // Clear all participant blocks
        const emptyMsg = DOMElements.jackpot.emptyPotMessage;
        if (emptyMsg) {
            if (!potContainer.contains(emptyMsg)) potContainer.appendChild(emptyMsg);
            emptyMsg.style.display = 'block'; // Show "No items in pot"
        }
    }
    // Reset local currentRound data related to items and participants
    if (currentRound) {
        currentRound.participants = [];
        currentRound.items = [];
        currentRound.totalValue = 0;
        // Keep roundId, serverSeedHash, status if it's 'pending' for next round
    }
    updateParticipantsUI(); // Update participant count display

    // After animations/transitions, reset elements for normal jackpot view
    setTimeout(() => {
        header.classList.remove('roulette-mode'); // Remove roulette styling from header
        track.style.transition = 'none'; track.style.transform = 'translateX(0)'; track.innerHTML = ''; // Reset roulette track
        rouletteContainer.style.display = 'none'; // Hide roulette
        winnerInfoBox.style.display = 'none'; winnerInfoBox.style.opacity = ''; winnerInfoBox.style.animation = ''; // Hide winner box

        // Restore header elements (pot value, timer, stats)
        const valueDisplay = header.querySelector('.jackpot-value');
        const timerDisplay = header.querySelector('.jackpot-timer');
        const statsDisplay = header.querySelector('.jackpot-stats');

        [valueDisplay, timerDisplay, statsDisplay].forEach((el, index) => {
            if (el) {
                const computedStyle = window.getComputedStyle(el);
                // el.style.display = computedStyle.display !== 'none' ? computedStyle.display : 'flex'; // Restore display
                el.style.display = 'flex'; // Assuming they are flex items
                el.style.opacity = '0'; // Start transparent for fade-in
                setTimeout(() => { // Staggered fade-in
                    el.style.transition = 'opacity 0.5s ease';
                    el.style.opacity = '1';
                }, 50 + index * 50);
            }
        });

        initiateNewRoundVisualReset(); // Full visual reset for text, timer, etc.
        updateDepositButtonState(); // Update button states

        if (socket?.connected) { // If socket is connected, request fresh round data
            console.log("Requesting fresh round data after reset to jackpot view.");
            socket.emit('requestRoundData');
        } else {
            console.warn("Socket not connected, skipping requestRoundData after reset.");
            // If not connected, UI will show defaults from initiateNewRoundVisualReset
        }
    }, 500); // Wait for fade-out transitions to complete
}


function initiateNewRoundVisualReset() {
    console.log("Initiating visual reset for new round display (or after a round ends).");
    // Reset timer display to full duration, remove pulse classes
    updateTimerUI(CONFIG.ROUND_DURATION); // This will also update the circle
    if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.classList.remove('urgent-pulse', 'timer-pulse');
    if (roundTimer) clearInterval(roundTimer); roundTimer = null; timerActive = false;

    // Clear participant items display and show empty pot message
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (container && emptyMsg) {
        container.innerHTML = ''; // Clear all current deposit blocks
        if (!container.contains(emptyMsg)) container.appendChild(emptyMsg); // Add empty message if not there
        emptyMsg.style.display = 'block'; // Ensure it's visible
    }

    // Reset pot value and participant count displays
    if (DOMElements.jackpot.potValue) DOMElements.jackpot.potValue.textContent = "$0.00";
    if (DOMElements.jackpot.participantCount) DOMElements.jackpot.participantCount.textContent = `0/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;

    userColorMap.clear(); // Clear user color mapping for the new round
    updateDepositButtonState(); // Update deposit button state (likely enable if conditions met)
    // CurrentRound object itself is updated by server events ('roundCreated', 'roundData')
}

function findWinnerFromData(winnerData) { // winnerData is { winner: {id, username, ...} }
    const winnerId = winnerData?.winner?.id || winnerData?.winner?._id;
    if (!winnerId) {
        console.error("Missing winner ID in findWinnerFromData:", winnerData);
        return null; // Cannot find winner without ID
    }
    if (!currentRound || !currentRound.participants) {
        console.warn("Missing currentRound/participants data for findWinnerFromData. Using provided winner data as is.");
        // Fallback to using only the directly provided winner details if local participant list is missing
        if (winnerData.winner) return { user: { ...winnerData.winner }, percentage: 0, value: 0 }; // Default percentage/value
        return null;
    }

    // Find the winner in the current round's participant list to get their deposited value and calculate chance
    const winnerParticipant = currentRound.participants.find(p => p.user?._id === winnerId || p.user?.id === winnerId);

    if (!winnerParticipant) {
        console.warn(`Winner ID ${winnerId} not found in local participants. Using provided winner data directly.`);
        // If winner not in local list (shouldn't happen if data is synced), use direct data
        if (winnerData.winner) return { user: { ...winnerData.winner }, percentage: 0, value: 0 };
        return null;
    }

    // Calculate percentage based on the participant's value and total pot value from currentRound
    const totalValueInPot = Math.max(0.01, currentRound.totalValue || 0.01); // Avoid division by zero
    const participantDepositedValue = winnerParticipant.itemsValue || 0;
    const percentage = (participantDepositedValue / totalValueInPot) * 100;

    return {
        user: { ...(winnerParticipant.user) }, // Return the full user object
        percentage: percentage || 0,           // Calculated percentage
        value: participantDepositedValue       // Participant's total deposited value
    };
}


async function verifyRound() { // For Provably Fair page
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationResultDisplay } = DOMElements.provablyFair;
    if (!roundIdInput || !serverSeedInput || !clientSeedInput || !verificationResultDisplay) {
        console.error("Verify form elements missing."); return;
    }
    const roundId = roundIdInput.value.trim(), serverSeed = serverSeedInput.value.trim(), clientSeed = clientSeedInput.value.trim();
    const resultEl = verificationResultDisplay;
    let validationError = null;

    // Basic input validation
    if (!roundId || !serverSeed || !clientSeed) validationError = 'Please fill in all fields (Round ID, Server Seed, Client Seed).';
    else if (serverSeed.length !== 64 || !/^[a-f0-9]{64}$/i.test(serverSeed)) validationError = 'Invalid Server Seed format (should be 64 hexadecimal characters).';
    else if (clientSeed.length === 0) validationError = 'Client Seed cannot be empty.';
    // Add more client seed validation if needed (e.g., hex, length)

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
        const result = await response.json(); // Server returns verification details
        if (!response.ok) throw new Error(result.error || `Verification failed (${response.status})`);

        resultEl.className = `verification-result ${result.verified ? 'success' : 'error'}`;
        let html = `<h4>Result (Round #${result.roundId || roundId})</h4>`;
        if (result.verified) {
            html += `<p style="color: var(--success-color); font-weight: bold;">✅ Verified Fair.</p>`;
            if (result.serverSeedHash) html += `<p><strong>Server Seed Hash (Used):</strong> <code class="seed-value">${result.serverSeedHash}</code></p>`;
            if (result.serverSeed) html += `<p><strong>Server Seed (Provided):</strong> <code class="seed-value">${result.serverSeed}</code></p>`;
            if (result.clientSeed) html += `<p><strong>Client Seed (Provided):</strong> <code class="seed-value">${result.clientSeed}</code></p>`;
            if (result.combinedString) html += `<p><strong>Combined String (ServerSeed + ClientSeed):</strong> <code class="seed-value wrap-anywhere">${result.combinedString}</code></p>`;
            if (result.finalHash) html += `<p><strong>Resulting SHA256 Hash (from Combined):</strong> <code class="seed-value">${result.finalHash}</code></p>`;
            if (result.winningTicket !== undefined) html += `<p><strong>Winning Ticket Number (Calculated):</strong> ${result.winningTicket} (out of ${result.totalTickets || 'N/A'} total tickets)</p>`;
            if (result.winnerUsername) html += `<p><strong>Verified Winner:</strong> ${result.winnerUsername}</p>`;
            if (result.totalValue !== undefined) html += `<p><strong>Final Pot Value (After Tax, for Winner):</strong> $${result.totalValue.toFixed(2)}</p>`;
        } else { // Not verified
            html += `<p style="color: var(--error-color); font-weight: bold;">❌ Verification Failed.</p>`;
            html += `<p><strong>Reason:</strong> ${result.reason || 'Mismatch detected.'}</p>`;
            // Display expected vs. calculated values if available
            if (result.serverSeedHash && result.calculatedHash && result.serverSeedHash !== result.calculatedHash) {
                html += `<p><strong>Expected Server Seed Hash:</strong> <code class="seed-value">${result.serverSeedHash}</code></p>`;
                html += `<p><strong>Calculated Hash from Provided Server Seed:</strong> <code class="seed-value">${result.calculatedHash}</code></p>`;
            }
            if (result.expectedProvableHash && result.calculatedProvableHash && result.expectedProvableHash !== result.calculatedProvableHash) {
                 html += `<p><strong>Expected Provable Hash:</strong> <code class="seed-value">${result.expectedProvableHash}</code></p>`;
                 html += `<p><strong>Calculated Provable Hash from Seeds:</strong> <code class="seed-value">${result.calculatedProvableHash}</code></p>`;
            }
            if (result.expectedServerSeed && result.providedServerSeed && result.expectedServerSeed !== result.providedServerSeed) {
                html += `<p><strong>Expected Server Seed (DB):</strong> <code class="seed-value">${result.expectedServerSeed}</code></p>`;
            }
             if (result.expectedClientSeed && result.providedClientSeed && result.expectedClientSeed !== result.providedClientSeed) {
                html += `<p><strong>Expected Client Seed (DB):</strong> <code class="seed-value">${result.expectedClientSeed}</code></p>`;
            }
            if (result.actualWinningTicket !== undefined && result.calculatedTicket !== undefined && result.actualWinningTicket !== result.calculatedTicket) {
                html += `<p><strong>Actual Winning Ticket (DB):</strong> ${result.actualWinningTicket}</p>`;
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
    if (!tableBody || !paginationContainer) {
        console.warn("Rounds history table/pagination elements missing."); return;
    }
    try {
        tableBody.innerHTML = '<tr><td colspan="5" class="loading-message">Loading round history...</td></tr>';
        paginationContainer.innerHTML = ''; // Clear old pagination
        const response = await fetch(`/api/rounds?page=${page}&limit=10`); // Fetch 10 rounds per page
        if (!response.ok) throw new Error(`Failed to load round history (${response.status})`);
        const data = await response.json(); // Expects { rounds: [], currentPage, totalPages, totalRounds }
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
                const timeToFormat = round.completedTime || round.endTime; // Prefer completedTime
                if (timeToFormat) {
                    try {
                        const d = new Date(timeToFormat);
                        if (!isNaN(d.getTime())) date = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
                    } catch (e) { console.error("Date formatting error:", e); }
                }
                // Escape quotes for onclick string arguments
                const serverSeedStr = (round.serverSeed || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
                const clientSeedStr = (round.clientSeed || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
                const roundIdStr = round.roundId || 'N/A';
                const winnerUsername = round.winner?.username || (round.status === 'error' ? 'ERROR' : 'N/A');
                const potValueStr = (round.totalValue !== undefined) ? `$${round.totalValue.toFixed(2)}` : '$0.00'; // Value winner received

                row.innerHTML = `
                    <td>#${roundIdStr}</td>
                    <td>${date}</td>
                    <td>${potValueStr}</td>
                    <td class="${round.winner ? 'winner-cell' : ''}">${winnerUsername}</td>
                    <td>
                        <button class="btn btn-secondary btn-small btn-verify"
                                onclick="window.populateVerificationFields('${roundIdStr}', '${serverSeedStr}', '${clientSeedStr}')"
                                ${!round.serverSeed ? 'disabled title="Seed not revealed yet for this round or round in error"' : 'title="Verify this round"'}>
                            Verify
                        </button>
                    </td>`;
                tableBody.appendChild(row);
            });
        }
        createPagination(data.currentPage, data.totalPages); // Create pagination controls
    } catch (error) {
        tableBody.innerHTML = `<tr><td colspan="5" class="error-message">Error loading rounds: ${error.message}</td></tr>`;
        console.error('Error loading past rounds:', error);
    }
}

// Make populateVerificationFields globally accessible for onclick
window.populateVerificationFields = function(roundId, serverSeed, clientSeed) {
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationSection } = DOMElements.provablyFair;
    if (roundIdInput) roundIdInput.value = roundId || '';
    if (serverSeedInput) serverSeedInput.value = serverSeed || '';
    if (clientSeedInput) clientSeedInput.value = clientSeed || '';
    if (verificationSection) verificationSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // Optionally notify if seeds are empty but round ID is valid (meaning round hasn't revealed them)
    if (!serverSeed && roundId && roundId !== 'N/A') {
        showNotification(`Info: Server Seed for Round #${roundId} is revealed after the round ends.`, 'info');
    }
};


function createPagination(currentPage, totalPages) { // For past rounds
    const container = DOMElements.provablyFair.roundsPagination;
    if (!container) return; container.innerHTML = ''; // Clear previous
    if (totalPages <= 1) return; // No pagination needed for 1 or 0 pages

    const maxPagesToShow = 5; // Number of page buttons to show (e.g., 1 ... 3 4 5 ... 10)
    const createButton = (text, page, isActive = false, isDisabled = false, isEllipsis = false) => {
        if (isEllipsis) {
            const span = document.createElement('span');
            span.className = 'page-ellipsis'; span.textContent = '...'; return span;
        }
        const button = document.createElement('button');
        button.className = `page-button ${isActive ? 'active' : ''}`;
        button.textContent = text; button.disabled = isDisabled;
        if (!isDisabled && typeof page === 'number') { // Only add listener if not disabled and is a page number
            button.addEventListener('click', (e) => { e.preventDefault(); loadPastRounds(page); });
        }
        return button;
    };

    // Previous Button
    container.appendChild(createButton('« Prev', currentPage - 1, false, currentPage <= 1));

    // Page Number Buttons
    if (totalPages <= maxPagesToShow) { // Show all pages if total is small
        for (let i = 1; i <= totalPages; i++) container.appendChild(createButton(i, i, i === currentPage));
    } else { // Complex pagination with ellipsis
        let pages = []; pages.push(1); // Always show first page

        // Calculate range for middle pages
        const rangePadding = Math.floor((maxPagesToShow - 3) / 2); // -3 for first, last, and one ellipsis potential
        let rangeStart = Math.max(2, currentPage - rangePadding);
        let rangeEnd = Math.min(totalPages - 1, currentPage + rangePadding);

        // Adjust range if it's too small due to being near start/end
        const rangeLength = rangeEnd - rangeStart + 1;
        const neededInMiddle = (maxPagesToShow - 2); // Need space for first, last, and pages in between
        if (rangeLength < neededInMiddle -1) { // -1 because we have first and last already, need maxPages-2 more things (pages or ellipsis)
             if (currentPage - rangeStart < rangeEnd - currentPage) { // Closer to start
                 rangeEnd = Math.min(totalPages - 1, rangeStart + (neededInMiddle - 2) ); // -2 for the two ellipsis
             } else { // Closer to end
                 rangeStart = Math.max(2, rangeEnd - (neededInMiddle - 2) +1);
             }
        }
         // Ensure range is valid after adjustment
         rangeStart = Math.max(2, rangeStart);
         rangeEnd = Math.min(totalPages - 1, rangeEnd);


        if (rangeStart > 2) pages.push('...'); // Ellipsis after first page
        for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);
        if (rangeEnd < totalPages - 1) pages.push('...'); // Ellipsis before last page

        pages.push(totalPages); // Always show last page

        // Render page buttons/ellipsis
        pages.forEach(page => {
            if (page === '...') container.appendChild(createButton('...', null, false, true, true));
            else container.appendChild(createButton(page, page, page === currentPage));
        });
    }

    // Next Button
    container.appendChild(createButton('Next »', currentPage + 1, false, currentPage >= totalPages));
}


function updateChatUI() {
    const { messageInput, sendMessageBtn, onlineUsers } = DOMElements.chat;
    if (currentUser) { // If user is logged in
        if (messageInput) {
            messageInput.disabled = false;
            messageInput.placeholder = 'Type your message...';
        }
        if (sendMessageBtn) sendMessageBtn.disabled = isChatSendOnCooldown; // Enable if not on cooldown
    } else { // If user is not logged in
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
    if (userId) messageElement.dataset.userId = userId; // For potential direct interactions later
    if (userSteamId) messageElement.dataset.userSteamId = userSteamId; // For linking to Steam profile, etc.

    if (type === 'system') { // System messages (e.g., connection info)
        messageElement.classList.add('system-message');
        messageElement.textContent = message;
    } else { // User messages
        const userAvatarSrc = avatar || '/img/default-avatar.png';
        const displayName = username || 'Anonymous';
        const userColor = getUserColor(userId || 'system-user'); // Use color for user
        messageElement.innerHTML = `
            <img src="${userAvatarSrc}" alt="${displayName}" class="chat-message-avatar" style="border-color: ${userColor};">
            <div class="chat-message-content">
                <span class="chat-message-user" style="color: ${userColor};">${displayName}</span>
                <p class="chat-message-text"></p>
            </div>
        `;
        const textElement = messageElement.querySelector('.chat-message-text');
        if (textElement) textElement.textContent = message; // Set text content safely
    }
    // Add new message to the top (because container is flex-direction: column-reverse)
    messagesContainer.insertBefore(messageElement, messagesContainer.firstChild);

    // Limit number of messages displayed
    while (messagesContainer.children.length > CONFIG.MAX_CHAT_MESSAGES) {
        messagesContainer.removeChild(messagesContainer.lastChild); // Remove oldest messages from bottom
    }
}


function handleSendMessage() {
    const { messageInput, sendMessageBtn } = DOMElements.chat;
    if (!messageInput || !currentUser || isChatSendOnCooldown) return;

    const messageText = messageInput.value.trim();
    if (messageText) {
        socket.emit('chatMessage', messageText); // Send to server
        messageInput.value = ''; // Clear input
        isChatSendOnCooldown = true; // Start cooldown

        if (sendMessageBtn) {
            sendMessageBtn.disabled = true; // Disable button
            const originalText = sendMessageBtn.textContent;
            let countdown = Math.floor(CONFIG.CHAT_SEND_COOLDOWN_MS / 1000);
            sendMessageBtn.textContent = `Wait ${countdown}s`; // Show countdown

            const intervalId = setInterval(() => {
                countdown--;
                if (countdown > 0) {
                    sendMessageBtn.textContent = `Wait ${countdown}s`;
                } else {
                    clearInterval(intervalId);
                    sendMessageBtn.textContent = originalText;
                    isChatSendOnCooldown = false; // End cooldown
                    if(currentUser) sendMessageBtn.disabled = false; // Re-enable if still logged in
                }
            }, 1000);
        }
        // Fallback to ensure cooldown flag is reset even if interval logic fails
        setTimeout(() => {
            isChatSendOnCooldown = false;
            if(currentUser && sendMessageBtn && !sendMessageBtn.textContent.startsWith("Wait")) { // Check if text wasn't reset by interval
                 sendMessageBtn.disabled = false;
            }
        }, CONFIG.CHAT_SEND_COOLDOWN_MS);
    }
}


function setupChatEventListeners() {
    const { messageInput, sendMessageBtn } = DOMElements.chat;
    sendMessageBtn?.addEventListener('click', handleSendMessage);
    messageInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { // Send on Enter (but not Shift+Enter for new lines)
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

async function loadWinningHistory() {
    const { modal, tableBody, loadingIndicator, noWinningsMessage } = DOMElements.winningHistoryModal;
    if (!currentUser) {
        showNotification("Please log in to view your winning history.", "info");
        return;
    }
    showModal(modal);
    if (loadingIndicator) loadingIndicator.style.display = 'flex';
    if (tableBody) tableBody.innerHTML = ''; // Clear previous history
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
            } else if (offerURL && (offerStatus === 'Sent' || offerStatus === 'Escrow' || offerStatus === 'PendingConfirmation' || offerStatus === 'Unknown' || offerStatus === 'PendingAcceptanceByWinner')) {
                // If it's PendingAcceptanceByWinner, it means user hasn't clicked "Accept My Winnings" or it failed before sending.
                // Here we just show a link if an offer ID exists.
                let linkText = offerStatus === 'PendingAcceptanceByWinner' ? `Accept Winnings (#${offerId || win.gameId})` : `View Offer (#${offerId})`;
                let titleText = offerStatus === 'PendingAcceptanceByWinner' ? `Click to accept winnings for Round #${win.gameId}` : `View trade offer on Steam`;
                // For PendingAcceptanceByWinner, this link shouldn't go to Steam yet.
                // This part of UI might need adjustment based on how "re-accepting" would work.
                // For now, if an offer ID exists, link to it.
                tradeCell.innerHTML = `<a href="${offerURL}" target="_blank" rel="noopener noreferrer" class="trade-link pending" title="${titleText}">
                                          <i class="fas fa-external-link-alt"></i> ${linkText}
                                      </a>`;
            } else if (offerStatus === 'No Items Won'){ // Taxed out
                 tradeCell.innerHTML = `<span class="trade-status info"><i class="fas fa-info-circle"></i> No Items (Tax)</span>`;
            }
            else { // Failed, Declined, Canceled, Expired, etc.
                tradeCell.innerHTML = `<span class="trade-status ${offerStatus.toLowerCase().includes('fail') || offerStatus === 'Declined' ? 'failed' : 'info'}" title="Offer ID: ${offerId || 'N/A'}">
                                          <i class="fas ${offerStatus.toLowerCase().includes('fail') || offerStatus === 'Declined' ? 'fa-times-circle' : 'fa-question-circle'}"></i>
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
            tableBody.innerHTML = `<tr><td colspan="4" class="error-message">Error loading history: ${error.message}</td></tr>`;
        }
        showNotification(`Error loading winning history: ${error.message}`, 'error');
    }
}


function setupSocketConnection() {
    socket.on('connect', () => {
        console.log('Socket connected:', socket.id);
        showNotification('Connected to server.', 'success', 2000);
        socket.emit('requestRoundData'); // Request current round state on connection
    });
    socket.on('disconnect', (reason) => {
        console.log('Socket disconnected:', reason);
        showNotification('Disconnected from server. Attempting to reconnect...', 'error', 5000);
        updateDepositButtonState();
        updateChatOnlineUsers(0); // Reset online users
        if(timerActive) { // Stop client timer if disconnected
            clearInterval(roundTimer); roundTimer = null; timerActive = false;
            updateTimerUI(0); // Or show a disconnected state
        }
    });
    socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
        showNotification('Connection Error. Please refresh.', 'error', 10000);
        updateDepositButtonState();
    });

    socket.on('roundCreated', (data) => { // New round started by backend
        console.log('New round created (event):', data);
        currentRound = data; // Update local currentRound
        resetToJackpotView(); // This calls initiateNewRoundVisualReset()
        // updateRoundUI(); // Called by resetToJackpotView through initiateNewRoundVisualReset
        // updateDepositButtonState(); // Also called by resetToJackpotView
    });
    socket.on('participantUpdated', (data) => { // Someone deposited
        console.log('Participant updated (event):', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            handleNewDeposit(data); // Process and display the new deposit
        } else if (!currentRound && data.roundId) { // If client somehow missed roundCreated
            console.warn("Participant update for unknown/stale round. Requesting full round data.");
            socket.emit('requestRoundData');
        }
    });

    // Listen for the new event for winner announcement before "accept"
    socket.on('roundWinnerPendingAcceptance', (data) => {
        console.log('Round winner pending acceptance (event):', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.winner = data.winner;
            currentRound.status = 'completed_pending_acceptance'; // Update local status
            currentRound.totalValueWonByWinner = data.totalValue; // Store value winner gets

            // Trigger winner animation sequence
            handleWinnerAnnouncement(data); // This starts roulette animation

            // Set up pendingWinningsOffer to show "Accept My Winnings" button after animation
            pendingWinningsOffer = {
                roundId: data.roundId,
                winnerInfo: data.winner,
                totalValue: data.totalValue, // This is the value after tax for the winner
                action: 'showAcceptWinningsButton'
            };
             if (currentUser && (data.winner.id === currentUser._id || data.winner.id === currentUser.id)) {
                showNotification('You won! Accept your winnings after the animation.', 'success', 10000);
            }
        } else {
            console.warn("Received 'roundWinnerPendingAcceptance' for mismatched round ID. Current:", currentRound?.roundId, "Received:", data.roundId);
        }
    });


    socket.on('tradeOfferSent', (data) => { // Winnings trade offer actually sent by bot
        console.log('Trade offer sent (event):', data);
        if (currentUser && data.userId === (currentUser._id || currentUser.id) && data.offerURL) {
            if (data.type === 'winning') {
                // This is now triggered AFTER user clicks "Accept My Winnings" and backend sends offer
                showAcceptOnSteamLinkPopup(data.offerURL, data.offerId, data.status);
                showNotification(`Winnings Sent! <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">Accept on Steam</a> (#${data.offerId})`, 'success', 15000);
            } else if (data.type === 'deposit') { // Handle notifications for deposit offers if needed
                 showNotification(`Deposit Offer Sent: <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">View Offer (#${data.offerId})</a> Status: ${data.status}`, 'info', 10000);
            }
        } else if (currentUser && data.userId === (currentUser._id || currentUser.id) && data.type === 'winning') {
            // Fallback if URL somehow missing but it's a winning offer for current user
            showNotification(`Winnings Sent: Check Steam for offer #${data.offerId}. (URL missing in event)`, 'warning', 8000);
        }
    });


    socket.on('roundRolling', (data) => { // Round is now rolling (winner selection phase)
        console.log('Round rolling event received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            timerActive = false; if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
            if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Rolling";
            if (DOMElements.jackpot.timerForeground) updateTimerCircle(0, CONFIG.ROUND_DURATION); // Show timer as complete
            currentRound.status = 'rolling';
            updateDepositButtonState(); // Deposits should be closed
        }
    });
    socket.on('roundCompleted', (data) => { // Round fully completed (after winner, etc.)
        console.log('Round completed event received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'completed'; // Or 'completed_pending_acceptance' if using that
            if(data.serverSeed) currentRound.serverSeed = data.serverSeed; // For provably fair
            if(data.clientSeed) currentRound.clientSeed = data.clientSeed;
        }
        // updateDepositButtonState(); // Should remain closed until new round
        // resetToJackpotView will usually be called by 'roundCreated' for the *next* round.
    });
    socket.on('roundError', (data) => {
        console.error('Round Error event received:', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'error';
            showNotification(`Round Error: ${data.error || 'Unknown error.'}`, 'error');
        }
        resetToJackpotView(); // Reset to a clean state on error
    });

    socket.on('roundData', (data) => { // Initial round data or forced update
        console.log('Received initial/updated round data (event):', data);
        if (!data || typeof data !== 'object') {
            console.error("Invalid round data received from server. Resetting.");
            initiateNewRoundVisualReset(); // Reset to default empty state
            showNotification('Error syncing with server. Please refresh if issues persist.', 'error');
            return;
        }

        const isNewRoundId = !currentRound || currentRound.roundId !== data.roundId;
        currentRound = data; // Update local currentRound with all details

        if (isNewRoundId && (data.status === 'pending' || (data.status === 'active' && data.participants?.length === 0))) {
            console.log("New round ID or empty active round received. Performing full visual reset.");
            initiateNewRoundVisualReset(); // Full reset for a truly new/empty round
            updateTimerUI(data.timeLeft !== undefined ? data.timeLeft : CONFIG.ROUND_DURATION); // Update timer based on new data
        } else {
            updateRoundUI(); // Update based on potentially existing round state
        }
        updateDepositButtonState(); // Update deposit button availability

        // Handle different round statuses
        if (currentRound.status === 'rolling' || currentRound.status === 'completed' || currentRound.status === 'completed_pending_acceptance') {
             if (!isSpinning && currentRound.winner && !pendingWinningsOffer) { // If winner known and not spinning, trigger animation
                 console.log("Connected/Synced mid-round/post-completion with winner. Triggering winner display sequence.");
                 // Prepare for the correct popup after animation
                 pendingWinningsOffer = {
                    roundId: currentRound.roundId,
                    winnerInfo: currentRound.winner,
                    totalValue: currentRound.totalValue, // This is totalValue won if status is completed
                    action: currentRound.status === 'completed_pending_acceptance' ? 'showAcceptWinningsButton' : null
                 };
                 if (currentRound.payoutOfferId && currentRound.payoutOfferStatus === 'Sent'){ // If offer already sent
                     pendingWinningsOffer.action = 'showAcceptOnSteamLink';
                     pendingWinningsOffer.offerURL = `https://steamcommunity.com/tradeoffer/${currentRound.payoutOfferId}/`;
                     pendingWinningsOffer.offerId = currentRound.payoutOfferId;
                     pendingWinningsOffer.status = currentRound.payoutOfferStatus;
                 }
                 handleWinnerAnnouncement(currentRound); // Pass full currentRound as it contains winner
             } else if (!isSpinning && !currentRound.winner) { // Rolling/completed but no winner info yet (shouldn't happen often)
                  console.log("Round is rolling/completed but no winner info yet. Waiting for winner event or resetting.");
                  // Could show "Rolling..." more prominently or wait. For now, resetToJackpotView might handle it
                  // if it's stuck in this state for too long.
             }
        } else if (currentRound.status === 'active') {
             if (currentRound.participants?.length > 0 && currentRound.timeLeft > 0 && !timerActive) {
                 console.log(`Received active round data. Starting/syncing client timer from ${currentRound.timeLeft}s.`);
                 startClientTimer(currentRound.timeLeft);
             } else if (currentRound.timeLeft <= 0 && timerActive) { // Server says time up
                 console.log("Server data indicates time up, stopping client timer.");
                 timerActive = false; if (roundTimer) clearInterval(roundTimer); roundTimer = null;
                 updateTimerUI(0); updateDepositButtonState();
             } else if (currentRound.participants?.length === 0 && timerActive) { // No participants, stop timer
                  console.log("Server data indicates no participants, stopping client timer.");
                  timerActive = false; if (roundTimer) clearInterval(roundTimer); roundTimer = null;
                  updateTimerUI(CONFIG.ROUND_DURATION); updateDepositButtonState();
             } else if (!timerActive) { // Timer not active, just update display
                 updateTimerUI(currentRound.timeLeft);
             }
        } else if (currentRound.status === 'pending') { // Waiting for round to start
            console.log("Received pending round state. Visuals should be reset.");
            if (!isNewRoundId) initiateNewRoundVisualReset(); // Only if not already reset by new round ID logic
            if(DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Waiting";
            updateDepositButtonState();
        } else if (!currentRound.status) { // No status, unusual
             console.warn("Received round data with no status. Performing visual reset.");
             initiateNewRoundVisualReset();
        }

        // Re-render participant deposits based on the full round data
        const potContainer = DOMElements.jackpot.participantsContainer;
        if(potContainer) {
            potContainer.innerHTML = ''; // Clear existing before re-rendering
            if (DOMElements.jackpot.emptyPotMessage && (!data.participants || data.participants.length === 0)) {
                potContainer.appendChild(DOMElements.jackpot.emptyPotMessage);
                DOMElements.jackpot.emptyPotMessage.style.display = 'block';
            } else if (DOMElements.jackpot.emptyPotMessage) {
                 DOMElements.jackpot.emptyPotMessage.style.display = 'none';
            }

            if (data.participants?.length > 0) {
                console.log("Rendering existing deposits from full round data.");
                // Sort participants if needed, e.g., by deposit time or value. For now, use order from server.
                // const sortedParticipants = [...data.participants].sort((a,b) => new Date(a.firstDepositTime) - new Date(b.firstDepositTime));
                data.participants.forEach(p => {
                    if (!p.user) return; // Skip if participant user data is missing
                    // Find all items belonging to this participant in this round from the round's master item list
                    const participantItemsForDisplay = data.items?.filter(item => (item.owner === p.user._id || item.owner === p.user.id)) || [];
                    displayLatestDeposit({ // Reuse function, ensuring it uses the full cumulative values
                        userId: p.user._id || p.user.id,
                        username: p.user.username,
                        avatar: p.user.avatar,
                        itemsValue: p.itemsValue, // This is participant's total value in round
                        tickets: p.tickets, // Participant's total tickets
                        depositedItems: participantItemsForDisplay, // All items by this user in this round
                        totalValue: data.totalValue // Overall round total value for percentage calculation
                    });
                    // Remove 'new deposit' animation if re-rendering existing
                    const element = potContainer.querySelector(`.player-deposit-container[data-user-id="${p.user._id || p.user.id}"]`);
                    if (element) element.classList.remove('player-deposit-new');
                });
                 updateAllParticipantPercentages(); // Crucial after re-rendering all
            }
        }
    });


    socket.on('notification', (data) => { // Generic notifications from server
        console.log('Notification event received:', data);
        // Show notification if it's global or for the current user
        if (!data.userId || (currentUser && data.userId === (currentUser._id || currentUser.id))) {
            showNotification(data.message || 'Received notification from server.', data.type || 'info', data.duration || 4000);
        }
    });
    socket.on('chatMessage', (data) => { // New chat message
        displayChatMessage(data);
    });
    socket.on('updateUserCount', (count) => { // Online user count update
        updateChatOnlineUsers(count);
    });

    // Add suggested handler for timer synchronization from backend
    socket.on('timerUpdate', (data) => {
        if (data && typeof data.timeLeft === 'number' && currentRound && (currentRound.status === 'active' || currentRound.status === 'pending')) {
            // console.log(`TimerUpdate event from server: ${data.timeLeft}s`);
            currentRound.timeLeft = data.timeLeft; // Sync local timeLeft
            if (!timerActive && data.timeLeft > 0 && currentRound.participants?.length > 0 && currentRound.status === 'active') {
                // If client timer isn't running but server says there's time and participants
                startClientTimer(data.timeLeft);
            } else {
                // Just update UI if timer is already running or conditions not met to start
                updateTimerUI(data.timeLeft);
            }
        }
    });
}


function setupEventListeners() {
    // Navigation Links
    DOMElements.nav.homeLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.homePage); });
    DOMElements.nav.aboutLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.aboutPage); });
    DOMElements.nav.tosLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.tosPage); });
    DOMElements.nav.faqLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.faqPage); });
    DOMElements.nav.fairLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.fairPage); });

    // Login Button
    DOMElements.user.loginButton?.addEventListener('click', () => {
        if (localStorage.getItem('ageVerified') === 'true') {
            window.location.href = '/auth/steam'; // Proceed to Steam login
        } else { // Show age verification modal first
            const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
            if(ageCheckbox) ageCheckbox.checked = false; // Reset checkbox
            if(ageAgreeButton) ageAgreeButton.disabled = true; // Reset button state
            showModal(DOMElements.ageVerification.modal);
        }
    });

    // User Profile Dropdown
    const { userProfile, userDropdownMenu, logoutButton, profileDropdownButton, winningHistoryDropdownButton } = DOMElements.user;
    userProfile?.addEventListener('click', (e) => { // Toggle dropdown
        e.stopPropagation(); // Prevent window click from closing it immediately
        if (userDropdownMenu) {
            const isVisible = userDropdownMenu.style.display === 'block';
            userDropdownMenu.style.display = isVisible ? 'none' : 'block';
            userProfile?.setAttribute('aria-expanded', String(!isVisible));
            userProfile?.classList.toggle('open', !isVisible);
        }
    });
    userProfile?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }}); // Accessibility

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
            loadWinningHistory(); // This will show the modal
        } else {
            showNotification("Please log in to view your winning history.", "info");
        }
        if (menu) menu.style.display = 'none'; // Close dropdown
        userProfile?.setAttribute('aria-expanded', 'false'); userProfile?.classList.remove('open');
    });

    // Profile Modal Actions
    DOMElements.profileModal.saveBtn?.addEventListener('click', handleProfileSave);
    DOMElements.profileModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.profileModal.cancelBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));

    // Accept Winnings Modal (Note: actionButton's onclick is set dynamically)
    const awModal = DOMElements.acceptWinningsModal;
    awModal.closeBtn?.addEventListener('click', () => hideModal(awModal.modal));
    awModal.closeFooterBtn?.addEventListener('click', () => hideModal(awModal.modal));
    // awModal.actionButton's listener is set in showAcceptWinningsButtonPopup or showAcceptOnSteamLinkPopup

    // Winning History Modal Actions
    const whModal = DOMElements.winningHistoryModal;
    whModal.closeBtn?.addEventListener('click', () => hideModal(whModal.modal));
    whModal.closeFooterBtn?.addEventListener('click', () => hideModal(whModal.modal));

    // Deposit Modal Actions
    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => {
        const button = DOMElements.deposit.showDepositModalButton;
        if (button.disabled) { // If button is disabled, show its title as notification
            showNotification(button.title || 'Deposits are currently closed.', 'info'); return;
        }
        if (!currentUser) {
            showNotification('Login Required: Please log in first.', 'error'); return;
        }
         if (!currentUser.tradeUrl) { // Check for trade URL
             console.log("Trade URL missing for user. Prompting user to set it in profile.");
             showNotification('Trade URL Required: Open your profile (click avatar) and set your Steam Trade URL.', 'error', 6000);
             if (DOMElements.profileModal.modal) { // Open profile modal for convenience
                 populateProfileModal(); showModal(DOMElements.profileModal.modal);
             }
             return;
         }
        showModal(DOMElements.deposit.depositModal); loadUserInventory(); // Open modal and load items
    });
    DOMElements.deposit.closeDepositModalButton?.addEventListener('click', () => hideModal(DOMElements.deposit.depositModal));
    DOMElements.deposit.depositButton?.addEventListener('click', requestDepositOffer); // "Request Deposit Offer" button
    DOMElements.deposit.acceptDepositOfferBtn?.addEventListener('click', () => { // "Accept on Steam" for DEPOSITS
         if (currentDepositOfferURL) {
             console.log("Opening Steam trade offer for deposit:", currentDepositOfferURL);
             window.open(currentDepositOfferURL, '_blank', 'noopener,noreferrer');
             const { depositStatusText } = DOMElements.deposit;
             if(depositStatusText) depositStatusText.textContent = "Check Steam tab for the offer...";
             // Optionally hide modal after a delay or let user close it
         } else {
             console.error("No deposit offer URL found for accept button.");
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

    // Provably Fair Verification Button
    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound);

    // Global click listener to close dropdowns/modals when clicking outside
    window.addEventListener('click', (e) => {
        const profileModalEl = DOMElements.profileModal.modal;
        const depositModalEl = DOMElements.deposit.depositModal;
        const acceptWinningsModalEl = DOMElements.acceptWinningsModal.modal;
        const winningHistoryModalEl = DOMElements.winningHistoryModal.modal;

        // Close user dropdown
        if (userDropdownMenu && userProfile && userDropdownMenu.style.display === 'block' &&
            !userProfile.contains(e.target) && !userDropdownMenu.contains(e.target)) {
            userDropdownMenu.style.display = 'none';
            userProfile.setAttribute('aria-expanded', 'false');
            userProfile.classList.remove('open');
        }
        // Close modals if click is on backdrop
        if (e.target === depositModalEl) hideModal(depositModalEl);
        if (e.target === profileModalEl) hideModal(profileModalEl);
        if (e.target === acceptWinningsModalEl) hideModal(acceptWinningsModalEl);
        if (e.target === winningHistoryModalEl) hideModal(winningHistoryModalEl);
    });

    // Global keydown listener for Escape key to close modals/dropdowns
    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
            const activeModal = [
                DOMElements.profileModal.modal,
                DOMElements.deposit.depositModal,
                DOMElements.acceptWinningsModal.modal,
                DOMElements.winningHistoryModal.modal,
                DOMElements.ageVerification.modal
            ].find(modal => modal?.style.display === 'flex');

            if (activeModal) {
                hideModal(activeModal);
            } else if (userDropdownMenu && userDropdownMenu.style.display === 'block') {
                 userDropdownMenu.style.display = 'none';
                 userProfile?.setAttribute('aria-expanded', 'false');
                 userProfile?.classList.remove('open');
                 userProfile?.focus(); // Return focus to profile trigger
             }
        }
    });

    setupChatEventListeners(); // Setup listeners for chat input and send button
}

function populateProfileModal() {
    const modalElements = DOMElements.profileModal;
    if (!currentUser || !modalElements.modal) return;

    modalElements.avatar.src = currentUser.avatar || '/img/default-avatar.png';
    modalElements.name.textContent = currentUser.username || 'User';
    modalElements.deposited.textContent = `$${(currentUser.totalDepositedValue || 0).toFixed(2)}`;
    modalElements.won.textContent = `$${(currentUser.totalWinningsValue || 0).toFixed(2)}`;
    modalElements.tradeUrlInput.value = currentUser.tradeUrl || '';

    // Display pending deposit offer status in profile modal
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
    // Updated regex to be less strict, just checks for general format. Backend has stricter validation.
    const urlPattern = /^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?.*partner=\d+.*token=[a-zA-Z0-9_-]+.*/i;
    if (newTradeUrl && !urlPattern.test(newTradeUrl)) {
        showNotification('Invalid Steam Trade URL format. Ensure it includes partner and token parameters, or leave empty to clear.', 'error', 7000); return;
    }

    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
        const response = await fetch('/api/user/tradeurl', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tradeUrl: newTradeUrl }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || `Failed to save trade URL (${response.status})`);

        currentUser.tradeUrl = result.tradeUrl; // Use tradeUrl from response as backend might have cleaned it
        showNotification(newTradeUrl ? 'Trade URL saved successfully!' : 'Trade URL cleared successfully!', 'success');
        updateDepositButtonState(); // Update main deposit button status if trade URL was missing
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

    checkLoginStatus(); // Check if user is already logged in
    setupEventListeners(); // Setup all general event listeners
    setupSocketConnection(); // Initialize Socket.IO connection and event handlers

    showPage(DOMElements.pages.homePage); // Show home page by default
    initiateNewRoundVisualReset(); // Set initial state for jackpot UI

    if (!ageVerified && DOMElements.ageVerification.modal) {
        // If age not verified, show modal (unless login button is clicked, which also handles this)
        // This ensures if they land directly on site, they see it.
        // const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
        // if(ageCheckbox) ageCheckbox.checked = false;
        // if(ageAgreeButton) ageAgreeButton.disabled = true;
        // showModal(DOMElements.ageVerification.modal);
        // This might be redundant if login button is the only entry point that needs age check.
        // If direct access to game features is possible without login first, then this is needed.
    }

    updateChatUI(); // Initial chat UI setup
});

console.log("main.js updated with Winnings Modal and Winning History logic, and user requested fixes for issue 1 & 2.");
