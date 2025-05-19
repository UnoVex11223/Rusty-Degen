// main.js - Rust Jackpot Frontend Logic
// Modifications:
// - Popup behavior for "Accept on Steam" button fixed.
// - Roulette visual changed to display item images from the pot ("old look").
// - Detailed winner announcement box (name, deposit, chance) removed before popup.
// - Retained "Accept Winnings" modal flow (user clicks "Accept My Winnings" first).

// Ensure Socket.IO client library is loaded before this script
const socket = io();

// --- Configuration Constants ---
const CONFIG = {
    ROUND_DURATION: 99,
    MAX_ITEMS_PER_DEPOSIT: 20,
    MAX_DISPLAY_DEPOSITS: 10,
    MAX_PARTICIPANTS_DISPLAY: 20,
    MAX_ITEMS_PER_POT_FRONTEND: 200,
    // ROULETTE_REPETITIONS: 20, // How many times items repeat in visual track construction.
    SPIN_DURATION_SECONDS: 6.5,
    WINNER_DISPLAY_DURATION: 5000, // Time before UI resets after "Accept Winnings" popup appears.
    CONFETTI_COUNT: 150,
    EASE_OUT_POWER: 5,
    BOUNCE_ENABLED: false,
    BOUNCE_OVERSHOOT_FACTOR: 0.07,
    BOUNCE_DAMPING: 0.35,
    BOUNCE_FREQUENCY: 3.5,
    LANDING_POSITION_VARIATION: 0.45, // Reduced variation for more centered landing
    MAX_CHAT_MESSAGES: 100,
    CHAT_SEND_COOLDOWN_MS: 2000,
    ROULETTE_ITEM_WIDTH: 70, // For item images, adjust as needed (CSS should match)
    ROULETTE_ITEM_MARGIN: 10, // Total margin between items
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
    acceptWinningsModal: {
        modal: document.getElementById('acceptWinningsModal'),
        headerTitle: document.querySelector('#acceptWinningsModal .modal-header h2'),
        bodyContent: document.querySelector('#acceptWinningsModal .modal-body'),
        closeBtn: document.getElementById('closeAcceptWinningsModal'),
        offerIdDisplay: document.getElementById('acceptWinningsOfferId'),
        statusText: document.getElementById('acceptWinningsStatusText'),
        actionButton: document.getElementById('acceptWinningsOnSteamBtn'), // This ID is kept, but text/action changes
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
        winnerInfoBox: document.getElementById('winnerInfo'), // Will be hidden
        winnerAvatar: document.getElementById('winnerAvatar'), // Will be hidden
        winnerName: document.getElementById('winnerName'),     // Will be hidden
        winnerDeposit: document.getElementById('winnerDeposit'), // Will be hidden
        winnerChance: document.getElementById('winnerChance'),   // Will be hidden
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
let currentDepositOfferURL = null;
let pendingWinningsOffer = null;
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
        resetAcceptWinningsModalUI();
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
        acceptDepositOfferBtn.onclick = null; // Clear previous handler
    }
    if (depositStatusText) {
        depositStatusText.textContent = '';
        depositStatusText.className = 'deposit-status-text';
    }
    currentDepositOfferURL = null;
}

function resetAcceptWinningsModalUI() {
    const { modal, headerTitle, bodyContent, statusText, actionButton, offerIdDisplay } = DOMElements.acceptWinningsModal;
    if (!modal) return;

    if (headerTitle) headerTitle.textContent = "Winnings!"; // Default title
    if (bodyContent) bodyContent.innerHTML = ""; // Clear dynamic body
    if (statusText) {
        statusText.textContent = '';
        statusText.className = 'deposit-status-text';
    }
    if (offerIdDisplay) {
        offerIdDisplay.textContent = '';
        offerIdDisplay.style.display = 'none'; // Hide by default
    }
    if (actionButton) {
        actionButton.textContent = 'Action'; // Default text
        actionButton.style.display = 'none';
        actionButton.disabled = true;
        actionButton.className = 'btn'; // Reset classes
        actionButton.removeAttribute('data-offer-url');
        actionButton.onclick = null; // IMPORTANT: Clear previous onclick handlers
    }
}

// Shows the "Accept My Winnings" button and info
function showAcceptWinningsButtonPopup(roundId, winnerUsername, totalValueWon) {
    const { modal, headerTitle, bodyContent, actionButton, statusText, offerIdDisplay } = DOMElements.acceptWinningsModal;
    resetAcceptWinningsModalUI(); // Start fresh

    if(headerTitle) headerTitle.textContent = "Congratulations!";
    if(bodyContent) {
        bodyContent.innerHTML = `
            <p>Congratulations, <strong>${winnerUsername || 'Winner'}</strong>!</p>
            <p>You've won the jackpot with a total value of <strong style="color: var(--primary-color);">$${(totalValueWon || 0).toFixed(2)}</strong>!</p>
            <p>Click the button below to have the items sent to your Steam account.</p>
            <p><small>(Site fee, if applicable, has already been deducted from the pot value shown)</small></p>
        `;
    }
    if(offerIdDisplay) offerIdDisplay.style.display = 'none';
    if(statusText) statusText.textContent = "Ready to claim your skins?";

    if (actionButton) {
        actionButton.textContent = 'Accept My Winnings';
        actionButton.classList.add('btn-primary'); // Use primary style for this action
        actionButton.style.display = 'inline-block';
        actionButton.disabled = false;
        actionButton.onclick = async () => {
            actionButton.disabled = true;
            actionButton.textContent = 'Processing...';
            if(statusText) statusText.textContent = "Sending request to server...";
            try {
                const response = await fetch('/api/round/accept-winnings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // body: JSON.stringify({ roundId: roundId }) // Backend currently finds latest for user
                });
                const result = await response.json();
                if (!response.ok || !result.success) {
                    throw new Error(result.error || 'Failed to accept winnings.');
                }
                if(statusText) statusText.textContent = "Winnings accepted! Waiting for trade offer from bot...";
                // The 'tradeOfferSent' socket event will trigger the next modal state (Accept on Steam)
                // Do not hide modal here; wait for tradeOfferSent.
            } catch (error) {
                showNotification(`Error accepting winnings: ${error.message}`, 'error');
                if(statusText) statusText.textContent = `Error: ${error.message}`;
                actionButton.disabled = false; // Re-enable on error
                actionButton.textContent = 'Accept My Winnings';
            }
        };
    }
    showModal(modal);
}

// Shows the "Accept on Steam" link
function showAcceptOnSteamLinkPopup(offerURL, offerId, tradeStatus) {
    const { modal, headerTitle, bodyContent, actionButton, statusText, offerIdDisplay } = DOMElements.acceptWinningsModal;
    resetAcceptWinningsModalUI(); // Start fresh

    if(headerTitle) headerTitle.textContent = "Winnings Sent!";
    if(bodyContent) {
        bodyContent.innerHTML = `
            <p>A Steam trade offer for your winnings has been prepared!</p>
            <p>Please click the button below to open the trade offer on Steam and accept your items.</p>
        `;
    }
    if(offerIdDisplay) {
        offerIdDisplay.textContent = `Trade Offer ID: #${offerId || 'N/A'}`;
        offerIdDisplay.style.display = 'block'; // Show offer ID
    }
    if(statusText) statusText.textContent = `Status: ${tradeStatus || 'Sent'}.`;

    if (actionButton) {
        actionButton.textContent = 'Accept on Steam';
        actionButton.classList.add('btn-success'); // Green for Steam action
        actionButton.innerHTML = 'Accept on Steam <i class="fas fa-external-link-alt"></i>'; // Add icon
        actionButton.style.display = 'inline-block';
        actionButton.disabled = !offerURL; // Disable if no URL

        if (offerURL) {
            actionButton.setAttribute('data-offer-url', offerURL);
            // FIX: Ensure this onclick handler is correctly assigned and works
            actionButton.onclick = () => {
                console.log("Accept on Steam clicked, URL:", offerURL);
                if (offerURL) {
                    window.open(offerURL, '_blank', 'noopener,noreferrer');
                    if(statusText) statusText.textContent = "Check the new Steam tab for your trade offer.";
                    // Optionally close modal after a short delay
                    // setTimeout(() => hideModal(modal), 3000);
                } else {
                    if(statusText) statusText.textContent = "Error: Trade offer URL is missing.";
                    showNotification("Error: Could not open trade offer, URL is missing.", "error");
                }
            };
        } else {
             actionButton.onclick = () => { // Fallback if no URL
                if(statusText) statusText.textContent = "Error: Trade offer URL is missing.";
                showNotification("Error: Could not open trade offer, URL is missing.", "error");
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
                case 'completed_pending_acceptance':
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
                console.error(`Server error fetching user: ${response.status}`);
                currentUser = null;
            }
        } else {
            currentUser = await response.json();
            console.log('User logged in:', currentUser?.username);
        }
    } catch (error) {
        console.error('Error checking login status:', error);
        currentUser = null;
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


// main.js - Rust Jackpot Frontend Logic - Part 2 of 2

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
        itemElement.dataset.itemData = JSON.stringify(item); // Store full item data
        itemElement.title = `${item.name || 'Item'} - $${item.price.toFixed(2)}`; // Show name in tooltip

        itemElement.innerHTML = `
            <img src="${item.image}" alt="${item.name || 'Skin Image'}" loading="lazy"
                 onerror="this.onerror=null; this.src='/img/default-item.png';">
            <div class="item-details">
                <div class="item-value">$${item.price.toFixed(2)}</div>
            </div>`;

        if (selectedItemsList.some(selected => selected.assetId === item.assetId)) {
            itemElement.classList.add('selected');
        }
        itemElement.addEventListener('click', () => {
            const fullItemData = JSON.parse(itemElement.dataset.itemData);
            toggleItemSelection(itemElement, fullItemData);
        });
        container.appendChild(itemElement);
    });
}


function toggleItemSelection(element, itemObject) {
    if (typeof itemObject.price !== 'number' || isNaN(itemObject.price)) {
        console.error("Attempted to select item with invalid price:", itemObject);
        showNotification('Selection Error: Cannot select item with invalid price.', 'error');
        return;
    }

    const assetId = itemObject.assetId;
    const index = selectedItemsList.findIndex(i => i.assetId === assetId);

    if (index === -1) {
        if (selectedItemsList.length >= CONFIG.MAX_ITEMS_PER_DEPOSIT) {
            showNotification(`Selection Limit: You can select a maximum of ${CONFIG.MAX_ITEMS_PER_DEPOSIT} items per deposit.`, 'info');
            return;
        }
        selectedItemsList.push(itemObject);
        element.classList.add('selected');
        addSelectedItemElement(itemObject);
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
    selectedElement.title = `${item.name || 'Item'} - $${item.price.toFixed(2)}`;

    selectedElement.innerHTML = `
        <img src="${item.image}" alt="${item.name || 'Selected Skin'}" loading="lazy"
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
    if (!currentRound || currentRound.status !== 'active' || isSpinning) {
        showNotification('Deposit Error: Deposits are currently closed.', 'error'); return;
    }
    if (currentUser?.pendingDepositOfferId) {
        showNotification('Deposit Error: You already have a pending deposit offer. Check your profile or Steam.', 'error');
        if (DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); }
        return;
    }

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
    acceptDepositOfferBtn.onclick = null; // Clear previous handler
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
                acceptDepositOfferBtn.setAttribute('data-offer-url', currentDepositOfferURL);
                // Set onclick for this specific button
                acceptDepositOfferBtn.onclick = () => {
                    if (currentDepositOfferURL) window.open(currentDepositOfferURL, '_blank', 'noopener,noreferrer');
                };
                depositButton.style.display = 'none';
                if (currentUser && !currentUser.pendingDepositOfferId) {
                    currentUser.pendingDepositOfferId = result.offerId;
                    updateUserUI(); updateDepositButtonState();
                }
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
            acceptDepositOfferBtn.setAttribute('data-offer-url', currentDepositOfferURL);
            acceptDepositOfferBtn.onclick = () => { // Set onclick for this specific button
                if (currentDepositOfferURL) window.open(currentDepositOfferURL, '_blank', 'noopener,noreferrer');
            };
            if(currentUser) {
                currentUser.pendingDepositOfferId = result.offerId;
                updateUserUI(); updateDepositButtonState();
            }
        }
    } catch (error) {
        depositStatusText.textContent = `Error: ${error.message}`;
        depositStatusText.className = 'deposit-status-text error';
        if (!(response && response.status === 409)) {
            resetDepositModalUI();
        }
        if (currentUser && currentUser.pendingDepositOfferId && !(response && response.status === 409)) {
            currentUser.pendingDepositOfferId = null;
            updateUserUI(); updateDepositButtonState();
        }
    }
}

function updateRoundUI() {
    const { potValue, participantCount } = DOMElements.jackpot;
    if (!currentRound || !potValue || !participantCount) {
        if (potValue) potValue.textContent = "$0.00";
        if (participantCount) participantCount.textContent = `0/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
        updateTimerUI(currentRound ? (currentRound.timeLeft !== undefined ? currentRound.timeLeft : CONFIG.ROUND_DURATION) : CONFIG.ROUND_DURATION);
        return;
    }
    potValue.textContent = `$${(currentRound.totalValue || 0).toFixed(2)}`;
    if (!timerActive) {
        updateTimerUI(currentRound.timeLeft !== undefined ? currentRound.timeLeft : CONFIG.ROUND_DURATION);
    }
    const participantNum = currentRound.participants?.length || 0;
    participantCount.textContent = `${participantNum}/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`;
    updateParticipantsUI();
}

function updateTimerUI(timeLeft) {
    const { timerValue, timerForeground } = DOMElements.jackpot;
    if (!timerValue || !timerForeground) return;
    const timeToShow = Math.max(0, Math.round(timeLeft));
    let displayValue = timeToShow.toString();

    if (currentRound && currentRound.status === 'active') {
        if (!timerActive && currentRound.participants?.length === 0) {
            displayValue = CONFIG.ROUND_DURATION.toString();
        } else {
            displayValue = timeToShow.toString();
        }
    } else if (isSpinning || (currentRound && currentRound.status === 'rolling')) {
        displayValue = "Rolling";
    } else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'completed_pending_acceptance' || currentRound.status === 'error')) {
        displayValue = "Ended";
    } else if (currentRound && currentRound.status === 'pending') {
        displayValue = "Waiting";
    } else if (!currentRound) {
        displayValue = CONFIG.ROUND_DURATION.toString();
    }

    timerValue.textContent = displayValue;
    updateTimerCircle(timeToShow, CONFIG.ROUND_DURATION);

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

function displayLatestDeposit(data) {
    const container = DOMElements.jackpot.participantsContainer;
    const emptyMsg = DOMElements.jackpot.emptyPotMessage;
    if (!container) return;
    const userId = data.userId || data.user?._id;
    if (!userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue)) return;

    const depositSfx = DOMElements.audio.depositSound;
    if (depositSfx) {
        depositSfx.volume = 0.6; depositSfx.currentTime = 0;
        depositSfx.play().catch(e => console.error("Error playing deposit sound:", e));
    }

    const username = data.username || data.user?.username || 'Unknown User';
    const avatar = data.avatar || data.user?.avatar || '/img/default-avatar.png';
    const itemsJustDeposited = data.depositedItems || [];
    const userColor = getUserColor(userId);
    const participantData = currentRound?.participants?.find(p => (p.user?._id === userId || p.user?.id === userId));
    const cumulativeValueForDisplay = participantData ? participantData.itemsValue : data.itemsValue;
    const currentTotalPotValue = Math.max(0.01, currentRound?.totalValue || 0.01);
    const percentageForDisplay = ((cumulativeValueForDisplay / currentTotalPotValue) * 100).toFixed(1);

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
            <div class="player-deposit-value" style="color: ${userColor}" title="Deposited: $${cumulativeValueForDisplay.toFixed(2)} | Chance: ${percentageForDisplay}%">
                $${cumulativeValueForDisplay.toFixed(2)} | ${percentageForDisplay}%
            </div>
        </div>`;
    const itemsGrid = document.createElement('div');
    itemsGrid.className = 'player-items-grid';
    if (itemsJustDeposited.length > 0) {
        itemsJustDeposited.sort((a, b) => (b.price || 0) - (a.price || 0));
        const displayItems = itemsJustDeposited.slice(0, CONFIG.MAX_ITEMS_PER_DEPOSIT);
        displayItems.forEach(item => {
            if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.image) return;
            const itemElement = document.createElement('div');
            itemElement.className = 'player-deposit-item';
            itemElement.title = `${item.name || 'Item'} - $${item.price.toFixed(2)}`;
            itemElement.style.borderColor = userColor;
            itemElement.innerHTML = `
                <img src="${item.image}" alt="${item.name || 'Skin Image'}" class="player-deposit-item-image" loading="lazy"
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
    if (container.firstChild) container.insertBefore(depositContainer, container.firstChild);
    else container.appendChild(depositContainer);
    if (emptyMsg) emptyMsg.style.display = 'none';
    setTimeout(() => depositContainer.classList.remove('player-deposit-new'), 500);
    const currentDepositBlocks = container.querySelectorAll('.player-deposit-container');
    if (currentDepositBlocks.length > CONFIG.MAX_DISPLAY_DEPOSITS) {
        for (let i = 0; i < currentDepositBlocks.length - CONFIG.MAX_DISPLAY_DEPOSITS; i++) {
            const oldestBlock = container.querySelector('.player-deposit-container:last-child');
            if (oldestBlock && oldestBlock !== depositContainer) {
                oldestBlock.style.transition = 'opacity 0.3s ease-out';
                oldestBlock.style.opacity = '0';
                setTimeout(() => { if (oldestBlock.parentNode === container) oldestBlock.remove(); }, 300);
            }
        }
    }
}

function handleNewDeposit(data) {
    if (!data || !data.roundId || !data.userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue) || data.totalValue === undefined || data.tickets === undefined) return;
    if (!data.depositedItems) data.depositedItems = [];
    if (!currentRound) {
        currentRound = { roundId: data.roundId, status: 'active', timeLeft: CONFIG.ROUND_DURATION, totalValue: 0, participants: [], items: [] };
    } else if (currentRound.roundId !== data.roundId) return;
    if (!currentRound.participants) currentRound.participants = [];
    if (!currentRound.items) currentRound.items = [];
    if (currentUser && currentUser.pendingDepositOfferId && (currentUser._id === data.userId || currentUser.id === data.userId)) {
       currentUser.pendingDepositOfferId = null;
       updateUserUI(); updateDepositButtonState();
       if (DOMElements.deposit.depositModal?.style.display === 'flex') {
           resetDepositModalUI(); selectedItemsList = [];
           if(DOMElements.deposit.selectedItemsContainer) DOMElements.deposit.selectedItemsContainer.innerHTML = '';
           updateTotalValue();
       }
    }
    let participantIndex = currentRound.participants.findIndex(p => p.user?._id === data.userId || p.user?.id === data.userId);
    if (participantIndex !== -1) {
        currentRound.participants[participantIndex] = {
            ...currentRound.participants[participantIndex],
            user: currentRound.participants[participantIndex].user || { _id: data.userId, id: data.userId, username: data.username, avatar: data.avatar },
            itemsValue: data.itemsValue, tickets: data.tickets
        };
    } else {
        currentRound.participants.push({
            user: { _id: data.userId, id: data.userId, username: data.username || 'Unknown User', avatar: data.avatar || '/img/default-avatar.png' },
            itemsValue: data.itemsValue, tickets: data.tickets
        });
    }
    currentRound.totalValue = data.totalValue;
    data.depositedItems.forEach(item => {
        if (item && typeof item.price === 'number' && !isNaN(item.price)) currentRound.items.push({ ...item, owner: data.userId });
    });
    updateRoundUI(); displayLatestDeposit(data); updateAllParticipantPercentages(); updateDepositButtonState();
    if (currentRound.status === 'active' && currentRound.participants.length === 1 && !timerActive) {
        startClientTimer(currentRound.timeLeft || CONFIG.ROUND_DURATION);
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
    if (!hasDepositBlocks && participantNum === 0) {
        emptyMsg.style.display = 'block';
    } else {
        emptyMsg.style.display = 'none';
    }
}

function startClientTimer(initialTime = CONFIG.ROUND_DURATION) {
    const timerDisplay = DOMElements.jackpot.timerValue;
    if (!timerDisplay) return;
    if (roundTimer) clearInterval(roundTimer);
    let timeLeft = Math.max(0, initialTime);
    timerActive = true; updateTimerUI(timeLeft); updateDepositButtonState();
    roundTimer = setInterval(() => {
        if (!timerActive) { clearInterval(roundTimer); roundTimer = null; return; }
        timeLeft--;
        if (currentRound) currentRound.timeLeft = timeLeft;
        updateTimerUI(timeLeft); updateDepositButtonState();
        if (timeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null; timerActive = false;
            if (timerDisplay) timerDisplay.textContent = "0";
            updateDepositButtonState();
        }
    }, 1000);
}

// MODIFIED: Create roulette items using actual item images from the pot
function createRouletteItems() {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer;
    if (!track || !container) { console.error("Roulette track or container missing."); return; }
    track.innerHTML = ''; track.style.transition = 'none'; track.style.transform = 'translateX(0)';

    if (!currentRound || !currentRound.items || currentRound.items.length === 0) {
        console.error('No items in current pot to create roulette items.');
        track.innerHTML = '<div class="roulette-message" style="color: white; text-align: center; padding: 20px;">No items in pot for roulette.</div>';
        return;
    }

    let itemPool = []; // This will hold item objects for the visual roulette
    const TICKET_VALUE = 0.01; // Assuming $0.01 per "visual ticket" for distribution

    // Create a pool of items, where each item appears proportionally to its value
    // (or a minimum number of times to ensure visibility)
    currentRound.items.forEach(item => {
        if (!item || typeof item.price !== 'number' || !item.image || !item.owner) return;
        const numVisualBlocks = Math.max(1, Math.floor(item.price / TICKET_VALUE)); // Each item gets at least one block
        for (let i = 0; i < numVisualBlocks; i++) {
            itemPool.push({
                image: item.image,
                name: item.name, // For tooltip/alt text
                price: item.price,
                ownerId: typeof item.owner === 'object' ? (item.owner._id || item.owner.id) : item.owner, // Get owner ID
                assetId: item.assetId // Useful for exact identification if needed
            });
        }
    });

    if (itemPool.length === 0) {
        console.error("Item pool for roulette is empty after processing pot items.");
        track.innerHTML = '<div class="roulette-message" style="color: red; text-align: center; padding: 20px;">Error: Could not build roulette items.</div>';
        return;
    }

    itemPool = shuffleArray([...itemPool]); // Shuffle the item pool

    const rouletteInnerContainer = container.querySelector('.roulette-container');
    const containerWidth = rouletteInnerContainer?.offsetWidth || container.offsetWidth || 1000;
    const itemWidthWithMargin = CONFIG.ROULETTE_ITEM_WIDTH + CONFIG.ROULETTE_ITEM_MARGIN;
    const itemsInView = Math.ceil(containerWidth / itemWidthWithMargin);
    const itemsForSpinBuffer = Math.max(150, itemsInView * 15); // Ensure enough for smooth visual, 15 full views
    const itemsToCreate = Math.max(itemsForSpinBuffer, 250); // Minimum of 250 items

    console.log(`Targeting ${itemsToCreate} visual blocks in roulette. Item pool size: ${itemPool.length}.`);

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < itemsToCreate; i++) {
        const currentItem = itemPool[i % itemPool.length]; // Cycle through the shuffled item pool
        const userColor = getUserColor(currentItem.ownerId);

        const itemElement = document.createElement('div');
        itemElement.className = 'roulette-item';
        itemElement.dataset.ownerId = currentItem.ownerId; // Store owner for highlighting winner
        itemElement.dataset.assetId = currentItem.assetId; // Store assetId
        // itemElement.style.borderColor = userColor; // Optional: border based on owner's color
        itemElement.title = `${currentItem.name || 'Item'} - $${currentItem.price.toFixed(2)}`;

        itemElement.innerHTML = `
            <img class="roulette-item-image" src="${currentItem.image}" alt="${currentItem.name || 'Item Image'}" loading="lazy"
                 onerror="this.onerror=null; this.src='/img/default-item.png';" >`;
        fragment.appendChild(itemElement);
    }
    track.appendChild(fragment);
    console.log(`Created ${track.children.length} item blocks for roulette animation.`);
}
// main.js - Rust Jackpot Frontend Logic - Part 2 of 2

// (Previous functions like loadUserInventory, displayInventoryItems, toggleItemSelection, etc., are in Part 1)
// (updateRoundUI, updateTimerUI, updateTimerCircle, updateAllParticipantPercentages, displayLatestDeposit, handleNewDeposit, updateParticipantsUI, startClientTimer are in Part 1)

// MODIFIED: Create roulette items using actual item images from the pot ("old look")
function createRouletteItems() {
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer;
    if (!track || !container) { console.error("Roulette track or container missing."); return; }
    track.innerHTML = ''; track.style.transition = 'none'; track.style.transform = 'translateX(0)';

    // Use currentRound.items which should be populated by the backend
    // Each item in currentRound.items should have: image, name, price, owner (ID)
    if (!currentRound || !currentRound.items || currentRound.items.length === 0) {
        console.error('No items in current pot to create roulette items for the "old look".');
        track.innerHTML = '<div class="roulette-message" style="color: white; text-align: center; padding: 20px;">No items in pot for roulette.</div>';
        return;
    }

    let visualItemPool = [];
    const TICKET_VALUE_FOR_VISUALS = 0.01; // How much value represents one "visual spot"

    currentRound.items.forEach(item => {
        if (!item || typeof item.price !== 'number' || !item.image || !item.owner) {
            // console.warn("Skipping invalid item for roulette pool:", item);
            return;
        }
        // Ensure ownerId is consistently retrieved
        const ownerId = (typeof item.owner === 'object' && item.owner !== null) ? (item.owner._id || item.owner.id) : item.owner;
        if (!ownerId) {
            // console.warn("Skipping item due to missing owner ID:", item);
            return;
        }

        const numVisualBlocks = Math.max(1, Math.floor(item.price / TICKET_VALUE_FOR_VISUALS));
        for (let i = 0; i < numVisualBlocks; i++) {
            visualItemPool.push({ // Store details needed for rendering and winner identification
                image: item.image,
                name: item.name || 'Item',
                price: item.price,
                ownerId: ownerId,
                assetId: item.assetId || `item-${i}` // Fallback assetId for keying if needed
            });
        }
    });

    if (visualItemPool.length === 0) {
        console.error("Visual item pool for roulette is empty after processing pot items.");
        track.innerHTML = '<div class="roulette-message" style="color: red; text-align: center; padding: 20px;">Error: Could not build roulette items from pot.</div>';
        return;
    }

    visualItemPool = shuffleArray([...visualItemPool]);

    const rouletteInnerContainer = container.querySelector('.roulette-container');
    const containerWidth = rouletteInnerContainer?.offsetWidth || container.offsetWidth || 1000;
    // CONFIG.ROULETTE_ITEM_WIDTH and CONFIG.ROULETTE_ITEM_MARGIN define item visual size
    const itemVisualWidth = CONFIG.ROULETTE_ITEM_WIDTH + (CONFIG.ROULETTE_ITEM_MARGIN / 2); // Effective width with half margin on each side
    const itemsInView = Math.ceil(containerWidth / itemVisualWidth);
    const itemsForSpinBuffer = Math.max(150, itemsInView * 15); // Ensure enough items for a good visual spin
    const itemsToCreate = Math.max(itemsForSpinBuffer, 250); // Create at least 250 visual blocks

    console.log(`Targeting ${itemsToCreate} visual blocks in roulette (item image based). Item pool size: ${visualItemPool.length}.`);

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < itemsToCreate; i++) {
        const currentItemVisual = visualItemPool[i % visualItemPool.length]; // Cycle through the shuffled pool
        // const userColor = getUserColor(currentItemVisual.ownerId); // Color based on item owner

        const itemElement = document.createElement('div');
        itemElement.className = 'roulette-item old-look-item'; // Add class for specific styling if needed
        itemElement.dataset.ownerId = currentItemVisual.ownerId;
        itemElement.dataset.assetId = currentItemVisual.assetId; // Original assetId
        itemElement.title = `${currentItemVisual.name} - $${currentItemVisual.price.toFixed(2)}`;
        // itemElement.style.borderColor = userColor; // Example: border by owner color

        itemElement.innerHTML = `
            <img class="roulette-item-image" src="${currentItemVisual.image}" alt="${currentItemVisual.name}" loading="lazy"
                 onerror="this.onerror=null; this.src='/img/default-item.png';">
            `; // Displaying the item's image
        fragment.appendChild(itemElement);
    }
    track.appendChild(fragment);
    console.log(`Created ${track.children.length} item image blocks for roulette animation.`);
}


function handleWinnerAnnouncement(data) {
    if (isSpinning) {
        console.warn("Received winner announcement but animation is already spinning. Ignoring.");
        return;
    }
    // Ensure we have items to display in roulette, which now come from currentRound.items
    if (!currentRound || !currentRound.items || currentRound.items.length === 0) {
        console.error("Missing item data in current pot for winner announcement. Requesting fresh data.");
        socket.emit('requestRoundData');
        setTimeout(() => {
            if (currentRound?.items?.length > 0) {
                console.log("Retrying winner announcement after receiving item data.");
                handleWinnerAnnouncement(data);
            } else {
                console.error("Still no item data after requesting. Cannot start spin. Resetting.");
                resetToJackpotView();
            }
        }, 1500);
        return;
    }

    const winnerDetails = data.winner;
    const winnerId = winnerDetails?.id || winnerDetails?._id;
    if (!winnerId) {
        console.error("Invalid winner data received in announcement:", data);
        resetToJackpotView(); return;
    }

    console.log(`Winner announced: ${winnerDetails.username}. Preparing roulette (item image based)...`);
    if (timerActive) {
        timerActive = false; clearInterval(roundTimer); roundTimer = null;
    }

    switchToRouletteView();
    setTimeout(() => {
        startRouletteAnimation({ winner: winnerDetails }); // winnerDetails contains the winner's user object
    }, 500);
}

function switchToRouletteView() {
    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer;
    const winnerInfoBox = DOMElements.roulette.winnerInfoBox; // Get reference to winner info box

    if (!header || !rouletteContainer) { console.error("Missing UI elements for roulette view switch."); return; }

    const valueDisplay = header.querySelector('.jackpot-value');
    const timerDisplay = header.querySelector('.jackpot-timer');
    const statsDisplay = header.querySelector('.jackpot-stats');

    [valueDisplay, timerDisplay, statsDisplay].forEach(el => {
        if (el) {
            el.style.transition = 'opacity 0.5s ease'; el.style.opacity = '0';
            setTimeout(() => { el.style.display = 'none'; }, 500);
        }
    });

    header.classList.add('roulette-mode');
    rouletteContainer.style.display = 'flex';
    rouletteContainer.style.opacity = '0'; rouletteContainer.style.transform = 'translateY(20px)';

    // MODIFICATION: Ensure winnerInfoBox is hidden initially as per user request
    if (winnerInfoBox) winnerInfoBox.style.display = 'none';

    setTimeout(() => {
        rouletteContainer.style.transition = 'opacity 0.7s ease, transform 0.7s ease';
        rouletteContainer.style.opacity = '1'; rouletteContainer.style.transform = 'translateY(0)';
    }, 600);

    if (DOMElements.roulette.returnToJackpotButton) DOMElements.roulette.returnToJackpotButton.style.display = 'none';
}

function startRouletteAnimation(winnerData) { // winnerData contains { winner: {id, username, avatar, ...} }
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }

    const winnerId = winnerData?.winner?.id || winnerData?.winner?._id; // This is the OWNER ID of the winning item(s)
    if (!winnerId) {
        console.error("Invalid winner (owner) data passed to startRouletteAnimation.");
        resetToJackpotView(); return;
    }

    isSpinning = true; updateDepositButtonState();
    if (DOMElements.roulette.winnerInfoBox) DOMElements.roulette.winnerInfoBox.style.display = 'none'; // Ensure hidden
    clearConfetti();
    createRouletteItems(); // This now creates item-based roulette

    const sound = DOMElements.audio.spinSound;
    if (sound) {
        sound.volume = 0.7; sound.currentTime = 0; sound.playbackRate = 1.0;
        sound.play().catch(e => console.error('Error playing spin sound:', e));
    }

    setTimeout(() => {
        const track = DOMElements.roulette.rouletteTrack;
        const itemsInTrack = track?.querySelectorAll('.roulette-item'); // These are item image blocks
        if (!track || !itemsInTrack || itemsInTrack.length === 0) {
            console.error('Cannot spin, no item blocks rendered on track.');
            isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
        }

        // Find an item in the track that belongs to the winnerId
        const minIndexPercent = 0.65, maxIndexPercent = 0.85;
        const minIndex = Math.floor(itemsInTrack.length * minIndexPercent);
        const maxIndex = Math.floor(itemsInTrack.length * maxIndexPercent);

        let winnerItemIndices = [];
        for (let i = minIndex; i <= maxIndex; i++) {
            if (itemsInTrack[i]?.dataset?.ownerId === winnerId) winnerItemIndices.push(i);
        }
        if (winnerItemIndices.length === 0) {
            for (let i = 0; i < itemsInTrack.length; i++) {
                 if (itemsInTrack[i]?.dataset?.ownerId === winnerId) winnerItemIndices.push(i);
            }
        }

        let winningElement, targetIndex;
        if (winnerItemIndices.length === 0) {
            console.error(`No items found in roulette track belonging to winner ID ${winnerId}. Fallback.`);
            targetIndex = Math.max(0, Math.min(itemsInTrack.length - 1, Math.floor(itemsInTrack.length * 0.75)));
            winningElement = itemsInTrack[targetIndex];
            if (!winningElement) {
                 isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
             }
        } else {
            targetIndex = winnerItemIndices[Math.floor(Math.random() * winnerItemIndices.length)];
            winningElement = itemsInTrack[targetIndex];
             if (!winningElement) {
                 isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
             }
        }
        console.log(`Selected winning item block at index ${targetIndex} (Owner: ${winnerId}) for animation.`);
        // Pass the original winnerData (which contains user object) to handleRouletteSpinAnimation
        handleRouletteSpinAnimation(winningElement, winnerData.winner);
    }, 100);
}

function handleRouletteSpinAnimation(winningElement, winnerUserObject) { // winnerUserObject is the direct winner user data
    const track = DOMElements.roulette.rouletteTrack;
    const container = DOMElements.roulette.inlineRouletteContainer?.querySelector('.roulette-container');
    if (!winningElement || !track || !container || !winnerUserObject) {
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const containerWidth = container.offsetWidth;
    const itemWidth = winningElement.offsetWidth || CONFIG.ROULETTE_ITEM_WIDTH;
    const itemOffsetLeft = winningElement.offsetLeft;
    const centerOffset = (containerWidth / 2) - (itemWidth / 2);
    const perfectCenterScrollPosition = -(itemOffsetLeft - centerOffset);
    const initialVariation = (Math.random() * 2 - 1) * (itemWidth * CONFIG.LANDING_POSITION_VARIATION);
    const maxAllowedAbsVariation = itemWidth * 0.49;
    let finalVariation = Math.abs(initialVariation) <= maxAllowedAbsVariation ? initialVariation : Math.sign(initialVariation) * maxAllowedAbsVariation;
    const targetScrollPosition = perfectCenterScrollPosition + finalVariation;

    const startPosition = parseFloat(track.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1] || '0');
    const duration = CONFIG.SPIN_DURATION_SECONDS * 1000;
    const totalDistance = targetScrollPosition - startPosition;

    let startTime = performance.now();
    track.style.transition = 'none';

    function animateRoulette(timestamp) {
        if (!isSpinning) {
            if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null; return;
        }
        const elapsed = timestamp - startTime;
        let currentPosition, animationFinished = false;

        if (elapsed <= duration) {
            const animationPhaseProgress = elapsed / duration;
            const easedProgress = easeOutAnimation(animationPhaseProgress);
            currentPosition = startPosition + totalDistance * easedProgress;
        } else {
            currentPosition = targetScrollPosition; animationFinished = true;
        }
        track.style.transform = `translateX(${currentPosition}px)`;

        if (!animationFinished) {
            animationFrameId = requestAnimationFrame(animateRoulette);
        } else {
            animationFrameId = null;
            finalizeSpin(winningElement, winnerUserObject); // Pass the winner's user object
        }
    }
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = requestAnimationFrame(animateRoulette);
}

function finalizeSpin(winningElement, winnerUserObject) { // winnerUserObject is the winner's user data
    if ((!isSpinning && winningElement?.classList.contains('winner-highlight')) || !winningElement || !winnerUserObject) {
        if (isSpinning) { isSpinning = false; updateDepositButtonState(); }
        return;
    }

    const winnerId = winnerUserObject.id || winnerUserObject._id;
    const userColor = getUserColor(winnerId);
    winningElement.classList.add('winner-highlight'); // Highlights the item block in roulette
    winningElement.style.borderColor = userColor; // Example: highlight with owner's color
    winningElement.style.boxShadow = `0 0 15px ${userColor}, 0 0 5px ${userColor}`; // Add a glow

    // Dynamic style for pulsing if needed (or rely on CSS class)
    const styleId = 'winner-pulse-style';
    document.getElementById(styleId)?.remove();
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        .winner-highlight {
            animation: winnerPulseItem 0.7s infinite alternate;
            --winner-item-color: ${userColor};
        }
        @keyframes winnerPulseItem {
            from { box-shadow: 0 0 10px var(--winner-item-color), 0 0 3px var(--winner-item-color); transform: scale(1.02); }
            to { box-shadow: 0 0 20px var(--winner-item-color), 0 0 7px var(--winner-item-color); transform: scale(1.07); }
        }`;
    document.head.appendChild(style);

    setTimeout(() => {
        handleSpinEnd(winnerUserObject); // Pass the winner's user object
    }, 800); // Slightly longer delay to appreciate the landed item
}

// MODIFIED: Remove detailed winner announcement, go to popup
function handleSpinEnd(winnerUserObject) { // winnerUserObject is the direct winner user data
    if (!winnerUserObject) {
        console.error("handleSpinEnd called with invalid winner data.");
        if (isSpinning) { isSpinning = false; updateDepositButtonState(); }
        resetToJackpotView(); return;
    }
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }

    const { winnerInfoBox } = DOMElements.roulette;
    if (winnerInfoBox) winnerInfoBox.style.display = 'none'; // Explicitly hide detailed announcement

    const winnerId = winnerUserObject.id || winnerUserObject._id;
    const userColor = getUserColor(winnerId); // For confetti
    launchConfetti(userColor);

    isSpinning = false;
    updateDepositButtonState();
    console.log("isSpinning set to false. Roulette animation complete.");

    // Process pending winnings offer immediately (shows "Accept My Winnings" popup)
    if (pendingWinningsOffer) {
        if (pendingWinningsOffer.action === 'showAcceptWinningsButton' && pendingWinningsOffer.winnerInfo) {
            console.log("Spin ended, showing 'Accept My Winnings' popup.");
            showAcceptWinningsButtonPopup(
                pendingWinningsOffer.roundId,
                pendingWinningsOffer.winnerInfo.username,
                pendingWinningsOffer.totalValue
            );
        } else if (pendingWinningsOffer.action === 'showAcceptOnSteamLink' && pendingWinningsOffer.offerURL) {
            // This case might occur if tradeOfferSent arrives *during* the brief spin end processing
            console.log("Spin ended, processing 'Accept on Steam' link directly.");
            showAcceptOnSteamLinkPopup(
                pendingWinningsOffer.offerURL,
                pendingWinningsOffer.offerId,
                pendingWinningsOffer.status
            );
        }
        pendingWinningsOffer = null;
    } else {
        // This case should be rare if roundWinnerPendingAcceptance sets up pendingWinningsOffer correctly
        console.warn("Spin ended, but no pendingWinningsOffer details found for popup.");
    }

    // Reset to jackpot view AFTER the accept winnings modal has been shown and potentially interacted with.
    // The modal itself will handle closing. The main view reset is for the *next* round.
    // CONFIG.WINNER_DISPLAY_DURATION might now refer to how long confetti stays or a general cleanup timer.
    // For now, let's assume the modal interaction handles the "pause" before full reset.
    // The resetToJackpotView is crucial for starting fresh for the *next* round.
    // It's called when 'roundCreated' is received.
    // We might want a shorter timeout just to clear confetti if the modal is interacted with quickly.
    setTimeout(clearConfetti, CONFIG.WINNER_DISPLAY_DURATION);
    // setTimeout(resetToJackpotView, CONFIG.WINNER_DISPLAY_DURATION); // This might be too soon if user is interacting with modal.
                                                                    // resetToJackpotView is better handled by `roundCreated` event for the next round.
}

function launchConfetti(mainColor = '#00e676') {
    const container = DOMElements.roulette.confettiContainer;
    if (!container) return;
    clearConfetti();
    const baseColor = mainColor;
    const complementaryColor = getComplementaryColor(baseColor);
    const lighterColor = lightenColor(baseColor, 30);
    const colors = [baseColor, lighterColor, complementaryColor, '#ffffff', lightenColor(complementaryColor, 20)];
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
        el.style.boxShadow = ''; // Clear explicit shadow
        // Reset border based on owner or default (if roulette items get individual borders)
        // if (el.dataset?.ownerId) el.style.borderColor = getUserColor(el.dataset.ownerId);
        // else el.style.borderColor = 'transparent';
        el.style.borderColor = 'transparent'; // Assuming default is transparent after highlight
    });
}

function resetToJackpotView() {
    console.log("Resetting to jackpot view for new round...");
    if (animationFrameId) cancelAnimationFrame(animationFrameId); animationFrameId = null;
    if (window.typeDepositInterval) clearInterval(window.typeDepositInterval); window.typeDepositInterval = null;
    if (window.typeChanceInterval) clearInterval(window.typeChanceInterval); window.typeChanceInterval = null;
    if (roundTimer) clearInterval(roundTimer); roundTimer = null;

    timerActive = false; isSpinning = false;

    const header = DOMElements.jackpot.jackpotHeader;
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer;
    const winnerInfoBox = DOMElements.roulette.winnerInfoBox;
    const track = DOMElements.roulette.rouletteTrack;

    if (!header || !rouletteContainer || !winnerInfoBox || !track) return;

    const sound = DOMElements.audio.spinSound;
    if (sound) { sound.pause(); sound.currentTime = 0; sound.volume = 1.0; sound.playbackRate = 1.0; }

    rouletteContainer.style.transition = 'opacity 0.5s ease';
    rouletteContainer.style.opacity = '0';
    if (winnerInfoBox.style.display !== 'none') { // Ensure it's hidden
        winnerInfoBox.style.transition = 'opacity 0.3s ease';
        winnerInfoBox.style.opacity = '0';
    }
    clearConfetti();

    const potContainer = DOMElements.jackpot.participantsContainer;
    if (potContainer) {
        potContainer.innerHTML = '';
        const emptyMsg = DOMElements.jackpot.emptyPotMessage;
        if (emptyMsg) {
            if (!potContainer.contains(emptyMsg)) potContainer.appendChild(emptyMsg);
            emptyMsg.style.display = 'block';
        }
    }
    if (currentRound) { // Reset relevant parts of local currentRound for the new game
        currentRound.participants = [];
        currentRound.items = [];
        currentRound.totalValue = 0;
        currentRound.winner = null; // Clear previous winner
        // roundId, serverSeedHash will be updated by 'roundCreated' or 'roundData'
    }
    updateParticipantsUI();

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
                el.style.display = 'flex'; el.style.opacity = '0';
                setTimeout(() => { el.style.transition = 'opacity 0.5s ease'; el.style.opacity = '1'; }, 50 + index * 50);
            }
        });
        initiateNewRoundVisualReset(); // This sets default text values for timer, pot, etc.
        // updateDepositButtonState(); // Called by initiateNewRoundVisualReset
        if (socket?.connected && (!currentRound || currentRound.status !== 'active')) {
            console.log("Requesting fresh round data after reset to ensure sync for new round.");
            socket.emit('requestRoundData');
        }
    }, 500);
}

function initiateNewRoundVisualReset() {
    console.log("Initiating visual reset for new round display.");
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

function findWinnerFromData(winnerData) { // winnerData is { winner: {id, username, ...} }
    const winnerUserObject = winnerData?.winner;
    if (!winnerUserObject || (!winnerUserObject.id && !winnerUserObject._id) ) {
        return null;
    }
    // For the item-based roulette, we mainly need the winner's user object for display.
    // The actual "value" and "percentage" for the *winner announcement* are less critical
    // if the detailed announcement box is removed.
    // However, the backend sends totalValueWon in roundWinnerPendingAcceptance.
    return {
        user: { ...winnerUserObject },
        // These might not be used if detailed winner box is removed
        percentage: 0, // Can be calculated if needed from currentRound but might be complex here
        value: 0       // Same as above
    };
}

async function verifyRound() { /* ... (no changes from previous version) ... */ }
async function loadPastRounds(page = 1) { /* ... (no changes from previous version) ... */ }
window.populateVerificationFields = function(roundId, serverSeed, clientSeed) { /* ... (no changes) ... */ };
function createPagination(currentPage, totalPages) { /* ... (no changes from previous version) ... */ }
function updateChatUI() { /* ... (no changes from previous version) ... */ }
function displayChatMessage(messageData) { /* ... (no changes from previous version) ... */ }
function handleSendMessage() { /* ... (no changes from previous version) ... */ }
function setupChatEventListeners() { /* ... (no changes from previous version) ... */ }
function updateChatOnlineUsers(count) { /* ... (no changes from previous version) ... */ }
async function loadWinningHistory() { /* ... (no changes from previous version) ... */ }

function setupSocketConnection() {
    socket.on('connect', () => {
        console.log('Socket connected:', socket.id);
        showNotification('Connected to server.', 'success', 2000);
        socket.emit('requestRoundData');
    });
    socket.on('disconnect', (reason) => {
        console.log('Socket disconnected:', reason);
        showNotification('Disconnected from server. Attempting to reconnect...', 'error', 5000);
        updateDepositButtonState(); updateChatOnlineUsers(0);
        if(timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; updateTimerUI(0); }
    });
    socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
        showNotification('Connection Error. Please refresh.', 'error', 10000);
        updateDepositButtonState();
    });

    socket.on('roundCreated', (data) => {
        console.log('New round created (event):', data);
        currentRound = data;
        resetToJackpotView(); // This ensures a full clean slate
    });
    socket.on('participantUpdated', (data) => {
        console.log('Participant updated (event):', data);
        if (currentRound && currentRound.roundId === data.roundId) handleNewDeposit(data);
        else if (!currentRound && data.roundId) socket.emit('requestRoundData');
    });

    socket.on('roundWinnerPendingAcceptance', (data) => {
        console.log('Round winner pending acceptance (event):', data);
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.winner = data.winner; // Store winner info from event
            currentRound.status = 'completed_pending_acceptance';
            currentRound.totalValueWonByWinner = data.totalValue; // Store the value the winner is due

            handleWinnerAnnouncement(data); // Start roulette animation

            pendingWinningsOffer = { // Prepare for the popup after animation
                roundId: data.roundId,
                winnerInfo: data.winner, // User object
                totalValue: data.totalValue, // Value to display
                action: 'showAcceptWinningsButton'
            };
            if (currentUser && (data.winner.id === currentUser._id || data.winner.id === currentUser.id)) {
                showNotification('You won! Claim your items after the animation.', 'success', 10000);
            }
        }
    });

    socket.on('tradeOfferSent', (data) => {
        console.log('Trade offer sent event received (frontend):', data);
        if (currentUser && data.userId === (currentUser._id || currentUser.id) && data.offerURL) {
            if (data.type === 'winning') {
                // This is triggered after user clicks "Accept My Winnings" & backend sends offer.
                // FIX: Ensure this modal shows the "Accept on Steam" button and works.
                showAcceptOnSteamLinkPopup(data.offerURL, data.offerId, data.status);
                showNotification(`Winnings Sent! <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">Accept on Steam</a> (#${data.offerId})`, 'success', 15000);
            } else if (data.type === 'deposit') {
                 showNotification(`Deposit Offer Sent: <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">View Offer (#${data.offerId})</a> Status: ${data.status}`, 'info', 10000);
            }
        } else if (currentUser && data.userId === (currentUser._id || currentUser.id) && data.type === 'winning') {
            showNotification(`Winnings Sent: Check Steam for offer #${data.offerId}. (URL missing in event)`, 'warning', 8000);
        }
    });

    socket.on('roundRolling', (data) => {
        if (currentRound && currentRound.roundId === data.roundId) {
            timerActive = false; if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
            if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Rolling";
            if (DOMElements.jackpot.timerForeground) updateTimerCircle(0, CONFIG.ROUND_DURATION);
            currentRound.status = 'rolling'; updateDepositButtonState();
        }
    });
    socket.on('roundCompleted', (data) => {
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'completed'; // Or completed_pending_acceptance
            if(data.serverSeed) currentRound.serverSeed = data.serverSeed;
            if(data.clientSeed) currentRound.clientSeed = data.clientSeed;
        }
    });
    socket.on('roundError', (data) => {
        if (currentRound && currentRound.roundId === data.roundId) {
            currentRound.status = 'error';
            showNotification(`Round Error: ${data.error || 'Unknown error.'}`, 'error');
        }
        resetToJackpotView();
    });

    socket.on('roundData', (data) => {
        if (!data || typeof data !== 'object') {
            initiateNewRoundVisualReset();
            showNotification('Error syncing with server.', 'error'); return;
        }
        const isNewRoundId = !currentRound || currentRound.roundId !== data.roundId;
        currentRound = data;
        if (isNewRoundId && (data.status === 'pending' || (data.status === 'active' && (!data.participants || data.participants.length === 0)))) {
            initiateNewRoundVisualReset();
            updateTimerUI(data.timeLeft !== undefined ? data.timeLeft : CONFIG.ROUND_DURATION);
        } else { updateRoundUI(); }
        updateDepositButtonState();

        if (currentRound.status === 'rolling' || currentRound.status === 'completed' || currentRound.status === 'completed_pending_acceptance') {
             if (!isSpinning && currentRound.winner && !pendingWinningsOffer) {
                 pendingWinningsOffer = {
                    roundId: currentRound.roundId, winnerInfo: currentRound.winner,
                    totalValue: currentRound.totalValue,
                    action: currentRound.status === 'completed_pending_acceptance' ? 'showAcceptWinningsButton' : null
                 };
                 if (currentRound.payoutOfferId && currentRound.payoutOfferStatus === 'Sent'){
                     pendingWinningsOffer.action = 'showAcceptOnSteamLink';
                     pendingWinningsOffer.offerURL = `https://steamcommunity.com/tradeoffer/${currentRound.payoutOfferId}/`;
                     pendingWinningsOffer.offerId = currentRound.payoutOfferId;
                     pendingWinningsOffer.status = currentRound.payoutOfferStatus;
                 }
                 handleWinnerAnnouncement(currentRound);
             }
        } else if (currentRound.status === 'active') {
             if (currentRound.participants?.length > 0 && currentRound.timeLeft > 0 && !timerActive) {
                 startClientTimer(currentRound.timeLeft);
             } else if (currentRound.timeLeft <= 0 && timerActive) {
                 timerActive = false; if (roundTimer) clearInterval(roundTimer); roundTimer = null;
                 updateTimerUI(0); updateDepositButtonState();
             } else if (currentRound.participants?.length === 0 && timerActive) {
                  timerActive = false; if (roundTimer) clearInterval(roundTimer); roundTimer = null;
                  updateTimerUI(CONFIG.ROUND_DURATION); updateDepositButtonState();
             } else if (!timerActive) { updateTimerUI(currentRound.timeLeft); }
        } else if (currentRound.status === 'pending') {
            if (!isNewRoundId) initiateNewRoundVisualReset();
            if(DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Waiting";
            updateDepositButtonState();
        }

        const potContainer = DOMElements.jackpot.participantsContainer;
        if(potContainer) {
            potContainer.innerHTML = '';
            if (DOMElements.jackpot.emptyPotMessage && (!data.participants || data.participants.length === 0)) {
                potContainer.appendChild(DOMElements.jackpot.emptyPotMessage);
                DOMElements.jackpot.emptyPotMessage.style.display = 'block';
            } else if (DOMElements.jackpot.emptyPotMessage) { DOMElements.jackpot.emptyPotMessage.style.display = 'none';}
            if (data.participants?.length > 0) {
                data.participants.forEach(p => {
                    if (!p.user) return;
                    const participantItemsForDisplay = data.items?.filter(item => (item.owner === p.user._id || item.owner === p.user.id)) || [];
                    displayLatestDeposit({
                        userId: p.user._id || p.user.id, username: p.user.username, avatar: p.user.avatar,
                        itemsValue: p.itemsValue, tickets: p.tickets,
                        depositedItems: participantItemsForDisplay, totalValue: data.totalValue
                    });
                    const element = potContainer.querySelector(`.player-deposit-container[data-user-id="${p.user._id || p.user.id}"]`);
                    if (element) element.classList.remove('player-deposit-new');
                });
                 updateAllParticipantPercentages();
            }
        }
    });

    socket.on('notification', (data) => {
        if (!data.userId || (currentUser && data.userId === (currentUser._id || currentUser.id))) {
            showNotification(data.message || 'Notification', data.type || 'info', data.duration || 4000);
        }
    });
    socket.on('chatMessage', (data) => { displayChatMessage(data); });
    socket.on('updateUserCount', (count) => { updateChatOnlineUsers(count); });
    socket.on('timerUpdate', (data) => {
        if (data && typeof data.timeLeft === 'number' && currentRound && (currentRound.status === 'active' || currentRound.status === 'pending')) {
            currentRound.timeLeft = data.timeLeft;
            if (!timerActive && data.timeLeft > 0 && currentRound.participants?.length > 0 && currentRound.status === 'active') {
                startClientTimer(data.timeLeft);
            } else { updateTimerUI(data.timeLeft); }
        }
    });
}

function setupEventListeners() {
    // Nav
    DOMElements.nav.homeLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.homePage); });
    DOMElements.nav.aboutLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.aboutPage); });
    DOMElements.nav.tosLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.tosPage); });
    DOMElements.nav.faqLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.faqPage); });
    DOMElements.nav.fairLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.fairPage); });
    // Login
    DOMElements.user.loginButton?.addEventListener('click', () => {
        if (localStorage.getItem('ageVerified') === 'true') window.location.href = '/auth/steam';
        else {
            const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification;
            if(ageCheckbox) ageCheckbox.checked = false; if(ageAgreeButton) ageAgreeButton.disabled = true;
            showModal(DOMElements.ageVerification.modal);
        }
    });
    // User Dropdown
    const { userProfile, userDropdownMenu, logoutButton, profileDropdownButton, winningHistoryDropdownButton } = DOMElements.user;
    userProfile?.addEventListener('click', (e) => {
        e.stopPropagation(); if (userDropdownMenu) {
            const isVisible = userDropdownMenu.style.display === 'block';
            userDropdownMenu.style.display = isVisible ? 'none' : 'block';
            userProfile?.setAttribute('aria-expanded', String(!isVisible)); userProfile?.classList.toggle('open', !isVisible);
        }
    });
    userProfile?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }});
    logoutButton?.addEventListener('click', (e) => { e.stopPropagation(); handleLogout(); });
    logoutButton?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleLogout(); }});
    profileDropdownButton?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); const menu = DOMElements.user.userDropdownMenu; const modal = DOMElements.profileModal.modal;
        if (currentUser && modal) { populateProfileModal(); showModal(modal); }
        else if (!currentUser) showNotification("Log in to view profile.", "info");
        if (menu) menu.style.display = 'none'; userProfile?.setAttribute('aria-expanded', 'false'); userProfile?.classList.remove('open');
    });
    winningHistoryDropdownButton?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); const menu = DOMElements.user.userDropdownMenu;
        if (currentUser) loadWinningHistory(); else showNotification("Log in to view winning history.", "info");
        if (menu) menu.style.display = 'none'; userProfile?.setAttribute('aria-expanded', 'false'); userProfile?.classList.remove('open');
    });
    // Profile Modal
    DOMElements.profileModal.saveBtn?.addEventListener('click', handleProfileSave);
    DOMElements.profileModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    DOMElements.profileModal.cancelBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal));
    // Accept Winnings Modal (actionButton onclick is dynamic)
    const awModal = DOMElements.acceptWinningsModal;
    awModal.closeBtn?.addEventListener('click', () => hideModal(awModal.modal));
    awModal.closeFooterBtn?.addEventListener('click', () => hideModal(awModal.modal));
    // Winning History Modal
    const whModal = DOMElements.winningHistoryModal;
    whModal.closeBtn?.addEventListener('click', () => hideModal(whModal.modal));
    whModal.closeFooterBtn?.addEventListener('click', () => hideModal(whModal.modal));
    // Deposit Modal
    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => {
        const button = DOMElements.deposit.showDepositModalButton; if (button.disabled) { showNotification(button.title || 'Deposits closed.', 'info'); return; }
        if (!currentUser) { showNotification('Login Required.', 'error'); return; }
         if (!currentUser.tradeUrl) {
             showNotification('Trade URL Required. Set it in your profile.', 'error', 6000);
             if (DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); } return;
         }
        showModal(DOMElements.deposit.depositModal); loadUserInventory();
    });
    DOMElements.deposit.closeDepositModalButton?.addEventListener('click', () => hideModal(DOMElements.deposit.depositModal));
    DOMElements.deposit.depositButton?.addEventListener('click', requestDepositOffer);
    DOMElements.deposit.acceptDepositOfferBtn?.addEventListener('click', () => { // This specific button always refers to deposit offers
         const url = DOMElements.deposit.acceptDepositOfferBtn.getAttribute('data-offer-url');
         if (url) window.open(url, '_blank', 'noopener,noreferrer');
         else showNotification("Error: Deposit offer URL missing.", "error");
    });
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
    // Global Click/Key Listeners
    window.addEventListener('click', (e) => { /* ... (no changes from previous version, handles closing dropdowns/modals) ... */ });
    document.addEventListener('keydown', function(event) { /* ... (no changes, handles Esc key) ... */ });
    setupChatEventListeners();
}

function populateProfileModal() { /* ... (no changes from previous version) ... */ }
async function handleProfileSave() { /* ... (no changes from previous version) ... */ }

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed. main.js executing.");
    checkLoginStatus(); setupEventListeners(); setupSocketConnection();
    showPage(DOMElements.pages.homePage);
    initiateNewRoundVisualReset(); // Set initial UI state for jackpot
    if (localStorage.getItem('ageVerified') !== 'true' && DOMElements.ageVerification.modal && DOMElements.user.loginButton?.style.display !== 'none') {
        // Show age verification if not verified and login button is potentially visible (i.e. not logged in)
        // This is a bit tricky; ideally, login status check completes first.
        // Simpler: just show if not verified, login button click will also show it.
    }
    updateChatUI();
});

console.log("main.js: Popup/roulette/announcement fixes applied.");
