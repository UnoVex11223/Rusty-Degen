// main.js - Rust Jackpot Frontend Logic (Modified) - Part 1 of 2
// Modifications:
// - Handles individual deposit entries instead of cumulative participant data.
// - Implements winner claim flow with a new "Accept Winnings" modal.
// - Shows unclaimed winnings in user profile.

const socket = io();

const CONFIG = {
    ROUND_DURATION: 99,
    MAX_ITEMS_PER_DEPOSIT: 20,         // Max items a user can select in the deposit modal at once
    MAX_DISPLAY_DEPOSITS_IN_POT: 25, // Max individual deposit blocks to show in the main pot view before potential truncation/scroll
    MAX_DEPOSITORS_DISPLAY_LIMIT: 20, // Corresponds to backend MAX_DEPOSITORS_PER_ROUND (unique users)
    MAX_TOTAL_DEPOSITS_ROUND_LIMIT: 50, // Corresponds to backend MAX_TOTAL_DEPOSITS_PER_ROUND (total deposit entries)
    MAX_ITEMS_PER_POT_FRONTEND: 200,   // Overall item limit in the pot
    ROULETTE_REPETITIONS: 20,
    SPIN_DURATION_SECONDS: 6.5,
    WINNER_DISPLAY_DURATION: 8000, // Increased slightly
    CONFETTI_COUNT: 150,
    EASE_OUT_POWER: 5,
    BOUNCE_ENABLED: false,
    BOUNCE_OVERSHOOT_FACTOR: 0.07,
    BOUNCE_DAMPING: 0.35,
    BOUNCE_FREQUENCY: 3.5,
    LANDING_POSITION_VARIATION: 0.60,
    MAX_CHAT_MESSAGES: 15,
    CHAT_SEND_COOLDOWN_MS: 2000,
    WON_ITEMS_DISPLAY_LIMIT: 10, // Max items to show directly in accept winnings modal before saying "+X more"
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
        unclaimedWinningsSection: document.getElementById('profile-unclaimed-winnings-section'),
        unclaimedWinningsList: document.getElementById('profileUnclaimedWinningsList'),
    },
    acceptWinningsModal: { // NEW
        modal: document.getElementById('acceptWinningsModal'),
        closeBtn: document.getElementById('closeAcceptWinningsModal'),
        roundIdSpan: document.getElementById('winningsRoundId'),
        totalValueSpan: document.getElementById('winningsTotalValue'),
        itemsContainer: document.getElementById('itemsWonContainer'),
        statusText: document.getElementById('acceptWinningsStatus'),
        tradeOfferLinkContainer: document.getElementById('winningsTradeOfferLinkContainer'),
        viewTradeOfferLink: document.getElementById('viewWinningsTradeOfferLink'),
        acceptButton: document.getElementById('acceptWinningsButton'),
        declineButton: document.getElementById('declineWinningsButton'),
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
        participantCount: document.getElementById('participantCount'), // Will show unique depositors
        totalPotItemsCountDisplay: document.getElementById('totalPotItemsCount'), // For total items in pot title
        depositsContainer: document.getElementById('itemsContainer'), // Renamed from participantsContainer in HTML for clarity
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
        winnerDeposit: document.getElementById('winnerDeposit'), // Value of the winning deposit entry
        winnerChance: document.getElementById('winnerChance'), // Chance from that winning deposit entry
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
let currentRound = null; // Will hold { roundId, status, timeLeft, depositsInRound, items, totalValue, uniqueDepositorsCount, totalDepositsCount etc. }
let selectedItemsList = []; // For deposit modal
let userInventory = [];     // For deposit modal
let isSpinning = false;
let timerActive = false;
let roundTimer = null;
let animationFrameId = null;
let userColorMap = new Map(); // For consistent user colors in UI
let notificationTimeout = null;
let spinStartTime = 0;
let currentDepositOfferURL = null; // For deposit modal
let onlineUserCount = 0;
let isChatSendOnCooldown = false;
let currentClaimingRecordId = null; // For accept winnings modal
let winningsModalQueue = []; // Queue for multiple win modals
let acceptWinningsModalVisible = false;

function showModal(modalElement) {
    if (modalElement) {
        modalElement.style.display = 'flex';
        if (modalElement === DOMElements.acceptWinningsModal.modal) {
            acceptWinningsModalVisible = true;
        }
    }
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
    if (modalElement === DOMElements.acceptWinningsModal.modal) {
        resetAcceptWinningsModal();
        acceptWinningsModalVisible = false;
        if (winningsModalQueue.length > 0) {
            const nextWin = winningsModalQueue.shift();
            populateAndShowAcceptWinningsModal(nextWin);
        }
    }
}
window.hideModal = hideModal; // Make accessible to inline HTML event handlers if any

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
    return userColorMap.get(userId) || '#cccccc'; // Fallback color
}

function showNotification(message, type = 'info', duration = 4000) {
    if (!DOMElements.notificationBar) {
        console.warn("Notification bar element (#notification-bar) not found. Using console.log as fallback.");
        console.log(`[${type.toUpperCase()}] ${message}`);
        return;
    }
    const bar = DOMElements.notificationBar;
    if (notificationTimeout) clearTimeout(notificationTimeout);
    bar.innerHTML = message; // Allow HTML in messages for links
    bar.className = 'notification-bar'; // Reset classes
    bar.classList.add(type);    // Add specific type class
    bar.classList.add('show');  // Trigger animation
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

function calculateBounce(t) { /* ... unchanged ... */ }
function getComplementaryColor(hex) { /* ... unchanged ... */ }
function lightenColor(hex, percent) { /* ... unchanged ... */ }
function darkenColor(hex, percent) { /* ... unchanged ... */ }


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
        // Clear profile-specific dynamic content
        if (DOMElements.profileModal.unclaimedWinningsList) DOMElements.profileModal.unclaimedWinningsList.innerHTML = '';
        if (DOMElements.profileModal.unclaimedWinningsSection) DOMElements.profileModal.unclaimedWinningsSection.style.display = 'none';

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
        depositStatusText.className = 'deposit-status-text'; // Reset class
    }
    currentDepositOfferURL = null;
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
                case 'completed': case 'error': title = 'Deposits closed (Round ended)'; break;
                case 'pending': title = 'Deposits closed (Waiting for round)'; break;
            }
        }
    } else if (currentRound.uniqueDepositorsCount >= CONFIG.MAX_DEPOSITORS_DISPLAY_LIMIT &&
               !currentRound.depositsInRound.some(d => d.user?._id === currentUser?._id || d.user?.id === currentUser?._id)) {
        // If user is NOT already a depositor and max unique depositors reached
        disabled = true;
        title = `Depositor limit (${CONFIG.MAX_DEPOSITORS_DISPLAY_LIMIT} unique users) reached.`;
    } else if (currentRound.totalDepositsCount >= CONFIG.MAX_TOTAL_DEPOSITS_ROUND_LIMIT) {
        disabled = true;
        title = `Maximum total deposits (${CONFIG.MAX_TOTAL_DEPOSITS_ROUND_LIMIT}) for this round reached.`;
    } else if (currentRound.items && currentRound.items.length >= CONFIG.MAX_ITEMS_PER_POT_FRONTEND) {
        disabled = true;
        title = `Pot item limit (${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}) reached`;
    } else if (typeof currentRound.timeLeft === 'number' && currentRound.timeLeft <= 0) {
        disabled = true;
        title = 'Deposits closed (Round ended/ending)';
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
            if (currentUser.unclaimedWinnings && currentUser.unclaimedWinnings.length > 0) {
                populateUnclaimedWinningsInProfile(currentUser.unclaimedWinnings);
                // Optionally, show a more prominent site-wide notification for first unclaimed win
                if (currentUser.unclaimedWinnings.some(uw => !localStorage.getItem(`notified_win_${uw.winningRecordId}`))) {
                    const firstNewUnclaimed = currentUser.unclaimedWinnings.find(uw => !localStorage.getItem(`notified_win_${uw.winningRecordId}`));
                    if (firstNewUnclaimed) {
                        showNotification(`You have unclaimed winnings from Round #${firstNewUnclaimed.roundDisplayId}! Check your Profile.`, 'success', 10000);
                        localStorage.setItem(`notified_win_${firstNewUnclaimed.winningRecordId}`, 'true');
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error checking login status:', error);
        currentUser = null;
        if (error.message && !error.message.includes("401") && !error.message.includes("403")) {
            showNotification(`Error checking login: ${error.message}`, 'error');
        }
    } finally {
        updateUserUI();
        updateChatUI();
        if (socket && socket.connected) {
            console.log("Requesting initial round data after checkLoginStatus.");
            socket.emit('requestRoundData');
        } else {
            console.warn("Socket not connected when checkLoginStatus finished. Round data request will occur on connect.");
            if (!currentRound) {
                updateTimerUI(CONFIG.ROUND_DURATION);
                updateDepositButtonState();
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
            const hasPendingDeposit = !!currentUser.pendingDepositOfferId;
            pendingOfferIndicator.style.display = hasPendingDeposit ? 'inline-block' : 'none';
             if (hasPendingDeposit) {
                 pendingOfferIndicator.title = `You have a pending deposit offer (#${currentUser.pendingDepositOfferId})! Click your profile to see details.`;
             }
        }
        // Update unclaimed winnings display in profile if modal elements are present
        if (DOMElements.profileModal.unclaimedWinningsSection) {
             populateUnclaimedWinningsInProfile(currentUser.unclaimedWinnings || []);
        }

    } else { // Not logged in
        loginButton.style.display = 'flex';
        userProfile.style.display = 'none';
        userProfile.setAttribute('aria-disabled', 'true');
        if (userDropdownMenu) userDropdownMenu.style.display = 'none';
        userProfile.setAttribute('aria-expanded', 'false');
        userProfile.classList.remove('open');
        if (pendingOfferIndicator) pendingOfferIndicator.style.display = 'none';
        // Clear profile modal dynamic content
        if (DOMElements.profileModal.unclaimedWinningsList) DOMElements.profileModal.unclaimedWinningsList.innerHTML = '';
        if (DOMElements.profileModal.unclaimedWinningsSection) DOMElements.profileModal.unclaimedWinningsSection.style.display = 'none';
        if (DOMElements.profileModal.pendingOfferStatus) DOMElements.profileModal.pendingOfferStatus.style.display = 'none';

    }
}

async function loadUserInventory() { /* ... mostly unchanged, ensure error messages are clear ... */
    const { inventoryItemsContainer, selectedItemsContainer, inventoryLoadingIndicator, totalValueDisplay } = DOMElements.deposit;
    if (!inventoryItemsContainer || !selectedItemsContainer || !inventoryLoadingIndicator || !totalValueDisplay) {
        console.error("Inventory DOM elements missing.");
        return;
    }

    resetDepositModalUI();
    selectedItemsList = [];
    if(selectedItemsContainer) selectedItemsContainer.innerHTML = '';
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
            } catch (e) { /* Ignore if parsing fails */ }
            if (response.status === 401 || response.status === 403) errorMsg = 'Please log in first.';
            throw new Error(errorMsg);
        }
        userInventory = await response.json();
        inventoryLoadingIndicator.style.display = 'none';

        if (!Array.isArray(userInventory)) throw new Error('Invalid inventory data received.');

        if (userInventory.length === 0) {
            inventoryItemsContainer.innerHTML = '<p class="empty-inventory-message">Your Rust inventory is empty, private, or there was an issue loading it. Please ensure your Steam inventory is set to public.</p>';
            return;
        }
        displayInventoryItems();
    } catch (error) {
        inventoryLoadingIndicator.style.display = 'none';
        inventoryItemsContainer.innerHTML = `<p class="error-message">Error loading inventory: ${error.message}</p>`;
        console.error('Error loading inventory:', error);
    }
}


function displayInventoryItems() { /* ... unchanged ... */ }
function toggleItemSelection(element, item) { /* ... unchanged ... */ }
function addSelectedItemElement(item) { /* ... unchanged ... */ }
function removeSelectedItemElement(assetId) { /* ... unchanged ... */ }
function removeSelectedItem(assetId) { /* ... unchanged ... */ }
function updateTotalValue() { /* ... unchanged ... */ }

async function requestDepositOffer() {
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit;
    if (!depositButton || !acceptDepositOfferBtn || !depositStatusText) return;

    if (selectedItemsList.length === 0) {
        showNotification('No Items Selected: Please select items first.', 'info');
        return;
    }
    const roundIsDepositable = currentRound && currentRound.status === 'active' && !isSpinning &&
                             (typeof currentRound.timeLeft === 'undefined' || currentRound.timeLeft > 0);

    if (!roundIsDepositable) {
        showNotification('Deposit Error: Deposits are currently closed for this round.', 'error');
        updateDepositButtonState();
        return;
    }
    if (currentUser?.pendingDepositOfferId) {
        showNotification('Deposit Error: You already have a pending deposit offer. Check your profile or Steam.', 'error');
        if (DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
        return;
    }

    // Re-check limits based on potentially updated currentRound data
    const currentUniqueDepositors = currentRound.uniqueDepositorsCount || 0;
    const isNewDepositorForRound = !currentRound.depositsInRound.some(d => d.user?._id === currentUser?._id || d.user?.id === currentUser?._id);

    if (isNewDepositorForRound && currentUniqueDepositors >= CONFIG.MAX_DEPOSITORS_DISPLAY_LIMIT) {
        showNotification(`Deposit Error: Depositor limit (${CONFIG.MAX_DEPOSITORS_DISPLAY_LIMIT} unique users) reached.`, 'error'); return;
    }
    if ((currentRound.totalDepositsCount || 0) >= CONFIG.MAX_TOTAL_DEPOSITS_ROUND_LIMIT) {
        showNotification(`Deposit Error: Maximum total deposits (${CONFIG.MAX_TOTAL_DEPOSITS_ROUND_LIMIT}) for this round reached.`, 'error'); return;
    }
    const itemsCurrentlyInPot = currentRound.items?.length || 0;
    if (itemsCurrentlyInPot + selectedItemsList.length > CONFIG.MAX_ITEMS_PER_POT_FRONTEND) {
        const slotsLeft = CONFIG.MAX_ITEMS_PER_POT_FRONTEND - itemsCurrentlyInPot;
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
            if (response.status === 409 && result.offerURL && result.offerId) { // Conflict - existing offer
                depositStatusText.textContent = `You already have a pending offer! Click 'Accept on Steam' to view it.`;
                depositStatusText.className = 'deposit-status-text warning';
                currentDepositOfferURL = result.offerURL;
                acceptDepositOfferBtn.style.display = 'inline-block';
                acceptDepositOfferBtn.disabled = false;
                depositButton.style.display = 'none';
                if (currentUser && !currentUser.pendingDepositOfferId) {
                    currentUser.pendingDepositOfferId = result.offerId;
                    updateUserUI(); // Reflect change in profile link/indicator
                    updateDepositButtonState();
                }
                return;
            } else {
                throw new Error(result.error || `Failed to create offer (${response.status})`);
            }
        } else if (!result.success || !result.offerURL || !result.offerId) {
            throw new Error(result.error || 'Backend did not return a valid offer URL and ID.');
        } else { // Success
            depositStatusText.textContent = "Offer created! Click 'Accept on Steam' below to complete.";
            depositStatusText.className = 'deposit-status-text success';
            currentDepositOfferURL = result.offerURL;
            depositButton.style.display = 'none';
            acceptDepositOfferBtn.style.display = 'inline-block';
            acceptDepositOfferBtn.disabled = false;
            if(currentUser) { // Update user object with pending offer ID
                currentUser.pendingDepositOfferId = result.offerId;
                updateUserUI();
                updateDepositButtonState();
            }
        }
    } catch (error) {
        console.error('Error requesting deposit offer:', error);
        depositStatusText.textContent = `Error: ${error.message}`;
        depositStatusText.className = 'deposit-status-text error';
        // Only reset UI fully if it's not a 409 (existing offer)
        if (!(response && response.status === 409)) {
            resetDepositModalUI(); // Enable depositButton etc.
        }
        // If it failed and user had a pending flag set by this attempt, clear it
        if (currentUser && currentUser.pendingDepositOfferId && !(response && response.status === 409)) {
            currentUser.pendingDepositOfferId = null;
            updateUserUI();
            updateDepositButtonState();
        }
    }
}

// main.js - Rust Jackpot Frontend Logic (Modified) - Part 2 of 2

function updateRoundUI() {
    const { potValue, participantCount, totalPotItemsCountDisplay } = DOMElements.jackpot;
    if (!potValue || !participantCount || !totalPotItemsCountDisplay) return;

    potValue.textContent = `$${(currentRound?.totalValue || 0).toFixed(2)}`;

    // Display unique depositors count and total number of deposit entries
    const uniqueDepositors = currentRound?.uniqueDepositorsCount || 0;
    const totalDepositsInRound = currentRound?.totalDepositsCount || 0;
    participantCount.textContent = `${uniqueDepositors}/${CONFIG.MAX_DEPOSITORS_DISPLAY_LIMIT}`;
    participantCount.title = `${uniqueDepositors} unique depositor(s), ${totalDepositsInRound} total deposit entries. Max unique: ${CONFIG.MAX_DEPOSITORS_DISPLAY_LIMIT}, Max total entries: ${CONFIG.MAX_TOTAL_DEPOSITS_ROUND_LIMIT}`;


    if (totalPotItemsCountDisplay) {
        totalPotItemsCountDisplay.textContent = currentRound?.items?.length || 0;
    }

    if (currentRound) {
        updateTimerUI(currentRound.timeLeft);
    } else {
        updateTimerUI(CONFIG.ROUND_DURATION);
    }
}


function updateTimerUI(timeLeftParam) {
    const { timerValue, timerForeground } = DOMElements.jackpot;
    if (!timerValue || !timerForeground) {
        console.error("Timer DOM elements not found in updateTimerUI.");
        return;
    }

    let timeLeftToConsider = (timeLeftParam === undefined && currentRound) ? currentRound.timeLeft : timeLeftParam;
    if (timeLeftToConsider === undefined) {
        timeLeftToConsider = (currentRound && currentRound.status === 'active' && (currentRound.uniqueDepositorsCount || 0) === 0) ? CONFIG.ROUND_DURATION : 0;
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
        const hasDepositors = (currentRound.uniqueDepositorsCount || 0) > 0;
        if ((timerActive && timeToShow > 0) || (!timerActive && timeToShow > 0 && hasDepositors)) {
            displayValue = timeToShow.toString();
        } else if (!timerActive && !hasDepositors) {
            displayValue = CONFIG.ROUND_DURATION.toString();
        } else {
            displayValue = "0";
        }
    } else if (!currentRound && timeLeftToConsider !== undefined) {
        displayValue = timeToShow.toString();
    } else {
        displayValue = "--";
    }

    timerValue.textContent = displayValue;
    updateTimerCircle(timeToShow, CONFIG.ROUND_DURATION);

    timerValue.classList.remove('urgent-pulse', 'timer-pulse');
    if (timerActive && timeToShow <= 10 && timeToShow > 0) {
        timerValue.classList.add('urgent-pulse');
    } else if (timerActive && timeToShow > 10) {
        // timerValue.classList.add('timer-pulse'); // Optional: less aggressive pulse for normal countdown
    }
}


function updateTimerCircle(timeLeft, totalTime) { /* ... unchanged ... */ }

function calculateOverallTotalTickets() {
    if (!currentRound || !currentRound.depositsInRound) return 0;
    return currentRound.depositsInRound.reduce((sum, depo) => sum + (depo.tickets || 0), 0);
}

function updateAllDepositEntryPercentages() {
    if (!currentRound || !currentRound.depositsInRound || currentRound.depositsInRound.length === 0) return;
    const container = DOMElements.jackpot.depositsContainer;
    if (!container) return;

    const depositBlocks = container.querySelectorAll('.player-deposit-container');
    const overallTotalTicketsInRound = calculateOverallTotalTickets();
    if (overallTotalTicketsInRound === 0) return; // Avoid division by zero

    depositBlocks.forEach(block => {
        const depositEntryId = block.dataset.depositEntryId; // Expecting this attribute on the block
        if (!depositEntryId) return;

        // Find the specific deposit entry in currentRound data
        const depositEntryData = currentRound.depositsInRound.find(depo => depo._id === depositEntryId);
        if (!depositEntryData || !depositEntryData.user) return;

        const userColor = getUserColor(depositEntryData.user._id || depositEntryData.user.id);
        const valueElement = block.querySelector('.player-deposit-value');
        const percentage = ((depositEntryData.tickets || 0) / overallTotalTicketsInRound) * 100;

        if (valueElement) {
            valueElement.textContent = `$${(depositEntryData.depositValue || 0).toFixed(2)} | ${percentage.toFixed(2)}%`;
            valueElement.title = `Deposited: $${(depositEntryData.depositValue || 0).toFixed(2)} | Chance for this entry: ${percentage.toFixed(2)}%`;
            valueElement.style.color = userColor;
        }
    });
}


function displayIndividualDeposit(depositEntryData) {
    const container = DOMElements.jackpot.depositsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (!container || !depositEntryData || !depositEntryData.user) return;

    const userId = depositEntryData.user._id || depositEntryData.user.id;
    const username = depositEntryData.user.username || 'Unknown User';
    const avatar = depositEntryData.user.avatar || '/img/default-avatar.png';
    const depositValue = depositEntryData.depositValue || 0;
    const itemsInThisDeposit = depositEntryData.depositedItems || [];
    const userColor = getUserColor(userId);

    // Calculate percentage for this specific deposit
    const overallTotalTickets = calculateOverallTotalTickets();
    const percentage = overallTotalTickets > 0 ? ((depositEntryData.tickets || 0) / overallTotalTickets) * 100 : 0;

    const depositContainer = document.createElement('div');
    depositContainer.dataset.userId = userId;
    depositContainer.dataset.depositEntryId = depositEntryData._id; // Store deposit entry ID
    depositContainer.className = 'player-deposit-container player-deposit-new'; // Add animation class

    const depositHeader = document.createElement('div');
    depositHeader.className = 'player-deposit-header';
    depositHeader.innerHTML = `
        <img src="${avatar}" alt="${username}" class="player-avatar" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-avatar.png';" style="border-color: ${userColor};">
        <div class="player-info">
            <div class="player-name" title="${username}">${username} (Entry)</div>
            <div class="player-deposit-value" style="color: ${userColor}" title="This Deposit: $${depositValue.toFixed(2)} | Chance: ${percentage.toFixed(2)}%">
                $${depositValue.toFixed(2)} | ${percentage.toFixed(2)}%
            </div>
        </div>`;

    const itemsGrid = document.createElement('div');
    itemsGrid.className = 'player-items-grid';
    if (itemsInThisDeposit.length > 0) {
        itemsInThisDeposit.sort((a, b) => (b.price || 0) - (a.price || 0)); // Sort items by price desc
        const displayItems = itemsInThisDeposit.slice(0, CONFIG.MAX_ITEMS_PER_DEPOSIT); // Show limited items directly

        displayItems.forEach(item => {
            if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.image) return;
            const itemElement = document.createElement('div');
            itemElement.className = 'player-deposit-item';
            itemElement.title = `${item.name} - $${item.price.toFixed(2)}`;
            itemElement.style.borderColor = userColor; // Use user's color for item border
            itemElement.innerHTML = `
                <img src="${item.image}" alt="${item.name}" class="player-deposit-item-image" loading="lazy"
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
        container.insertBefore(depositContainer, container.firstChild); // Add new deposits at the top
    } else {
        container.appendChild(depositContainer);
    }

    if (emptyMsg) emptyMsg.style.display = 'none';

    // Remove animation class after a short delay
    setTimeout(() => {
        depositContainer.classList.remove('player-deposit-new');
    }, 500);

    // Limit displayed deposit blocks
    const currentDepositBlocks = container.querySelectorAll('.player-deposit-container');
    if (currentDepositBlocks.length > CONFIG.MAX_DISPLAY_DEPOSITS_IN_POT) {
        const blocksToRemoveCount = currentDepositBlocks.length - CONFIG.MAX_DISPLAY_DEPOSITS_IN_POT;
        for (let i = 0; i < blocksToRemoveCount; i++) {
            const oldestBlock = container.querySelector('.player-deposit-container:last-child');
            if (oldestBlock && oldestBlock !== depositContainer) { // Don't remove the one just added
                oldestBlock.style.transition = 'opacity 0.3s ease-out';
                oldestBlock.style.opacity = '0';
                setTimeout(() => {
                    if (oldestBlock.parentNode === container) { // Check if still child before removing
                        oldestBlock.remove();
                    }
                }, 300);
            }
        }
    }
    // Play sound
    const depositSfx = DOMElements.audio.depositSound;
    if (depositSfx) {
        depositSfx.volume = 0.6;
        depositSfx.currentTime = 0;
        depositSfx.play().catch(e => console.error("Error playing deposit sound:", e));
    }
}


function handleNewDepositInRoundEvent(data) { // data is { roundId, depositEntry, totalPotValue, totalPotItemsCount, ... }
    if (!data || !data.roundId || !data.depositEntry || !data.depositEntry.user) {
        console.error("Invalid new deposit event data received:", data);
        return;
    }
    if (!currentRound) { // Should ideally not happen if roundData is received first
        console.warn("Handling new deposit but currentRound is null. Requesting full round data.");
        socket.emit('requestRoundData');
        return; // Wait for full round data
    }
    if (currentRound.roundId !== data.roundId) {
        console.warn(`New deposit received for wrong round (${data.roundId}). Current is ${currentRound.roundId}. Ignoring.`);
        return;
    }

    // Update local currentRound data
    currentRound.depositsInRound.push(data.depositEntry); // Add the new deposit entry
    currentRound.totalValue = data.totalPotValue;
    currentRound.items = currentRound.items || []; // Ensure items array exists
    data.depositEntry.depositedItems.forEach(newItem => { // Add items from this deposit to the flat list if not already there by assetId
        if (!currentRound.items.find(i => i.assetId === newItem.assetId && i.ownerSteamId === data.depositEntry.user.steamId)) { // A bit more specific check needed
            currentRound.items.push({ ...newItem, ownerSteamId: data.depositEntry.user.steamId, _id: new Date().getTime().toString() + Math.random() }); // Mock _id for client side items array
        }
    });
    currentRound.uniqueDepositorsCount = data.uniqueDepositorsCount;
    currentRound.totalDepositsCount = data.totalDepositsCount;


    // If this deposit is from the current logged-in user, clear their pending offer flag
    if (currentUser && (currentUser._id === data.depositEntry.user._id || currentUser.id === data.depositEntry.user._id) && currentUser.pendingDepositOfferId) {
       console.log(`Deposit processed for current user ${currentUser.username}, clearing local pending offer flag.`);
       currentUser.pendingDepositOfferId = null;
       updateUserUI(); // Update profile pending indicator
       updateDepositButtonState(); // Enable deposit button again
       if (DOMElements.deposit.depositModal?.style.display === 'flex') { // If deposit modal is open
           resetDepositModalUI();
           selectedItemsList = []; // Clear selection
           if(DOMElements.deposit.selectedItemsContainer) DOMElements.deposit.selectedItemsContainer.innerHTML = '';
           updateTotalValue(); // Reset total value display
           // Optionally hide the modal: hideModal(DOMElements.deposit.depositModal);
       }
    }

    displayIndividualDeposit(data.depositEntry);
    updateRoundUI(); // This will update pot value, depositor counts, and call updateTimerUI
    updateAllDepositEntryPercentages(); // Recalculate percentages for all displayed entries
    updateDepositButtonState();

    // Timer start logic (server dictates, but client can react visually if not already started)
    if (currentRound.status === 'active' && currentRound.uniqueDepositorsCount > 0 && !timerActive && currentRound.timeLeft > 0) {
        if (currentRound.timeLeft < CONFIG.ROUND_DURATION) { // If server has already started its timer
             startClientTimer(currentRound.timeLeft);
        } else if (currentRound.timeLeft === CONFIG.ROUND_DURATION) { // If server has not started its timer (e.g. first deposit)
            // The server should send a timerUpdate when its timer actually starts.
            // For now, the UI will show CONFIG.ROUND_DURATION.
        }
    }
}


function updateDepositsUIOnFullLoad() { // Called after receiving full 'roundData'
    const container = DOMElements.jackpot.depositsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (!container || !emptyMsg) return;

    container.innerHTML = ''; // Clear existing entries

    if (!currentRound || !currentRound.depositsInRound || currentRound.depositsInRound.length === 0) {
        if (!container.contains(emptyMsg)) container.appendChild(emptyMsg);
        emptyMsg.style.display = 'block';
    } else {
        emptyMsg.style.display = 'none';
        // Sort deposits if needed (e.g., by timestamp) - assuming backend sends them sorted or order doesn't matter for initial display
        currentRound.depositsInRound.forEach(depo => {
            displayIndividualDeposit(depo);
            const element = container.querySelector(`.player-deposit-container[data-deposit-entry-id="${depo._id}"]`);
            if (element) element.classList.remove('player-deposit-new'); // Remove animation class for initial load
        });
        updateAllDepositEntryPercentages();
    }
}


function startClientTimer(initialTime) { /* ... unchanged ... */ }


function createRouletteItems() {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer;
    if (!track || !container) { console.error("Roulette track or inline roulette element missing."); return; }

    track.innerHTML = '';
    track.style.transition = 'none';
    track.style.transform = 'translateX(0)';

    if (!currentRound || !currentRound.depositsInRound || currentRound.depositsInRound.length === 0) {
        console.error('No deposit entries available to create roulette items.');
        track.innerHTML = '<div class="roulette-message">Waiting for deposits...</div>';
        return;
    }

    let ticketPool = [];
    const totalTicketsInRound = calculateOverallTotalTickets();
    const targetVisualBlocks = 150; // Desired number of visual blocks on the roulette

    if (totalTicketsInRound <= 0) {
        // Fallback if no tickets (e.g., all $0.00 deposits, though ticket_value_ratio should handle this)
        // Create a pool based on number of deposits, giving each an equal chance visually
        console.warn("Total tickets in round is zero for roulette. Building based on deposit count.");
        currentRound.depositsInRound.forEach(depo => {
            const visualBlocks = Math.max(1, Math.ceil(targetVisualBlocks / currentRound.depositsInRound.length));
            for (let i = 0; i < visualBlocks; i++) ticketPool.push(depo); // Push the deposit entry itself
        });
    } else {
        currentRound.depositsInRound.forEach(depo => {
            const ticketsForThisDeposit = depo.tickets || 0;
            // Calculate visual blocks proportional to this deposit's tickets vs total tickets
            const visualBlocksForDeposit = Math.max(1, Math.ceil((ticketsForThisDeposit / totalTicketsInRound) * targetVisualBlocks));
            for (let i = 0; i < visualBlocksForDeposit; i++) {
                ticketPool.push(depo); // Push the deposit entry
            }
        });
    }

    if (ticketPool.length === 0) {
        console.error("Ticket pool calculation resulted in zero items for roulette.");
        track.innerHTML = '<div class="roulette-message">Error building roulette items.</div>';
        return;
    }

    ticketPool = shuffleArray([...ticketPool]); // Shuffle the visual blocks

    // Ensure enough items for smooth animation (padding before and after)
    const rouletteInnerContainer = container.querySelector('.roulette-container');
    const containerWidth = rouletteInnerContainer?.offsetWidth || container.offsetWidth || 1000;
    const itemWidthWithMargin = 90 + 10; // Assuming roulette-item width 90px + 5px margin each side
    const itemsInView = Math.ceil(containerWidth / itemWidthWithMargin);
    const itemsForSpinBuffer = Math.max(300, ticketPool.length * CONFIG.ROULETTE_REPETITIONS); // More repetitions if small pool
    const totalItemsNeededForAnimation = itemsForSpinBuffer + (itemsInView * 2); // Buffer for start and end
    const itemsToCreate = Math.max(totalItemsNeededForAnimation, 500); // Ensure a minimum number of items

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < itemsToCreate; i++) {
        const depositEntry = ticketPool[i % ticketPool.length]; // Cycle through the shuffled ticketPool
        if (!depositEntry || !depositEntry.user) {
            console.warn(`Skipping roulette item creation at index ${i} due to invalid deposit entry data.`);
            continue;
        }
        const userId = depositEntry.user._id || depositEntry.user.id;
        const userColor = getUserColor(userId);
        const avatar = depositEntry.user.avatar || '/img/default-avatar.png';

        const itemElement = document.createElement('div');
        itemElement.className = 'roulette-item';
        itemElement.dataset.userId = userId; // Store user ID
        itemElement.dataset.depositEntryId = depositEntry._id; // Store the ID of the specific deposit entry
        itemElement.style.borderColor = userColor;
        itemElement.innerHTML = `
            <img class="roulette-avatar" src="${avatar}" alt="${depositEntry.user.username || 'Participant'}" loading="lazy"
                 onerror="this.onerror=null; this.src='/img/default-avatar.png';" >`;
        fragment.appendChild(itemElement);
    }
    track.appendChild(fragment);
}


function handleWinnerAnnouncement(data) { // data is from 'roundWinner' socket event
    if (isSpinning) {
        console.warn("Received winner announcement but animation is already spinning.");
        return;
    }
    if (!currentRound || !currentRound.depositsInRound || currentRound.depositsInRound.length === 0) {
        console.error("Missing round/deposit data for winner announcement. Requesting fresh data.");
        socket.emit('requestRoundData'); // Request full data to rebuild state
        // Schedule a retry or handle gracefully if data doesn't arrive
        setTimeout(() => {
            if (currentRound?.depositsInRound?.length > 0) {
                handleWinnerAnnouncement(data); // Retry with potentially updated data
            } else {
                console.error("Still no deposit data after requesting. Cannot start spin.");
                resetToJackpotView();
            }
        }, 1500);
        return;
    }

    const winnerUserDetails = data.winner; // { id, steamId, username, avatar }
    // The actual winningDepositEntryId should come from the server's 'roundWinner' or 'roundData' if completed
    const winningDepositEntryIdFromServer = data.winningDepositEntryId || currentRound?.winningDepositEntryId;

    if (!winnerUserDetails || !winnerUserDetails.id) {
        console.error("Invalid winner user details received in announcement:", data);
        resetToJackpotView();
        return;
    }
    if (!winningDepositEntryIdFromServer) {
        console.error("Winning Deposit Entry ID not found in winner announcement data:", data);
        // Fallback: try to find *any* deposit by this winner if ID is missing, though this is not ideal for fairness proof
    }


    console.log(`Winner announced: ${winnerUserDetails.username}. Preparing roulette...`);
    timerActive = false; if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
    if (currentRound) currentRound.status = 'rolling';
    updateTimerUI(0); // Show "Rolling"
    updateDepositButtonState(); // Disable deposits

    switchToRouletteView();
    setTimeout(() => {
        // Pass both general winner user details and the specific winning deposit entry ID
        startRouletteAnimation(winnerUserDetails, winningDepositEntryIdFromServer);
    }, 500); // Delay to allow view switch animation
}

function switchToRouletteView() { /* ... unchanged ... */ }


function startRouletteAnimation(winnerUserDetails, winningDepositEntryId) {
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }

    if (!winnerUserDetails || !winnerUserDetails.id || !winningDepositEntryId) {
        console.error("Invalid winner data or winning deposit entry ID passed to startRouletteAnimation.");
        resetToJackpotView(); return;
    }

    isSpinning = true; updateDepositButtonState(); spinStartTime = 0;
    if (DOMElements.roulette.winnerInfoBox) DOMElements.roulette.winnerInfoBox.style.display = 'none';
    clearConfetti();
    createRouletteItems(); // This now uses depositsInRound

    // Find the corresponding full deposit entry data from currentRound for display details
    const winningDepositEntryData = currentRound?.depositsInRound?.find(depo => depo._id === winningDepositEntryId);

    if (!winningDepositEntryData) {
        console.error(`Could not find full details for winning deposit entry ID: ${winningDepositEntryId}.`);
        // Fallback: Use general winner user details, but deposit-specific info will be missing
        // This situation should be rare if data is consistent.
    }

    const sound = DOMElements.audio.spinSound;
    if (sound) {
        sound.volume = 0.7; sound.currentTime = 0; sound.playbackRate = 1.0;
        sound.play().catch(e => console.error('Error playing spin sound:', e));
    }

    setTimeout(() => { // Small delay for items to render
        const track = DOMElements.roulette.rouletteTrack;
        const itemsOnTrack = track?.querySelectorAll('.roulette-item');
        if (!track || !itemsOnTrack || itemsOnTrack.length === 0) {
            console.error('Cannot spin, no items rendered on track.');
            isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
        }

        // Find a roulette item that corresponds to the winningDepositEntryId
        const minIndexPercent = 0.65, maxIndexPercent = 0.85; // Target landing zone
        const minIndex = Math.floor(itemsOnTrack.length * minIndexPercent);
        const maxIndex = Math.floor(itemsOnTrack.length * maxIndexPercent);

        let possibleWinningElementsIndices = [];
        for (let i = minIndex; i <= maxIndex; i++) {
            if (itemsOnTrack[i]?.dataset?.depositEntryId === winningDepositEntryId) {
                possibleWinningElementsIndices.push(i);
            }
        }
        // If no winning item in the preferred zone, search entire track (less ideal for visual)
        if (possibleWinningElementsIndices.length === 0) {
            console.warn(`Winning deposit entry ${winningDepositEntryId} not found in preferred roulette zone. Searching all items.`);
            for (let i = 0; i < itemsOnTrack.length; i++) {
                 if (itemsOnTrack[i]?.dataset?.depositEntryId === winningDepositEntryId) {
                    possibleWinningElementsIndices.push(i);
                 }
            }
        }

        let targetLandingElement;
        if (possibleWinningElementsIndices.length > 0) {
            // Pick a random one from the found indices
            targetLandingElement = itemsOnTrack[possibleWinningElementsIndices[Math.floor(Math.random() * possibleWinningElementsIndices.length)]];
        } else {
            // Absolute fallback: if the winning deposit entry is somehow not on the track (should not happen)
            // Land on an item representing the winner's user ID, or a random item.
            console.error(`CRITICAL: Winning deposit entry ID ${winningDepositEntryId} not represented on roulette track. Landing on a fallback.`);
            let fallbackIndices = [];
            for (let i = minIndex; i <= maxIndex; i++) {
                if (itemsOnTrack[i]?.dataset?.userId === winnerUserDetails.id) fallbackIndices.push(i);
            }
            if (fallbackIndices.length === 0) fallbackIndices = Array.from(Array(itemsOnTrack.length).keys()); // All items
            const fallbackTargetIndex = fallbackIndices.length > 0 ? fallbackIndices[Math.floor(Math.random() * fallbackIndices.length)] : Math.floor(itemsOnTrack.length * 0.75);
            targetLandingElement = itemsOnTrack[Math.max(0, Math.min(itemsOnTrack.length - 1, fallbackTargetIndex))];
        }

        if (!targetLandingElement) {
             console.error("Could not determine a target landing element for roulette.");
             isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
        }

        handleRouletteSpinAnimation(targetLandingElement, winnerUserDetails, winningDepositEntryData);
    }, 100);
}


function handleRouletteSpinAnimation(winningElement, winnerUserDetails, winningDepositEntryData) {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer?.querySelector('.roulette-container');
    if (!winningElement || !track || !container) {
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }
    // ... (rest of animation calculation logic is the same as before) ...
    const containerWidth = container.offsetWidth;
    const itemWidth = winningElement.offsetWidth || 90; // Use actual or default
    const itemOffsetLeft = winningElement.offsetLeft; // Position of the target item within the track
    const centerOffset = (containerWidth / 2) - (itemWidth / 2); // Center of the viewport minus half item width
    const perfectCenterScrollPosition = -(itemOffsetLeft - centerOffset); // Scroll needed to bring item's left edge to where it would be centered

    // Add random variation to landing position for visual effect
    const initialVariation = (Math.random() * 2 - 1) * (itemWidth * CONFIG.LANDING_POSITION_VARIATION);
    const maxAllowedAbsVariation = itemWidth * 0.49; // Ensure it mostly lands on the target item
    let finalVariation = (Math.abs(initialVariation) <= maxAllowedAbsVariation) ? initialVariation : Math.sign(initialVariation) * maxAllowedAbsVariation;
    const targetScrollPosition = perfectCenterScrollPosition + finalVariation;
    const finalTargetPosition = targetScrollPosition;

    const startPosition = parseFloat(track.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1] || '0');
    const duration = CONFIG.SPIN_DURATION_SECONDS * 1000;
    const bounceDuration = CONFIG.BOUNCE_ENABLED ? 1200 : 0; // Example bounce duration
    const totalAnimationTime = duration + bounceDuration;
    const totalDistance = finalTargetPosition - startPosition;
    const overshootAmount = totalDistance * CONFIG.BOUNCE_OVERSHOOT_FACTOR; // For bounce effect

    let startTime = performance.now(); spinStartTime = startTime;
    track.style.transition = 'none'; // Ensure CSS transitions are off for JS animation

    function animateRoulette(timestamp) {
        if (!isSpinning) { // Check if spin was cancelled
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            animationFrameId = null; return;
        }
        const elapsed = timestamp - startTime;
        let currentPosition, animationFinished = false;

        if (elapsed <= duration) { // Main easing phase
            const animationPhaseProgress = elapsed / duration;
            const easedProgress = easeOutAnimation(animationPhaseProgress);
            currentPosition = startPosition + totalDistance * easedProgress;
        } else if (CONFIG.BOUNCE_ENABLED && elapsed <= totalAnimationTime) { // Bounce phase
            const bouncePhaseProgress = (elapsed - duration) / bounceDuration;
            const bounceDisplacementFactor = calculateBounce(bouncePhaseProgress); // Your bounce function
            currentPosition = finalTargetPosition - (overshootAmount * bounceDisplacementFactor);
        } else { // Animation complete
            currentPosition = finalTargetPosition;
            animationFinished = true;
        }

        track.style.transform = `translateX(${currentPosition}px)`;

        if (!animationFinished) {
            animationFrameId = requestAnimationFrame(animateRoulette);
        } else {
            animationFrameId = null;
            finalizeSpin(winningElement, winnerUserDetails, winningDepositEntryData); // Pass all data
        }
    }
    if (animationFrameId) cancelAnimationFrame(animationFrameId); // Clear any existing frame
    animationFrameId = requestAnimationFrame(animateRoulette);
}


function finalizeSpin(winningElement, winnerUserDetails, winningDepositEntryData) {
    if ((!isSpinning && winningElement?.classList.contains('winner-highlight')) || !winningElement || !winnerUserDetails?.id) {
        if (isSpinning) { isSpinning = false; updateDepositButtonState(); resetToJackpotView(); }
        return;
    }
    const winnerId = winnerUserDetails.id;
    const userColor = getUserColor(winnerId);
    winningElement.classList.add('winner-highlight');
    // ... (rest of winner pulse styling is the same as before) ...
    const styleId = 'winner-pulse-style';
    document.getElementById(styleId)?.remove(); // Remove old style if exists
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        .winner-highlight {
            z-index: 5; border-width: 3px; border-color: ${userColor};
            animation: winnerPulse 1.5s infinite; --winner-color: ${userColor};
            transform: scale(1.05); /* Keep it slightly scaled */
        }
        @keyframes winnerPulse {
            0%, 100% { box-shadow: 0 0 15px var(--winner-color); transform: scale(1.05); }
            50% { box-shadow: 0 0 25px var(--winner-color), 0 0 10px var(--winner-color); transform: scale(1.1); }
        }`;
    document.head.appendChild(style);

    setTimeout(() => {
        handleSpinEnd(winnerUserDetails, winningDepositEntryData); // Pass all data
    }, 300); // Short delay before showing winner info box
}


function handleSpinEnd(winnerUserDetails, winningDepositEntryData) {
    if (!winnerUserDetails?.id) { // Check only user details as entry data might be sparse in fallback
        if (!isSpinning) return;
        isSpinning = false; updateDepositButtonState(); resetToJackpotView();
        return;
    }
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }

    const { winnerInfoBox, winnerAvatar, winnerName, winnerDeposit, winnerChance } = DOMElements.roulette;
    if (winnerInfoBox && winnerAvatar && winnerName && winnerDeposit && winnerChance) {
        const winnerId = winnerUserDetails.id;
        const userColor = getUserColor(winnerId);

        winnerAvatar.src = winnerUserDetails.avatar || '/img/default-avatar.png';
        winnerAvatar.alt = winnerUserDetails.username || 'Winner';
        winnerAvatar.style.borderColor = userColor;
        winnerAvatar.style.boxShadow = `0 0 15px ${userColor}`;

        winnerName.textContent = winnerUserDetails.username || 'Winner';
        winnerName.style.color = userColor;

        let depositValueStr = "$?.??";
        let chanceValueStr = "?.??%";

        if (winningDepositEntryData) { // If we have the specific winning deposit's data
            depositValueStr = `$${(winningDepositEntryData.depositValue || 0).toFixed(2)}`;
            const overallTotalTickets = calculateOverallTotalTickets();
            const chance = overallTotalTickets > 0 ? ((winningDepositEntryData.tickets || 0) / overallTotalTickets) * 100 : 0;
            chanceValueStr = `${chance.toFixed(2)}%`;
        } else {
            // Fallback if specific winning deposit entry data wasn't found earlier
            console.warn("Displaying winner info without specific deposit entry details.");
        }

        winnerDeposit.textContent = ''; // Clear for typing effect
        winnerChance.textContent = '';  // Clear for typing effect

        winnerInfoBox.style.display = 'flex';
        winnerInfoBox.style.opacity = '0';
        winnerInfoBox.style.animation = 'fadeIn 0.5s ease forwards';

        // Typing effect for deposit and chance
        setTimeout(() => {
            let depositIndex = 0; let chanceIndex = 0; const typeDelay = 35;
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
                            // Actions after all typing is done
                            setTimeout(() => { launchConfetti(userColor); }, 200);
                            isSpinning = false;
                            updateDepositButtonState();
                            // Winner claim modal will be shown by 'youWonRoundDetails' event if user is the winner
                            setTimeout(resetToJackpotView, CONFIG.WINNER_DISPLAY_DURATION);
                        }
                    }, typeDelay);
                }
            }, typeDelay);
        }, 500); // Delay before starting typing effect

    } else { // Fallback if UI elements are missing
        isSpinning = false;
        updateDepositButtonState();
        resetToJackpotView();
    }
}


function launchConfetti(mainColor = '#00e676') { /* ... unchanged ... */ }
function clearConfetti() { /* ... unchanged ... */ }

function resetToJackpotView() {
    console.log("Resetting to jackpot view...");
    // ... (clear intervals, flags - mostly same as before) ...
    if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null;
    if (window.soundFadeInInterval) clearInterval(window.soundFadeInInterval); window.soundFadeInInterval = null;
    if (window.soundFadeOutInterval) clearInterval(window.soundFadeOutInterval); window.soundFadeOutInterval = null;
    if (window.typeDepositInterval) clearInterval(window.typeDepositInterval); window.typeDepositInterval = null;
    if (window.typeChanceInterval) clearInterval(window.typeChanceInterval); window.typeChanceInterval = null;

    if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
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

    setTimeout(() => {
        header.classList.remove('roulette-mode');
        track.style.transition = 'none'; track.style.transform = 'translateX(0)'; track.innerHTML = '';
        rouletteContainer.style.display = 'none';
        winnerInfoBox.style.display = 'none'; winnerInfoBox.style.opacity = ''; winnerInfoBox.style.animation = '';

        const valueDisplay = header.querySelector('.jackpot-value');
        const timerDisplayElement = header.querySelector('.jackpot-timer'); // Renamed to avoid conflict
        const statsDisplay = header.querySelector('.jackpot-stats');
        [valueDisplay, timerDisplayElement, statsDisplay].forEach((el, index) => {
            if (el) {
                const computedStyle = window.getComputedStyle(el);
                el.style.display = computedStyle.display !== 'none' ? computedStyle.display : 'flex'; // Or appropriate default
                el.style.opacity = '0'; // Start from transparent
                setTimeout(() => { // Staggered fade-in
                    el.style.transition = 'opacity 0.5s ease';
                    el.style.opacity = '1';
                }, 50 + index * 50);
            }
        });

        initiateNewRoundVisualReset(); // Reset visual elements for a new round
        updateDepositButtonState();
        if (socket?.connected) {
            console.log("Requesting round data after resetToJackpotView.");
            socket.emit('requestRoundData'); // Get fresh data for the new/pending round
        }
    }, 500); // Duration of fade-out animations
}


function initiateNewRoundVisualReset() {
    console.log("Initiating visual reset for new round display.");
    if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
    timerActive = false;
    updateTimerUI(CONFIG.ROUND_DURATION);
    if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.classList.remove('urgent-pulse', 'timer-pulse');

    const container = DOMElements.jackpot.depositsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (container && emptyMsg) {
        container.innerHTML = ''; // Clear all deposit entries
        if (!container.contains(emptyMsg)) container.appendChild(emptyMsg); // Ensure empty message is there
        emptyMsg.style.display = 'block';
    }

    if (DOMElements.jackpot.potValue) DOMElements.jackpot.potValue.textContent = "$0.00";
    if (DOMElements.jackpot.participantCount) DOMElements.jackpot.participantCount.textContent = `0/${CONFIG.MAX_DEPOSITORS_DISPLAY_LIMIT}`; // Reset unique depositors count
    if (DOMElements.jackpot.totalPotItemsCountDisplay) DOMElements.jackpot.totalPotItemsCountDisplay.textContent = "0";


    userColorMap.clear(); // Clear user color mapping for the new round
    updateDepositButtonState();
}


function findWinnerFromData(winnerData) { /* Not strictly needed if server sends winningDepositEntryId */ return null; }
async function verifyRound() { /* ... unchanged ... */ }
async function loadPastRounds(page = 1) { /* ... unchanged ... */ }
window.populateVerificationFields = function(roundId, serverSeed, clientSeed) { /* ... unchanged ... */ };
function createPagination(currentPage, totalPages) { /* ... unchanged ... */ }
async function showWinningHistory() { /* ... unchanged ... */ }
function populateWinningHistoryTable(winnings) { /* ... unchanged ... */ }
function updateChatUI() { /* ... unchanged ... */ }
function displayChatMessage(messageData, isInitialLoad = false) { /* ... unchanged ... */ }
function handleSendMessage() { /* ... unchanged ... */ }
function setupChatEventListeners() { /* ... unchanged ... */ }
function updateChatOnlineUsers(count) { /* ... unchanged ... */ }

// --- NEW/MODIFIED for Winner Claim Flow ---
function resetAcceptWinningsModal() {
    const modalElements = DOMElements.acceptWinningsModal;
    if (!modalElements.modal) return;

    modalElements.roundIdSpan.textContent = 'N/A';
    modalElements.totalValueSpan.textContent = '0.00';
    modalElements.itemsContainer.innerHTML = '<p>Loading items...</p>';
    modalElements.statusText.textContent = '';
    modalElements.statusText.className = 'accept-winnings-status-text';
    modalElements.acceptButton.disabled = false;
    modalElements.acceptButton.textContent = 'Claim Your Items!';
    modalElements.tradeOfferLinkContainer.style.display = 'none';
    modalElements.viewTradeOfferLink.href = '#';
    currentClaimingRecordId = null;
}

function populateAndShowAcceptWinningsModal(data) { // data from 'youWonRoundDetails'
    const modalElements = DOMElements.acceptWinningsModal;
    if (!modalElements.modal || !currentUser) {
        console.error("Accept Winnings Modal or current user not found.");
        return;
    }
    if (acceptWinningsModalVisible) {
        winningsModalQueue.push(data);
        return;
    }
    resetAcceptWinningsModal(); // Reset before populating

    currentClaimingRecordId = data.winningRecordId;
    modalElements.roundIdSpan.textContent = data.roundId || 'N/A';
    modalElements.totalValueSpan.textContent = (data.amountWon || 0).toFixed(2);

    modalElements.itemsContainer.innerHTML = ''; // Clear previous items
    if (data.itemsWon && data.itemsWon.length > 0) {
        const itemsFragment = document.createDocumentFragment();
        data.itemsWon.slice(0, CONFIG.WON_ITEMS_DISPLAY_LIMIT).forEach(item => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'won-item'; // Use class from HTML example, style in CSS
            itemDiv.innerHTML = `
                <img src="${item.image || '/img/default-item.png'}" alt="${item.name || 'Item'}" 
                     onerror="this.onerror=null; this.src='/img/default-item.png';">
                <div class="won-item-details">
                    <span class="won-item-name">${item.name || 'Unknown Item'}</span>
                    <span class="won-item-price">$${(item.price || 0).toFixed(2)}</span>
                </div>`;
            itemsFragment.appendChild(itemDiv);
        });
        if (data.itemsWon.length > CONFIG.WON_ITEMS_DISPLAY_LIMIT) {
            const moreItemsP = document.createElement('p');
            moreItemsP.textContent = `+ ${data.itemsWon.length - CONFIG.WON_ITEMS_DISPLAY_LIMIT} more items.`;
            moreItemsP.style.textAlign = 'center';
            itemsFragment.appendChild(moreItemsP);
        }
        modalElements.itemsContainer.appendChild(itemsFragment);
    } else {
        modalElements.itemsContainer.innerHTML = '<p>No specific item details available (or all items were taxed).</p>';
    }
    showModal(modalElements.modal);
}

async function handleClaimWinnings() {
    const modalElements = DOMElements.acceptWinningsModal;
    if (!currentClaimingRecordId || !modalElements.modal) {
        showNotification("Error: No winning record ID found to claim.", "error");
        return;
    }

    modalElements.acceptButton.disabled = true;
    modalElements.acceptButton.textContent = 'Claiming...';
    modalElements.statusText.textContent = 'Processing your claim, please wait...';
    modalElements.statusText.className = 'accept-winnings-status-text info';

    try {
        const response = await fetch(`/api/winnings/claim/${currentClaimingRecordId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || `Failed to claim winnings (Status: ${response.status})`);
        }

        if (result.success && result.data) {
            modalElements.statusText.textContent = result.data.message || 'Trade offer successfully initiated! Check Steam.';
            modalElements.statusText.className = 'accept-winnings-status-text success';
            modalElements.acceptButton.style.display = 'none'; // Hide claim button

            if (result.data.offerURL) {
                modalElements.viewTradeOfferLink.href = result.data.offerURL;
                modalElements.tradeOfferLinkContainer.style.display = 'block';
            }
            // Update user object if it has unclaimedWinnings array
            if (currentUser && currentUser.unclaimedWinnings) {
                currentUser.unclaimedWinnings = currentUser.unclaimedWinnings.filter(uw => uw.winningRecordId !== currentClaimingRecordId);
                populateUnclaimedWinningsInProfile(currentUser.unclaimedWinnings); // Refresh profile display
            }
        } else {
             throw new Error(result.error || 'Claim processed but no offer details returned.');
        }

    } catch (error) {
        console.error('Error claiming winnings:', error);
        modalElements.statusText.textContent = `Error: ${error.message}`;
        modalElements.statusText.className = 'accept-winnings-status-text error';
        modalElements.acceptButton.disabled = false; // Re-enable for retry if appropriate
        modalElements.acceptButton.textContent = 'Try Claiming Again';
    }
}

function populateUnclaimedWinningsInProfile(unclaimedWinningsArray) {
    const section = DOMElements.profileModal.unclaimedWinningsSection;
    const listContainer = DOMElements.profileModal.unclaimedWinningsList;

    if (!section || !listContainer) return;

    listContainer.innerHTML = ''; // Clear previous
    if (unclaimedWinningsArray && unclaimedWinningsArray.length > 0) {
        section.style.display = 'block';
        unclaimedWinningsArray.forEach(win => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'unclaimed-win-item'; // Style this class in CSS
            itemDiv.innerHTML = `
                <p>Round #${win.roundDisplayId || 'N/A'} - Won ~$${(win.amountWon || 0).toFixed(2)}
                   <small>(${new Date(win.timestamp || win.createdAt).toLocaleDateString()})</small>
                </p>
                <button class="btn btn-small btn-primary claim-from-profile-btn" data-record-id="${win.winningRecordId || win._id}">
                    Claim Now <i class="fas fa-gift"></i>
                </button>
            `;
            itemDiv.querySelector('.claim-from-profile-btn').addEventListener('click', (e) => {
                const recordId = e.target.closest('button').dataset.recordId;
                // Find the full win details (items etc.) to populate the main modal
                const fullWinData = currentUser?.unclaimedWinnings?.find(uw => (uw.winningRecordId || uw._id) === recordId) ||
                                    currentUser?.allWinningsData?.find(uw => (uw.winningRecordId || uw._id) === recordId); // Assuming allWinningsData might be stored if needed

                if (fullWinData) { // fullWinData should match structure expected by populateAndShowAcceptWinningsModal
                    populateAndShowAcceptWinningsModal({
                        winningRecordId: recordId,
                        roundId: fullWinData.roundDisplayId,
                        amountWon: fullWinData.amountWon,
                        itemsWon: fullWinData.itemsWon || fullWinData.itemsWonDetails || [] // Adapt based on what's available
                    });
                    hideModal(DOMElements.profileModal.modal); // Close profile modal
                } else {
                    showNotification("Could not find details for this win. Please try refreshing.", "error");
                }
            });
            listContainer.appendChild(itemDiv);
        });
    } else {
        section.style.display = 'none';
    }
}


function setupSocketConnection() {
    socket.on('connect', () => { /* ... unchanged ... */ });
    socket.on('timerUpdate', (data) => { /* ... unchanged ... */ });

    socket.on('roundData', (data) => {
        console.log('Received initial/updated round data:', data);
        if (!data || typeof data !== 'object') {
            console.error("Invalid round data received from server.");
            showNotification('Error syncing with server.', 'error');
            currentRound = null;
            initiateNewRoundVisualReset();
            return;
        }

        currentRound = data; // This now includes depositsInRound, uniqueDepositorsCount, totalDepositsCount
        isSpinning = (currentRound.status === 'rolling' || (currentRound.status === 'completed' && currentRound.winner));
        updateRoundUI(); // Updates pot value, depositor counts, and timer
        updateDepositsUIOnFullLoad(); // Clears and re-renders all deposit entries based on new structure

        if (currentRound.status === 'active') {
            // Timer logic based on uniqueDepositorsCount and timeLeft
            const hasDepositors = (currentRound.uniqueDepositorsCount || 0) > 0;
            if (hasDepositors && typeof currentRound.timeLeft === 'number' && currentRound.timeLeft > 0) {
                if (!timerActive || (roundTimer === null)) {
                     startClientTimer(currentRound.timeLeft);
                }
            } else if (!hasDepositors && timerActive) {
                clearInterval(roundTimer); roundTimer = null; timerActive = false;
                updateTimerUI(CONFIG.ROUND_DURATION);
            } else if (typeof currentRound.timeLeft === 'number' && currentRound.timeLeft <= 0 && timerActive) {
                clearInterval(roundTimer); roundTimer = null; timerActive = false;
                updateTimerUI(0);
            } else if (!hasDepositors) {
                 timerActive = false; if(roundTimer) clearInterval(roundTimer); roundTimer = null;
                 updateTimerUI(CONFIG.ROUND_DURATION);
            }
        } else if (['pending', 'completed', 'error', 'rolling'].includes(currentRound.status)) {
            if (timerActive || roundTimer) {
                clearInterval(roundTimer); roundTimer = null; timerActive = false;
            }
            if (currentRound.status === 'rolling' || (currentRound.status === 'completed' && currentRound.winner && !isSpinning)) {
                handleWinnerAnnouncement(currentRound); // Pass the full round data
            } else if (currentRound.status === 'pending'){
                 initiateNewRoundVisualReset();
            } else { // Completed without winner yet shown, or error
                updateTimerUI(0); // Show "Ended" or similar
            }
        }
        updateDepositButtonState();
    });

    socket.on('roundCreated', (data) => {
        console.log('New round created by server:', data);
        currentRound = data; // Store the new round data
        resetToJackpotView(); // This visually resets the jackpot area and requests fresh round data
        // It calls initiateNewRoundVisualReset() internally.
    });

    // NEW event for individual deposits
    socket.on('newDepositInRound', (data) => { // data: { roundId, depositEntry, totalPotValue, ... }
        console.log('New deposit received:', data);
        handleNewDepositInRoundEvent(data);
    });

    // Replaces 'participantUpdated'
    // socket.on('participantUpdated', (data) => { /* REMOVE or adapt if still used for other things */ });


    socket.on('roundRolling', (data) => { /* ... unchanged ... */ });

    socket.on('roundWinner', (data) => { // data: { roundId, winner: {id, username, avatar}, winningTicket, totalValue, serverSeed, clientSeed, provableHash, serverSeedHash, winningDepositEntryId }
        if (currentRound && currentRound.roundId === data.roundId) {
            if (!currentRound.winner) currentRound.winner = data.winner; // Store winner details
            currentRound.winningDepositEntryId = data.winningDepositEntryId; // Store winning deposit ID
            currentRound.status = 'rolling'; // Ensure status reflects rolling if not already
            handleWinnerAnnouncement(data); // Pass all received winner data
        }
    });

    // NEW: Listen for specific winner details to claim
    socket.on('youWonRoundDetails', (data) => { // data: { winningRecordId, roundId, amountWon, itemsWon }
        if (currentUser && (currentUser._id === data.winnerIdFromBackend || currentRound?.winner?.id === currentUser._id)) {
            console.log("Received 'youWonRoundDetails', populating claim modal:", data);
            currentUser.unclaimedWinnings = currentUser.unclaimedWinnings || [];
            if (!currentUser.unclaimedWinnings.find(w => w.winningRecordId === data.winningRecordId)) {
                currentUser.unclaimedWinnings.push({
                    winningRecordId: data.winningRecordId,
                    roundDisplayId: data.roundId,
                    amountWon: data.amountWon,
                    itemsWon: data.itemsWon,
                    timestamp: Date.now()
                });
                populateUnclaimedWinningsInProfile(currentUser.unclaimedWinnings);
            }
            populateAndShowAcceptWinningsModal(data);
        }
    });
     socket.on('unclaimedWinningsNotification', (unclaimedWinnings) => {
        if (currentUser && unclaimedWinnings && unclaimedWinnings.length > 0) {
            console.log("Received unclaimed winnings notification:", unclaimedWinnings);
            currentUser.unclaimedWinnings = unclaimedWinnings; // Update local cache
            populateUnclaimedWinningsInProfile(unclaimedWinnings);
            // Optionally, show a general notification that they have claims pending in profile
            showNotification(`You have ${unclaimedWinnings.length} unclaimed past winnings! Check your Profile.`, 'info', 8000);
        }
    });


    socket.on('roundCompleted', (data) => { /* ... unchanged ... */ });
    socket.on('roundError', (data) => { /* ... unchanged ... */ });
    socket.on('tradeOfferSent', (data) => {
        console.log('tradeOfferSent event:', data);
        if (!currentUser || (data.userId && data.userId !== currentUser._id && data.userId !== currentUser.id)) {
            return;
        }

        const modalElements = DOMElements.acceptWinningsModal;
        if (!modalElements.modal) return;

        // Remove from unclaimed winnings list if present
        if (currentUser.unclaimedWinnings) {
            currentUser.unclaimedWinnings = currentUser.unclaimedWinnings.filter(uw => uw.winningRecordId !== data.winningRecordId);
            populateUnclaimedWinningsInProfile(currentUser.unclaimedWinnings);
        }

        const sameRecord = currentClaimingRecordId && data.winningRecordId === currentClaimingRecordId;

        if (!acceptWinningsModalVisible || !sameRecord) {
            resetAcceptWinningsModal();
            currentClaimingRecordId = data.winningRecordId;
            modalElements.statusText.textContent = 'Trade offer sent! Check Steam to accept.';
            modalElements.statusText.className = 'accept-winnings-status-text success';
            modalElements.acceptButton.style.display = 'none';
            if (data.offerURL) {
                modalElements.viewTradeOfferLink.href = data.offerURL;
                modalElements.tradeOfferLinkContainer.style.display = 'block';
            }
            showModal(modalElements.modal);
        } else {
            modalElements.statusText.textContent = 'Trade offer sent! Check Steam to accept.';
            modalElements.statusText.className = 'accept-winnings-status-text success';
            modalElements.acceptButton.style.display = 'none';
            if (data.offerURL) {
                modalElements.viewTradeOfferLink.href = data.offerURL;
                modalElements.tradeOfferLinkContainer.style.display = 'block';
            }
        }
    });
    socket.on('notification', (data) => { /* ... unchanged ... */ });
    socket.on('chatMessage', (data) => { /* ... unchanged ... */ });
    socket.on('initialChatMessages', (messages) => { /* ... unchanged ... */ });
    socket.on('updateUserCount', (count) => { /* ... unchanged ... */ });
}


function setupEventListeners() {
    // Navigation links
    DOMElements.nav.homeLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.homePage); });
    // ... (other nav links unchanged) ...
    DOMElements.nav.aboutLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.aboutPage); });
    DOMElements.nav.tosLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.tosPage); });
    DOMElements.nav.faqLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.faqPage); });
    DOMElements.nav.fairLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.fairPage); });


    // User controls
    DOMElements.user.loginButton?.addEventListener('click', () => {
        window.location.href = '/auth/steam';
    });
    // ... (user profile dropdown, logout unchanged) ...
    const { userProfile, userDropdownMenu, logoutButton, profileDropdownButton, winningHistoryDropdownButton } = DOMElements.user;
    userProfile?.addEventListener('click', (e) => { e.stopPropagation(); if (userDropdownMenu) { const isVisible = userDropdownMenu.style.display === 'block'; userDropdownMenu.style.display = isVisible ? 'none' : 'block'; userProfile?.setAttribute('aria-expanded', String(!isVisible)); userProfile?.classList.toggle('open', !isVisible); } });
    userProfile?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }});
    logoutButton?.addEventListener('click', (e) => { e.stopPropagation(); handleLogout(); });
    logoutButton?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleLogout(); }});
    profileDropdownButton?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const menu = DOMElements.user.userDropdownMenu; const modal = DOMElements.profileModal.modal; if (currentUser && modal) { populateProfileModal(); showModal(modal); } else if (!currentUser) showNotification("Please log in to view your profile.", "info"); if (menu) menu.style.display = 'none'; userProfile?.setAttribute('aria-expanded', 'false'); userProfile?.classList.remove('open'); });
    winningHistoryDropdownButton?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); const menu = DOMElements.user.userDropdownMenu; if (currentUser) { showWinningHistory(); } else { showNotification("Please log in to view your winning history.", "info"); } if (menu) menu.style.display = 'none'; userProfile?.setAttribute('aria-expanded', 'false'); userProfile?.classList.remove('open'); });


    // Profile Modal
    DOMElements.profileModal.saveBtn?.addEventListener('click', handleProfileSave);
    DOMElements.profileModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.profileModal.cancelBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));

    // Winning History Modal
    DOMElements.winningHistoryModal.closeBtnHeader?.addEventListener('click', () => hideModal(DOMElements.winningHistoryModal.modal));
    DOMElements.winningHistoryModal.closeBtnFooter?.addEventListener('click', () => hideModal(DOMElements.winningHistoryModal.modal));


    // Deposit Modal
    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => { /* ... (logic mostly unchanged, ensure correct checks) ... */
        const button = DOMElements.deposit.showDepositModalButton;
        if (button.disabled && button.title) { showNotification(button.title, 'info'); return; }
        if (!currentUser) { showNotification('Login Required: Please log in first.', 'error'); return; }
        if (!currentUser.tradeUrl) {
            showNotification('Trade URL Required: Please open your profile (click your avatar) and set your Steam Trade URL before depositing.', 'error', 6000);
            if (DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
            return;
        }
        showModal(DOMElements.deposit.depositModal);
        loadUserInventory();
    });
    DOMElements.deposit.closeDepositModalButton?.addEventListener('click', () => hideModal(DOMElements.deposit.depositModal));
    DOMElements.deposit.depositButton?.addEventListener('click', requestDepositOffer);
    DOMElements.deposit.acceptDepositOfferBtn?.addEventListener('click', () => {
        if (currentDepositOfferURL) {
            window.open(currentDepositOfferURL, '_blank', 'noopener');
        }
    });


    // Accept Winnings Modal (NEW)
    DOMElements.acceptWinningsModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.acceptWinningsModal.modal));
    DOMElements.acceptWinningsModal.acceptButton?.addEventListener('click', handleClaimWinnings);
    // Optional: Decline button logic
    // DOMElements.acceptWinningsModal.declineButton?.addEventListener('click', () => { /* ... handle declining winnings ... */ hideModal(DOMElements.acceptWinningsModal.modal); });


    // Age Verification
    const { modal: ageModal, checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
    if (ageModal && ageCheckbox && ageAgreeButton) { /* ... unchanged ... */ }

    // Provably Fair
    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound);

    // Global listeners (dropdown close, escape key)
    window.addEventListener('click', (e) => { /* ... (dropdown close logic unchanged) ... */ });
    document.addEventListener('keydown', function(event) { /* ... (escape key for modals unchanged) ... */ });

    setupChatEventListeners(); // Chat listeners
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
    // Populate unclaimed winnings section
    populateUnclaimedWinningsInProfile(currentUser.unclaimedWinnings || []);
}


async function handleProfileSave() { /* ... unchanged ... */ }

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed.");
    const ageVerified = localStorage.getItem('ageVerified') === 'true';

    initiateNewRoundVisualReset(); // Initial visual state

    checkLoginStatus(); // Fetches user, then round data via socket
    setupEventListeners();
    setupSocketConnection();

    showPage(DOMElements.pages.homePage);

    if (!ageVerified && DOMElements.ageVerification.modal) {
        const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
        if(ageCheckbox) ageCheckbox.checked = false;
        if(ageAgreeButton) ageAgreeButton.disabled = true;
        showModal(DOMElements.ageVerification.modal);
    }
    updateChatUI(); // Initial chat UI setup
});

console.log("main.js modified for individual deposits and winner claim flow.");
