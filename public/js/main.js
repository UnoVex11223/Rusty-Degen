// main (14).js - PART 1 of 2
// main.js - Rust Jackpot Frontend Logic
// Modifications:
// - Addressed timer starting at zero issue.
// - Added logic to update client's currentRound.items from 'roundWinner' event.
// - Added extensive logging for roulette and winner display flow.

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
    ROULETTE_REPETITIONS: 20, // Not directly used in current animation logic, but kept for potential future use
    SPIN_DURATION_SECONDS: 6.5,
    WINNER_DISPLAY_DURATION: 8000, // Increased slightly to allow button interaction
    CONFETTI_COUNT: 150,
    EASE_OUT_POWER: 5,
    BOUNCE_ENABLED: false,
    BOUNCE_OVERSHOOT_FACTOR: 0.07,
    BOUNCE_DAMPING: 0.35,
    BOUNCE_FREQUENCY: 3.5,
    LANDING_POSITION_VARIATION: 0.60,
    MAX_CHAT_MESSAGES: 100, // Max chat messages to display
    CHAT_SEND_COOLDOWN_MS: 2000, // Frontend visual cooldown for chat send button
    ROULETTE_TRANSITION_DELAY: 300, // MODIFIED: Delay for faster transition to roulette
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
    winningHistoryModal: { // Added for Winning History
        modal: document.getElementById('winningHistoryModal'),
        closeBtn: document.getElementById('closeWinningHistoryModal'),
        closeFooterBtn: document.getElementById('winningHistoryModalCloseFooterBtn'),
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
        depositButton: document.getElementById('depositButton'), // This is the "Request Deposit Offer" button
        inventoryItemsContainer: document.getElementById('inventory-items'),
        selectedItemsContainer: document.getElementById('selectedItems'),
        totalValueDisplay: document.getElementById('totalValue'),
        inventoryLoadingIndicator: document.getElementById('inventory-loading'),
        acceptDepositOfferBtn: document.getElementById('acceptDepositOfferBtn'), // This is the "Accept on Steam" button in deposit modal
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
        acceptWinningOfferBtn: document.getElementById('acceptWinningOfferBtn'), // ADDED: Button for winner to accept trade
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

let currentUser = null; //
let currentRound = null; // This will store { roundId, status, timeLeft, totalValue, participants, items, serverSeedHash, winner?, offerURL?, _id (mongoId) }
let selectedItemsList = []; //
let userInventory = []; //
let isSpinning = false; //
let timerActive = false; // Flag to indicate if client-side interval timer is running
let roundTimer = null; // Stores the interval ID for the client-side timer
let animationFrameId = null; //
let userColorMap = new Map(); //
let notificationTimeout = null; //
let currentDepositOfferURL = null; // For the deposit modal's "Accept on Steam" button
let onlineUserCount = 0; //
let isChatSendOnCooldown = false; //

function showModal(modalElement) { //
    if (modalElement) modalElement.style.display = 'flex'; //
}

function hideModal(modalElement) { //
    if (modalElement) modalElement.style.display = 'none'; //
    if (modalElement === DOMElements.deposit.depositModal) { //
        resetDepositModalUI(); // Ensure deposit modal is reset when hidden
    }
}

function showPage(pageElement) { //
    Object.values(DOMElements.pages).forEach(page => { //
        if (page) page.style.display = 'none'; //
    });
    if (pageElement) pageElement.style.display = 'block'; //
    document.querySelectorAll('.main-nav a, .secondary-nav a, .primary-nav a') //
        .forEach(link => link?.classList.remove('active')); //
    let activeLink = null; //
    if (pageElement === DOMElements.pages.homePage) activeLink = DOMElements.nav.homeLink; //
    else if (pageElement === DOMElements.pages.aboutPage) activeLink = DOMElements.nav.aboutLink; //
    else if (pageElement === DOMElements.pages.tosPage) activeLink = DOMElements.nav.tosLink; //
    else if (pageElement === DOMElements.pages.faqPage) activeLink = DOMElements.nav.faqLink; //
    else if (pageElement === DOMElements.pages.fairPage) activeLink = DOMElements.nav.fairLink; //
    if (activeLink) activeLink.classList.add('active'); //

    if (pageElement === DOMElements.pages.fairPage) { //
        loadPastRounds(); // Load history when navigating to Provably Fair page
    }
}
window.showPage = showPage; // Make it globally accessible for inline script in HTML

function getUserColor(userId) { //
    if (!userId) return COLOR_PALETTE[COLOR_PALETTE.length - 1]; // Default color for unknown
    if (!userColorMap.has(userId)) { //
        const colorIndex = userColorMap.size % COLOR_PALETTE.length; //
        userColorMap.set(userId, COLOR_PALETTE[colorIndex]); //
    }
    return userColorMap.get(userId); //
}

function showNotification(message, type = 'info', duration = 4000) { //
    if (!DOMElements.notificationBar) { //
        console.warn("Notification bar element (#notification-bar) not found. Using console.log as fallback.");
        console.log(`[${type.toUpperCase()}] ${message}`); //
        return; //
    }
    const bar = DOMElements.notificationBar; //
    if (notificationTimeout) clearTimeout(notificationTimeout); //
    bar.innerHTML = message; // Using innerHTML for links, ensure server messages are sanitized if they come from user input
    bar.className = 'notification-bar'; // Reset classes
    bar.classList.add(type); // e.g., 'success', 'error', 'info'
    bar.classList.add('show'); //
    notificationTimeout = setTimeout(() => { //
        bar.classList.remove('show'); //
        notificationTimeout = null; //
    }, duration); //
}

function shuffleArray(array) { //
    let currentIndex = array.length, randomIndex; //
    while (currentIndex !== 0) { //
        randomIndex = Math.floor(Math.random() * currentIndex); //
        currentIndex--; //
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]]; //
    }
    return array; //
}

function easeOutAnimation(t) { //
    const clampedT = Math.max(0, Math.min(1, t)); //
    return 1 - Math.pow(1 - clampedT, CONFIG.EASE_OUT_POWER); //
}

function calculateBounce(t) { // Kept for potential future use, but BOUNCE_ENABLED is false
    if (!CONFIG.BOUNCE_ENABLED) return 0; //
    const clampedT = Math.max(0, Math.min(1, t)); //
    const decay = Math.exp(-clampedT / CONFIG.BOUNCE_DAMPING); //
    const oscillations = Math.sin(clampedT * Math.PI * 2 * CONFIG.BOUNCE_FREQUENCY); //
    return -decay * oscillations; //
}

function getComplementaryColor(hex) { //
    hex = hex.replace('#', ''); //
    let r = parseInt(hex.substring(0, 2), 16); //
    let g = parseInt(hex.substring(2, 4), 16); //
    let b = parseInt(hex.substring(4, 6), 16); //
    r = 255 - r; g = 255 - g; b = 255 - b; //
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`; //
}

function lightenColor(hex, percent) { //
    hex = hex.replace('#', ''); //
    let r = parseInt(hex.substring(0, 2), 16); //
    let g = parseInt(hex.substring(2, 4), 16); //
    let b = parseInt(hex.substring(4, 6), 16); //
    r = Math.min(255, Math.floor(r + (255 - r) * (percent / 100))); //
    g = Math.min(255, Math.floor(g + (255 - g) * (percent / 100))); //
    b = Math.min(255, Math.floor(b + (255 - b) * (percent / 100))); //
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`; //
}

function darkenColor(hex, percent) { //
    hex = hex.replace('#', ''); //
    let r = parseInt(hex.substring(0, 2), 16); //
    let g = parseInt(hex.substring(2, 4), 16); //
    let b = parseInt(hex.substring(4, 6), 16); //
    r = Math.max(0, Math.floor(r * (1 - percent / 100))); //
    g = Math.max(0, Math.floor(g * (1 - percent / 100))); //
    b = Math.max(0, Math.floor(b * (1 - percent / 100))); //
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`; //
}

async function handleLogout() { //
    console.log("Attempting logout...");
    try {
        const response = await fetch('/logout', { //
            method: 'POST', // Ensure it's a POST request as defined in app.js
        });
        if (!response.ok) { //
             const result = await response.json().catch(() => ({ error: 'Logout request failed.' })); //
            throw new Error(result.error || `Logout request failed with status ${response.status}.`); //
        }
        const result = await response.json(); //
         if (!result.success) { // Check for success flag from backend
             throw new Error(result.error || 'Logout unsuccessful according to server.'); //
         }
        console.log('Logout successful.');
        currentUser = null; //
        updateUserUI(); //
        updateDepositButtonState(); //
        updateChatUI(); //
        showNotification('You have been successfully signed out.', 'success'); //
    } catch (error) {
        console.error('Logout Error:', error);
        showNotification(`Logout failed: ${error.message}`, 'error'); //
    } finally {
        // Ensure dropdown is closed after logout attempt
        const { userDropdownMenu, userProfile } = DOMElements.user; //
        if (userDropdownMenu) { //
            userDropdownMenu.style.display = 'none'; //
            userProfile?.setAttribute('aria-expanded', 'false'); //
            userProfile?.classList.remove('open'); //
        }
    }
}


function resetDepositModalUI() { //
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit; //
    if (depositButton) { //
        depositButton.disabled = selectedItemsList.length === 0; // Re-evaluate based on selection
        depositButton.style.display = 'inline-block'; // Default to show request button
        depositButton.textContent = 'Request Deposit Offer'; //
    }
    if (acceptDepositOfferBtn) { //
        acceptDepositOfferBtn.style.display = 'none'; // Hide accept offer button
        acceptDepositOfferBtn.removeAttribute('data-offer-url'); // Clear any stored URL
    }
    if (depositStatusText) { //
        depositStatusText.textContent = ''; // Clear status text
        depositStatusText.className = 'deposit-status-text'; // Reset class
    }
    currentDepositOfferURL = null; // Clear stored offer URL
}


function updateDepositButtonState() { //
    const button = DOMElements.deposit.showDepositModalButton; //
    if (!button) return; //

    let disabled = false; //
    let title = 'Deposit Rust skins into the pot'; // Default title

    if (!currentUser) { //
        disabled = true; //
        title = 'Log in to deposit'; //
    } else if (currentUser.pendingDepositOfferId) { //
         disabled = true; // User has a pending offer, they shouldn't be able to create another
         title = 'You have a pending deposit offer. Please complete or cancel it on Steam (check profile for details).'; //
    } else if (!currentUser.tradeUrl) { //
         disabled = true; //
         title = 'Set your Steam Trade URL in your profile to deposit'; //
    } else if (isSpinning || (currentRound && currentRound.status === 'rolling')) { // Check isSpinning (client) and server status
        disabled = true; //
        title = 'Deposits closed during winner selection'; //
    } else if (!currentRound || currentRound.status !== 'active') { //
        disabled = true; //
        title = 'Deposits are currently closed'; //
        if (currentRound) { //
            switch (currentRound.status) { //
                // 'rolling' is already handled above
                case 'completed': //
                case 'error': title = 'Deposits closed (Round ended)'; break; //
                case 'pending': title = 'Deposits closed (Waiting for round)'; break; //
            }
        }
    } else if (currentRound.participants && currentRound.participants.length >= CONFIG.MAX_PARTICIPANTS_DISPLAY) { //
        disabled = true; //
        title = `Participant limit (${CONFIG.MAX_PARTICIPANTS_DISPLAY}) reached`; //
    } else if (currentRound.items && currentRound.items.length >= CONFIG.MAX_ITEMS_PER_POT_FRONTEND) { //
        disabled = true; //
        title = `Pot item limit (${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}) reached`; //
    } else if (timerActive && currentRound.timeLeft !== undefined && currentRound.timeLeft <= 0) { //
        // This condition implies the client-side timer hit zero but server hasn't declared 'rolling' yet.
        // Deposits should be closed.
        disabled = true; //
        title = 'Deposits closed (Round ending)'; //
    }


    button.disabled = disabled; //
    button.title = title; //
    button.classList.toggle('deposit-disabled', disabled); //
}

async function checkLoginStatus() { //
    try {
        const response = await fetch('/api/user'); //
        if (!response.ok) { //
            if (response.status === 401 || response.status === 403) { // Unauthorized or Forbidden
                currentUser = null; //
            } else { // Other server errors
                throw new Error(`Server error fetching user: ${response.status}`); //
            }
        } else { //
            currentUser = await response.json(); //
            console.log('User logged in:', currentUser?.username); //
        }
    } catch (error) {
        console.error('Error checking login status:', error); //
        currentUser = null; //
        // Avoid showing notification for typical "not logged in" scenarios (401/403)
        if (error.message && !error.message.includes("401") && !error.message.includes("403")) { //
            showNotification(`Error checking login: ${error.message}`, 'error'); //
        }
    } finally {
        updateUserUI(); //
        updateDepositButtonState(); //
        updateChatUI(); // Update chat based on login status
    }
}

function updateUserUI() { //
    const { loginButton, userProfile, userAvatar, userName, userDropdownMenu, pendingOfferIndicator } = DOMElements.user; //
    if (!loginButton || !userProfile) return; // Essential elements must exist

    if (currentUser) { //
        if (userAvatar) userAvatar.src = currentUser.avatar || '/img/default-avatar.png'; //
        if (userName) userName.textContent = currentUser.username || 'User'; //
        loginButton.style.display = 'none'; //
        userProfile.style.display = 'flex'; // Changed from inline-flex to flex for consistency
        userProfile.setAttribute('aria-disabled', 'false'); // Enable profile interactions

        // Pending offer indicator logic
        if (pendingOfferIndicator) { //
            const hasPending = !!currentUser.pendingDepositOfferId; //
            pendingOfferIndicator.style.display = hasPending ? 'inline-block' : 'none'; //
             if (hasPending) { //
                 pendingOfferIndicator.title = `You have a pending deposit offer (#${currentUser.pendingDepositOfferId})! Click your profile to see details.`; //
             }
        }

    } else { // Not logged in
        loginButton.style.display = 'flex'; // Changed from inline-flex
        userProfile.style.display = 'none'; //
        userProfile.setAttribute('aria-disabled', 'true'); //
        if (userDropdownMenu) { //
            userDropdownMenu.style.display = 'none'; // Ensure dropdown is closed
            userProfile.setAttribute('aria-expanded', 'false'); //
            userProfile.classList.remove('open'); //
        }
        if (pendingOfferIndicator) pendingOfferIndicator.style.display = 'none'; //
    }
}

async function loadUserInventory() { //
    const { inventoryItemsContainer, selectedItemsContainer, inventoryLoadingIndicator, totalValueDisplay } = DOMElements.deposit; //
    if (!inventoryItemsContainer || !selectedItemsContainer || !inventoryLoadingIndicator || !totalValueDisplay) { //
        console.error("Inventory DOM elements missing for loadUserInventory.");
        return; //
    }

    resetDepositModalUI(); // Reset buttons and status text in deposit modal
    selectedItemsList = []; // Clear current selection
    selectedItemsContainer.innerHTML = ''; // Clear display of selected items
    updateTotalValue(); // Reset total value display to $0.00

    inventoryLoadingIndicator.style.display = 'flex'; // Show spinner
    inventoryItemsContainer.innerHTML = ''; // Clear previous inventory items

    try {
        const response = await fetch('/api/inventory'); //
        if (!response.ok) { //
            let errorMsg = 'Failed to load your inventory.'; // Default message
            try {
                const errorData = await response.json(); // Try to get specific error from backend
                errorMsg = errorData.error || `Inventory load failed (Status: ${response.status})`; //
            } catch (e) { /* Ignore if parsing errorData itself fails, use default message */ }

            if (response.status === 401 || response.status === 403) { //
                errorMsg = 'Please log in to view your inventory.'; // More specific for auth issues
            }
            throw new Error(errorMsg); //
        }
        userInventory = await response.json(); //
        inventoryLoadingIndicator.style.display = 'none'; // Hide spinner

        if (!Array.isArray(userInventory)) { // Basic validation of received data
            throw new Error('Invalid inventory data format received from the server.'); //
        }

        if (userInventory.length === 0) { //
            inventoryItemsContainer.innerHTML = '<p class="empty-inventory-message">Your inventory is empty, not public, or no tradable Rust items meet the minimum value.</p>'; //
            return; //
        }
        displayInventoryItems(); // Render the fetched items

    } catch (error) {
        inventoryLoadingIndicator.style.display = 'none'; // Hide spinner on error too
        inventoryItemsContainer.innerHTML = `<p class="error-message">Error loading inventory: ${error.message}</p>`; //
        console.error('Error loading user inventory:', error); //
    }
}


function displayInventoryItems() { //
    const container = DOMElements.deposit.inventoryItemsContainer; //
    if (!container) return; //
    container.innerHTML = ''; // Clear previous items

    userInventory.forEach(item => { //
        // Ensure item has essential properties and valid price
        if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.assetId || !item.image) { //
            console.warn("Skipping invalid inventory item during display:", item); //
            return; //
        }

        const itemElement = document.createElement('div'); //
        itemElement.className = 'inventory-item'; //
        itemElement.dataset.assetId = item.assetId; //
        // itemElement.dataset.name = item.name; // Name not displayed directly on item, only price
        itemElement.dataset.image = item.image; //
        itemElement.dataset.price = item.price.toFixed(2); //
        itemElement.title = `$${item.price.toFixed(2)}`; // Tooltip shows price only

        itemElement.innerHTML = `
            <img src="${item.image}" alt="Skin Image" loading="lazy"
                 onerror="this.onerror=null; this.src='/img/default-item.png';">
            <div class="item-details">
                <div class="item-value">$${item.price.toFixed(2)}</div>
            </div>`; //

        // Check if item is already in selectedItemsList (e.g., if modal was re-opened without full reset)
        if (selectedItemsList.some(selected => selected.assetId === item.assetId)) { //
            itemElement.classList.add('selected'); //
        }

        itemElement.addEventListener('click', () => toggleItemSelection(itemElement, item)); //
        container.appendChild(itemElement); //
    });
}

function toggleItemSelection(element, item) { //
    if (typeof item.price !== 'number' || isNaN(item.price)) { //
        console.error("Attempted to select item with invalid price:", item); //
        showNotification('Selection Error: Cannot select item with invalid price.', 'error'); //
        return; //
    }

    const assetId = item.assetId; //
    const index = selectedItemsList.findIndex(i => i.assetId === assetId); //

    if (index === -1) { // Item not selected, try to select
        if (selectedItemsList.length >= CONFIG.MAX_ITEMS_PER_DEPOSIT) { //
            showNotification(`Selection Limit: You can select a maximum of ${CONFIG.MAX_ITEMS_PER_DEPOSIT} items per deposit.`, 'info'); //
            return; //
        }
        selectedItemsList.push(item); //
        element.classList.add('selected'); //
        addSelectedItemElement(item); //
    } else { // Item already selected, deselect
        selectedItemsList.splice(index, 1); //
        element.classList.remove('selected'); //
        removeSelectedItemElement(assetId); //
    }
    updateTotalValue(); //
    resetDepositModalUI(); // Enable/disable deposit button based on selection
}

function addSelectedItemElement(item) { //
    const container = DOMElements.deposit.selectedItemsContainer; //
    if (!container) return; //
    if (typeof item.price !== 'number' || isNaN(item.price)) { //
        console.error("Cannot add selected item element, invalid price:", item); //
        return; //
    }

    const selectedElement = document.createElement('div'); //
    selectedElement.className = 'selected-item-display'; //
    selectedElement.dataset.assetId = item.assetId; //
    selectedElement.title = `$${item.price.toFixed(2)}`; // Tooltip shows price only

    selectedElement.innerHTML = `
        <img src="${item.image}" alt="Selected Skin Image" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-item.png';">
        <div class="item-value">$${item.price.toFixed(2)}</div>
        <button class="remove-item-btn" title="Remove Item" data-asset-id="${item.assetId}" aria-label="Remove Item">&times;</button>
        `; //

    selectedElement.querySelector('.remove-item-btn')?.addEventListener('click', (e) => { //
        e.stopPropagation(); // Prevent triggering the parent click (which also removes)
        const assetIdToRemove = e.target.dataset.assetId; //
        if (assetIdToRemove) { //
            removeSelectedItem(assetIdToRemove); // This will also update inventory item class
            updateTotalValue(); //
            resetDepositModalUI(); //
        }
    });

    // Allow clicking the whole item to deselect it as well
    selectedElement.addEventListener('click', () => { //
        removeSelectedItem(item.assetId); //
        updateTotalValue(); //
        resetDepositModalUI(); //
    });

    container.appendChild(selectedElement); //
}

function removeSelectedItemElement(assetId) { //
    const container = DOMElements.deposit.selectedItemsContainer; //
    const selectedElement = container?.querySelector(`.selected-item-display[data-asset-id="${assetId}"]`); //
    if (selectedElement) selectedElement.remove(); //
}

function removeSelectedItem(assetId) { //
    selectedItemsList = selectedItemsList.filter(item => item.assetId !== assetId); //

    // Update visual state in the main inventory list
    const inventoryElement = DOMElements.deposit.inventoryItemsContainer?.querySelector(`.inventory-item[data-asset-id="${assetId}"]`); //
    if (inventoryElement) inventoryElement.classList.remove('selected'); //

    removeSelectedItemElement(assetId); // Remove from the "selected items" display
}

function updateTotalValue() { //
    const { totalValueDisplay } = DOMElements.deposit; //
    if (!totalValueDisplay) return; //

    const total = selectedItemsList.reduce((sum, item) => { //
        // Ensure price is a valid number before adding
        const price = typeof item.price === 'number' && !isNaN(item.price) ? item.price : 0; //
        return sum + price; //
    }, 0); //
    totalValueDisplay.textContent = `$${total.toFixed(2)}`; //
}


async function requestDepositOffer() { //
    const { depositButton, acceptDepositOfferBtn, depositStatusText } = DOMElements.deposit; //
    if (!depositButton || !acceptDepositOfferBtn || !depositStatusText) return; //

    if (selectedItemsList.length === 0) { //
        showNotification('No Items Selected: Please select items first.', 'info'); //
        return; //
    }
    if (!currentRound || currentRound.status !== 'active' || isSpinning) { showNotification('Deposit Error: Deposits are currently closed.', 'error'); return; } //
    if (currentUser?.pendingDepositOfferId) { //
        showNotification('Deposit Error: You already have a pending deposit offer. Check your profile or Steam.', 'error'); //
        if (DOMElements.profileModal.modal) { populateProfileModal(); showModal(DOMElements.profileModal.modal); } //
        return; //
    }

    // Client-side checks for limits before hitting the API
    const participantsLength = currentRound.participants?.length || 0; //
    const isNewParticipant = !currentRound.participants?.some(p => p.user?._id === currentUser?._id || p.user?.id === currentUser?._id); //
    if (isNewParticipant && participantsLength >= CONFIG.MAX_PARTICIPANTS_DISPLAY) { showNotification(`Deposit Error: Participant limit (${CONFIG.MAX_PARTICIPANTS_DISPLAY}) reached.`, 'error'); return; } //

    const itemsInPot = currentRound.items?.length || 0; //
    if (itemsInPot + selectedItemsList.length > CONFIG.MAX_ITEMS_PER_POT_FRONTEND) { //
        const slotsLeft = CONFIG.MAX_ITEMS_PER_POT_FRONTEND - itemsInPot; //
        showNotification(`Deposit Error: Pot item limit would be exceeded (Max ${CONFIG.MAX_ITEMS_PER_POT_FRONTEND}). Only ${slotsLeft} slots left.`, 'error', 6000); //
        return; //
    }


    depositButton.disabled = true; //
    depositButton.textContent = 'Requesting...'; //
    acceptDepositOfferBtn.style.display = 'none'; //
    depositStatusText.textContent = 'Creating deposit offer... Please wait.'; //
    depositStatusText.className = 'deposit-status-text info'; //
    let response; // Define response here to be accessible in catch

    try {
        const assetIds = selectedItemsList.map(item => item.assetId); //
        console.log("Requesting deposit offer for assetIds:", assetIds); //
        response = await fetch('/api/deposit', { // Assign to outer response
            method: 'POST', //
            headers: { 'Content-Type': 'application/json' }, //
            body: JSON.stringify({ assetIds }), //
        });
        const result = await response.json(); //

        if (!response.ok) { //
            if (response.status === 409 && result.offerURL && result.offerId) { //
                console.warn("User already has a pending offer:", result.offerId); //
                depositStatusText.textContent = `You already have a pending offer! Click 'Accept on Steam' to view it.`; //
                depositStatusText.className = 'deposit-status-text warning'; //
                currentDepositOfferURL = result.offerURL; //
                acceptDepositOfferBtn.style.display = 'inline-block'; //
                acceptDepositOfferBtn.disabled = false; //
                depositButton.style.display = 'none'; //
                if (currentUser && !currentUser.pendingDepositOfferId) { currentUser.pendingDepositOfferId = result.offerId; updateUserUI(); updateDepositButtonState(); } //
                return; //
            } else { //
                throw new Error(result.error || `Failed to create offer (${response.status})`); //
            }
        } else if (!result.success || !result.offerURL || !result.offerId) { //
            throw new Error(result.error || 'Backend did not return a valid offer URL and ID.'); //
        } else { //
            console.log("Deposit offer created:", result.offerId); //
            depositStatusText.textContent = "Offer created! Click 'Accept on Steam' below to complete."; //
            depositStatusText.className = 'deposit-status-text success'; //
            currentDepositOfferURL = result.offerURL; //
            depositButton.style.display = 'none'; //
            acceptDepositOfferBtn.style.display = 'inline-block'; //
            acceptDepositOfferBtn.disabled = false; //
            if(currentUser) { currentUser.pendingDepositOfferId = result.offerId; updateUserUI(); updateDepositButtonState(); } //
        }
    } catch (error) {
        console.error('Error requesting deposit offer:', error); //
        depositStatusText.textContent = `Error: ${error.message}`; //
        depositStatusText.className = 'deposit-status-text error'; //
        if (!(response && response.status === 409)) { // Check if response is defined
            resetDepositModalUI(); //
        }
        if (currentUser && currentUser.pendingDepositOfferId && !(response && response.status === 409)) { //
            console.log("Clearing potentially stale pending offer ID due to error."); //
            currentUser.pendingDepositOfferId = null; updateUserUI(); updateDepositButtonState(); //
        }
    }
}


function updateRoundUI() { //
    const { potValue, participantCount } = DOMElements.jackpot; //
    if (!currentRound || !potValue || !participantCount) { //
        console.warn("updateRoundUI: currentRound or DOM elements missing.", currentRound, potValue, participantCount);
        return;
    }

    potValue.textContent = `$${(currentRound.totalValue || 0).toFixed(2)}`; //

    // MODIFICATION: Ensure timeLeft is valid before updating timerUI
    let timeLeftForUI = CONFIG.ROUND_DURATION; // Default for a pending or freshly active round
    if (currentRound.status === 'active') {
        if (currentRound.endTime && new Date(currentRound.endTime) > Date.now()) {
            timeLeftForUI = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - Date.now()) / 1000));
        } else if (!currentRound.endTime && currentRound.participants && currentRound.participants.length > 0) {
            // Timer is expected to be running or just started, but endTime might not be set on client yet
            // Server 'timerUpdate' will soon correct this, or if client timer starts, it uses ROUND_DURATION
            timeLeftForUI = currentRound.timeLeft !== undefined ? currentRound.timeLeft : ROUND_DURATION;
        } else if (!currentRound.endTime && (!currentRound.participants || currentRound.participants.length === 0)) {
            timeLeftForUI = ROUND_DURATION; // Round active, no participants, show full time
        } else if (currentRound.endTime && new Date(currentRound.endTime) <= Date.now()) {
            timeLeftForUI = 0; // Timer should have ended
        }
    } else if (currentRound.status === 'rolling' || currentRound.status === 'completed' || currentRound.status === 'error') {
        timeLeftForUI = 0;
    } else if (currentRound.status === 'pending') {
        timeLeftForUI = CONFIG.ROUND_DURATION; // Show full duration for pending
    }

    if (!timerActive) { // Only update timer directly if not actively being managed by client-side interval
        updateTimerUI(timeLeftForUI);
    }


    const participantNum = currentRound.participants?.length || 0; //
    participantCount.textContent = `${participantNum}/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`; //
    updateParticipantsUI(); // Ensure empty message is handled correctly
}


function updateTimerUI(timeLeft) { //
    const { timerValue, timerForeground } = DOMElements.jackpot; //
    if (!timerValue || !timerForeground) return; //

    const timeToShow = Math.max(0, Math.round(timeLeft)); //
    let displayValue = timeToShow.toString(); //

    // MODIFICATION: Simplified timer display logic based on round status and timerActive
    if (currentRound && currentRound.status === 'active') {
        if (timerActive || timeToShow > 0) { // If client timer is running OR there's actual time left
            displayValue = timeToShow.toString();
        } else if (timeToShow <= 0 && currentRound.participants && currentRound.participants.length > 0) {
             // Timer ended for an active round with participants
            displayValue = "0";
        } else { // Active round, no participants, or timer hasn't "officially" started from server perspective
            displayValue = CONFIG.ROUND_DURATION.toString();
        }
    } else if (currentRound && currentRound.status === 'rolling') {
        displayValue = "0";
    } else if (isSpinning) {
        displayValue = "0";
    } else if (currentRound && (currentRound.status === 'completed' || currentRound.status === 'error')) {
        displayValue = "Ended";
    } else if (currentRound && currentRound.status === 'pending') {
        displayValue = "Waiting"; // Or CONFIG.ROUND_DURATION.toString();
    } else if (!currentRound) { // Initial state before any round data
        displayValue = "--";
    }


    timerValue.textContent = displayValue; //
    updateTimerCircle(timeToShow, CONFIG.ROUND_DURATION); //

    if (timerActive && timeToShow <= 10 && timeToShow > 0) { //
        timerValue.classList.add('urgent-pulse'); //
        timerValue.classList.remove('timer-pulse'); //
    } else { //
        timerValue.classList.remove('urgent-pulse'); //
        if (timerActive && timeToShow > 10) { //
            timerValue.classList.add('timer-pulse'); //
        } else { //
            timerValue.classList.remove('timer-pulse'); //
        }
    }
}

function updateTimerCircle(timeLeft, totalTime) { //
    const circle = DOMElements.jackpot.timerForeground; //
    if (!circle) return; //

    if (circle instanceof SVGCircleElement && circle.r?.baseVal?.value) { //
        const radius = circle.r.baseVal.value; //
        const circumference = 2 * Math.PI * radius; //
        let progress = 0; //
        // MODIFICATION: Simplified progress calculation logic
        if (currentRound && currentRound.status === 'active' && totalTime > 0) {
            if (currentRound.endTime && new Date(currentRound.endTime) > Date.now()) { // Timer is definitely running
                 progress = Math.min(1, Math.max(0, timeLeft / totalTime));
            } else if (!currentRound.endTime && (!currentRound.participants || currentRound.participants.length === 0)) {
                progress = 1; // Show full if active, no participants, and no endTime (timer not started)
            } else if (!currentRound.endTime && currentRound.participants && currentRound.participants.length > 0) {
                // Active, has participants, but client might not have endTime yet.
                // If timeLeft was passed as ROUND_DURATION, show full.
                progress = (timeLeft === totalTime) ? 1 : Math.min(1, Math.max(0, timeLeft / totalTime));
            } else { // Timer likely ended or invalid state for active progress
                progress = 0;
            }
        } else if (!currentRound || (currentRound && currentRound.status === 'pending')) { // No round or pending
            progress = 1; // Show full circle
        }
        // For 'rolling', 'completed', 'error', progress remains 0 (empty circle)

        const offset = circumference * (1 - progress); //
        circle.style.strokeDasharray = `${circumference}`; //
        circle.style.strokeDashoffset = `${Math.max(0, offset)}`; //
    }
}

function updateAllParticipantPercentages() { //
    if (!currentRound || !currentRound.participants || currentRound.participants.length === 0) return; //
    const container = DOMElements.jackpot.participantsContainer; //
    if (!container) return; //

    const depositBlocks = container.querySelectorAll('.player-deposit-container'); //
    const currentTotalPotValue = Math.max(0.01, currentRound.totalValue || 0.01); //

    depositBlocks.forEach(block => { //
        const userId = block.dataset.userId; //
        if (!userId) return; //

        const participantData = currentRound.participants.find(p => p.user?._id === userId || p.user?.id === userId); //
        if (!participantData) return; //

        const cumulativeValue = participantData.itemsValue || 0; //
        const percentage = ((cumulativeValue / currentTotalPotValue) * 100).toFixed(1); //
        const valueElement = block.querySelector('.player-deposit-value'); //

        if (valueElement) { //
            const userColor = getUserColor(userId); //
            valueElement.textContent = `$${cumulativeValue.toFixed(2)} | ${percentage}%`; //
            valueElement.title = `Deposited: $${cumulativeValue.toFixed(2)} | Chance: ${percentage}%`; //
            valueElement.style.color = userColor; //
        }
    });
}


function displayLatestDeposit(data) { //
    const container = DOMElements.jackpot.participantsContainer; //
    const emptyMsg = DOMElements.jackpot.emptyPotMessage; //
    if (!container) return; //

    const userId = data.userId || data.user?._id; //
    if (!userId || typeof data.itemsValue !== 'number' || isNaN(data.itemsValue)) { //
        console.error("Invalid data passed to displayLatestDeposit:", data); //
        return; //
    }

    const depositSfx = DOMElements.audio.depositSound; //
    if (depositSfx) { //
        depositSfx.volume = 0.6; //
        depositSfx.currentTime = 0; //
        depositSfx.play().catch(e => console.error("Error playing deposit sound:", e)); //
    }

    const username = data.username || data.user?.username || 'Unknown User'; //
    const avatar = data.avatar || data.user?.avatar || '/img/default-avatar.png'; //
    const value = data.itemsValue; //
    const items = data.depositedItems || []; //
    const userColor = getUserColor(userId); //

    const participantData = currentRound?.participants?.find(p => (p.user?._id === userId || p.user?.id === userId)); //
    const cumulativeValue = participantData ? participantData.itemsValue : value; //
    const currentTotalPotValue = Math.max(0.01, currentRound?.totalValue || 0.01); //
    const percentage = ((cumulativeValue / currentTotalPotValue) * 100).toFixed(1); //

    const depositContainer = document.createElement('div'); //
    depositContainer.dataset.userId = userId; //
    depositContainer.className = 'player-deposit-container player-deposit-new'; //

    const depositHeader = document.createElement('div'); //
    depositHeader.className = 'player-deposit-header'; //
    depositHeader.innerHTML = `
        <img src="${avatar}" alt="${username}" class="player-avatar" loading="lazy"
             onerror="this.onerror=null; this.src='/img/default-avatar.png';" style="border-color: ${userColor};">
        <div class="player-info">
            <div class="player-name" title="${username}">${username}</div>
            <div class="player-deposit-value" style="color: ${userColor}" title="Deposited: $${cumulativeValue.toFixed(2)} | Chance: ${percentage}%">
                $${cumulativeValue.toFixed(2)} | ${percentage}%
            </div>
        </div>`; //

    const itemsGrid = document.createElement('div'); //
    itemsGrid.className = 'player-items-grid'; //

    if (items.length > 0) { //
        items.sort((a, b) => (b.price || 0) - (a.price || 0)); //
        const displayItems = items.slice(0, CONFIG.MAX_ITEMS_PER_DEPOSIT); //

        displayItems.forEach(item => { //
            if (!item || typeof item.price !== 'number' || isNaN(item.price) || !item.image) { //
                console.warn("Skipping invalid item in deposit display:", item); //
                return; //
            }
            const itemElement = document.createElement('div'); //
            itemElement.className = 'player-deposit-item'; //
            itemElement.title = `$${item.price.toFixed(2)}`; //
            itemElement.style.borderColor = userColor; //
            itemElement.innerHTML = `
                <img src="${item.image}" alt="Skin Image" class="player-deposit-item-image" loading="lazy"
                     onerror="this.onerror=null; this.src='/img/default-item.png';">
                <div class="player-deposit-item-info">
                    <div class="player-deposit-item-value" style="color: ${userColor}">$${item.price.toFixed(2)}</div>
                </div>`; //
            itemsGrid.appendChild(itemElement); //
        });

        if (items.length > CONFIG.MAX_ITEMS_PER_DEPOSIT) { //
            const moreItems = document.createElement('div'); //
            moreItems.className = 'player-deposit-item-more'; //
            moreItems.style.color = userColor; //
            moreItems.textContent = `+${items.length - CONFIG.MAX_ITEMS_PER_DEPOSIT} more`; //
            itemsGrid.appendChild(moreItems); //
        }
    }

    depositContainer.appendChild(depositHeader); //
    depositContainer.appendChild(itemsGrid); //

    if (container.firstChild) { //
        container.insertBefore(depositContainer, container.firstChild); //
    } else { //
        container.appendChild(depositContainer); //
    }

    if (emptyMsg) emptyMsg.style.display = 'none'; //

    setTimeout(() => { //
        depositContainer.classList.remove('player-deposit-new'); //
    }, 500); //

    const currentDepositBlocks = container.querySelectorAll('.player-deposit-container'); //
    if (currentDepositBlocks.length > CONFIG.MAX_DISPLAY_DEPOSITS) { //
        const blocksToRemove = currentDepositBlocks.length - CONFIG.MAX_DISPLAY_DEPOSITS; //
        for (let i = 0; i < blocksToRemove; i++) { //
            const oldestBlock = container.querySelector('.player-deposit-container:last-child'); //
            if (oldestBlock && oldestBlock !== depositContainer) { //
                oldestBlock.style.transition = 'opacity 0.3s ease-out'; //
                oldestBlock.style.opacity = '0'; //
                setTimeout(() => { //
                    if (oldestBlock.parentNode === container) { //
                        oldestBlock.remove(); //
                    }
                }, 300); //
            }
        }
    }
}


// main (14).js - PART 2 of 2

// MODIFICATION: Added logging
function handleRouletteSpinAnimation(winningElement, winner) { //
    console.log('[DEBUG] handleRouletteSpinAnimation called. WinningElement:', winningElement, 'Winner:', winner);
    const track = DOMElements.roulette.rouletteTrack; //
    const container = DOMElements.roulette.inlineRouletteContainer?.querySelector('.roulette-container'); //
    if (!winningElement || !track || !container) { //
        console.error("[DEBUG] CRITICAL_ERROR in handleRouletteSpinAnimation: Missing elements for roulette animation loop. Resetting.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return; //
    }

    const containerWidth = container.offsetWidth; //
    const itemWidth = winningElement.offsetWidth || 90; // Use actual or default (90px from CSS)
    const itemOffsetLeft = winningElement.offsetLeft; //

    if (itemWidth === 0) {
        console.error("[DEBUG] CRITICAL_ERROR in handleRouletteSpinAnimation: winningElement.offsetWidth is 0. Items might not be visible. Resetting.");
        isSpinning = false; updateDepositButtonState(); resetToJackpotView(); return;
    }

    const centerOffset = (containerWidth / 2) - (itemWidth / 2); //
    const perfectCenterScrollPosition = -(itemOffsetLeft - centerOffset); //

    const initialVariation = (Math.random() * 2 - 1) * (itemWidth * CONFIG.LANDING_POSITION_VARIATION); //
    const maxAllowedAbsVariation = itemWidth * 0.49; //
    let finalVariation; //
    if (Math.abs(initialVariation) <= maxAllowedAbsVariation) { //
        finalVariation = initialVariation; //
    } else { //
        finalVariation = Math.sign(initialVariation) * maxAllowedAbsVariation; //
    }
    const targetScrollPosition = perfectCenterScrollPosition + finalVariation; //
    const finalTargetPosition = targetScrollPosition; //
    console.log(`[DEBUG] handleRouletteSpinAnimation: ContainerWidth=${containerWidth}, ItemWidth=${itemWidth}, ItemOffsetLeft=${itemOffsetLeft}, CenterOffset=${centerOffset}, PerfectCenterScroll=${perfectCenterScrollPosition}, FinalVariation=${finalVariation}, TargetScroll=${targetScrollPosition}`);

    const startPosition = parseFloat(track.style.transform?.match(/translateX\(([-.\d]+)px\)/)?.[1] || '0'); //
    const duration = CONFIG.SPIN_DURATION_SECONDS * 1000; //
    const bounceDuration = CONFIG.BOUNCE_ENABLED ? 1200 : 0; //
    const totalAnimationTime = duration + bounceDuration; //
    const totalDistance = finalTargetPosition - startPosition; //
    const overshootAmount = totalDistance * CONFIG.BOUNCE_OVERSHOOT_FACTOR; //

    let startTime = performance.now(); //
    track.style.transition = 'none'; //

    if (!window.animateRouletteCallCount) window.animateRouletteCallCount = 0; // Initialize if not present

    function animateRoulette(timestamp) { //
        if (!isSpinning) { //
            console.log("[DEBUG] animateRoulette: Animation loop stopped: isSpinning false."); //
            if (animationFrameId) cancelAnimationFrame(animationFrameId); //
            animationFrameId = null; return; //
        }

        const elapsed = timestamp - startTime; //
        let currentPosition, animationFinished = false; //

        if (elapsed <= duration) { //
            const animationPhaseProgress = elapsed / duration; //
            const easedProgress = easeOutAnimation(animationPhaseProgress); //
            currentPosition = startPosition + totalDistance * easedProgress; //
        } else if (CONFIG.BOUNCE_ENABLED && elapsed <= totalAnimationTime) { //
            const bouncePhaseProgress = (elapsed - duration) / bounceDuration; //
            const bounceDisplacementFactor = calculateBounce(bouncePhaseProgress); //
            currentPosition = finalTargetPosition - (overshootAmount * bounceDisplacementFactor); //
        } else { //
            currentPosition = finalTargetPosition; animationFinished = true; //
        }

        track.style.transform = `translateX(${currentPosition}px)`; //

        // MODIFICATION: Logging inside animation loop
        window.animateRouletteCallCount++;
        if (window.animateRouletteCallCount % 30 === 1) { // Log roughly every half second at 60fps
            // console.log(`[DEBUG] animateRoulette: Frame ${window.animateRouletteCallCount}, Elapsed: ${elapsed.toFixed(0)}ms, Pos: ${currentPosition.toFixed(2)}px, Target: ${finalTargetPosition.toFixed(2)}px`);
        }

        if (!animationFinished) { //
            animationFrameId = requestAnimationFrame(animateRoulette); //
        } else { //
            console.log("[DEBUG] animateRoulette: Animation finished naturally in loop. Calling finalizeSpin."); //
            window.animateRouletteCallCount = 0; // Reset counter
            animationFrameId = null; //
            finalizeSpin(winningElement, winner); //
        }
    }
    if (animationFrameId) cancelAnimationFrame(animationFrameId); //
    animationFrameId = requestAnimationFrame(animateRoulette); //
}


// MODIFICATION: Added logging
function finalizeSpin(winningElement, winner) { //
    console.log('[DEBUG] finalizeSpin: Called. Winning Element:', winningElement, 'Winner:', winner);
    if ((!isSpinning && winningElement?.classList.contains('winner-highlight')) || !winningElement || !winner?.user) { //
        console.warn("[DEBUG] finalizeSpin: Called, but seems already finalized or data invalid. Bailing.");
        if (isSpinning) { isSpinning = false; updateDepositButtonState(); resetToJackpotView(); } //
        return; //
    }
    console.log("[DEBUG] finalizeSpin: Applying highlight to winner element."); //

    const winnerId = winner.user.id || winner.user._id; //
    const userColor = getUserColor(winnerId); //

    winningElement.classList.add('winner-highlight'); //

    const styleId = 'winner-pulse-style'; //
    document.getElementById(styleId)?.remove(); //
    const style = document.createElement('style'); //
    style.id = styleId; //
    style.textContent = `
        .winner-highlight {
            z-index: 5; border-width: 3px; border-color: ${userColor};
            animation: winnerPulse 1.5s infinite; --winner-color: ${userColor};
            transform: scale(1.05);
        }
        @keyframes winnerPulse {
            0%, 100% { box-shadow: 0 0 15px var(--winner-color); transform: scale(1.05); }
            50% { box-shadow: 0 0 25px var(--winner-color), 0 0 10px var(--winner-color); transform: scale(1.1); }
        }`; //
    document.head.appendChild(style); //

    console.log('[DEBUG] finalizeSpin: Setting timeout to call handleSpinEnd.');
    setTimeout(() => { //
        console.log('[DEBUG] finalizeSpin (timeout): Calling handleSpinEnd.');
        handleSpinEnd(winningElement, winner); //
    }, 300); //
}

// MODIFICATION: Added extensive logging
function handleSpinEnd(winningElement, winner) { //
    console.error('[DEBUG] CRITICAL_POINT: handleSpinEnd CALLED. Winner:', winner, 'Winning Element:', winningElement); // Make this stand out

    if (!winningElement || !winner?.user) { //
        console.error("[DEBUG] CRITICAL_ERROR in handleSpinEnd: Called with invalid data/element. Resetting. Winner:", winner, "Element:", winningElement);
        if (!isSpinning && !winningElement?.classList.contains('winner-highlight')) { // If not spinning and not already finalized
             console.warn("[DEBUG] handleSpinEnd: Spin already ended or was not started properly."); //
        } else if (isSpinning) { // If it was spinning, reset
             console.warn("[DEBUG] handleSpinEnd: Was still spinning, forcing reset.");
             isSpinning = false; updateDepositButtonState(); resetToJackpotView(); //
        }
        return; //
    }
    if (animationFrameId) { console.log("[DEBUG] handleSpinEnd: Cancelling lingering animationFrameId."); cancelAnimationFrame(animationFrameId); animationFrameId = null; } //

    console.log("[DEBUG] handleSpinEnd: Displaying winner info, confetti, and trade offer button."); //
    const { winnerInfoBox, winnerAvatar, winnerName, winnerDeposit, winnerChance, acceptWinningOfferBtn } = DOMElements.roulette; //

    if (winnerInfoBox && winnerAvatar && winnerName && winnerDeposit && winnerChance && acceptWinningOfferBtn) { //
        const winnerId = winner.user.id || winner.user._id; //
        const userColor = getUserColor(winnerId); //

        winnerAvatar.src = winner.user.avatar || '/img/default-avatar.png'; //
        winnerAvatar.alt = winner.user.username || 'Winner'; //
        winnerAvatar.style.borderColor = userColor; //
        winnerAvatar.style.boxShadow = `0 0 15px ${userColor}`; //

        winnerName.textContent = winner.user.username || 'Winner'; //
        winnerName.style.color = userColor; //

        // MODIFICATION: Use findWinnerFromData to get accurate deposit/percentage for the display
        const displayWinnerData = findWinnerFromData({ winner: winner.user }); // Pass only the user part
        const depositValueStr = `$${(displayWinnerData.value || 0).toFixed(2)}`;
        const chanceValueStr = `${(displayWinnerData.percentage || 0).toFixed(2)}%`;


        winnerDeposit.textContent = ''; //
        winnerChance.textContent = ''; //

        winnerInfoBox.style.display = 'flex'; //
        winnerInfoBox.style.opacity = '0'; //
        winnerInfoBox.style.animation = 'fadeIn 0.5s ease forwards'; //

        if (currentUser && (currentUser._id === winnerId || currentUser.id === winnerId)) { //
            console.log("[DEBUG] handleSpinEnd: Current user is the winner. Showing 'Accept Winnings' button.");
            acceptWinningOfferBtn.style.display = 'inline-block'; // Show button for the winner
            acceptWinningOfferBtn.classList.remove('ready'); // Reset ready state
            acceptWinningOfferBtn.onclick = () => { //
                if (currentRound && currentRound.offerURL) { //
                    console.log(`[DEBUG] handleSpinEnd: Winner accepting trade via URL: ${currentRound.offerURL}`);
                    window.open(currentRound.offerURL, '_blank', 'noopener,noreferrer'); //
                } else { //
                    console.warn("[DEBUG] handleSpinEnd: Accept Winnings clicked, but currentRound.offerURL is missing. CurrentRound:", currentRound);
                    showNotification("Preparing your trade offer... please wait a moment. If this persists, check notifications or winning history.", "info", 6000); //
                }
            };
        } else { //
            console.log("[DEBUG] handleSpinEnd: Current user is NOT the winner. Hiding 'Accept Winnings' button.");
            acceptWinningOfferBtn.style.display = 'none'; // Hide for non-winners
        }


        setTimeout(() => { // Typing animation for stats
            let depositIndex = 0; let chanceIndex = 0; const typeDelay = 35; //
            if (window.typeDepositInterval) clearInterval(window.typeDepositInterval); //
            if (window.typeChanceInterval) clearInterval(window.typeChanceInterval); //

            window.typeDepositInterval = setInterval(() => { //
                if (depositIndex < depositValueStr.length) { //
                    winnerDeposit.textContent += depositValueStr[depositIndex]; depositIndex++; //
                } else { //
                    clearInterval(window.typeDepositInterval); window.typeDepositInterval = null; //
                    window.typeChanceInterval = setInterval(() => { //
                        if (chanceIndex < chanceValueStr.length) { //
                            winnerChance.textContent += chanceValueStr[chanceIndex]; chanceIndex++; //
                        } else { //
                            clearInterval(window.typeChanceInterval); window.typeChanceInterval = null; //
                            console.log("[DEBUG] handleSpinEnd: Stats typing animation complete. Launching confetti.");
                            setTimeout(() => { launchConfetti(userColor); }, 200); //
                        }
                    }, typeDelay); //
                }
            }, typeDelay); //
        }, 500); //
    } else { //
        console.error("[DEBUG] CRITICAL_ERROR in handleSpinEnd: Winner info display elements or accept button missing."); //
    }

    isSpinning = false; // Set spinning to false once animation is done
    updateDepositButtonState(); // Update buttons now that spinning is false
    console.log("[DEBUG] handleSpinEnd: isSpinning set to false. Setting timeout for round reset.");

    setTimeout(() => { //
        // Only reset if this specific round's animation has truly completed and not been superseded
        // And if currentRound still exists and has a winner that matches
        if (!isSpinning && currentRound && currentRound.winner && winner && winner.user && (currentRound.winner.id === winner.user.id || currentRound.winner._id === winner.user.id)) { //
            console.log(`[DEBUG] handleSpinEnd (timeout ${CONFIG.WINNER_DISPLAY_DURATION}ms): Winner display duration ended for winner ${winner.user.username}. Resetting pot and requesting new round data.`);
            // MODIFICATION: Ensure currentRound is fully nulled to prevent stale data issues for next round's roulette items if socket events are slightly delayed.
            currentRound = null; // CRITICAL: Clear current round data to force complete refresh from server for next round.
            initiateNewRoundVisualReset(); // Visually clear pot items, timer etc.
            socket.emit('requestRoundData'); // Request data for the next round from server
        } else { //
            console.warn(`[DEBUG] handleSpinEnd (timeout ${CONFIG.WINNER_DISPLAY_DURATION}ms): Winner display duration ended, but state changed or not the current winner. Skipping full reset. isSpinning: ${isSpinning}, currentRound winner: ${currentRound?.winner?.id || currentRound?.winner?._id}, displayed winner: ${winner?.user?.id || winner?.user?._id}`);
            // Still good to ensure UI is in a somewhat clean state if possible, without nulling currentRound if a new one has arrived.
            if (!isSpinning) { // If another spin hasn't started
                const header = DOMElements.jackpot.jackpotHeader;
                if (header && header.classList.contains('roulette-mode')) {
                    // If it's stuck in roulette mode but shouldn't be, try a soft reset of view
                    console.log("[DEBUG] handleSpinEnd (timeout): Attempting a soft visual reset as round state seems desynced from winner display.");
                    resetToJackpotView(); // This will clear roulette view elements.
                }
                // Request fresh data anyway to re-sync if something went wrong.
                socket.emit('requestRoundData');
            }
        }
    }, CONFIG.WINNER_DISPLAY_DURATION); //
}


function launchConfetti(mainColor = '#00e676') { //
    const container = DOMElements.roulette.confettiContainer; //
    if (!container) return; //
    clearConfetti(); //

    const baseColor = mainColor; //
    const complementaryColor = getComplementaryColor(baseColor); //
    const lighterColor = lightenColor(baseColor, 30); //
    const darkerColor = darkenColor(baseColor, 30); //
    const colors = [baseColor, lighterColor, darkerColor, complementaryColor, '#ffffff', lightenColor(complementaryColor, 20)]; //

    for (let i = 0; i < CONFIG.CONFETTI_COUNT; i++) { //
        const confetti = document.createElement('div'); //
        confetti.className = 'confetti-piece'; //
        confetti.style.left = `${Math.random() * 100}%`; //

        const animDuration = 2 + Math.random() * 3; //
        const animDelay = Math.random() * 1.5; //

        confetti.style.setProperty('--duration', `${animDuration}s`); //
        confetti.style.setProperty('--delay', `${animDelay}s`); //
        confetti.style.setProperty('--color', colors[Math.floor(Math.random() * colors.length)]); //

        const size = Math.random() * 8 + 4; //
        confetti.style.width = `${size}px`; confetti.style.height = `${size}px`; //

        const rotationStart = Math.random() * 360; //
        const rotationEnd = rotationStart + (Math.random() - 0.5) * 720; //
        const fallX = (Math.random() - 0.5) * 100; //

        confetti.style.setProperty('--fall-x', `${fallX}px`); //
        confetti.style.setProperty('--rotation-start', `${rotationStart}deg`); //
        confetti.style.setProperty('--rotation-end', `${rotationEnd}deg`); //

        if (Math.random() < 0.5) confetti.style.borderRadius = '50%'; //
        container.appendChild(confetti); //
    }
}

function clearConfetti() { //
    if (DOMElements.roulette.confettiContainer) DOMElements.roulette.confettiContainer.innerHTML = ''; //
    document.getElementById('winner-pulse-style')?.remove(); //
    document.querySelectorAll('.roulette-item.winner-highlight').forEach(el => { //
        el.classList.remove('winner-highlight'); //
        el.style.transform = ''; //
        if (el.dataset?.userId) el.style.borderColor = getUserColor(el.dataset.userId); //
        else el.style.borderColor = 'transparent'; //
    });
}

function resetToJackpotView() { //
    console.log("[DEBUG] resetToJackpotView: Called.");
    if (animationFrameId) { console.log("[DEBUG] resetToJackpotView: Cancelling animationFrameId."); cancelAnimationFrame(animationFrameId); animationFrameId = null; }
    if (window.soundFadeInInterval) clearInterval(window.soundFadeInInterval); window.soundFadeInInterval = null; //
    if (window.soundFadeOutInterval) clearInterval(window.soundFadeOutInterval); window.soundFadeOutInterval = null; //
    if (window.typeDepositInterval) clearInterval(window.typeDepositInterval); window.typeDepositInterval = null; //
    if (window.typeChanceInterval) clearInterval(window.typeChanceInterval); window.typeChanceInterval = null; //

    timerActive = false; // Reset client-side timer flag
    isSpinning = false; // Ensure spinning is false

    const header = DOMElements.jackpot.jackpotHeader; //
    const rouletteContainer = DOMElements.roulette.inlineRouletteContainer; //
    const winnerInfoBox = DOMElements.roulette.winnerInfoBox; //
    const track = DOMElements.roulette.rouletteTrack; //
    const acceptWinningOfferBtn = DOMElements.roulette.acceptWinningOfferBtn; //

    if (!header || !rouletteContainer || !winnerInfoBox || !track || !acceptWinningOfferBtn) { //
        console.error("[DEBUG] Missing elements for resetToJackpotView. Cannot fully reset UI."); return; //
    }

    const sound = DOMElements.audio.spinSound; //
    if (sound) { sound.pause(); sound.currentTime = 0; sound.volume = 1.0; sound.playbackRate = 1.0; } //

    rouletteContainer.style.transition = 'opacity 0.5s ease'; //
    rouletteContainer.style.opacity = '0'; //
    if (winnerInfoBox.style.display !== 'none') { //
        winnerInfoBox.style.transition = 'opacity 0.3s ease'; //
        winnerInfoBox.style.opacity = '0'; //
    }
    clearConfetti(); //

    acceptWinningOfferBtn.style.display = 'none'; //
    acceptWinningOfferBtn.classList.remove('ready'); //
    acceptWinningOfferBtn.onclick = null; //

    setTimeout(() => { //
        if (header) header.classList.remove('roulette-mode'); //
        if (track) { track.style.transition = 'none'; track.style.transform = 'translateX(0)'; track.innerHTML = ''; } //
        if (rouletteContainer) rouletteContainer.style.display = 'none'; //
        if (winnerInfoBox) { winnerInfoBox.style.display = 'none'; winnerInfoBox.style.opacity = ''; winnerInfoBox.style.animation = ''; } //

        const valueDisplay = header?.querySelector('.jackpot-value'); //
        const timerDisplay = header?.querySelector('.jackpot-timer'); //
        const statsDisplay = header?.querySelector('.jackpot-stats'); //

        [valueDisplay, timerDisplay, statsDisplay].forEach((el, index) => { //
            if (el) { //
                const computedStyle = window.getComputedStyle(el); //
                el.style.display = computedStyle.display !== 'none' ? computedStyle.display : 'flex'; //
                el.style.opacity = '0'; //
                setTimeout(() => { //
                    el.style.transition = 'opacity 0.5s ease'; //
                    el.style.opacity = '1'; //
                }, 50 + index * 50); //
            }
        });
        
        // Don't call initiateNewRoundVisualReset here directly as it might be too aggressive
        // if a 'roundData' event is about to arrive with new info.
        // However, ensuring timer display is reset visually is good.
        updateTimerUI(currentRound && currentRound.timeLeft !== undefined ? currentRound.timeLeft : CONFIG.ROUND_DURATION);
        if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.classList.remove('urgent-pulse', 'timer-pulse'); //

        updateDepositButtonState(); //

        // If socket is disconnected, it's safer to clear local currentRound.
        // If connected, 'roundData' event should handle the refresh.
        if (!socket.connected) { //
            console.log("[DEBUG] resetToJackpotView: Socket disconnected, clearing local currentRound data and performing full visual reset."); //
            currentRound = null; //
            initiateNewRoundVisualReset(); // Perform full visual reset if disconnected
        } else {
            console.log("[DEBUG] resetToJackpotView: Socket connected. Relying on server events for next round data.");
            // It might be good to request data if currentRound is now inconsistent.
            // socket.emit('requestRoundData'); // Reconsider if this is needed here or handled elsewhere.
        }

    }, 500); //
}


function initiateNewRoundVisualReset() { //
    console.log("[DEBUG] initiateNewRoundVisualReset: Called.");
    // Stop any active client timer explicitly
    if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
    timerActive = false;

    // Reset timer display to full (or based on a fresh 'pending' state if currentRound was updated)
    updateTimerUI(CONFIG.ROUND_DURATION);
    if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.classList.remove('urgent-pulse', 'timer-pulse'); //

    const container = DOMElements.jackpot.participantsContainer; //
    const emptyMsg = DOMElements.jackpot.emptyPotMessage; //
    if (container && emptyMsg) { //
        container.innerHTML = ''; // Clear ALL participant blocks
        if (!container.contains(emptyMsg)) container.appendChild(emptyMsg); // Ensure empty message is there
        emptyMsg.style.display = 'block'; // Show it
    }

    if (DOMElements.jackpot.potValue) DOMElements.jackpot.potValue.textContent = "$0.00"; //
    if (DOMElements.jackpot.participantCount) DOMElements.jackpot.participantCount.textContent = `0/${CONFIG.MAX_PARTICIPANTS_DISPLAY}`; //

    userColorMap.clear(); //
    updateDepositButtonState(); //
    // Do NOT nullify currentRound here directly in this visual reset function.
    // currentRound should be managed by the 'roundData' event or when a round truly concludes (like in handleSpinEnd timeout).
    // This function primarily resets the *visuals* to prepare for new round data.
    console.log("[DEBUG] initiateNewRoundVisualReset: Visuals reset for new round.");
}


function findWinnerFromData(winnerData) { //
    // winnerData is expected to be { winner: { id, _id, username, avatar, ... } }
    const winnerUserDetails = winnerData?.winner;
    const winnerId = winnerUserDetails?.id || winnerUserDetails?._id;

    if (!winnerId) { //
        console.error("[DEBUG] Missing winner ID in findWinnerFromData:", winnerData);
        if (winnerUserDetails?.username) { // If we have some details, use them as fallback
            return { user: { ...winnerUserDetails }, percentage: 0, value: 0, username: winnerUserDetails.username, avatar: winnerUserDetails.avatar }; //
        }
        return { user: { username: "Error", avatar: "/img/default-avatar.png" }, percentage: 0, value: 0 }; // Fallback for display
    }

    if (!currentRound || !currentRound.participants) { //
        console.warn("[DEBUG] findWinnerFromData: Missing currentRound/participants data. Using provided winner data as is or fallback.");
        if (winnerUserDetails) return { user: { ...winnerUserDetails }, percentage: 0, value: 0, username: winnerUserDetails.username, avatar: winnerUserDetails.avatar }; //
        return { user: { username: "Error", avatar: "/img/default-avatar.png" }, percentage: 0, value: 0 }; //
    }

    const winnerParticipant = currentRound.participants.find(p => p.user && (p.user._id === winnerId || p.user.id === winnerId)); //

    if (!winnerParticipant || !winnerParticipant.user) { // Ensure user object exists within participant
        console.warn(`[DEBUG] findWinnerFromData: Winner ID ${winnerId} not found in local participants or user object missing. Using provided winner data or fallback. Participants:`, currentRound.participants);
        if (winnerUserDetails) return { user: { ...winnerUserDetails }, percentage: 0, value: 0, username: winnerUserDetails.username, avatar: winnerUserDetails.avatar }; //
        return { user: { username: "Error", avatar: "/img/default-avatar.png" }, percentage: 0, value: 0 }; //
    }

    const totalValue = Math.max(0.01, currentRound.totalValue || 0.01); // Use round's totalValue (which should be pre-tax for this calc)
    const participantValue = winnerParticipant.itemsValue || 0; //
    const percentage = (participantValue / totalValue) * 100; //

    return { //
        user: { ...(winnerParticipant.user) }, // Spread the user object from participant
        percentage: isNaN(percentage) ? 0 : percentage, //
        value: participantValue, //
        username: winnerParticipant.user.username, //
        avatar: winnerParticipant.user.avatar //
    };
}

async function verifyRound() { //
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationResultDisplay } = DOMElements.provablyFair; //
    if (!roundIdInput || !serverSeedInput || !clientSeedInput || !verificationResultDisplay) { //
        console.error("Verify form elements missing."); return; //
    }
    const roundId = roundIdInput.value.trim(), serverSeed = serverSeedInput.value.trim(), clientSeed = clientSeedInput.value.trim(); //
    const resultEl = verificationResultDisplay; //
    let validationError = null; //

    if (!roundId || !serverSeed || !clientSeed) validationError = 'Please fill in all fields (Round ID, Server Seed, Client Seed).'; //
    else if (serverSeed.length !== 64 || !/^[a-f0-9]{64}$/i.test(serverSeed)) validationError = 'Invalid Server Seed format (should be 64 hexadecimal characters).'; //
    else if (clientSeed.length === 0) validationError = 'Client Seed cannot be empty.'; //

    if (validationError) { //
        resultEl.style.display = 'block'; resultEl.className = 'verification-result error'; //
        resultEl.innerHTML = `<p>${validationError}</p>`; return; //
    }

    try {
        resultEl.style.display = 'block'; resultEl.className = 'verification-result loading'; //
        resultEl.innerHTML = '<p>Verifying...</p>'; //
        const response = await fetch('/api/verify', { //
            method: 'POST', headers: { 'Content-Type': 'application/json' }, //
            body: JSON.stringify({ roundId, serverSeed, clientSeed }) //
        });
        const result = await response.json(); //
        if (!response.ok) throw new Error(result.error || `Verification failed (${response.status})`); //

        resultEl.className = `verification-result ${result.verified ? 'success' : 'error'}`; //
        let html = `<h4>Result (Round #${result.roundId || roundId})</h4>`; //
        if (result.verified) { //
            html += `<p style="color: var(--success-color); font-weight: bold;">✅ Verified Fair.</p>`; //
            if (result.serverSeedHash) html += `<p><strong>Server Seed Hash (Used):</strong> <code class="seed-value">${result.serverSeedHash}</code></p>`; //
            if (result.serverSeed) html += `<p><strong>Server Seed (Provided):</strong> <code class="seed-value">${result.serverSeed}</code></p>`; //
            if (result.clientSeed) html += `<p><strong>Client Seed (Provided):</strong> <code class="seed-value">${result.clientSeed}</code></p>`; //
            if (result.combinedString) html += `<p><strong>Combined String (Server-Client):</strong> <code class="seed-value wrap-anywhere">${result.combinedString}</code></p>`; //
            if (result.finalHash) html += `<p><strong>Resulting SHA256 Hash:</strong> <code class="seed-value">${result.finalHash}</code></p>`; //
            if (result.winningTicket !== undefined) html += `<p><strong>Winning Ticket Number:</strong> ${result.winningTicket} (out of ${result.totalTickets || 'N/A'} total tickets)</p>`; //
            if (result.winnerUsername) html += `<p><strong>Verified Winner:</strong> ${result.winnerUsername}</p>`; //
            if (result.totalValue !== undefined) html += `<p><strong>Final Pot Value (After Tax):</strong> $${result.totalValue.toFixed(2)}</p>`; //
        } else { //
            html += `<p style="color: var(--error-color); font-weight: bold;">❌ Verification Failed.</p>`; //
            html += `<p><strong>Reason:</strong> ${result.reason || 'Mismatch detected.'}</p>`; //
            if (result.serverSeedHash) html += `<p><strong>Expected Server Seed Hash:</strong> <code class="seed-value">${result.serverSeedHash}</code></p>`; //
            if (result.calculatedHash) html += `<p><strong>Calculated Hash from Provided Seed:</strong> <code class="seed-value">${result.calculatedHash}</code></p>`; //
            if (result.serverSeed && result.serverSeed !== serverSeed) html += `<p><strong>Expected Server Seed:</strong> <code class="seed-value">${result.serverSeed}</code></p>`; //
            if (result.clientSeed && result.clientSeed !== clientSeed) html += `<p><strong>Expected Client Seed:</strong> <code class="seed-value">${result.clientSeed}</code></p>`; //
            if (result.calculatedWinningTicket !== undefined) html += `<p><strong>Calculated Ticket from Inputs:</strong> ${result.calculatedWinningTicket}</p>`; //
            if (result.actualWinningTicket !== undefined) html += `<p><strong>Actual Recorded Ticket:</strong> ${result.actualWinningTicket}</p>`; //
            if (result.totalTickets !== undefined) html += `<p><strong>Total Tickets in Round:</strong> ${result.totalTickets}</p>`; //
        }
        resultEl.innerHTML = html; //
    } catch (error) {
        resultEl.style.display = 'block'; resultEl.className = 'verification-result error'; //
        resultEl.innerHTML = `<p>Verification Error: ${error.message}</p>`; //
        console.error('Error verifying round:', error); //
    }
}

async function loadPastRounds(page = 1) { //
    const tableBody = DOMElements.provablyFair.roundsTableBody; //
    const paginationContainer = DOMElements.provablyFair.roundsPagination; //
    if (!tableBody || !paginationContainer) { //
        console.warn("Rounds history table/pagination elements missing."); return; //
    }
    try {
        tableBody.innerHTML = '<tr><td colspan="5" class="loading-message">Loading round history...</td></tr>'; //
        paginationContainer.innerHTML = ''; //
        const response = await fetch(`/api/rounds?page=${page}&limit=10`); //
        if (!response.ok) throw new Error(`Failed to load round history (${response.status})`); //
        const data = await response.json(); //
        if (!data || !Array.isArray(data.rounds) || typeof data.currentPage !== 'number' || typeof data.totalPages !== 'number') { //
            throw new Error('Invalid rounds data received from server.'); //
        }
        tableBody.innerHTML = ''; //
        if (data.rounds.length === 0) { //
            const message = (page === 1) ? 'No past rounds found.' : 'No rounds found on this page.'; //
            tableBody.innerHTML = `<tr><td colspan="5" class="no-rounds-message">${message}</td></tr>`; //
        } else { //
            data.rounds.forEach(round => { //
                const row = document.createElement('tr'); //
                row.dataset.roundId = round.roundId; //
                let date = 'N/A'; //
                const timeToFormat = round.completedTime || round.endTime; //
                if (timeToFormat) { //
                    try {
                        const d = new Date(timeToFormat); //
                        if (!isNaN(d.getTime())) date = d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }); //
                    } catch (e) { console.error("Date formatting error:", e); } //
                }
                const serverSeedStr = (round.serverSeed || '').replace(/'/g, "\\'"); //
                const clientSeedStr = (round.clientSeed || '').replace(/'/g, "\\'"); //
                const roundIdStr = round.roundId || 'N/A'; //
                const winnerUsername = round.winner?.username || (round.status === 'error' ? 'ERROR' : 'N/A'); //
                const potValueStr = (round.totalValue !== undefined) ? `$${round.totalValue.toFixed(2)}` : '$0.00'; //

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
                    </td>`; //
                tableBody.appendChild(row); //
            });
        }
        createPagination(data.currentPage, data.totalPages, loadPastRounds); //
    } catch (error) {
        tableBody.innerHTML = `<tr><td colspan="5" class="error-message">Error loading rounds: ${error.message}</td></tr>`; //
        console.error('Error loading past rounds:', error); //
    }
}

window.populateVerificationFields = function(roundId, serverSeed, clientSeed) { //
    const { roundIdInput, serverSeedInput, clientSeedInput, verificationSection, verificationResultDisplay } = DOMElements.provablyFair; //
    if (roundIdInput) roundIdInput.value = roundId || ''; //
    if (serverSeedInput) serverSeedInput.value = serverSeed || ''; //
    if (clientSeedInput) clientSeedInput.value = clientSeed || ''; //
    if (verificationResultDisplay) verificationResultDisplay.style.display = 'none'; // Hide old result
    if (verificationSection) verificationSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); //
    if (!serverSeed && roundId && roundId !== 'N/A') showNotification(`Info: Server Seed for Round #${roundId} is revealed after the round ends.`, 'info'); //
};

function createPagination(currentPage, totalPages, callbackFn) { //
    const container = DOMElements.provablyFair.roundsPagination; // Assuming this is the correct container for general pagination
    if (!container) return; container.innerHTML = ''; //
    if (totalPages <= 1) return; //

    const maxPagesToShow = 5; //
    const createButton = (text, page, isActive = false, isDisabled = false, isEllipsis = false) => { //
        if (isEllipsis) { //
            const span = document.createElement('span'); //
            span.className = 'page-ellipsis'; span.textContent = '...'; return span; //
        }
        const button = document.createElement('button'); //
        button.className = `page-button ${isActive ? 'active' : ''}`; //
        button.textContent = text; button.disabled = isDisabled; //
        if (!isDisabled && typeof page === 'number') button.addEventListener('click', (e) => { e.preventDefault(); callbackFn(page); }); //
        return button; //
    };

    container.appendChild(createButton('« Prev', currentPage - 1, false, currentPage <= 1)); //

    if (totalPages <= maxPagesToShow) { //
        for (let i = 1; i <= totalPages; i++) container.appendChild(createButton(i, i, i === currentPage)); //
    } else { //
        let pages = []; pages.push(1); //
        const rangePadding = Math.floor((maxPagesToShow - 3) / 2); //
        let rangeStart = Math.max(2, currentPage - rangePadding); //
        let rangeEnd = Math.min(totalPages - 1, currentPage + rangePadding); //
        const rangeLength = rangeEnd - rangeStart + 1; //
        const needed = (maxPagesToShow - 3); //
        if (rangeLength < needed) { //
             if (currentPage - rangeStart < rangeEnd - currentPage) rangeEnd = Math.min(totalPages - 1, rangeStart + needed -1); //
             else rangeStart = Math.max(2, rangeEnd - needed + 1); //
        }
        if (rangeStart > 2) pages.push('...'); //
        for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i); //
        if (rangeEnd < totalPages - 1) pages.push('...'); //
        pages.push(totalPages); //
        pages.forEach(page => { //
            if (page === '...') container.appendChild(createButton('...', null, false, true, true)); //
            else container.appendChild(createButton(page, page, page === currentPage)); //
        });
    }
    container.appendChild(createButton('Next »', currentPage + 1, false, currentPage >= totalPages)); //
}


function updateChatUI() { //
    const { messageInput, sendMessageBtn, onlineUsers } = DOMElements.chat; //
    if (currentUser) { //
        if (messageInput) { //
            messageInput.disabled = false; //
            messageInput.placeholder = 'Type your message...'; //
        }
        if (sendMessageBtn) sendMessageBtn.disabled = isChatSendOnCooldown; //
    } else { //
        if (messageInput) { //
            messageInput.disabled = true; //
            messageInput.placeholder = 'Sign in to chat'; //
            messageInput.value = ''; // Clear any pre-filled text
        }
        if (sendMessageBtn) sendMessageBtn.disabled = true; //
    }
    if (onlineUsers) onlineUsers.textContent = onlineUserCount; //
}

function displayChatMessage(messageData) { //
    const { messagesContainer } = DOMElements.chat; //
    if (!messagesContainer) return; //

    const { type = 'user', username, avatar, message, userId, userSteamId } = messageData; //
    const messageElement = document.createElement('div'); //
    messageElement.classList.add('chat-message'); //
    if (userId) messageElement.dataset.userId = userId; //
    if (userSteamId) messageElement.dataset.userSteamId = userSteamId; //

    if (type === 'system') { //
        messageElement.classList.add('system-message'); //
        messageElement.textContent = message; //
    } else { //
        const userAvatarSrc = avatar || '/img/default-avatar.png'; //
        const displayName = username || 'Anonymous'; //
        const userColor = getUserColor(userId || 'system-user'); //
        messageElement.innerHTML = `
            <img src="${userAvatarSrc}" alt="${displayName}" class="chat-message-avatar" style="border-color: ${userColor};">
            <div class="chat-message-content">
                <span class="chat-message-user" style="color: ${userColor};">${displayName}</span>
                <p class="chat-message-text"></p>
            </div>`; //
        const textElement = messageElement.querySelector('.chat-message-text'); //
        if (textElement) textElement.textContent = message; //
    }
    messagesContainer.insertBefore(messageElement, messagesContainer.firstChild); //
    while (messagesContainer.children.length > CONFIG.MAX_CHAT_MESSAGES) { //
        messagesContainer.removeChild(messagesContainer.lastChild); //
    }
}

function handleSendMessage() { //
    const { messageInput, sendMessageBtn } = DOMElements.chat; //
    if (!messageInput || !currentUser || isChatSendOnCooldown) return; //

    const messageText = messageInput.value.trim(); //
    if (messageText) { //
        socket.emit('chatMessage', messageText); //
        messageInput.value = ''; //
        isChatSendOnCooldown = true; //
        if (sendMessageBtn) { //
            sendMessageBtn.disabled = true; //
            const originalText = sendMessageBtn.textContent; //
            let countdown = Math.floor(CONFIG.CHAT_SEND_COOLDOWN_MS / 1000); //
            sendMessageBtn.textContent = `Wait ${countdown}s`; //
            const intervalId = setInterval(() => { //
                countdown--; //
                if (countdown > 0) { //
                    sendMessageBtn.textContent = `Wait ${countdown}s`; //
                } else { //
                    clearInterval(intervalId); //
                    sendMessageBtn.textContent = originalText; //
                    isChatSendOnCooldown = false; //
                    if(currentUser) sendMessageBtn.disabled = false; //
                }
            }, 1000); //
        }
        setTimeout(() => { //
            isChatSendOnCooldown = false; //
            if(currentUser && sendMessageBtn && !sendMessageBtn.textContent.startsWith("Wait")) { //
                 sendMessageBtn.disabled = false; //
            }
        }, CONFIG.CHAT_SEND_COOLDOWN_MS); //
    }
}

function setupChatEventListeners() { //
    const { messageInput, sendMessageBtn } = DOMElements.chat; //
    sendMessageBtn?.addEventListener('click', handleSendMessage); //
    messageInput?.addEventListener('keypress', (e) => { //
        if (e.key === 'Enter' && !e.shiftKey) { //
            e.preventDefault(); //
            handleSendMessage(); //
        }
    });
}

function updateChatOnlineUsers(count) { //
    onlineUserCount = count; //
    const { onlineUsers } = DOMElements.chat; //
    if (onlineUsers) { //
        onlineUsers.textContent = onlineUserCount; //
    }
}

async function fetchWinningHistory() { //
    const { modal, loadingIndicator, tableBody, noWinningsMessage } = DOMElements.winningHistoryModal; //
    if (!currentUser) { //
        showNotification("Please log in to view your winning history.", "info"); //
        return; //
    }
    showModal(modal); //
    if (loadingIndicator) loadingIndicator.style.display = 'flex'; //
    if (tableBody) tableBody.innerHTML = ''; //
    if (noWinningsMessage) noWinningsMessage.style.display = 'none'; //

    try {
        const response = await fetch('/api/user/winning-history'); //
        if (!response.ok) { //
            const errData = await response.json().catch(() => ({ error: `Failed to fetch history (${response.status})` })); //
            throw new Error(errData.error); //
        }
        const history = await response.json(); //
        if (loadingIndicator) loadingIndicator.style.display = 'none'; //

        if (history.length === 0) { //
            if (noWinningsMessage) noWinningsMessage.style.display = 'block'; //
        } else { //
            history.forEach(win => { //
                const row = tableBody.insertRow(); //
                const dateWon = win.dateWon ? new Date(win.dateWon).toLocaleString() : 'N/A'; //
                const amountWon = typeof win.amountWon === 'number' ? `$${win.amountWon.toFixed(2)}` : 'N/A'; //
                let tradeStatusHtml = win.tradeStatus || 'Unknown'; //

                if (win.tradeOfferId && (win.tradeStatus === 'Sent' || win.tradeStatus === 'Pending Send' || win.tradeStatus === 'Escrow')) { //
                    tradeStatusHtml = `<a href="https://steamcommunity.com/tradeoffer/${win.tradeOfferId}/" target="_blank" rel="noopener noreferrer" class="trade-link">${win.tradeStatus} <i class="fas fa-external-link-alt"></i></a>`; //
                } else if (win.tradeStatus === 'Accepted') { //
                    tradeStatusHtml = `<span class="trade-status accepted"><i class="fas fa-check-circle"></i> Accepted</span>`; //
                } else if (win.tradeStatus && win.tradeStatus.startsWith('Failed')) { //
                    tradeStatusHtml = `<span class="trade-status failed" title="${win.tradeStatus}"><i class="fas fa-times-circle"></i> Failed</span>`; //
                } else { //
                     tradeStatusHtml = `<span class="trade-status">${win.tradeStatus || 'N/A'}</span>`; //
                }

                row.innerHTML = `
                    <td>#${win.gameId || 'N/A'}</td>
                    <td>${dateWon}</td>
                    <td>${amountWon}</td>
                    <td>${tradeStatusHtml}</td>
                `; //
            });
        }
    } catch (error) {
        console.error("Error fetching winning history:", error); //
        if (loadingIndicator) loadingIndicator.style.display = 'none'; //
        if (tableBody) tableBody.innerHTML = `<tr><td colspan="4" class="error-message">Error: ${error.message}</td></tr>`; //
    }
}


function setupSocketConnection() { //
    socket.on('connect', () => { //
        console.log('Socket connected:', socket.id); //
        showNotification('Connected to server.', 'success', 2000); //
        console.log('[DEBUG] Socket connected. Requesting initial round data.');
        socket.emit('requestRoundData'); //
    });
    socket.on('disconnect', (reason) => { //
        console.log('Socket disconnected:', reason); //
        showNotification('Disconnected from server. Attempting to reconnect...', 'error', 5000); //
        updateDepositButtonState(); //
        updateChatOnlineUsers(0); //
        timerActive = false; // MODIFICATION: Ensure client timer stops on disconnect
        if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
    });
    socket.on('connect_error', (error) => { //
        console.error('Socket connection error:', error); //
        showNotification('Connection Error. Please refresh.', 'error', 10000); //
        updateDepositButtonState(); //
    });

    socket.on('roundCreated', (data) => { //
        console.log('[DEBUG] Socket event: roundCreated', JSON.stringify(data)); //
        currentRound = data; //
        // MODIFICATION: Reset view more comprehensively before updating UI
        if (isSpinning) { // If a spin was somehow stuck, reset it
            console.warn("[DEBUG] roundCreated received while isSpinning=true. Force resetting jackpot view.");
            resetToJackpotView();
        }
        initiateNewRoundVisualReset(); // Clear participants, pot, reset timer display to full
        updateRoundUI(); // Update with new (empty) round data
        updateDepositButtonState(); //
        // Timer on client side typically starts with the first deposit or if server indicates time left
        // For a brand new round, timerActive should be false.
        if (timerActive) {
            console.log("[DEBUG] roundCreated: Clearing active client timer as new round is starting fresh.");
            clearInterval(roundTimer); roundTimer = null; timerActive = false;
        }
        updateTimerUI(data.timeLeft); // Ensure timer displays correctly (e.g., full duration)
    });
    socket.on('participantUpdated', (data) => { //
        console.log('[DEBUG] Socket event: participantUpdated', JSON.stringify(data)); //
        if (currentRound && currentRound.roundId === data.roundId) { //
            handleNewDeposit(data); //
        } else if (!currentRound && data.roundId) { //
            console.warn("[DEBUG] Participant update for unknown round. Requesting full round data."); //
            socket.emit('requestRoundData'); //
        } else if (currentRound && currentRound.roundId !== data.roundId) {
            console.warn(`[DEBUG] Participant update for old round ${data.roundId}, current is ${currentRound.roundId}. Ignoring this update, requesting fresh data.`);
            socket.emit('requestRoundData');
        }
    });

    socket.on('timerUpdate', (data) => { // Server authoritative timer update
        // console.log('[DEBUG] Socket event: timerUpdate', JSON.stringify(data));
        if (currentRound && data.timeLeft !== undefined) {
            currentRound.timeLeft = data.timeLeft; // Update client's idea of timeLeft
            if (!timerActive && currentRound.status === 'active' && data.timeLeft > 0 && data.timeLeft < CONFIG.ROUND_DURATION) {
                // If timer is not active on client but server says it should be (e.g. joining mid-round)
                console.log(`[DEBUG] timerUpdate: Server sent timeLeft=${data.timeLeft} for active round, client timer was not active. Starting/syncing client timer.`);
                startClientTimer(data.timeLeft);
            } else if (timerActive || currentRound.status !== 'active') {
                // If client timer is already managing, or round isn't active, just update UI
                updateTimerUI(data.timeLeft);
            }
            updateDepositButtonState();
        }
    });

    socket.on('roundRolling', (data) => { //
        console.log('[DEBUG] Socket event: roundRolling', JSON.stringify(data)); //
        if (currentRound && currentRound.roundId === data.roundId) { //
            timerActive = false; // Stop client-side timer interval if it was running
            if (roundTimer) { clearInterval(roundTimer); roundTimer = null; } //
            if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "0"; // Keep at 0
            if (DOMElements.jackpot.timerForeground) updateTimerCircle(0, CONFIG.ROUND_DURATION); // Set circle to empty
            currentRound.status = 'rolling'; //
            updateDepositButtonState(); //
            console.log('[DEBUG] roundRolling: Client status updated. Waiting for roundWinner event.');
        }
    });

    socket.on('roundWinner', (data) => { //
        console.log('[DEBUG] Socket event: roundWinner', JSON.stringify(data));
        if (!data || !data.roundId || !data.winner) {
            console.error('[DEBUG] roundWinner event received with invalid data. Aborting client-side winner processing.', data);
            showNotification("Error processing winner information from server.", "error");
            resetToJackpotView(); // Try to reset to a safe state
            socket.emit('requestRoundData'); // Ask for fresh state
            return;
        }

        // MODIFICATION: Ensure this is for the current round the client thinks is active/rolling
        if (currentRound && currentRound.roundId === data.roundId) { //
            console.log(`[DEBUG] roundWinner: Processing winner for current round ${data.roundId}.`);
            currentRound.winner = data.winner; // Store winner
            currentRound.status = 'rolling'; // Ensure status reflects this (might already be)
            currentRound.offerURL = data.offerURL; // Store offer URL if provided by server
            currentRound.payoutOfferId = data.payoutOfferId; // Store offer ID
            
            // MODIFICATION: Crucially update client's currentRound.items
            if (data.items && Array.isArray(data.items)) {
                currentRound.items = data.items;
                console.log('[DEBUG] roundWinner: Updated client currentRound.items count:', currentRound.items.length);
            } else {
                console.warn('[DEBUG] roundWinner: Event data did NOT include items. Roulette might fail if client items are stale.');
                // Consider requesting full round data again if items are missing and critical, though this might delay animation
            }

            handleWinnerAnnouncement(data); // This will start the animation
        } else { //
            console.warn(`[DEBUG] roundWinner: Received winner for mismatched/unknown round. Client current: ${currentRound?.roundId}, Received: ${data.roundId}. Current status: ${currentRound?.status}`);
             // If currentRound is null, or status is completed/pending, it might be a late connection or resync.
             if (!currentRound || (currentRound.status !== 'active' && currentRound.status !== 'rolling')) { //
                console.log("[DEBUG] roundWinner: Processing winner for a round that wasn't active/rolling locally. Potentially late connection or resync.");
                // Construct a minimal currentRound for the animation if possible
                currentRound = {
                    roundId: data.roundId,
                    winner: data.winner,
                    status: 'rolling', // Assume it's now rolling
                    participants: data.participants || [], // Use if available
                    items: data.items || [],             // CRITICAL: Use items from event
                    offerURL: data.offerURL,
                    payoutOfferId: data.payoutOfferId
                };
                console.log('[DEBUG] roundWinner: Constructed new currentRound for animation. Items count:', currentRound.items.length);
                handleWinnerAnnouncement(data); //
            } else {
                console.error(`[DEBUG] roundWinner: Winner event for ${data.roundId} does not match active client round ${currentRound.roundId}. Not processing animation to avoid conflict. Requesting fresh data.`);
                socket.emit('requestRoundData'); // Get the true current state
            }
        }
    });

    socket.on('winningOfferCreated', (data) => { //
        console.log('[DEBUG] Socket event: winningOfferCreated', JSON.stringify(data)); //
        if (currentUser && data.userId === (currentUser._id || currentUser.id)) { //
            if (currentRound && currentRound.roundId === data.roundId) { // Ensure it's for the active round being displayed
                currentRound.offerURL = data.offerURL; // Store/update the offer URL
                currentRound.payoutOfferId = data.offerId; //
            }

            const acceptBtn = DOMElements.roulette.acceptWinningOfferBtn; //
            if (acceptBtn && acceptBtn.style.display !== 'none') { // If button is visible (i.e., user is winner)
                console.log('[DEBUG] winningOfferCreated: Winner button visible, setting URL and ready state.');
                acceptBtn.onclick = () => { //
                    window.open(data.offerURL, '_blank', 'noopener,noreferrer'); //
                };
                acceptBtn.classList.add('ready'); // Add class for styling emphasis
                showNotification(`Your winnings are ready! Click the button to claim them on Steam. (Offer #${data.offerId})`, 'success', 8000); //
            } else { //
                 // If button isn't visible yet but this event arrives, store for when winner screen shows
                 // This is covered by currentRound.offerURL storage
                 console.log('[DEBUG] winningOfferCreated: Winner button NOT visible, but offer created. User will see on winner screen or history.');
                 showNotification(`Your trade offer (#${data.offerId}) for winnings is ready! You can accept it on Steam.`, 'success', 8000); //
            }
        }
    });


    socket.on('roundCompleted', (data) => { //
        console.log('[DEBUG] Socket event: roundCompleted', JSON.stringify(data)); //
        if (currentRound && currentRound.roundId === data.roundId) { //
            currentRound.status = 'completed'; //
            if(data.serverSeed) currentRound.serverSeed = data.serverSeed; //
            if(data.clientSeed) currentRound.clientSeed = data.clientSeed; //
        }
        updateDepositButtonState(); //
        // Visual reset is handled by handleSpinEnd timeout or resetToJackpotView,
        // followed by a 'roundCreated' for the next round.
    });
    socket.on('roundError', (data) => { //
        console.error('[DEBUG] Socket event: roundError', JSON.stringify(data)); //
        if (currentRound && currentRound.roundId === data.roundId) { //
            currentRound.status = 'error'; //
            showNotification(`Round Error: ${data.error || 'Unknown error.'}`, 'error'); //
        } else if (data.roundId) { // Error for a specific round not matching current
             showNotification(`Error in round #${data.roundId}: ${data.error || 'Unknown error.'}`, 'error');
        } else { // Generic error
            showNotification(`Server Error: ${data.error || 'Unknown error.'}`, 'error');
        }
        // Full reset if an error occurs during critical phase
        isSpinning = false; timerActive = false; //
        if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
        updateDepositButtonState(); //
        resetToJackpotView(); //
        // Request fresh data to try and recover state
        console.log('[DEBUG] roundError: Requesting fresh round data after error.');
        socket.emit('requestRoundData');
    });

    // MODIFICATION: More robust handling of roundData, especially for timer and item sync
    socket.on('roundData', (data) => { //
        console.log('[DEBUG] Socket event: roundData received', JSON.stringify(data).substring(0, 500) + (JSON.stringify(data).length > 500 ? "..." : "")); // Log snippet

        if (!data || typeof data !== 'object' || !data.roundId) { //
            console.error("[DEBUG] Invalid or incomplete round data received from server:", data);
            showNotification('Error syncing with server (invalid round data).', 'error');
            initiateNewRoundVisualReset(); // Try to reset to a clean state
            return; //
        }

        const previousRoundStatus = currentRound?.status; //
        const previousRoundId = currentRound?.roundId;
        currentRound = data; // Update local state with fresh data from server

        console.log(`[DEBUG] roundData: Set currentRound to ID ${currentRound.roundId}, Status: ${currentRound.status}, TimeLeft: ${currentRound.timeLeft}, Participants: ${currentRound.participants?.length}, Items: ${currentRound.items?.length}`);

        // If this roundData is for a new round after a previous one was 'rolling' or 'completed'
        if ( (previousRoundStatus === 'rolling' || previousRoundStatus === 'completed' || previousRoundStatus === 'error') &&
             currentRound.status === 'active' &&
             previousRoundId !== currentRound.roundId) {
            console.log(`[DEBUG] roundData: New active round ${currentRound.roundId} received after previous round ${previousRoundId} (${previousRoundStatus}). Ensuring clean reset.`);
            if (isSpinning) resetToJackpotView(); // If stuck in spin, reset view
            initiateNewRoundVisualReset(); // Ensure visuals are clean for the new round
        }


        updateRoundUI(); // Update pot value, participant count, and initial timer display
        updateDepositButtonState(); //

        if (currentRound.status === 'rolling') { //
            if (!isSpinning && currentRound.winner) { //
                console.log("[DEBUG] roundData: Connected mid-roll with winner known, triggering animation for round", currentRound.roundId); //
                handleWinnerAnnouncement(currentRound); // Contains winner, items, offerURL etc.
            } else if (!isSpinning && previousRoundStatus !== 'rolling') { //
                console.log("[DEBUG] roundData: Server indicates rolling, client awaiting winner announcement for round", currentRound.roundId); //
                if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "0"; //
                if (DOMElements.jackpot.timerForeground) updateTimerCircle(0, CONFIG.ROUND_DURATION); //
                if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
            } else if (isSpinning && previousRoundId !== currentRound.roundId) {
                // A new round is rolling but client is still spinning for an old one. Reset.
                console.warn(`[DEBUG] roundData: New round ${currentRound.roundId} is rolling, but client was spinning for old round ${previousRoundId}. Resetting client spin.`);
                resetToJackpotView();
                // Then potentially re-trigger animation for the *new* rolling round if winner is known
                if(currentRound.winner) handleWinnerAnnouncement(currentRound);
            }
        } else if (currentRound.status === 'completed') { //
            if (!isSpinning && currentRound.winner) { //
                console.log("[DEBUG] roundData: Connected post-completion with winner known for round", currentRound.roundId, ". Displaying winner screen."); //
                handleWinnerAnnouncement(currentRound); // Show winner screen directly
            } else if (!isSpinning) { //
                 console.log("[DEBUG] roundData: Connected after round completed (or no winner to display). Resetting view for round", currentRound.roundId); //
                 resetToJackpotView(); // If no winner data to display, reset
            }
        } else if (currentRound.status === 'active') { //
            console.log(`[DEBUG] roundData: Round ${currentRound.roundId} is active. Client timerActive: ${timerActive}. Server timeLeft: ${currentRound.timeLeft}`);
             if (currentRound.timeLeft > 0 && currentRound.timeLeft <= CONFIG.ROUND_DURATION) { // Only start/sync if valid timeLeft
                if (!timerActive || (currentRound.participants && currentRound.participants.length > 0)) { // Start if not active, or if active and has participants (server should dictate)
                     console.log(`[DEBUG] roundData: Starting/Syncing client timer for round ${currentRound.roundId} from server timeLeft: ${currentRound.timeLeft}s.`);
                     startClientTimer(currentRound.timeLeft); //
                }
             } else if (currentRound.timeLeft <= 0 && timerActive) { // Server says time is 0, but client timer was active
                 console.log(`[DEBUG] roundData: Server timeLeft is 0 for active round ${currentRound.roundId}. Stopping client timer.`);
                 timerActive = false; if (roundTimer) clearInterval(roundTimer); roundTimer = null; //
                 updateTimerUI(0); //
             } else if (currentRound.participants && currentRound.participants.length === 0 && timerActive) { // Active round, no participants, but client timer was running
                  console.log(`[DEBUG] roundData: Active round ${currentRound.roundId} has no participants, stopping client timer.`);
                  timerActive = false; if (roundTimer) clearInterval(roundTimer); roundTimer = null; //
                  updateTimerUI(CONFIG.ROUND_DURATION); // Show full time
             } else if (!timerActive) { // If timer not active on client, just update display based on server
                 updateTimerUI(currentRound.timeLeft); //
             }
        } else if (currentRound.status === 'pending') { //
            console.log("[DEBUG] roundData: Received pending round state for round", currentRound.roundId, ". Resetting visuals."); //
            if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
            initiateNewRoundVisualReset(); //
            if(DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Waiting"; //
        }

        // MODIFICATION: More careful re-rendering of participants
        const container = DOMElements.jackpot.participantsContainer; //
        const forceRedraw = data.forceRedrawParticipants || previousRoundId !== currentRound.roundId || previousRoundStatus !== currentRound.status;

        if(container && (forceRedraw || !container.hasChildNodes() && currentRound.participants?.length > 0 ) ) { //
            console.log(`[DEBUG] roundData: Re-rendering participant deposits from full round data for round ${currentRound.roundId}. Force redraw: ${forceRedraw}`);
            container.innerHTML = ''; // Clear previous
            if (DOMElements.jackpot.emptyPotMessage) DOMElements.jackpot.emptyPotMessage.style.display = 'none'; //

            if (currentRound.participants && currentRound.participants.length > 0) { //
                // Ensure participant user objects have _id, username, avatar for displayLatestDeposit
                const validParticipants = currentRound.participants.filter(p => p.user && (p.user._id || p.user.id) && p.user.username);
                const sortedParticipants = [...validParticipants].sort((a,b) => (b.itemsValue || 0) - (a.itemsValue || 0)); //

                sortedParticipants.forEach(p => { //
                    // Find items specific to this participant from the currentRound.items list
                    const participantItems = currentRound.items?.filter(item => item.owner === (p.user._id || p.user.id)) || []; //
                    displayLatestDeposit({ //
                        userId: p.user._id || p.user.id, //
                        username: p.user.username, //
                        avatar: p.user.avatar, //
                        itemsValue: p.itemsValue, //
                        depositedItems: participantItems // Pass the filtered items
                    });
                    const element = container.querySelector(`.player-deposit-container[data-user-id="${p.user._id || p.user.id}"]`); //
                    if (element) element.classList.remove('player-deposit-new'); //
                });
                updateAllParticipantPercentages(); //
            } else if (currentRound.status === 'active' || currentRound.status === 'pending') { // If active/pending but no participants, show empty message
                 initiateNewRoundVisualReset(); // No participants, ensure empty state for active/pending rounds
            }
        } else if (container && (!currentRound.participants || currentRound.participants.length === 0) && (currentRound.status === 'active' || currentRound.status === 'pending')) { //
            initiateNewRoundVisualReset(); //
        }
    });


    socket.on('tradeOfferSent', (data) => { // For deposit offers primarily, winnings handled by winningOfferCreated
         console.log('[DEBUG] Socket event: tradeOfferSent (deposit)', JSON.stringify(data)); //
         if (currentUser && data.userId === (currentUser._id || currentUser.id) && data.offerURL && data.type !== 'winning') { // Check type
              showNotification(`Deposit Offer Sent: <a href="${data.offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">Click here to accept the deposit offer on Steam!</a> (#${data.offerId})`, 'success', 10000); //
         } else if (currentUser && data.userId === (currentUser._id || currentUser.id) && data.type !== 'winning') { //
              showNotification(`Deposit Offer Sent: Check Steam to complete your deposit! (#${data.offerId})`, 'success', 8000); //
         }
    });
    socket.on('notification', (data) => { //
        console.log('[DEBUG] Socket event: notification', JSON.stringify(data)); //
        if (!data.userId || (currentUser && data.userId === (currentUser._id || currentUser.id))) { //
            showNotification(data.message || 'Received notification from server.', data.type || 'info', data.duration || 4000); //
        }
    });

    socket.on('chatMessage', (data) => { //
        displayChatMessage(data); //
    });
    socket.on('updateUserCount', (count) => { //
        updateChatOnlineUsers(count); //
    });
    // MODIFICATION: Add handler for noActiveRound from server
    socket.on('noActiveRound', () => {
        console.log('[DEBUG] Socket event: noActiveRound. Server indicates no current round to display.');
        currentRound = null; // Clear local currentRound
        isSpinning = false; // Ensure not stuck in spin state
        if (timerActive) { clearInterval(roundTimer); roundTimer = null; timerActive = false; }
        resetToJackpotView(); // Reset main jackpot display area
        initiateNewRoundVisualReset(); // Ensure pot is empty and timer shows waiting/full
        updateDepositButtonState(); // Update button states based on no round
        // Perhaps show a message like "Waiting for next round..." in the timer area
        if (DOMElements.jackpot.timerValue) DOMElements.jackpot.timerValue.textContent = "Next...";
    });
}


function setupEventListeners() { //
    DOMElements.nav.homeLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.homePage); }); //
    DOMElements.nav.aboutLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.aboutPage); }); //
    DOMElements.nav.tosLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.tosPage); }); //
    DOMElements.nav.faqLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.faqPage); }); //
    DOMElements.nav.fairLink?.addEventListener('click', (e) => { e.preventDefault(); showPage(DOMElements.pages.fairPage); }); //

    DOMElements.user.loginButton?.addEventListener('click', () => { //
        if (localStorage.getItem('ageVerified') === 'true') { //
            console.log("Age already verified, proceeding to Steam login."); //
            window.location.href = '/auth/steam'; //
        } else { //
            console.log("Age not verified, showing verification modal."); //
            const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification; //
            if(ageCheckbox) ageCheckbox.checked = false; //
            if(ageAgreeButton) ageAgreeButton.disabled = true; //
            showModal(DOMElements.ageVerification.modal); //
        }
    });

    const { userProfile, userDropdownMenu, logoutButton, profileDropdownButton, winningHistoryDropdownButton } = DOMElements.user; //
    userProfile?.addEventListener('click', (e) => { //
        e.stopPropagation(); //
        if (userDropdownMenu) { //
            const isVisible = userDropdownMenu.style.display === 'block'; //
            userDropdownMenu.style.display = isVisible ? 'none' : 'block'; //
            userProfile?.setAttribute('aria-expanded', String(!isVisible)); //
            userProfile?.classList.toggle('open', !isVisible); //
        }
    });
    userProfile?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); }}); //

    logoutButton?.addEventListener('click', (e) => { e.stopPropagation(); handleLogout(); }); //
    logoutButton?.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleLogout(); }}); //

    profileDropdownButton?.addEventListener('click', (e) => { //
        e.preventDefault(); e.stopPropagation(); //
        const menu = DOMElements.user.userDropdownMenu; //
        const modal = DOMElements.profileModal.modal; //
        if (currentUser && modal) { //
            populateProfileModal(); showModal(modal); //
        } else if (!currentUser) showNotification("Please log in to view your profile.", "info"); //
        else console.error("Profile modal element not found."); //
        if (menu) menu.style.display = 'none'; //
        userProfile?.setAttribute('aria-expanded', 'false'); //
        userProfile?.classList.remove('open'); //
    });

    winningHistoryDropdownButton?.addEventListener('click', (e) => { //
        e.preventDefault(); e.stopPropagation(); //
        fetchWinningHistory(); //
        const menu = DOMElements.user.userDropdownMenu; //
        if (menu) menu.style.display = 'none'; //
        userProfile?.setAttribute('aria-expanded', 'false'); //
        userProfile?.classList.remove('open'); //
    });
    DOMElements.winningHistoryModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.winningHistoryModal.modal)); //
    DOMElements.winningHistoryModal.closeFooterBtn?.addEventListener('click', () => hideModal(DOMElements.winningHistoryModal.modal)); //


    DOMElements.profileModal.saveBtn?.addEventListener('click', handleProfileSave); //
    DOMElements.profileModal.closeBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal)); //
    DOMElements.profileModal.cancelBtn?.addEventListener('click', () => hideModal(DOMElements.profileModal.modal)); //

    DOMElements.deposit.showDepositModalButton?.addEventListener('click', () => { //
        const button = DOMElements.deposit.showDepositModalButton; //
        if (button.disabled) { //
            showNotification(button.title || 'Deposits are currently closed.', 'info'); return; //
        }
        if (!currentUser) { //
            showNotification('Login Required: Please log in first.', 'error'); return; //
        }
         if (!currentUser.tradeUrl) { //
             console.log("Trade URL missing for user. Prompting user to set it in profile."); //
             showNotification('Trade URL Required: Please open your profile (click your avatar) and set your Steam Trade URL before depositing.', 'error', 6000); //
             if (DOMElements.profileModal.modal) { //
                 populateProfileModal(); showModal(DOMElements.profileModal.modal); //
             }
             return; //
         }
        showModal(DOMElements.deposit.depositModal); loadUserInventory(); //
    });
    DOMElements.deposit.closeDepositModalButton?.addEventListener('click', () => hideModal(DOMElements.deposit.depositModal)); //
    DOMElements.deposit.depositButton?.addEventListener('click', requestDepositOffer); //
    DOMElements.deposit.acceptDepositOfferBtn?.addEventListener('click', () => { //
         if (currentDepositOfferURL) { //
             console.log("Opening Steam trade offer (deposit):", currentDepositOfferURL); //
             window.open(currentDepositOfferURL, '_blank', 'noopener,noreferrer'); //
             const { depositStatusText } = DOMElements.deposit; //
             if(depositStatusText) depositStatusText.textContent = "Check Steam tab for the offer..."; //
         } else { //
             console.error("No deposit offer URL found for accept button."); //
             showNotification("Error: Could not find the deposit trade offer URL.", "error"); //
         }
    });

    const { modal: ageModal, checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification; //
    if (ageModal && ageCheckbox && ageAgreeButton) { //
        ageCheckbox.addEventListener('change', () => { ageAgreeButton.disabled = !ageCheckbox.checked; }); //
        ageAgreeButton.addEventListener('click', () => { //
            if (ageCheckbox.checked) { //
                localStorage.setItem('ageVerified', 'true'); hideModal(ageModal); //
                console.log("Age verification agreed. Proceeding to Steam login."); //
                window.location.href = '/auth/steam'; //
            }
        });
        ageAgreeButton.disabled = !ageCheckbox.checked; //
    }

    DOMElements.provablyFair.verifyButton?.addEventListener('click', verifyRound); //

    window.addEventListener('click', (e) => { //
        const profileModalEl = DOMElements.profileModal.modal; //
        const depositModalEl = DOMElements.deposit.depositModal; //
        const winningHistoryModalEl = DOMElements.winningHistoryModal.modal; //

        if (userDropdownMenu && userProfile && userDropdownMenu.style.display === 'block' && //
            !userProfile.contains(e.target) && !userDropdownMenu.contains(e.target)) { //
            userDropdownMenu.style.display = 'none'; //
            userProfile.setAttribute('aria-expanded', 'false'); //
            userProfile.classList.remove('open'); //
        }
        if (e.target === depositModalEl) hideModal(depositModalEl); //
        if (e.target === profileModalEl) hideModal(profileModalEl); //
        if (e.target === winningHistoryModalEl) hideModal(winningHistoryModalEl); //
    });

    document.addEventListener('keydown', function(event) { //
        const profileModalEl = DOMElements.profileModal.modal; //
        const depositModalEl = DOMElements.deposit.depositModal; //
        const winningHistoryModalEl = DOMElements.winningHistoryModal.modal; //
        const ageVerificationModalEl = DOMElements.ageVerification.modal; //

        if (event.key === 'Escape') { //
             if (profileModalEl?.style.display === 'flex') hideModal(profileModalEl); //
             else if (depositModalEl?.style.display === 'flex') hideModal(depositModalEl); //
             else if (winningHistoryModalEl?.style.display === 'flex') hideModal(winningHistoryModalEl); //
             else if (ageVerificationModalEl?.style.display === 'flex') hideModal(ageVerificationModalEl); //
             else if (userDropdownMenu && userDropdownMenu.style.display === 'block') { //
                 userDropdownMenu.style.display = 'none'; //
                 userProfile?.setAttribute('aria-expanded', 'false'); //
                 userProfile?.classList.remove('open'); //
                 userProfile?.focus(); //
             }
        }
    });

    setupChatEventListeners(); //
}

function populateProfileModal() { //
    const modalElements = DOMElements.profileModal; //
    if (!currentUser || !modalElements.modal) return; //

    modalElements.avatar.src = currentUser.avatar || '/img/default-avatar.png'; //
    modalElements.name.textContent = currentUser.username || 'User'; //
    modalElements.deposited.textContent = `$${(currentUser.totalDepositedValue || 0).toFixed(2)}`; //
    modalElements.won.textContent = `$${(currentUser.totalWinningsValue || 0).toFixed(2)}`; //
    modalElements.tradeUrlInput.value = currentUser.tradeUrl || ''; //

    const statusDiv = modalElements.pendingOfferStatus; //
    if (!statusDiv) return; //
    if (currentUser.pendingDepositOfferId) { //
        const offerId = currentUser.pendingDepositOfferId; //
        const offerURL = `https://steamcommunity.com/tradeoffer/${offerId}/`; //
        statusDiv.innerHTML = `<p>⚠️ You have a <a href="${offerURL}" target="_blank" rel="noopener noreferrer" class="profile-pending-link">pending deposit offer (#${offerId})</a> awaiting action on Steam.</p>`; //
        statusDiv.style.display = 'block'; //
    } else { //
        statusDiv.style.display = 'none'; //
        statusDiv.innerHTML = ''; //
    }
}

async function handleProfileSave() { //
    const { tradeUrlInput, saveBtn } = DOMElements.profileModal; //
    if (!tradeUrlInput || !saveBtn || !currentUser) { //
         showNotification("Not logged in or profile elements missing.", "error"); return; //
    }
    const newTradeUrl = tradeUrlInput.value.trim(); //
    const urlPattern = /^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/i; //
    if (newTradeUrl && !urlPattern.test(newTradeUrl)) { //
        showNotification('Invalid Steam Trade URL format. Please check or leave empty to clear.', 'error', 6000); return; //
    }

    saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; //
    try {
        const response = await fetch('/api/user/tradeurl', { //
            method: 'POST', headers: { 'Content-Type': 'application/json' }, //
            body: JSON.stringify({ tradeUrl: newTradeUrl }), //
        });
        const result = await response.json(); //
        if (!response.ok || !result.success) throw new Error(result.error || `Failed to save trade URL (${response.status})`); //

        currentUser.tradeUrl = newTradeUrl; //
        showNotification(newTradeUrl ? 'Trade URL saved successfully!' : 'Trade URL cleared successfully!', 'success'); //
        updateDepositButtonState(); //
        hideModal(DOMElements.profileModal.modal); //
    } catch (error) {
        console.error("Error saving trade URL:", error); //
        showNotification(`Error saving Trade URL: ${error.message}`, 'error'); //
    } finally {
        saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; //
    }
}


document.addEventListener('DOMContentLoaded', () => { //
    console.log("DOM fully loaded and parsed. Applying new Jackpot flow with fixes."); //
    const ageVerified = localStorage.getItem('ageVerified') === 'true'; //

    checkLoginStatus(); //
    setupEventListeners(); //
    setupSocketConnection(); //

    showPage(DOMElements.pages.homePage); //
    initiateNewRoundVisualReset(); // Initial visual state

    if (!ageVerified && DOMElements.ageVerification.modal) { //
        const { checkbox: ageCheckbox, agreeButton: ageAgreeButton } = DOMElements.ageVerification; //
        if(ageCheckbox) ageCheckbox.checked = false; //
        if(ageAgreeButton) ageAgreeButton.disabled = true; //
        showModal(DOMElements.ageVerification.modal); //
    }

    updateChatUI(); //
});

console.log("main.js updated with timer fixes, roulette data handling, and logging."); 
