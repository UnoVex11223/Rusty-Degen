// Required dependencies
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const mongoose = require('mongoose');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');
const cors = require('cors');
const SteamTotp = require('steam-totp');
const axios = require('axios');
const NodeCache = require('node-cache');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, query, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();
const SteamID = require('steamid'); // Make sure to install: npm install steamid


// --- Enhanced: connect-mongo for persistent sessions ---
const MongoStore = require('connect-mongo');

// --- FIXED: Consistent Trade URL Validation ---
const TRADE_URL_REGEX = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/;

// --- Configuration Constants ---
const requiredEnvVars = [
    'MONGODB_URI', 'SESSION_SECRET', 'STEAM_API_KEY', 'SITE_URL',
    'STEAM_USERNAME', 'STEAM_PASSWORD', 'STEAM_SHARED_SECRET', 'BOT_TRADE_URL', 'SITE_NAME', 'STEAM_IDENTITY_SECRET'
];
const isBotConfigured = process.env.STEAM_USERNAME && process.env.STEAM_PASSWORD && process.env.STEAM_SHARED_SECRET && process.env.BOT_TRADE_URL;
let missingVars = requiredEnvVars.filter(v => !process.env[v] && !(v.startsWith('STEAM_') || v === 'BOT_TRADE_URL' || v === 'SITE_NAME') && isBotConfigured);
if (!isBotConfigured) {
    console.warn("WARN: Steam Bot credentials/config incomplete in .env file. Trading features will be disabled.");
} else {
    missingVars = missingVars.concat(requiredEnvVars.filter(v => (v.startsWith('STEAM_') || v === 'BOT_TRADE_URL' || v === 'SITE_NAME') && !process.env[v]));
}

if (missingVars.length > 0) {
    console.error(`FATAL: Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1);
}

const RUST_APP_ID = 252490;
const RUST_CONTEXT_ID = 2;
const ROUND_DURATION = parseInt(process.env.ROUND_DURATION_SECONDS) || 99;
const TICKET_VALUE_RATIO = parseFloat(process.env.TICKET_VALUE) || 0.01;
const PRICE_CACHE_TTL_SECONDS = parseInt(process.env.PRICE_CACHE_TTL_SECONDS) || 15 * 60;
const PRICE_REFRESH_INTERVAL_MS = (parseInt(process.env.PRICE_REFRESH_MINUTES) || 10) * 60 * 1000;
const MIN_ITEM_VALUE = parseFloat(process.env.MIN_ITEM_VALUE) || 0.10;
const PRICE_FETCH_TIMEOUT_MS = 30000;
const MAX_PARTICIPANTS = 20;
const MAX_ITEMS_PER_POT = 200;
const MAX_ITEMS_PER_DEPOSIT = parseInt(process.env.MAX_ITEMS_PER_DEPOSIT) || 20;
const TAX_MIN_PERCENT = 5;
const TAX_MAX_PERCENT = 10;
const MIN_POT_FOR_TAX = parseFloat(process.env.MIN_POT_FOR_TAX) || 100;
const MAX_CHAT_MESSAGE_LENGTH = 200;
const CHAT_COOLDOWN_SECONDS = parseInt(process.env.CHAT_COOLDOWN_SECONDS) || 5;
const COOKIE_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_TRADE_RETRY_ATTEMPTS = 2;

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: process.env.SITE_URL || "*", methods: ["GET", "POST"] } });

// --- Security Middleware ---
app.set('trust proxy', 1);
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "default-src": ["'self'"],
            "script-src": ["'self'", "/socket.io/socket.io.js", "'unsafe-inline'"], // Consider making inline scripts hashed if possible
            "script-src-attr": ["'self'", "'unsafe-inline'"], // For onclick in HTML, consider moving to JS event listeners
            "style-src": ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "'unsafe-inline'"],
            "img-src": ["'self'", "data:", "*.steamstatic.com", "*.akamai.steamstatic.com", "steamcdn-a.akamaihd.net"], // Added steamcdn
            "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            "connect-src": (() => {
                const sources = ["'self'"];
                const siteUrl = process.env.SITE_URL;
                if (siteUrl) {
                    try {
                        const url = new URL(siteUrl);
                        sources.push(`ws://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(`wss://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(siteUrl);
                    } catch (e) {
                        console.error("Invalid SITE_URL for CSP connect-src:", siteUrl, e);
                    }
                }
                sources.push("https://rust.scmm.app"); // For price fetching
                sources.push("https://api.steampowered.com"); // For any direct Steam API calls if used
                sources.push("https://steamcommunity.com"); // For bot interactions
                return sources;
            })(),
            "frame-src": ["'self'", "https://steamcommunity.com"], // If you embed Steam content
            "frame-ancestors": ["'self'", "https://steamcommunity.com"],
            "object-src": ["'none'"],
            "upgrade-insecure-requests": [],
        },
    })
);

const generalApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many login attempts from this IP, please try again after 10 minutes', standardHeaders: true, legacyHeaders: false });
const sensitiveActionLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, message: 'Too many requests for this action, please try again after 5 minutes', standardHeaders: true, legacyHeaders: false });
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 10, message: 'Too many deposit attempts, please wait a minute.', standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20,
    message: 'Too many chat messages from this IP. Please wait a moment.',
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', generalApiLimiter);
app.use(cors({ origin: process.env.SITE_URL || "*", credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session Configuration with MongoStore
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        ttl: 14 * 24 * 60 * 60, // 14 days
        autoRemove: 'native'
    }),
    cookie: {
        maxAge: 3600000 * 24, // 1 day
        secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
        httpOnly: true,
        sameSite: 'lax' // Or 'strict' if appropriate
    }
});
app.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

// --- Steam Strategy ---
passport.use(new SteamStrategy({
    returnURL: `${process.env.SITE_URL}/auth/steam/return`,
    realm: process.env.SITE_URL,
    apiKey: process.env.STEAM_API_KEY,
    providerURL: 'https://steamcommunity.com/openid' // Default, can be omitted
},
    async (identifier, profile, done) => {
        try {
            const userData = {
                username: profile.displayName || `User${profile.id.substring(profile.id.length - 5)}`,
                avatar: profile._json.avatarfull || profile._json.avatar || '/img/default-avatar.png',
            };
            const user = await User.findOneAndUpdate(
                { steamId: profile.id },
                {
                    $set: userData,
                    $setOnInsert: {
                        steamId: profile.id,
                        tradeUrl: '', // Initialize with empty trade URL
                        createdAt: new Date(),
                        pendingDepositOfferId: null,
                        totalDepositedValue: 0,
                        totalWinningsValue: 0
                    }
                },
                { new: true, upsert: true, runValidators: true }
            );
            return done(null, user);
        } catch (err) {
            console.error('Steam Strategy Error:', err);
            return done(err);
        }
    }
));
passport.serializeUser((user, done) => done(null, user.id)); // Store user.id in session
passport.deserializeUser(async (id, done) => { // Fetch user from DB using id
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        console.error("DeserializeUser Error:", err);
        done(err);
    }
});

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Successfully connected to MongoDB.'))
    .catch(err => {
        console.error('MongoDB Connection Error:', err);
        process.exit(1);
    });

// --- MongoDB Schemas ---
const userSchema = new mongoose.Schema({
    steamId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    avatar: { type: String },
    tradeUrl: {
        type: String,
        default: '',
        // Ensure validator is only applied if value is not empty
        validate: {
            validator: function(v) {
                if (v === '') return true; // Allow empty string
                return TRADE_URL_REGEX.test(v);
            },
            message: 'Invalid Steam Trade URL format.'
        }
    },
    createdAt: { type: Date, default: Date.now },
    banned: { type: Boolean, default: false },
    pendingDepositOfferId: { type: String, default: null, index: true }, // ID of the bot's offer to the user
    totalDepositedValue: { type: Number, default: 0, min: 0 },
    totalWinningsValue: { type: Number, default: 0, min: 0 }
});

const itemSchema = new mongoose.Schema({
    assetId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    image: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true, index: true },
    depositedAt: { type: Date, default: Date.now }
});

const roundSchema = new mongoose.Schema({
    roundId: { type: Number, required: true, unique: true, index: true }, // Site's internal round number
    status: { type: String, enum: ['pending', 'active', 'rolling', 'completed', 'completed_pending_acceptance', 'error'], default: 'pending', index: true },
    startTime: { type: Date },
    endTime: { type: Date }, // When the timer is set to end
    completedTime: { type: Date }, // When the round actually completes (winner decided)
    totalValue: { type: Number, default: 0, min: 0 }, // Value of items in the pot
    items: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }], // Items currently in the pot
    participants: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        itemsValue: { type: Number, required: true, default: 0, min: 0 },
        tickets: { type: Number, required: true, default: 0, min: 0 }
    }],
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    winningTicket: { type: Number, min: 0 },
    serverSeed: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    serverSeedHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    clientSeed: { type: String, match: /^[a-f0-9]+$/ }, // Can be more flexible
    provableHash: { type: String, match: /^[a-f0-9]{64}$/ }, // Hash of serverSeed + clientSeed
    taxAmount: { type: Number, default: 0, min: 0 },
    taxedItems: [{ assetId: String, name: String, price: { type: Number, min: 0 } }], // Details of items taken as tax
    payoutOfferId: { type: String, index: true }, // Steam trade offer ID for winnings
    payoutOfferStatus: { type: String, enum: [
        'PendingAcceptanceByWinner', 'Sent', 'Accepted', 'Declined', 'Canceled', 'Expired', 'InvalidItems', 'Escrow', 'Failed', 'Unknown',
        'Failed - No Trade URL', 'No Items Won', 'Pending Confirmation', 'Failed - Bot Not Ready', 'Failed - Offer Creation Error',
        'Failed - Bad URL', 'Failed - Inventory/Trade Issue', 'Failed - DB Error Post-Send', 'Failed - Synchronous Offer Prep Error',
        'Failed - Invalid Trade URL Format', 'Failed - Bot Inventory Issue', 'Failed - Bot Session Issue', 'Failed - Manually Cleared',
        'Failed - Timeout AutoClear', 'Failed - Invalid Trade URL Components', 'Failed - Invalid Partner ID', 'Failed - URL Parse Error',
        'Failed - Bot Not Configured', 'Failed - Malformed Trade URL', 'Failed - Inventory Private', 'Failed - Trade Banned',
        'Failed - Rate Limited', 'Failed - System Error', 'Failed - Send Error' // Added 'Failed - Send Error'
    ], default: 'Unknown' }
});
roundSchema.index({ 'participants.user': 1 }); // For finding rounds a user participated in
roundSchema.index({ winner: 1, status: 1, completedTime: -1 }); // For user winning history

const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);

// --- Steam Bot Setup ---
const community = new SteamCommunity();
let manager = null;
let currentBotCookies = null;
let cookieRefreshInterval = null;
let lastCookieValidation = 0;

// ENHANCED: Validate if cookies are still active
async function validateAndRefreshCookies() {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] LOG_INFO: Validating bot cookies...`);

    if (!currentBotCookies || currentBotCookies.length === 0) {
        console.log(`[${timestamp}] LOG_WARN: No cookies available, executing full login...`);
        return executeBotLogin();
    }

    // Test if cookies are still valid by checking if we're logged in
    return new Promise((resolve, reject) => {
        if (!community.steamID) { // If steamID isn't set on community, cookies are definitely bad
            console.log(`[${timestamp}] LOG_WARN: No steamID on community object, cookies likely expired. Re-logging in...`);
            return executeBotLogin().then(resolve).catch(reject);
        }

        // Try to get our own user info as a test
        community.getSteamUser(community.steamID, (err, user) => {
            if (err) { // Error implies cookies might be invalid
                console.log(`[${timestamp}] LOG_WARN: Cookie validation failed (getSteamUser error), re-logging in...`, err.message);
                return executeBotLogin().then(resolve).catch(reject);
            }
            // Cookies are still valid
            console.log(`[${timestamp}] LOG_SUCCESS: Cookies validated successfully. User: ${user.name}`);
            lastCookieValidation = Date.now();
            resolve();
        });
    });
}


async function ensureValidManager() {
    const timestamp = new Date().toISOString();

    if (!manager) {
        console.log(`[${timestamp}] LOG_INFO: Manager doesn't exist, creating new instance...`);
        if (!currentBotCookies || currentBotCookies.length === 0) {
            await validateAndRefreshCookies(); // This will login if no cookies
        }
        return createTradeOfferManager(currentBotCookies); // Pass current (possibly new) cookies
    }

    const timeSinceLastValidation = Date.now() - lastCookieValidation;
    if (timeSinceLastValidation > 5 * 60 * 1000) { // e.g., 5 minutes
        console.log(`[${timestamp}] LOG_INFO: Time for cookie validation (${Math.floor(timeSinceLastValidation / 1000)}s since last check)`);
        await validateAndRefreshCookies(); // This may update currentBotCookies

        // Update cookies on existing manager
        if (manager && currentBotCookies) {
            return new Promise((resolve, reject) => {
                manager.setCookies(currentBotCookies, (err) => {
                    if (err) {
                        console.error(`[${timestamp}] LOG_ERROR: Failed to update cookies on existing manager:`, err);
                        // If updating fails, fall back to recreating the manager
                        return createTradeOfferManager(currentBotCookies).then(resolve).catch(reject);
                    } else {
                        console.log(`[${timestamp}] LOG_SUCCESS: Updated cookies on existing manager`);
                        resolve();
                    }
                });
            });
        }
    }
    return Promise.resolve(); // Manager exists and cookies recently validated or not due for check
}


function createTradeOfferManager(cookies) {
    const timestamp = new Date().toISOString();

    if (manager && manager !== null) {
        console.log(`[${timestamp}] LOG_INFO: Shutting down existing TradeOfferManager instance before creating a new one.`);
        try {
            manager.shutdown();
        } catch (shutdownErr) {
            console.error(`[${timestamp}] LOG_ERROR: Error during manager shutdown:`, shutdownErr);
        }
        manager = null;
    }

    manager = new TradeOfferManager({
        steam: community, // The SteamCommunity instance
        domain: process.env.SITE_URL ? process.env.SITE_URL.replace(/^https?:\/\//, '') : 'localhost', // Your domain
        language: 'en', // Prices in English
        pollInterval: 10000, // Poll for new offers every 10 seconds
        cancelTime: 10 * 60 * 1000, // Automatically cancel sent offers after 10 minutes
    });

    setupManagerEventHandlers(); // Attach event handlers to the new manager instance

    return new Promise((resolve, reject) => {
        if (!cookies || cookies.length === 0) {
            const errMsg = `[${timestamp}] LOG_ERROR: Attempted to set empty cookies on TradeOfferManager. Login likely failed or cookies are missing.`;
            console.error(errMsg);
            return reject(new Error("Empty cookies provided to TradeOfferManager."));
        }
        manager.setCookies(cookies, (err) => {
            if (err) {
                console.error(`[${timestamp}] LOG_ERROR: Failed to set cookies on new TradeOfferManager:`, err);
                reject(err);
            } else {
                console.log(`[${timestamp}] LOG_SUCCESS: Cookies set on new TradeOfferManager instance.`);
                lastCookieValidation = Date.now(); // Cookies are fresh
                resolve();
            }
        });
    });
}


if (process.env.STEAM_IDENTITY_SECRET) {
    community.on('confKeyNeeded', (tag, callback) => {
        const time = Math.floor(Date.now() / 1000);
        if (SteamTotp && typeof SteamTotp.generateConfirmationKey === 'function') {
            const confKey = SteamTotp.generateConfirmationKey(process.env.STEAM_IDENTITY_SECRET, time, tag);
            callback(null, time, confKey);
        } else {
            console.error("FATAL: SteamTotp.generateConfirmationKey is not available for confKeyNeeded. STEAM_IDENTITY_SECRET is set but confirmations may fail.");
            callback(new Error("Confirmation key generation failed: SteamTotp unavailable"), null, null);
        }
    });
}

let isBotReady = false;
const pendingDeposits = new Map(); // In-memory map for pending deposit offers

function generateAuthCode() {
    const secret = process.env.STEAM_SHARED_SECRET;
    if (!secret) { console.error("STEAM_SHARED_SECRET missing. Cannot generate 2FA code."); return null; }
    try {
        const code = SteamTotp.generateAuthCode(secret);
        console.log("LOG_DEBUG: Generated 2FA code:", code);
        return code;
    }
    catch (e) { console.error("Error generating 2FA code:", e); return null; }
}

let isLoginInProgress = false;
const LOGIN_RETRY_COOLDOWN = 60 * 1000; // 1 minute
let lastLoginAttemptTimestamp = 0;


async function executeBotLogin() {
    if (isLoginInProgress) {
        console.log("LOG_INFO: Bot login attempt already in progress. Skipping.");
        return Promise.reject(new Error("Login already in progress."));
    }
    const now = Date.now();
    if (now - lastLoginAttemptTimestamp < LOGIN_RETRY_COOLDOWN) {
        console.log(`LOG_INFO: Bot login attempt was made recently (within ${LOGIN_RETRY_COOLDOWN / 1000}s). Waiting for cooldown.`);
        return Promise.reject(new Error("Login attempt cooldown active."));
    }
    isLoginInProgress = true;
    lastLoginAttemptTimestamp = now;
    isBotReady = false; // Set to false until login completes
    console.log("LOG_INFO: Attempting to execute bot login/re-login...");

    return new Promise((resolve, reject) => {
        if (!isBotConfigured) {
            console.warn("WARN: Bot not configured, cannot login.");
            isLoginInProgress = false;
            reject(new Error("Bot not configured."));
            return;
        }

        const loginCredentials = {
            accountName: process.env.STEAM_USERNAME,
            password: process.env.STEAM_PASSWORD,
            twoFactorCode: generateAuthCode() // Generate fresh code for each attempt
        };

        if (!loginCredentials.twoFactorCode) {
            console.warn("WARN: Could not generate 2FA code for login attempt.");
            isLoginInProgress = false;
            reject(new Error("2FA code generation failed for login."));
            return;
        }

        console.log(`LOG_INFO: Attempting Steam login for bot: ${loginCredentials.accountName} (via executeBotLogin)...`);
        community.login(loginCredentials, async (err, sessionID, cookies, steamguard) => {
            if (err || !community.steamID) { // Check for err OR if steamID is not set after login attempt
                console.error('STEAM LOGIN ERROR (executeBotLogin):', { message: err?.message, eresult: err?.eresult, steamguard, steamID: community.steamID });
                if (err?.eresult === 5) console.warn('Login Failure Hint: Invalid Password?');
                if (err?.eresult === 65) console.warn('Login Failure Hint: Incorrect 2FA Code or Account Rate Limit?');
                if (err?.eresult === 63) console.warn('Login Failure Hint: Account Logon Denied - Check Email/Steam Guard?');
                isLoginInProgress = false;
                currentBotCookies = null; // Clear any stale cookies
                reject(err || new Error(`Login failed: community.steamID undefined. EResult: ${err?.eresult}`));
                return;
            }

            console.log(`LOG_SUCCESS (executeBotLogin): Steam bot ${loginCredentials.accountName} logged in (SteamID: ${community.steamID}). Setting cookies...`);
            currentBotCookies = cookies; // Store the new cookies
            community.setCookies(cookies); // Also set on community instance

            try {
                await createTradeOfferManager(cookies); // Create or recreate manager with new cookies
                isLoginInProgress = false;
                isBotReady = true;
                lastCookieValidation = Date.now(); // Mark validation time
                console.log("LOG_SUCCESS (executeBotLogin): Steam Bot is fully ready and operational.");
                resolve(true);
            } catch (managerErr) {
                isLoginInProgress = false;
                currentBotCookies = null; // Clear cookies if manager setup fails
                console.error('TradeOfferManager Error setting cookies after login (executeBotLogin):', managerErr);
                reject(managerErr);
            }
        });
    });
}

async function refreshBotSession() {
    console.log("LOG_INFO: Refreshing bot session...");
    if (!isBotConfigured) {
        isBotReady = false;
        return Promise.reject(new Error("Bot not configured, cannot refresh session."));
    }

    try {
        await ensureValidManager(); // This handles validation and recreation if needed
        isBotReady = true; // If ensureValidManager resolves, bot should be ready
        return Promise.resolve();
    } catch (err) {
        console.error("LOG_ERROR: Failed to refresh bot session:", err);
        isBotReady = false; // If it fails, bot is not ready
        return Promise.reject(err);
    }
}

function startPeriodicCookieRefresh() {
    if (cookieRefreshInterval) {
        clearInterval(cookieRefreshInterval);
    }

    cookieRefreshInterval = setInterval(async () => {
        if (isBotReady && currentBotCookies) { // Only refresh if bot is considered ready and has cookies
            try {
                console.log("LOG_INFO: Performing periodic cookie refresh...");
                await validateAndRefreshCookies(); // This will re-login if validation fails
            } catch (err) {
                console.error("LOG_ERROR: Periodic cookie refresh failed:", err);
                // isBotReady might be set to false within validateAndRefreshCookies -> executeBotLogin on failure
            }
        }
    }, COOKIE_REFRESH_INTERVAL_MS);
}


function setupManagerEventHandlers() {
    if (!manager) return;

    manager.on('newOffer', async (offer) => {
        console.log(`LOG_DEBUG: manager.on('newOffer') received. Offer ID: ${offer.id}, Partner: ${offer.partner.getSteamID64()}, Our Offer: ${offer.isOurOffer}`);
        if (!isBotReady || offer.isOurOffer) {
            if (offer.isOurOffer) console.log(`LOG_DEBUG: Ignoring newOffer event for our own offer #${offer.id} (likely a deposit or payout).`);
            else console.log(`LOG_DEBUG: Ignoring newOffer event #${offer.id} because bot not ready.`);
            return;
        }
        // If it's not our offer and items are being given to us (potential donation or mistake)
        if (offer.itemsToReceive.length > 0 && offer.itemsToGive.length === 0) {
            if (offer.message && offer.message.includes('DepositID:')) { // Should not happen if !offer.isOurOffer
                console.log(`LOG_WARN: Received a 'newOffer' that looks like a deposit response (ID in message), but it's not our offer. Offer #${offer.id}. Declining.`);
            } else {
                console.log(`LOG_WARN: Received unsolicited item offer #${offer.id} from ${offer.partner.getSteamID64()}. Declining.`);
            }
            return offer.decline((err) => { if (err) console.error(`LOG_ERROR: Error declining unsolicited/unexpected newOffer ${offer.id}:`, err); });
        }
        console.log(`LOG_INFO: Ignoring other unexpected incoming offer #${offer.id} from ${offer.partner.getSteamID64()}. Message: "${offer.message}"`);
        offer.decline(err => { if(err) console.error(`Error declining other unexpected newOffer ${offer.id}:`, err); });
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        console.log(`LOG_INFO: Bot's sentOffer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()}) Msg: "${offer.message}"`);

        const depositIdMatch = offer.message.match(/DepositID: ([a-f0-9-]+)/i);
        const depositIdFromMessage = depositIdMatch ? depositIdMatch[1] : null;
        let depositData = null;

        if (depositIdFromMessage && pendingDeposits.has(depositIdFromMessage)) {
            depositData = pendingDeposits.get(depositIdFromMessage);
            if (depositData.offerIdAttempted && depositData.offerIdAttempted !== offer.id) {
                console.warn(`WARN: Offer ID mismatch for DepositID ${depositIdFromMessage}. Tracked: ${depositData.offerIdAttempted}, Event: ${offer.id}. This is unusual. Processing with event offer ID.`);
                // Potentially update the tracked offerId if this state change is for the actual offer
                // depositData.offerIdAttempted = offer.id;
            } else if (!depositData.offerIdAttempted) {
                // This can happen if the offer was sent and state changed before the offer.id was updated in pendingDeposits
                depositData.offerIdAttempted = offer.id;
            }
        }

        // --- Handle DEPOSIT offers ---
        if (depositData && offer.id === depositData.offerIdAttempted) {
            console.log(`LOG_DEBUG: Offer #${offer.id} matched pending deposit ${depositIdFromMessage}.`);
            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                pendingDeposits.delete(depositIdFromMessage); // Remove from pending map first
                console.log(`LOG_SUCCESS: Processing accepted deposit offer #${offer.id} (DepositID: ${depositIdFromMessage}) for user ${depositData.steamId}`);

                // Clear the user's pending flag
                User.updateOne({ _id: depositData.userId, pendingDepositOfferId: offer.id }, { $set: { pendingDepositOfferId: null }})
                    .catch(e => console.error("DB_ERROR: Error clearing user pending flag on deposit accept:", e));

                let createdItemDocuments = []; // To keep track of items for potential rollback
                try {
                    // Fetch fresh round data to ensure atomicity and avoid stale data
                    const roundForDeposit = await Round.findById(depositData.roundId).select('status participants items totalValue roundId'); // Fetch only necessary fields
                    if (!roundForDeposit || roundForDeposit.status !== 'active' || isRolling) { // isRolling is a global flag
                        console.warn(`WARN: Deposit ${depositIdFromMessage} (Offer ${offer.id}) accepted, but round invalid/rolling. Items NOT added to pot. Round status: ${roundForDeposit?.status}, isRolling: ${isRolling}`);
                        io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Deposit Error: Round for offer #${offer.id} ended/changed before processing. Contact support.` });
                        // TODO: Decide if items should be returned to user here. For now, they are with the bot.
                        return;
                    }
                    const isNewP = !roundForDeposit.participants.some(p => p.user?.toString() === depositData.userId.toString());
                    if (isNewP && roundForDeposit.participants.length >= MAX_PARTICIPANTS) {
                        console.warn(`WARN: Deposit ${depositIdFromMessage} accepted, but participant limit for round ${roundForDeposit.roundId} reached.`);
                        io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Deposit Error: Participant limit reached for offer #${offer.id}. Contact support.` }); return;
                    }
                    if (roundForDeposit.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                        console.warn(`WARN: Deposit ${depositIdFromMessage} accepted, but pot item limit for round ${roundForDeposit.roundId} reached.`);
                        io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Deposit Error: Pot item limit reached for offer #${offer.id}. Contact support.` }); return;
                    }

                    // Create Item documents
                    const itemModelsToSave = depositData.items.map(itemDetail => new Item({
                        assetId: itemDetail.assetid, name: itemDetail._name, image: itemDetail._image,
                        price: itemDetail._price, owner: depositData.userId, roundId: depositData.roundId
                    }));
                    createdItemDocuments = await Item.insertMany(itemModelsToSave, { ordered: false });
                    const createdItemIds = createdItemDocuments.map(doc => doc._id);
                    console.log(`LOG_INFO: Deposit ${depositIdFromMessage}: Inserted ${createdItemIds.length} items into DB.`);

                    // Update user's total deposited value
                    await User.findByIdAndUpdate( depositData.userId, { $inc: { totalDepositedValue: depositData.totalValue } } );

                    // Update the round document
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));
                    let participantUpdateQuery;
                    const participantExists = roundForDeposit.participants.some(p => p.user.toString() === depositData.userId.toString());

                    if (participantExists) {
                        participantUpdateQuery = {
                            $inc: {
                                'participants.$[elem].itemsValue': depositData.totalValue,
                                'participants.$[elem].tickets': depositTickets,
                                totalValue: depositData.totalValue
                            },
                            $push: { items: { $each: createdItemIds } }
                        };
                    } else {
                        participantUpdateQuery = {
                            $push: {
                                participants: { user: depositData.userId, itemsValue: depositData.totalValue, tickets: depositTickets },
                                items: { $each: createdItemIds }
                            },
                            $inc: { totalValue: depositData.totalValue }
                        };
                    }

                    const arrayFilters = participantExists ? [{ 'elem.user': depositData.userId }] : [];
                    const updatedRound = await Round.findByIdAndUpdate(
                        depositData.roundId,
                        participantUpdateQuery,
                        { new: true, arrayFilters: arrayFilters.length > 0 ? arrayFilters : undefined }
                    ).populate('participants.user', 'steamId username avatar').lean(); // Lean for emitting

                    if (!updatedRound) throw new Error('Failed to update round data after deposit.');

                    currentRound = updatedRound; // Update global currentRound

                    // Emit update to clients
                    const finalParticipantData = updatedRound.participants.find(p => p.user?._id.toString() === depositData.userId.toString());
                    if (finalParticipantData && finalParticipantData.user) {
                        io.emit('participantUpdated', {
                            roundId: updatedRound.roundId,
                            userId: finalParticipantData.user._id.toString(),
                            username: finalParticipantData.user.username,
                            avatar: finalParticipantData.user.avatar,
                            itemsValue: finalParticipantData.itemsValue,
                            tickets: finalParticipantData.tickets,
                            totalValue: updatedRound.totalValue,
                            depositedItems: depositData.items.map(i => ({ assetId: i.assetid, name: i._name, image: i._image, price: i._price }))
                        });
                        console.log(`LOG_INFO: Emitted 'participantUpdated' for user ${finalParticipantData.user.username} in round ${updatedRound.roundId}.`);
                    }

                    // Start timer if this is the first participant
                    if (updatedRound.participants.length === 1 && !roundTimer && updatedRound.status === 'active') {
                        startRoundTimer();
                    }
                    console.log(`LOG_SUCCESS: Deposit success processed for offer #${offer.id}. User: ${finalParticipantData?.user?.username}`);

                } catch (dbErr) {
                    console.error(`CRITICAL_DB_ERROR processing accepted deposit ${offer.id} (DepositID ${depositIdFromMessage}):`, dbErr);
                    io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `CRITICAL Deposit Error for offer #${offer.id}. Items may be held by bot. Contact support.` });
                    // Rollback items if they were inserted
                    if (createdItemDocuments.length > 0) {
                        await Item.deleteMany({ _id: { $in: createdItemDocuments.map(d => d._id) } });
                        console.log(`LOG_INFO: Rolled back ${createdItemDocuments.length} items from DB for failed deposit ${offer.id}.`);
                    }
                    // Potentially mark the round as error if this critical failure occurs
                    if (currentRound && currentRound._id?.toString() === depositData.roundId.toString()) {
                        console.error(`CRITICAL_ERROR: Marking round ${currentRound.roundId} as 'error' due to deposit processing failure.`);
                        await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } });
                        io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error led to round error.' });
                        currentRound.status = 'error'; // Update global state
                    }
                }

            } else if ([
                TradeOfferManager.ETradeOfferState.Declined,
                TradeOfferManager.ETradeOfferState.Canceled,
                TradeOfferManager.ETradeOfferState.Expired,
                TradeOfferManager.ETradeOfferState.InvalidItems // Items were not available
                ].includes(offer.state)) {

                pendingDeposits.delete(depositIdFromMessage);
                console.warn(`WARN: Deposit offer ${offer.id} (DepositID: ${depositIdFromMessage}) for user ${depositData.steamId} was ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                User.updateOne({ _id: depositData.userId, pendingDepositOfferId: offer.id }, { $set: {pendingDepositOfferId: null }})
                    .catch(e => console.error("DB_ERROR: Error clearing user pending flag on deposit failure/cancellation:", e));
                const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Your deposit offer (#${offer.id}) was ${stateMessage}.` });
            } else {
                // Other states like InEscrow, CreatedNeedsConfirmation for a deposit are unusual but log them.
                console.log(`LOG_DEBUG: Deposit Offer #${offer.id} (DepositID: ${depositIdFromMessage}) changed to unhandled state: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
            }
        }
        // --- Handle PAYOUT offers (winnings) ---
        else { // Offer is likely a payout if not matched to a pending deposit
            let payoutStatusUpdate = 'Unknown';
            switch (offer.state) {
                case TradeOfferManager.ETradeOfferState.Accepted: payoutStatusUpdate = 'Accepted'; break;
                case TradeOfferManager.ETradeOfferState.Declined: payoutStatusUpdate = 'Declined'; break;
                case TradeOfferManager.ETradeOfferState.Canceled: payoutStatusUpdate = 'Canceled'; break;
                case TradeOfferManager.ETradeOfferState.Expired: payoutStatusUpdate = 'Expired'; break;
                case TradeOfferManager.ETradeOfferState.InvalidItems: payoutStatusUpdate = 'InvalidItems'; break;
                case TradeOfferManager.ETradeOfferState.InEscrow: payoutStatusUpdate = 'Escrow'; break;
                case TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation: // Bot needs to confirm
                case TradeOfferManager.ETradeOfferState.PendingConfirmation: // User needs to confirm (mobile)
                    payoutStatusUpdate = 'Pending Confirmation'; break;
                default: payoutStatusUpdate = TradeOfferManager.ETradeOfferState[offer.state] || 'Unknown';
            }
            console.log(`LOG_INFO: Payout offer #${offer.id} to ${offer.partner.getSteamID64()} changed to ${payoutStatusUpdate}.`);
            try {
                const updatedRound = await Round.findOneAndUpdate(
                    { payoutOfferId: offer.id }, // Find round by this payout offer ID
                    { $set: { payoutOfferStatus: payoutStatusUpdate } },
                    { new: true }
                ).populate('winner', 'steamId _id username'); // Populate winner for notification

                if (updatedRound && updatedRound.winner) {
                    const winnerUserIdStr = updatedRound.winner._id.toString();
                    console.log(`LOG_INFO: Updated payoutOfferStatus to ${payoutStatusUpdate} for round ${updatedRound.roundId}, winner ${updatedRound.winner.username}.`);

                    let notifType = 'info';
                    let notifMessage = `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) status: ${payoutStatusUpdate}.`;

                    if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                        notifType = 'success';
                        notifMessage = `Winnings from offer #${offer.id} (Round #${updatedRound.roundId}) successfully accepted!`;
                    } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired].includes(offer.state)) {
                        notifType = 'error';
                        notifMessage = `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) was ${payoutStatusUpdate}. Contact support if this was an error.`;
                         // Potentially re-allow user to click "Accept Winnings" if offer failed due to non-user fault (e.g. expired too fast)
                        if (offer.state === TradeOfferManager.ETradeOfferState.Expired || offer.state === TradeOfferManager.ETradeOfferState.Canceled) {
                             await Round.updateOne({ _id: updatedRound._id }, { $set: { payoutOfferStatus: 'PendingAcceptanceByWinner', payoutOfferId: null }});
                             notifMessage += " You can try accepting again.";
                        }
                    } else if (offer.state === TradeOfferManager.ETradeOfferState.InEscrow) {
                        notifType = 'warning';
                    }
                    io.to(winnerUserIdStr).emit('notification', { type: notifType, message: notifMessage });
                } else if (!updatedRound) {
                    // This can happen if the offer was for something else or if DB is out of sync.
                    console.warn(`WARN: Could not find round associated with payout offer #${offer.id} to update status. Offer message: "${offer.message}"`);
                }
            } catch (dbError) {
                console.error(`DB_ERROR: Error updating payout status for offer #${offer.id} in DB:`, dbError);
            }
        }
    });
}


if (isBotConfigured) {
    console.log("LOG_INFO: Bot is configured. Attempting initial login via executeBotLogin.");
    executeBotLogin()
        .then(() => {
            console.log("LOG_SUCCESS: Initial bot login successful.");
            // Auto-accept friend requests
            community.on('friendRelationship', (steamID, relationship) => {
                if (relationship === SteamCommunity.EFriendRelationship.RequestRecipient) {
                    console.log(`LOG_INFO: Received friend request from ${steamID}. Accepting...`);
                    community.addFriend(steamID, (friendErr) => {
                        if (friendErr) console.error(`LOG_ERROR: Error accepting friend request from ${steamID}:`, friendErr);
                        else console.log(`LOG_SUCCESS: Accepted friend request from ${steamID}.`);
                    });
                }
            });

            startPeriodicCookieRefresh();
            ensureInitialRound(); // Ensure a round is active or created
        })
        .catch(err => {
            // This error is critical for bot functionality.
            console.error("CRITICAL_ERROR: Initial bot login failed:", err.message);
            // Consider exiting if bot is essential and fails to start, or implement more robust retry.
        });
} else {
    console.warn("WARN: Steam Bot not configured. Trading features will be disabled.");
    isBotReady = false;
}


let currentRound = null; // Holds the current round object (usually a Mongoose document or lean object)
let roundTimer = null;   // Interval ID for the round countdown
let isRolling = false;   // Flag to indicate if a round is currently in the "rolling" (winner selection) phase

// --- Price Cache ---
const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false });

function getFallbackPrice(marketHashName) {
    // For items not found, assign a minimal value or zero, based on your site's rules.
    return MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0; // Or just 0 if no minimum
}

async function refreshPriceCache() {
    console.log("PRICE_INFO: Attempting to refresh price cache from rust.scmm.app...");
    const apiUrl = `https://rust.scmm.app/api/item/prices?currency=USD`; // Ensure currency is USD
    try {
        const response = await axios.get(apiUrl, { timeout: PRICE_FETCH_TIMEOUT_MS });
        if (response.data && Array.isArray(response.data)) {
            const items = response.data;
            let updatedCount = 0;
            let newItems = []; // For batch set
            items.forEach(item => {
                // Ensure item has a name and a valid price (price from API is in cents)
                if (item?.name && typeof item.price === 'number' && item.price >= 0) {
                    const priceInDollars = item.price / 100.0; // Convert cents to dollars
                    newItems.push({ key: item.name, val: priceInDollars });
                    updatedCount++;
                }
            });
            if (newItems.length > 0) {
                const success = priceCache.mset(newItems); // Batch set prices
                if(success) console.log(`PRICE_SUCCESS: Refreshed price cache with ${updatedCount} items from rust.scmm.app.`);
                else console.error("PRICE_ERROR: Failed to bulk set price cache (node-cache mset returned false).");
            } else {
                console.warn("PRICE_WARN: No valid items found in the response from rust.scmm.app price refresh.");
            }
        } else {
            console.error("PRICE_ERROR: Invalid or empty array response received from rust.scmm.app price refresh. Response Status:", response.status);
        }
    } catch (error) {
        console.error(`PRICE_ERROR: Failed to fetch prices from ${apiUrl}.`);
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            console.error(` -> Error: Request timed out after ${PRICE_FETCH_TIMEOUT_MS}ms.`);
        } else if (error.response) {
            console.error(` -> Status: ${error.response.status}, Response:`, error.response.data || error.message);
        } else if (error.request) {
            console.error(` -> Error: No response received (Network issue?).`, error.message);
        } else {
            console.error(' -> Error setting up request:', error.message);
        }
    }
}

function getItemPrice(marketHashName) {
    if (typeof marketHashName !== 'string' || marketHashName.length === 0) {
        console.warn("getItemPrice called with invalid marketHashName:", marketHashName);
        return 0; // Return 0 for invalid input
    }
    const cachedPrice = priceCache.get(marketHashName);
    return (cachedPrice !== undefined) ? cachedPrice : getFallbackPrice(marketHashName);
}

// --- Core Game Logic ---
async function createNewRound() {
    if (isRolling) { // Prevent new round creation if one is currently being decided
        console.log("LOG_INFO: Cannot create new round: Current round is rolling.");
        return null;
    }
    if (currentRound && currentRound.status === 'active') { // Prevent if an active round already exists
        console.log(`LOG_INFO: Cannot create new round: Round ${currentRound.roundId} is already active.`);
        return currentRound; // Return the existing active round
    }

    try {
        isRolling = false; // Ensure rolling flag is reset
        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');

        const lastRound = await Round.findOne().sort('-roundId'); // Get the highest roundId
        const nextRoundId = lastRound ? lastRound.roundId + 1 : 1;

        const newRound = new Round({
            roundId: nextRoundId,
            status: 'active', // New rounds start as active
            startTime: new Date(),
            serverSeed: serverSeed,
            serverSeedHash: serverSeedHash,
            items: [],
            participants: [],
            totalValue: 0,
            payoutOfferStatus: 'Unknown' // Initial status for winnings
        });
        await newRound.save();
        currentRound = newRound.toObject(); // Store as a plain object for easier manipulation

        // Notify clients about the new round
        io.emit('roundCreated', {
            roundId: newRound.roundId,
            serverSeedHash: newRound.serverSeedHash,
            timeLeft: ROUND_DURATION, // Initial time for the new round
            totalValue: 0,
            participants: [],
            items: []
        });
        console.log(`LOG_SUCCESS: --- Round ${newRound.roundId} created and active ---`);
        // No timer is started here automatically; it starts when the first participant joins
        return newRound.toObject();
    } catch (err) {
        console.error('FATAL_ERROR: Error creating new round:', err);
        setTimeout(createNewRound, 10000); // Retry after a delay if creation fails
        return null;
    }
}

async function ensureInitialRound() {
    // Only proceed if bot is configured. Readiness check can be more nuanced.
    if (isBotConfigured && isBotReady) {
        if (!currentRound) { // If no round is currently loaded in memory
            try {
                // Look for an existing active round in DB (e.g., after server restart)
                const existingActive = await Round.findOne({ status: 'active' })
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items') // If items are stored as full docs, or just IDs
                    .lean(); // Use .lean() for performance if not modifying directly

                if (existingActive) {
                    console.log(`LOG_INFO: Found existing active round ${existingActive.roundId} on startup.`);
                    currentRound = existingActive;
                    // If round has participants and an endTime is set and in the future, resume timer
                    if (currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        startRoundTimer(true); // Resume with remaining time
                    } else if (currentRound.participants.length > 0 && !currentRound.endTime && !roundTimer) {
                        // If active with participants but no end time (e.g. timer didn't start before crash)
                        console.warn(`WARN: Active round ${currentRound.roundId} found without endTime. Starting timer now.`);
                        startRoundTimer(false); // Start fresh timer
                    }
                } else {
                    // No active round found, create a new one
                    console.log("LOG_INFO: No active round found, creating initial round...");
                    await createNewRound();
                }
            } catch (dbErr) {
                console.error("DB_ERROR: Error ensuring initial round:", dbErr);
            }
        }
    } else if (isBotConfigured && !isBotReady) {
        console.log("LOG_INFO: Bot configured but not ready, skipping initial round check until bot is ready.");
        // Bot might become ready later, at which point ensureInitialRound could be called again or implicitly handled
    } else {
        console.log("LOG_INFO: Bot not configured, skipping initial round check.");
    }
}


function startRoundTimer(useRemainingTime = false) {
    if (roundTimer) clearInterval(roundTimer); // Clear any existing timer
    if (!currentRound || currentRound.status !== 'active') {
        console.warn("WARN: Cannot start timer: No active round or round status invalid.");
        return;
    }

    let timeLeft;
    let calculatedEndTime;

    if (useRemainingTime && currentRound.endTime) { // Resuming an existing timer
        calculatedEndTime = new Date(currentRound.endTime);
        timeLeft = Math.max(0, Math.floor((calculatedEndTime.getTime() - Date.now()) / 1000));
        console.log(`LOG_INFO: Resuming timer for round ${currentRound.roundId} with ${timeLeft}s remaining.`);
    } else { // Starting a new timer
        timeLeft = ROUND_DURATION;
        calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
        currentRound.endTime = calculatedEndTime; // Update in-memory round object
        // Update endTime in database
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime }})
            .catch(e => console.error(`DB_ERROR: Error saving round end time for round ${currentRound?.roundId}:`, e));
        console.log(`LOG_INFO: Starting timer for round ${currentRound.roundId} (${ROUND_DURATION}s). End time: ${calculatedEndTime.toISOString()}`);
    }

    io.emit('timerUpdate', { timeLeft }); // Initial emit of time

    roundTimer = setInterval(async () => {
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) {
            clearInterval(roundTimer); roundTimer = null;
            console.warn("WARN: Timer stopped: Round state became invalid during countdown.");
            return;
        }

        const now = Date.now();
        let currenttimeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - now) / 1000));

        io.emit('timerUpdate', { timeLeft: currenttimeLeft }); // Emit updated time

        if (currenttimeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null;
            console.log(`LOG_INFO: Round ${currentRound.roundId} timer reached zero.`);
            await endRound(); // Proceed to end the round
        }
    }, 1000);
}


async function endRound() {
    if (!currentRound || isRolling || currentRound.status !== 'active') {
        console.warn(`WARN: Attempted to end round ${currentRound?.roundId}, but state is invalid (Status: ${currentRound?.status}, Rolling: ${isRolling})`);
        return;
    }
    isRolling = true; // Set rolling flag
    const roundIdToEnd = currentRound.roundId;
    const roundMongoId = currentRound._id; // Assuming currentRound is a Mongoose object or has _id
    console.log(`LOG_INFO: --- Ending round ${roundIdToEnd}... ---`);

    try {
        // Update round status to 'rolling' in DB
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } }); // Mark endTime as now
        io.emit('roundRolling', { roundId: roundIdToEnd });

        // Fetch the full round data for processing
        const round = await Round.findById(roundMongoId)
            .populate('participants.user', 'steamId username avatar tradeUrl') // Populate necessary user fields
            .populate('items') // Populate item details
            .lean(); // Use lean for performance

        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);
        if (round.status !== 'rolling') { // Double check status
            console.warn(`WARN: Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Aborting endRound.`);
            isRolling = false; return;
        }
        currentRound = round; // Update global currentRound with full lean object

        // Handle rounds with no participants or no value
        if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            console.log(`LOG_INFO: Round ${round.roundId} ended with no valid participants or value.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date() } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants or value." });
            isRolling = false;
            setTimeout(createNewRound, 5000); // Schedule new round
            return;
        }

        // --- Tax Calculation ---
        let finalItems = [...round.items]; // Items to be given to the winner
        let originalPotValue = round.totalValue; // Use the round's recorded totalValue
        let valueForWinner = originalPotValue;
        let taxAmount = 0;
        let taxedItemsInfo = []; // To store info about items taken for tax
        let itemsToTakeForTaxIds = new Set();

        if (originalPotValue >= MIN_POT_FOR_TAX) {
            const targetTaxValue = originalPotValue * (TAX_MIN_PERCENT / 100);
            const maxTaxValue = originalPotValue * (TAX_MAX_PERCENT / 100);
            // Sort items by price (ascending) to take smaller items for tax first
            const sortedItemsForTax = [...round.items].sort((a, b) => a.price - b.price);
            let currentTaxValueAccumulated = 0;

            for (const item of sortedItemsForTax) {
                if (currentTaxValueAccumulated + item.price <= maxTaxValue) { // Stay within max tax
                    itemsToTakeForTaxIds.add(item._id.toString());
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price });
                    currentTaxValueAccumulated += item.price;
                    if (currentTaxValueAccumulated >= targetTaxValue) break; // Stop if target tax reached
                } else {
                    // Adding this item would exceed max tax, so stop or try a smaller item if available
                    break;
                }
            }

            if (itemsToTakeForTaxIds.size > 0) {
                finalItems = round.items.filter(item => !itemsToTakeForTaxIds.has(item._id.toString()));
                taxAmount = currentTaxValueAccumulated;
                valueForWinner = originalPotValue - taxAmount;
                console.log(`LOG_INFO: Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${itemsToTakeForTaxIds.size} items). Original Value: $${originalPotValue.toFixed(2)}. New Pot Value for Winner: $${valueForWinner.toFixed(2)}`);
            }
        }

        // --- Winner Selection (Provably Fair) ---
        const clientSeed = crypto.randomBytes(16).toString('hex'); // Generate client seed
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16); // Use first 8 hex chars
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);

        if (totalTickets <= 0) throw new Error(`Cannot determine winner: Total tickets is zero for round ${round.roundId}.`);
        const winningTicket = decimalFromHash % totalTickets; // Determine winning ticket number
        let cumulativeTickets = 0;
        let winnerInfo = null; // This will hold the populated winner user object

        for (const participant of round.participants) {
            if (!participant?.tickets || !participant.user) continue; // Skip if invalid participant data
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winnerInfo = participant.user; // Winner found
                break;
            }
        }

        if (!winnerInfo || !winnerInfo._id) throw new Error(`Winner selection failed for round ${round.roundId}.`);

        // Update winner's stats
        await User.findByIdAndUpdate(winnerInfo._id, { $inc: { totalWinningsValue: valueForWinner } });
        console.log(`LOG_INFO: Updated winnings stats for ${winnerInfo.username}: added $${valueForWinner.toFixed(2)}`);

        // Finalize round data for saving
        const finalUpdateData = {
            status: 'completed_pending_acceptance', // Winner needs to accept winnings
            completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winnerInfo._id,
            taxAmount: taxAmount, taxedItems: taxedItemsInfo,
            totalValue: valueForWinner, // This is the value the winner gets
            items: finalItems.map(i => i._id), // Store IDs of items won
            payoutOfferStatus: 'PendingAcceptanceByWinner' // Initial status for payout
        };

        const completedRound = await Round.findOneAndUpdate({ _id: roundMongoId }, { $set: finalUpdateData }, { new: true });
        if (!completedRound) throw new Error("Failed to save completed round data.");

        console.log(`LOG_SUCCESS: Round ${round.roundId} completed. Winner: ${winnerInfo.username} (Ticket: ${winningTicket}/${totalTickets}, Value Won: $${valueForWinner.toFixed(2)})`);

        // Emit event to clients
        io.emit('roundWinnerPendingAcceptance', {
            roundId: round.roundId,
            winner: { id: winnerInfo._id, steamId: winnerInfo.steamId, username: winnerInfo.username, avatar: winnerInfo.avatar },
            winningTicket: winningTicket,
            totalValue: valueForWinner, // Value winner will receive
            totalTickets: totalTickets,
            serverSeed: round.serverSeed, // Reveal server seed
            clientSeed: clientSeed,       // Reveal client seed
            provableHash: provableHash,   // Reveal final hash
            serverSeedHash: round.serverSeedHash // Public hash from round start
        });

    } catch (err) {
        console.error(`CRITICAL_ERROR: Error during endRound for round ${roundIdToEnd}:`, err);
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', payoutOfferStatus: 'Failed' }})
            .catch(e => console.error("DB_ERROR: Error marking round as error after endRound failure:", e));
        io.emit('roundError', { roundId: roundIdToEnd, error: 'Internal server error during round finalization.' });
    } finally {
        isRolling = false; // Reset rolling flag
        console.log(`LOG_INFO: Scheduling next round creation after round ${roundIdToEnd} finalization.`);
        setTimeout(createNewRound, 10000); // Schedule next round creation
    }
}


async function checkOfferStatus(offerId) {
    return new Promise((resolve) => {
        if (!isBotReady || !manager) {
            console.warn(`LOG_WARN: Cannot check offer status for ${offerId}: Bot not ready or manager unavailable.`);
            return resolve(null); // Indicate failure to check
        }
        manager.getOffer(offerId, (err, offer) => {
            if (err) {
                console.log(`LOG_WARN: Could not fetch offer ${offerId} for status check:`, err.message);
                // If error is EResult 25 (LimitExceeded), it means the offer doesn't exist or isn't ours
                if (err.eresult === 25) {
                    return resolve({ state: -1, stateName: 'NotFoundOrNotOwned' }); // Special state for not found
                }
                return resolve(null); // Other errors
            }
            // Offer found
            resolve({
                state: offer.state,
                stateName: TradeOfferManager.ETradeOfferState[offer.state]
            });
        });
    });
}

// Helper function to parse and validate trade URL
function parseTradeURL(tradeUrl) {
    try {
        // More flexible regex that handles potential variations
        const regex = /https?:\/\/(www\.)?steamcommunity\.com\/tradeoffer\/new\/\?partner=(\d+)(&|&amp;)token=([a-zA-Z0-9_-]+)/i;
        const match = tradeUrl.match(regex);

        if (!match) {
            return { valid: false, error: 'Invalid trade URL format' };
        }

        const [, , partnerId, , token] = match;

        // Convert partner ID to SteamID64
        const steamId = new SteamID();
        steamId.universe = SteamID.Universe.PUBLIC;
        steamId.type = SteamID.Type.INDIVIDUAL;
        steamId.instance = SteamID.Instance.DESKTOP;
        steamId.accountid = parseInt(partnerId);

        return {
            valid: true,
            partnerId: partnerId,
            token: token,
            steamId64: steamId.getSteamID64(),
            steamIdObject: steamId
        };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

// Alternative method 1: Create offer using SteamID and token separately
async function createOfferMethod1(winner, manager) {
    const parsed = parseTradeURL(winner.tradeUrl);
    if (!parsed.valid) {
        throw new Error(`Invalid trade URL: ${parsed.error}`);
    }

    // Create offer using SteamID object
    const offer = manager.createOffer(parsed.steamIdObject);
    offer.setToken(parsed.token); // Set the token separately

    return offer;
}

// Alternative method 2: Create offer using partner's SteamID64
async function createOfferMethod2(winner, manager) {
    const parsed = parseTradeURL(winner.tradeUrl);
    if (!parsed.valid) {
        throw new Error(`Invalid trade URL: ${parsed.error}`);
    }

    // Create offer using SteamID64 string
    const offer = manager.createOffer(parsed.steamId64);
    offer.setToken(parsed.token);

    return offer;
}

// Alternative method 3: URL normalization before use
function normalizeTradeURL(tradeUrl) {
    // Remove any trailing slashes or spaces
    let normalized = tradeUrl.trim().replace(/\/$/, '');

    // Fix common issues
    normalized = normalized.replace(/&amp;/g, '&'); // Fix HTML entities
    normalized = normalized.replace(/^http:/, 'https:'); // Force HTTPS

    // Ensure proper URL encoding
    try {
        const url = new URL(normalized);
        return url.toString();
    } catch (e) {
        return normalized; // Return as-is if URL parsing fails
    }
}

// Enhanced sendWinningTradeOffer with multiple fallback methods
async function sendWinningTradeOffer(roundDoc, winner, itemsToSend, retryAttempt = 0) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ========== STARTING WINNING TRADE OFFER ==========`);
    console.log(`[${timestamp}] Round: ${roundDoc.roundId}, Winner: ${winner?.username}`);
    console.log(`[${timestamp}] Trade URL from winner object: ${winner?.tradeUrl}`); // Log the initial trade URL
    console.log(`[${timestamp}] Items to send: ${itemsToSend?.length || 0}`);

    // Validate inputs
    if (!roundDoc || !winner || !itemsToSend) {
        console.error(`[${timestamp}] PAYOUT_ERROR: Missing required parameters for sendWinningTradeOffer.`);
        // Avoid DB update if roundDoc is missing
        if (roundDoc && roundDoc._id) {
             await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - System Error' } });
        }
        return;
    }

    // Check trade URL exists on winner object
    if (!winner.tradeUrl) {
        console.error(`[${timestamp}] PAYOUT_ERROR: Winner ${winner.username} has no trade URL for round ${roundDoc.roundId}`);
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - No Trade URL' } });
        if (io && winner._id) {
            io.to(winner._id.toString()).emit('notification', {
                type: 'error',
                message: 'Please set your Steam Trade URL in your profile to receive winnings.'
            });
        }
        return;
    }

    // Parse and validate trade URL (this uses the new flexible regex)
    const parsed = parseTradeURL(winner.tradeUrl);
    console.log(`[${timestamp}] Trade URL parse result for "${winner.tradeUrl}":`, parsed);

    if (!parsed.valid) {
        console.error(`[${timestamp}] PAYOUT_ERROR (Round ${roundDoc.roundId}): ${parsed.error}. Original URL: "${winner.tradeUrl}"`);
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Invalid Trade URL Format' } });
        if (io && winner._id) {
            io.to(winner._id.toString()).emit('notification', {
                type: 'error',
                message: `Your Steam Trade URL format is invalid (${parsed.error}). Please update it in your profile.`
            });
        }
        return;
    }

    // Check for items to send
    if (!itemsToSend || itemsToSend.length === 0) {
        console.log(`[${timestamp}] PAYOUT_INFO (Round ${roundDoc.roundId}): No items to send to ${winner.username} (all consumed by tax or empty pot).`);
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'No Items Won' } });
        if (io && winner._id) {
            io.to(winner._id.toString()).emit('notification', {
                type: 'info',
                message: `Congratulations on winning round #${roundDoc.roundId}! No items were sent as the pot was consumed by fees or was empty.`
            });
        }
        return;
    }

    // Ensure bot is ready
    try {
        await ensureValidManager(); // This should also handle cookie validation and re-login if necessary
        console.log(`[${timestamp}] Bot session validated for round ${roundDoc.roundId}.`);
        if (!manager) { // Double check manager exists
            throw new Error("TradeOfferManager (manager) is null after session validation.");
        }
    } catch (sessionError) {
        console.error(`[${timestamp}] PAYOUT_ERROR (Round ${roundDoc.roundId}): Bot session error:`, sessionError.message, sessionError);
        if (retryAttempt < MAX_TRADE_RETRY_ATTEMPTS) {
            console.log(`[${timestamp}] Retrying payout for round ${roundDoc.roundId} after session error (attempt ${retryAttempt + 2})...`);
            await new Promise(resolve => setTimeout(resolve, 5000 * (retryAttempt + 1))); // Exponential backoff style
            return sendWinningTradeOffer(roundDoc, winner, itemsToSend, retryAttempt + 1);
        }
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Bot Session Issue' } });
        if (io && winner._id) {
            io.to(winner._id.toString()).emit('notification', { type: 'error', message: 'Bot service is temporarily unavailable. Please try again or contact support.' });
        }
        return;
    }

    let offer = null;
    let lastOfferCreationError = null;
    const offerCreationMethods = [
        { name: 'Direct URL', fn: () => manager.createOffer(winner.tradeUrl) }, // Original trade URL
        { name: 'Normalized URL', fn: () => manager.createOffer(normalizeTradeURL(winner.tradeUrl)) },
        { name: 'SteamID + Token', fn: () => createOfferMethod1(winner, manager) }, // Uses parsed SteamID object + token
        { name: 'SteamID64 + Token', fn: () => createOfferMethod2(winner, manager) }, // Uses parsed SteamID64 string + token
        { name: 'Partner URL Construction', fn: () => {
            const reconstructedUrl = `https://steamcommunity.com/tradeoffer/new/?partner=${parsed.partnerId}&token=${parsed.token}`;
            console.log(`[${timestamp}] Attempting Partner URL Construction with: ${reconstructedUrl}`);
            return manager.createOffer(reconstructedUrl);
        }}
    ];

    for (const method of offerCreationMethods) {
        try {
            console.log(`[${timestamp}] Round ${roundDoc.roundId}: Trying offer creation method: ${method.name}`);
            offer = await method.fn(); // Ensure this is awaited if fn is async (createOfferMethod1/2 are)

            if (offer && typeof offer.addMyItems === 'function') { // Basic check for a valid offer object
                console.log(`[${timestamp}] Round ${roundDoc.roundId}: ✓ Offer created successfully using method: ${method.name}`);
                break; // Exit loop if offer creation is successful
            } else {
                 lastOfferCreationError = new Error(`Method ${method.name} returned an invalid offer object.`);
                console.error(`[${timestamp}] Round ${roundDoc.roundId}: ✗ Method '${method.name}' failed: Invalid offer object returned.`);
                offer = null; // Reset offer if it's not valid
            }
        } catch (error) {
            lastOfferCreationError = error;
            console.error(`[${timestamp}] Round ${roundDoc.roundId}: ✗ Method '${method.name}' failed:`, error.message, error);
            offer = null; // Reset offer on error
        }
    }

    if (!offer) {
        console.error(`[${timestamp}] CRITICAL (Round ${roundDoc.roundId}): All offer creation methods failed for ${winner.username}.`);
        console.error(`[${timestamp}] Last offer creation error (Round ${roundDoc.roundId}):`, lastOfferCreationError?.message, lastOfferCreationError);

        let finalStatus = 'Failed - Offer Creation Error';
        if (lastOfferCreationError && lastOfferCreationError.message && lastOfferCreationError.message.toLowerCase().includes('malformed')) {
            finalStatus = 'Failed - Malformed Trade URL';
             if (io && winner._id) {
                io.to(winner._id.toString()).emit('notification', {
                    type: 'error',
                    message: 'Your trade URL appears to be malformed. Please get a new one from Steam and update your profile.'
                });
            }
        }

        if (retryAttempt < MAX_TRADE_RETRY_ATTEMPTS && finalStatus !== 'Failed - Malformed Trade URL') { // Don't retry malformed indefinitely
            console.log(`[${timestamp}] Retrying payout for round ${roundDoc.roundId} after offer creation failure (attempt ${retryAttempt + 2})...`);
            await new Promise(resolve => setTimeout(resolve, 6000 * (retryAttempt + 1)));
            return sendWinningTradeOffer(roundDoc, winner, itemsToSend, retryAttempt + 1);
        }

        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: finalStatus } });
         if (io && winner._id && finalStatus === 'Failed - Offer Creation Error') { // General creation error
             io.to(winner._id.toString()).emit('notification', { type: 'error', message: 'Could not create trade offer. Please try again or contact support.'});
         }
        return;
    }

    // Offer object is now available
    try {
        console.log(`[${timestamp}] Round ${roundDoc.roundId}: Proceeding to add items and send offer for ${winner.username}.`);

        const itemsForOffer = itemsToSend.map(item => ({
            assetid: String(item.assetId || item.id), // Handle if assetId is under 'id' property
            appid: RUST_APP_ID,
            contextid: String(RUST_CONTEXT_ID) // Ensure contextid is string if manager expects it
        }));

        console.log(`[${timestamp}] Round ${roundDoc.roundId}: Items being prepared for offer:`, JSON.stringify(itemsForOffer.map(i => i.assetid)));

        // Add items to the offer
        const addItemsResult = offer.addMyItems(itemsForOffer);
        if (!addItemsResult || !offer.itemsToGive || offer.itemsToGive.length !== itemsForOffer.length) {
             // This check is important. addMyItems might return true but not add all items if some are invalid/missing from bot inv.
            console.error(`[${timestamp}] PAYOUT_ERROR (Round ${roundDoc.roundId}): Bot failed to add all items to offer. Expected ${itemsForOffer.length}, got ${offer.itemsToGive?.length || 0}. Items might be missing from bot inventory or untradable.`);
            await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Bot Inventory Issue' } });
            if (io && winner._id) {
                io.to(winner._id.toString()).emit('notification', { type: 'error', message: `Critical error: Bot could not find/add all items for your winnings (Round ${roundDoc.roundId}). Contact support immediately.` });
            }
            return;
        }
        console.log(`[${timestamp}] Round ${roundDoc.roundId}: Successfully added ${offer.itemsToGive.length} items to offer for ${winner.username}.`);

        const offerMessage = `🎉 Round #${roundDoc.roundId} Winnings - ${process.env.SITE_NAME || 'YourSite'} - Value: $${roundDoc.totalValue.toFixed(2)} 🎉 Congratulations!`;
        offer.setMessage(offerMessage);

        console.log(`[${timestamp}] Round ${roundDoc.roundId}: Offer state before send for ${winner.username}:`, {
            state: offer.state, // ETradeOfferState
            itemsToGiveCount: offer.itemsToGive.length,
            itemsToReceiveCount: offer.itemsToReceive.length,
            partnerSteamID64: offer.partner ? offer.partner.getSteamID64() : 'N/A',
            messageSet: offer.message
        });

        console.log(`[${timestamp}] Round ${roundDoc.roundId}: Attempting to send offer to ${winner.username} (Offer ID if already set: ${offer.id})...`);

        const sendResponse = await new Promise((resolveOfferSend, rejectOfferSend) => {
            offer.send((err, status) => {
                const callbackTimestamp = new Date().toISOString();
                if (err) {
                    console.error(`[${callbackTimestamp}] PAYOUT_SEND_ERROR (Round ${roundDoc.roundId}) for ${winner.username}: EResult=${err.eresult}, Message='${err.message}', Cause='${err.cause}'`, err);
                    // Attach offer.id to the error if available for better tracking
                    if (offer.id) err.offerId = offer.id;
                    return rejectOfferSend(err);
                }
                console.log(`[${callbackTimestamp}] PAYOUT_SEND_SUCCESS (Round ${roundDoc.roundId}) for ${winner.username}: Status: ${status}, Offer ID: ${offer.id}, Offer State: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
                resolveOfferSend({ status, offerId: offer.id, offerState: offer.state });
            });
        });

        const { status: steamStatus, offerId: actualOfferId, offerState } = sendResponse;
        const offerURL = `https://steamcommunity.com/tradeoffer/${actualOfferId}/`;
        let initialPayoutStatus = 'Sent'; // Default

        if (offerState === TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation ||
            offerState === TradeOfferManager.ETradeOfferState.PendingConfirmation ||
            (steamStatus === 'pending' && process.env.STEAM_IDENTITY_SECRET)) { // 'pending' status with identity secret often means bot needs to confirm
            initialPayoutStatus = 'Pending Confirmation';
        } else if (offerState === TradeOfferManager.ETradeOfferState.InEscrow) {
            initialPayoutStatus = 'Escrow';
        }
        // Note: offer.state might be ETradeOfferState.Active after a successful send if no confirmation/escrow

        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferId: actualOfferId, payoutOfferStatus: initialPayoutStatus } });
        console.log(`[${timestamp}] PAYOUT_DB_UPDATE (Round ${roundDoc.roundId}): DB updated for offer ${actualOfferId}. Status set to: ${initialPayoutStatus}.`);

        if (io && winner._id) {
            io.to(winner._id.toString()).emit('tradeOfferSent', { roundId: roundDoc.roundId, userId: winner._id.toString(), offerId: actualOfferId, offerURL, status: initialPayoutStatus, type: 'winning' });
            let notifMessage = `Winnings offer #${actualOfferId} (Round #${roundDoc.roundId}) has been sent! Status: ${initialPayoutStatus}. Click to view: ${offerURL}`;
            if (initialPayoutStatus === 'Pending Confirmation') notifMessage = `Winnings offer #${actualOfferId} (Round #${roundDoc.roundId}) needs confirmation. Please check Steam.`;
            else if (initialPayoutStatus === 'Escrow') notifMessage = `Winnings offer #${actualOfferId} (Round #${roundDoc.roundId}) is in Steam escrow. Please check your trades.`;
            io.to(winner._id.toString()).emit('notification', { type: initialPayoutStatus === 'Sent' || initialPayoutStatus === 'Accepted' ? 'success' : 'info', message: notifMessage });
        }
        console.log(`[${timestamp}] ========== WINNING TRADE OFFER COMPLETED for Round ${roundDoc.roundId} ==========`);

    } catch (sendProcessError) { // Catches errors from offer.send() or subsequent DB updates
        const errorTimestamp = new Date().toISOString();
        console.error(`[${errorTimestamp}] PAYOUT_PROCESS_ERROR (Round ${roundDoc.roundId}) for ${winner.username}:`, sendProcessError.message, sendProcessError);

        let offerStatusUpdate = 'Failed - Send Error'; // Default for this catch block
        let userMessage = `Error sending your winnings for round ${roundDoc.roundId}.`;
        let shouldRetrySend = false; // Default to not retry send errors unless specified

        if (sendProcessError.eresult) { // If the error has an EResult (likely from offer.send callback)
            userMessage += ` (Code: ${sendProcessError.eresult})`;
            switch (sendProcessError.eresult) {
                case 26: offerStatusUpdate = 'Failed - Invalid Trade URL'; userMessage = 'Your Steam Trade URL is invalid or expired. Please update it in your profile.'; break;
                case 15: offerStatusUpdate = 'Failed - Inventory Private'; userMessage = 'Could not send winnings. Please ensure your Steam inventory is public and not full, or you are not trade banned.'; break; // Can also be inventory full / cannot trade
                case 16: offerStatusUpdate = 'Failed - Trade Banned'; userMessage = 'You (or the bot) appear to be trade banned. Contact Steam support.'; break;
                case 11: offerStatusUpdate = 'Failed - Bot Session Issue'; userMessage = 'Bot session error. Please try again.'; shouldRetrySend = true; break;
                case 25: offerStatusUpdate = 'Failed - Rate Limited'; userMessage = 'Too many trade offers. Please try again later.'; shouldRetrySend = true; break;
                // Add other specific EResults if needed
                default: shouldRetrySend = true; // Retry other EResults by default if not catastrophic
            }
        } else if (sendProcessError.message?.includes('No items were added')) { // Custom error from item adding check
             offerStatusUpdate = 'Failed - Bot Inventory Issue';
             userMessage = `Critical error: Bot could not prepare items for your winnings (Round ${roundDoc.roundId}). Contact support.`;
        }


        if (shouldRetrySend && retryAttempt < MAX_TRADE_RETRY_ATTEMPTS) {
            console.log(`[${errorTimestamp}] Retrying payout for round ${roundDoc.roundId} after send process error (attempt ${retryAttempt + 2})...`);
            if (sendProcessError.eresult === 11) await validateAndRefreshCookies(); // Force session refresh for session issues
            await new Promise(resolve => setTimeout(resolve, 7000 * (retryAttempt + 1))); // Longer backoff for send errors
            return sendWinningTradeOffer(roundDoc, winner, itemsToSend, retryAttempt + 1);
        }

        // Final failure for this attempt or non-retryable error
        const offerIdWithError = sendProcessError.offerId || offer?.id || null; // Get offer ID if it exists
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferId: offerIdWithError, payoutOfferStatus: offerStatusUpdate } });
        if (io && winner._id) {
            io.to(winner._id.toString()).emit('notification', { type: 'error', message: userMessage });
        }
        console.log(`[${errorTimestamp}] ========== WINNING TRADE OFFER FAILED for Round ${roundDoc.roundId} - Status: ${offerStatusUpdate} ==========`);
    }
}


// --- Authentication Routes ---
app.get('/auth/steam', authLimiter, passport.authenticate('steam', { failureRedirect: '/' }));
app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => { res.redirect('/'); } // Redirect to homepage after successful login
);
app.post('/logout', (req, res, next) => {
    req.logout(err => { // passport.logout()
        if (err) { return next(err); }
        req.session.destroy(err => { // Destroy the session
            if (err) {
                console.error("Error destroying session during logout:", err);
                return res.status(500).json({ error: 'Logout failed due to session error.' });
            }
            res.clearCookie('connect.sid'); // Ensure client cookie is cleared
            res.json({ success: true, message: "Logged out successfully." });
        });
    });
});


// --- Middleware & API Routes ---
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) { return next(); }
    res.status(401).json({ error: 'Not authenticated. Please log in.' });
}
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.warn("Validation Errors:", errors.array());
        return res.status(400).json({ error: errors.array()[0].msg }); // Return first error message
    }
    next();
};

app.get('/api/user', ensureAuthenticated, (req, res) => {
    // Return only necessary, non-sensitive user data
    const { _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue });
});

app.post('/api/user/tradeurl',
    sensitiveActionLimiter, ensureAuthenticated,
    [
        body('tradeUrl').trim().custom((value) => {
            if (value === '') return true; // Allow empty string to clear URL
            if (!TRADE_URL_REGEX.test(value)) throw new Error('Invalid Steam Trade URL format. Ensure it includes partner and token parameters.');
            return true;
        })
    ],
    handleValidationErrors,
    async (req, res) => {
        const { tradeUrl } = req.body;
        try {
            // Find user and update. Mongoose validation will run.
            const updatedUser = await User.findByIdAndUpdate(req.user._id, { tradeUrl: tradeUrl }, { new: true, runValidators: true });
            if (!updatedUser) return res.status(404).json({ error: 'User not found.' });

            console.log(`LOG_INFO: Trade URL updated for user: ${updatedUser.username} to "${tradeUrl}"`);
            res.json({ success: true, tradeUrl: updatedUser.tradeUrl });
        } catch (err) {
            if (err.name === 'ValidationError') {
                console.error(`Trade URL Validation Error for user ${req.user._id}:`, err.message);
                // Extract a user-friendly message from Mongoose validation error if possible
                const messages = Object.values(err.errors).map(e => e.message);
                return res.status(400).json({ error: messages.join(', ') || 'Invalid Trade URL.' });
            }
            console.error(`Error updating trade URL for user ${req.user._id}:`, err);
            res.status(500).json({ error: 'Server error saving Trade URL.' });
        }
    }
);

app.post('/api/admin/clear-stuck-round', ensureAuthenticated, async (req, res) => {
    if (!process.env.ADMIN_STEAM_IDS || !process.env.ADMIN_STEAM_IDS.split(',').includes(req.user.steamId)) {
        return res.status(403).json({ error: 'Forbidden: Admin access required.' });
    }

    try {
        const stuckRound = await Round.findOneAndUpdate(
            { status: 'completed_pending_acceptance' }, // Find a round stuck in this state
            { $set: { status: 'completed', payoutOfferStatus: 'Failed - Manually Cleared' }}, // Mark as completed
            { new: true }
        );
        const clearedUsers = await User.updateMany(
            { pendingDepositOfferId: { $ne: null } }, // Find users with any pending deposit offer ID
            { $set: { pendingDepositOfferId: null } } // Clear the flag
        );

        console.log('LOG_INFO (Admin): Cleared stuck round:', stuckRound?.roundId || 'None found');
        console.log('LOG_INFO (Admin): Cleared pending offers for users:', clearedUsers.modifiedCount);

        // If the globally tracked currentRound was the one cleared, reset it
        if (currentRound && stuckRound && currentRound._id.toString() === stuckRound._id.toString()) {
            currentRound = null; // Force re-fetch or new round creation
            await ensureInitialRound(); // Attempt to setup a new/existing round
        }

        res.json({ success: true, clearedRoundId: stuckRound?.roundId, clearedUserOffers: clearedUsers.modifiedCount });
    } catch (error) {
        console.error('Error (Admin) clearing stuck round:', error);
        res.status(500).json({ error: 'Failed to clear stuck round' });
    }
});


app.get('/api/user/winning-history', ensureAuthenticated, async (req, res) => {
    try {
        const winnings = await Round.find({ winner: req.user._id, status: { $in: ['completed', 'completed_pending_acceptance', 'error'] } })
            .sort({ completedTime: -1 }) // Show most recent first
            .select('roundId completedTime totalValue payoutOfferId payoutOfferStatus taxAmount') // Select relevant fields
            .limit(25) // Limit to a reasonable number, e.g., 25
            .lean(); // Use .lean() for performance

        const history = winnings.map(win => ({
            gameId: win.roundId,
            amountWon: win.totalValue, // This is the value after tax
            dateWon: win.completedTime,
            tradeOfferId: win.payoutOfferId,
            tradeStatus: win.payoutOfferStatus || 'Unknown'
        }));
        res.json(history);
    } catch (error) {
        console.error(`Error fetching winning history for user ${req.user._id}:`, error);
        res.status(500).json({ error: 'Server error fetching winning history.' });
    }
});

app.post('/api/round/accept-winnings', ensureAuthenticated, sensitiveActionLimiter, async (req, res) => {
    console.log(`LOG_INFO: Received POST /api/round/accept-winnings for user ${req.user.username}`);
    try {
        const user = req.user; // User object from session

        // Find the latest round won by the user that is pending their acceptance
        const round = await Round.findOne({
            winner: user._id,
            status: 'completed_pending_acceptance',
            payoutOfferStatus: 'PendingAcceptanceByWinner' // Ensure it's explicitly waiting for user
        }).sort({ completedTime: -1 }) // Get the most recent one if multiple (should not happen often)
          .populate('winner', 'steamId username avatar tradeUrl') // Populate winner details for trade URL
          .populate('items'); // Populate items to be sent

        if (!round) {
            console.warn(`LOG_WARN: No winnings pending acceptance found for user ${user.username}`);
            return res.status(404).json({ error: 'No winnings pending your acceptance found or round already processed.' });
        }

        console.log(`LOG_INFO: Found round ${round.roundId} for user ${user.username} to accept winnings.`);

        if (!round.winner || !round.winner.tradeUrl) { // Winner details should be populated
            console.warn(`LOG_WARN: User ${user.username} (or populated winner) has no trade URL for round ${round.roundId}.`);
            await Round.updateOne({ _id: round._id }, { $set: { payoutOfferStatus: 'Failed - No Trade URL' } });
            return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile to accept winnings.' });
        }
        // The new sendWinningTradeOffer has its own more robust parsing, so the strict regex check here might be redundant
        // but it's a good first-pass client-side validation before hitting the more complex logic.
        if (!TRADE_URL_REGEX.test(round.winner.tradeUrl)) {
            console.error(`LOG_ERROR: Invalid trade URL format for user ${user.username} (pre-check): "${round.winner.tradeUrl}"`);
            await Round.updateOne({ _id: round._id }, { $set: { payoutOfferStatus: 'Failed - Invalid Trade URL Format' } });
            return res.status(400).json({ error: 'Your Steam Trade URL format is invalid. Please update it.' });
        }

        console.log(`LOG_INFO: Calling sendWinningTradeOffer for round ${round.roundId}, user ${round.winner.username}. Items: ${round.items.length}`);
        // Call sendWinningTradeOffer. This function will handle setting offer status in DB.
        await sendWinningTradeOffer(round, round.winner, round.items);

        // The response here is just an acknowledgement. Actual offer status is handled by bot events.
        res.json({ success: true, message: 'Winnings accepted. Trade offer processing initiated. Watch for Steam notifications.' });

    } catch (error) {
        console.error('CRITICAL_ERROR: Error in /api/round/accept-winnings:', error);
        res.status(500).json({ error: 'Server error while accepting winnings. Please try again or contact support.' });
    }
});


app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    if (!isBotConfigured) return res.status(503).json({ error: "Trading service is currently offline." });
    if (!isBotReady) {
        console.warn(`Inventory fetch failed for ${req.user.username}: Bot service is unavailable (isBotReady: false).`);
        return res.status(503).json({ error: "Steam service temporarily unavailable. Please try again later." });
    }
    try {
        await ensureValidManager(); // Ensure bot session is valid

        const inventory = await new Promise((resolve, reject) => {
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv, currency) => {
                if (err) {
                    if (err.message?.includes('profile is private') || err.eresult === 15) {
                        return reject(new Error('Your Steam inventory is private. Please set it to public.'));
                    }
                    console.error(`Inventory Fetch Error (Manager): User ${req.user.steamId}: EResult ${err.eresult}, Message: ${err.message || err}`);
                    return reject(new Error(`Could not fetch inventory. Steam might be busy (EResult: ${err.eresult || 'N/A'}) or inventory private.`));
                }
                resolve(inv || []); // Resolve with empty array if inv is null/undefined
            });
        });

        if (!inventory?.length) return res.json([]); // No items or empty inventory

        const validItems = inventory.map(item => {
                const itemName = item.market_hash_name;
                let price = 0;
                if (itemName) price = getItemPrice(itemName); // Get price from cache/fallback
                else console.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`);

                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

                if (!item.assetid || !item.icon_url || !itemName) {
                    console.warn(`Inventory item missing required properties: assetId ${item?.assetid}, Name ${itemName}, Icon ${item?.icon_url}`);
                    return null; // Skip invalid items
                }
                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`;
                return { assetId: item.assetid, name: itemName, image: imageUrl, price: finalPrice, tradable: item.tradable };
            })
            .filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE); // Filter out non-tradable and low-value items

        res.json(validItems);
    } catch (err) {
        console.error(`Error in /api/inventory for ${req.user?.username || req.user?.steamId}:`, err.message);
        const clientErrorMessage = (err.message === 'Your Steam inventory is private. Please set it to public.')
                                 ? err.message
                                 : 'Server error fetching inventory.';
        res.status(err.message.includes('private') ? 403 : 500).json({ error: clientErrorMessage });
    }
});

app.post('/api/deposit', depositLimiter, ensureAuthenticated,
    [
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`You can deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.') // Basic check
    ],
    handleValidationErrors,
    async (req, res) => {
        const user = req.user;
        const requestedAssetIds = req.body.assetIds;

        if (!isBotConfigured) return res.status(503).json({ error: "Trading service is currently offline." });
        if (!isBotReady) {
            console.warn(`Deposit attempt by ${user.username} while bot not ready.`);
            return res.status(503).json({ error: "Deposit service temporarily unavailable (Bot not ready)." });
        }
        if (!user.tradeUrl || !TRADE_URL_REGEX.test(user.tradeUrl)) {
            return res.status(400).json({ error: 'Valid Steam Trade URL required in profile for deposits.' });
        }

        // Check for existing pending deposit offer for this user
        if (user.pendingDepositOfferId) {
            try {
                const offerStatus = await checkOfferStatus(user.pendingDepositOfferId);
                // If offer is still active, Sent, or awaiting confirmation, inform user
                if (offerStatus && [
                       TradeOfferManager.ETradeOfferState.Active,
                       TradeOfferManager.ETradeOfferState.Sent, // Bot sent, user hasn't accepted
                       TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation // Bot needs to confirm
                    ].includes(offerStatus.state)) {
                    console.log(`User ${user.username} already has pending deposit offer ${user.pendingDepositOfferId}. State: ${offerStatus.stateName}`);
                    const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                    return res.status(409).json({ error: 'You have an active deposit offer pending. Please accept or decline it on Steam first.', offerId: user.pendingDepositOfferId, offerURL });
                } else {
                    // If offer is not in an actionable state (e.g., expired, declined, invalid), clear the flag
                    console.log(`Clearing stale/non-active pending offer ${user.pendingDepositOfferId} for user ${user.username} (State: ${offerStatus?.stateName || 'Unknown/Error'}).`);
                    await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
                     // req.user might be stale, so update local copy too if needed, though a fresh fetch or relying on DB is safer
                }
            } catch (offerFetchError) { // Should be handled by checkOfferStatus returning null
                console.warn(`Error checking pending offer ${user.pendingDepositOfferId}, clearing flag:`, offerFetchError.message);
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
            }
        }

        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }

        // Verify round limits (participants, items in pot)
        let latestRoundData;
        try {
            latestRoundData = await Round.findById(currentRound._id).select('participants items').lean();
            if (!latestRoundData) throw new Error('Could not fetch current round data for deposit.');
            const isNewParticipant = !latestRoundData.participants.some(p => p.user?.toString() === user._id.toString());
            if (isNewParticipant && latestRoundData.participants.length >= MAX_PARTICIPANTS) {
                return res.status(400).json({ error: `Participant limit (${MAX_PARTICIPANTS}) reached for this round.` });
            }
            if (latestRoundData.items.length + requestedAssetIds.length > MAX_ITEMS_PER_POT) {
                const slotsLeft = MAX_ITEMS_PER_POT - latestRoundData.items.length;
                return res.status(400).json({ error: `Depositing these items would exceed the pot limit (${MAX_ITEMS_PER_POT} items). ${slotsLeft > 0 ? slotsLeft + ' slots left.' : 'Pot is full.'}` });
            }
        } catch (dbErr) {
            console.error(`Error fetching round data during deposit for ${user.username}:`, dbErr);
            return res.status(500).json({ error: 'Internal server error checking round limits.' });
        }

        let itemsToRequestDetails = [];
        let depositTotalValue = 0;

        try {
            console.log(`Verifying inventory for ${user.username} (SteamID: ${user.steamId}) to confirm ${requestedAssetIds.length} deposit items...`);
            await ensureValidManager(); // Ensure bot session is fresh

            const userInventory = await new Promise((resolve, reject) => { // Fetch user's inventory
                manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                    if (err) {
                        if (err.message?.includes('profile is private') || err.eresult === 15) return reject(new Error('Your Steam inventory is private.'));
                        console.error(`Inventory Fetch Error (Deposit): User ${user.steamId}: EResult ${err.eresult}`, err);
                        return reject(new Error(`Could not fetch your inventory (EResult: ${err.eresult}). Ensure it's public and tradable.`));
                    }
                    resolve(inv || []);
                });
            });
            const userInventoryMap = new Map(userInventory.map(item => [item.assetid, item])); // For quick lookup

            for (const assetId of requestedAssetIds) {
                const inventoryItem = userInventoryMap.get(assetId);
                if (!inventoryItem) throw new Error(`Item (Asset ID ${assetId}) not found in your inventory or already in a trade.`);
                if (!inventoryItem.tradable) throw new Error(`Item '${inventoryItem.market_hash_name}' is not tradable.`);

                const price = getItemPrice(inventoryItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) throw new Error(`Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below the minimum deposit value of $${MIN_ITEM_VALUE.toFixed(2)}.`);

                itemsToRequestDetails.push({
                    assetid: inventoryItem.assetid, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID,
                    _price: price, _name: inventoryItem.market_hash_name,
                    _image: `https://community.akamai.steamstatic.com/economy/image/${inventoryItem.icon_url}`
                });
                depositTotalValue += price;
            }
            if (itemsToRequestDetails.length === 0) throw new Error("No valid items could be verified for deposit.");
            console.log(`Verified ${itemsToRequestDetails.length} items for deposit for ${user.username}. Total Value: $${depositTotalValue.toFixed(2)}`);
        } catch (verificationError) {
            console.warn(`Deposit item verification failed for ${user.username}:`, verificationError.message);
            return res.status(400).json({ error: verificationError.message });
        }

        const depositId = uuidv4(); // Unique ID for this deposit attempt
        const offerMessage = `Deposit for ${process.env.SITE_NAME || 'Our Site'} | Round: ${currentRound.roundId} | DepositID: ${depositId}`;
        let cleanupTimeout = null; // For auto-cleanup of pendingDeposits map

        try {
            const offer = manager.createOffer(user.tradeUrl); // Create offer TO the user
            offer.addTheirItems(itemsToRequestDetails.map(item => ({ assetid: item.assetid, appid: item.appid, contextid: item.contextid }))); // Bot requests these items
            offer.setMessage(offerMessage);

            // Store pending deposit info (in-memory, consider DB for persistence if needed)
            pendingDeposits.set(depositId, {
                userId: user._id, roundId: currentRound._id, items: itemsToRequestDetails,
                totalValue: depositTotalValue, steamId: user.steamId, offerIdAttempted: null // offerIdAttempted will be set after send
            });
            console.log(`Stored pending deposit ${depositId} for user ${user.steamId}.`);

            // Timeout to remove from pendingDeposits if not processed
            const offerCancelTime = manager.cancelTime || 10 * 60 * 1000;
            cleanupTimeout = setTimeout(() => {
                if(pendingDeposits.has(depositId)) {
                    const pendingData = pendingDeposits.get(depositId);
                    console.log(`Deposit attempt ${depositId} (Offer: ${pendingData.offerIdAttempted || 'N/A'}) expired or timed out.`);
                    pendingDeposits.delete(depositId);
                    if (pendingData.offerIdAttempted) { // If an offer was actually sent
                        User.updateOne({ _id: user._id, pendingDepositOfferId: pendingData.offerIdAttempted }, { $set: { pendingDepositOfferId: null }})
                            .catch(e => console.error("Error clearing user pending flag on deposit expiry/timeout:", e));
                    }
                }
            }, offerCancelTime + 5000); // Add a small buffer

            console.log(`Sending deposit offer to ${user.username} (Trade URL: ${user.tradeUrl}). DepositID: ${depositId}`);
            const status = await new Promise((resolve, reject) => { // Send the offer
                offer.send((err, sendStatus) => {
                    if (err) return reject(err);
                    resolve(sendStatus); // 'pending' if needs confirmation, 'sent' otherwise
                });
            });
            const actualOfferId = offer.id; // Get the offer ID after sending
            console.log(`Deposit offer ${actualOfferId} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);

            if (pendingDeposits.has(depositId)) {
                pendingDeposits.get(depositId).offerIdAttempted = actualOfferId; // Update map with actual offer ID
            }

            try { // Update user's pendingDepositOfferId in DB
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: actualOfferId });
                console.log(`Set pendingDepositOfferId=${actualOfferId} for user ${user.username}.`);
            } catch (dbUpdateError) {
                console.error(`CRITICAL: Failed to set pendingDepositOfferId for user ${user.username} after sending offer ${actualOfferId}.`, dbUpdateError);
                // Offer sent but DB update failed. This state needs careful handling or manual correction.
            }

            const offerURL = `https://steamcommunity.com/tradeoffer/${actualOfferId}/`;
            res.json({ success: true, message: 'Deposit offer created! Please accept it on Steam.', offerId: actualOfferId, offerURL: offerURL });

        } catch (error) { // Error during offer.send()
            console.error(`Error sending deposit offer for ${user.username} (DepositID: ${depositId}): EResult ${error.eresult}, Msg: ${error.message}`);
            pendingDeposits.delete(depositId); // Clean up from map
            if (cleanupTimeout) clearTimeout(cleanupTimeout);

            // Clear pending flag on user if it was set (though likely not if send failed)
            User.updateOne({ _id: user._id, pendingDepositOfferId: offer?.id || null }, { $set: { pendingDepositOfferId: null }})
                .catch(e => console.error("Error clearing user flag on deposit offer send fail:", e));

            let userMessage = 'Failed to create deposit trade offer. Please try again later.';
            if (error.eresult === 26 || error.message?.toLowerCase().includes('trade url')) {
                userMessage = 'Your Steam Trade URL might be invalid or expired. Please check your profile.';
            } else if (error.eresult === 15 || error.eresult === 16) { // User cannot trade or inventory issues
                userMessage = `Could not create deposit offer. Ensure you can trade and your inventory is accessible (Error: ${error.eresult}).`;
            } else if (error.eresult) {
                userMessage += ` (Steam Error Code: ${error.eresult})`;
            }
            res.status(500).json({ error: userMessage });
        }
    }
);


// Socket.IO Middleware for session and passport
io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.initialize()(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.session()(socket.request, socket.request.res || {}, next); });

let connectedChatUsers = 0; // Simple counter for online users via Socket.IO
const userLastMessageTime = new Map(); // For chat cooldown

io.on('connection', (socket) => {
    connectedChatUsers++;
    io.emit('updateUserCount', connectedChatUsers); // Notify all clients of user count change

    const user = socket.request.user; // User object from passport session
    if (user && user.username) {
        console.log(`LOG_INFO: User ${user.username} (Socket ID: ${socket.id}) connected.`);
        // Can emit user-specific data here if needed, e.g., pending offer status
    } else {
        console.log(`LOG_INFO: Anonymous client (Socket ID: ${socket.id}) connected.`);
    }

    socket.on('requestRoundData', async () => {
        let roundToFormat = null;
        try {
            // Prioritize in-memory currentRound if it's likely up-to-date
            if (currentRound?._id && ['active', 'rolling', 'pending', 'completed_pending_acceptance'].includes(currentRound.status)) {
                // If participants or winner are just IDs, re-populate for client
                if ( (currentRound.participants && currentRound.participants.length > 0 && typeof currentRound.participants[0]?.user === 'string') ||
                     (currentRound.winner && typeof currentRound.winner === 'string') ) {
                    currentRound = await Round.findById(currentRound._id)
                          .populate('participants.user', 'steamId username avatar')
                          .populate('items')
                          .populate('winner', 'steamId username avatar').lean();
                }
                roundToFormat = currentRound;
            }
            // If no suitable in-memory round, try fetching from DB
            if (!roundToFormat) {
                roundToFormat = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending', 'completed_pending_acceptance'] } })
                      .sort({ startTime: -1 }) // Get the latest relevant round
                      .populate('participants.user', 'steamId username avatar')
                      .populate('items')
                      .populate('winner', 'steamId username avatar').lean();
                if (roundToFormat) currentRound = roundToFormat; // Update global currentRound
            }

            const formattedData = formatRoundForClient(roundToFormat);
            if (formattedData) socket.emit('roundData', formattedData);
            else socket.emit('noActiveRound'); // Or some other event indicating no round
        } catch (err) {
            console.error(`Error fetching round data for socket ${socket.id}:`, err);
            socket.emit('roundError', { error: 'Failed to load round data.' });
        }
    });

    socket.on('chatMessage', (msg) => {
        if (!user || !user._id) { // Ensure user is authenticated to chat
            socket.emit('notification', {type: 'error', message: 'You must be logged in to chat.'});
            return;
        }
        const userId = user._id.toString();
        const now = Date.now();
        const lastMsgTime = userLastMessageTime.get(userId) || 0;

        if (now - lastMsgTime < CHAT_COOLDOWN_SECONDS * 1000) {
            const timeLeft = Math.ceil((CHAT_COOLDOWN_SECONDS * 1000 - (now - lastMsgTime)) / 1000);
            socket.emit('notification', {type: 'warning', message: `Please wait ${timeLeft}s before sending another message.`});
            return;
        }

        const trimmedMsg = msg.trim();
        if (typeof trimmedMsg !== 'string' || trimmedMsg.length === 0 || trimmedMsg.length > MAX_CHAT_MESSAGE_LENGTH) {
            socket.emit('notification', {type: 'error', message: `Invalid message. Max ${MAX_CHAT_MESSAGE_LENGTH} chars, not empty.`});
            return;
        }

        userLastMessageTime.set(userId, now); // Update last message time

        const messageData = {
            type: 'user', // Differentiate from system messages
            username: user.username,
            avatar: user.avatar || '/img/default-avatar.png',
            message: trimmedMsg, // Send sanitized message
            userId: userId,
            userSteamId: user.steamId,
            timestamp: new Date()
        };
        io.emit('chatMessage', messageData); // Broadcast to all clients
        console.log(`Chat (User: ${user.username}, ID: ${userId}): ${trimmedMsg}`);
    });

    socket.on('disconnect', (reason) => {
        connectedChatUsers--;
        io.emit('updateUserCount', connectedChatUsers);
        if (user && user.username) {
            console.log(`LOG_INFO: User ${user.username} disconnected. Reason: ${reason}`);
        } else {
            console.log(`LOG_INFO: Anonymous client disconnected. Reason: ${reason}`);
        }
    });
});

function formatRoundForClient(round) {
    if (!round) return null;

    // Calculate timeLeft based on round status and endTime
    const timeLeft = (round.status === 'active' && round.endTime)
        ? Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000))
        : (round.status === 'pending' ? ROUND_DURATION : 0); // Or some default for pending

    // Format participants
    const participantsFormatted = (round.participants || []).map(p => {
        if (!p.user) return null; // Skip if user data is missing
        // Ensure p.user is an object with details, not just an ID
        const userObj = p.user._id ? p.user : { _id: p.user.toString() }; // Handle populated vs non-populated
        return {
            user: { _id: userObj._id, steamId: userObj.steamId, username: userObj.username, avatar: userObj.avatar },
            itemsValue: p.itemsValue || 0,
            tickets: p.tickets || 0
        };
    }).filter(p => p !== null);

    // Format items
    const itemsFormatted = (round.items || []).map(i => {
        if (!i || typeof i.price !== 'number' || !i.assetId || !i.name || !i.image) {
            console.warn("formatRoundForClient: Skipping malformed item:", i);
            return null;
        }
        return {
            assetId: i.assetId, name: i.name, image: i.image, price: i.price,
            owner: i.owner?._id || i.owner?.toString() // Send owner ID
        };
    }).filter(item => item !== null);

    // Format winner details
    let winnerDetails = null;
    if (round.winner && round.winner.steamId) { // If winner is populated
        winnerDetails = {
            id: round.winner._id, steamId: round.winner.steamId,
            username: round.winner.username, avatar: round.winner.avatar
        };
    } else if (round.winner) { // If winner is just an ID (should ideally be populated)
        winnerDetails = { id: round.winner.toString() }; // Basic info
    }

    return {
        roundId: round.roundId,
        status: round.status,
        startTime: round.startTime,
        endTime: round.endTime,
        timeLeft: timeLeft,
        totalValue: round.totalValue || 0,
        serverSeedHash: round.serverSeedHash, // Always send hash
        participants: participantsFormatted,
        items: itemsFormatted,
        winner: winnerDetails,
        // Only send sensitive provably fair details if round is completed
        winningTicket: (round.status === 'completed' || round.status === 'completed_pending_acceptance') ? round.winningTicket : undefined,
        serverSeed: (round.status === 'completed' || round.status === 'completed_pending_acceptance') ? round.serverSeed : undefined,
        clientSeed: (round.status === 'completed' || round.status === 'completed_pending_acceptance') ? round.clientSeed : undefined,
        provableHash: (round.status === 'completed' || round.status === 'completed_pending_acceptance') ? round.provableHash : undefined,
        taxAmount: round.taxAmount,
        payoutOfferId: round.payoutOfferId,
        payoutOfferStatus: round.payoutOfferStatus
    };
}

app.get('/api/round/current', async (req, res) => {
    let roundToFormat = null;
    try {
        // Try to use in-memory currentRound if it's in a relevant state
        if (currentRound?._id && ['active', 'rolling', 'pending', 'completed_pending_acceptance'].includes(currentRound.status)) {
            // If participants or winner are just IDs (not populated), re-fetch from DB with population
             if ( (currentRound.participants && currentRound.participants.length > 0 && typeof currentRound.participants[0]?.user === 'string') ||
                 (currentRound.winner && typeof currentRound.winner === 'string') ||
                 (currentRound.items && currentRound.items.length > 0 && typeof currentRound.items[0] === 'string') ) {
                currentRound = await Round.findById(currentRound._id)
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items') // Populate items fully
                    .populate('winner', 'steamId username avatar').lean();
            }
            roundToFormat = currentRound;
        }

        // If no suitable in-memory round, fetch the latest relevant one from DB
        if (!roundToFormat) {
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending', 'completed_pending_acceptance'] } })
                .sort({ startTime: -1 }) // Get the most recently started relevant round
                .populate('participants.user', 'steamId username avatar')
                .populate('items')
                .populate('winner', 'steamId username avatar').lean();

            if (roundToFormat) {
                currentRound = roundToFormat; // Update global currentRound
                // If fetched round is active with participants and timer logic needs checking
                if (currentRound.status === 'active' && currentRound.participants?.length > 0) {
                    if (currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) startRoundTimer(true); // Resume
                    else if (!currentRound.endTime && !roundTimer) startRoundTimer(false); // Start fresh
                }
            }
        }

        const formattedData = formatRoundForClient(roundToFormat);
        if (formattedData) {
            res.json(formattedData);
        } else {
            // If no round found and bot is ready, try to create one
            if (isBotReady && !isRolling) { // Ensure not currently rolling
                console.log("LOG_INFO: No current round found for API, attempting to create one.");
                const newRound = await createNewRound(); // createNewRound updates global currentRound
                const newFormattedData = formatRoundForClient(newRound);
                if (newFormattedData) return res.json(newFormattedData);
            }
            res.status(404).json({ error: 'No active or pending round found, and could not create one at this time.' });
        }
    } catch (err) {
        console.error('Error fetching/formatting current round data:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' });
    }
});


app.get('/api/rounds', // No ensureAuthenticated, public history
    [
        query('page').optional().isInt({ min: 1 }).toInt().default(1),
        query('limit').optional().isInt({ min: 1, max: 50 }).toInt().default(10) // Max limit 50
    ], handleValidationErrors, async (req, res) => {
    try {
        const { page, limit } = req.query;
        const skip = (page - 1) * limit;

        // Query for completed or errored rounds
        const queryFilter = { status: { $in: ['completed', 'completed_pending_acceptance', 'error'] } };

        const rounds = await Round.find(queryFilter)
            .sort('-roundId') // Sort by internal roundId descending (most recent first)
            .skip(skip)
            .limit(limit)
            .populate('winner', 'username avatar steamId') // Populate winner details
            .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount taxedItems payoutOfferId payoutOfferStatus') // Select fields
            .lean();

        const totalRounds = await Round.countDocuments(queryFilter);
        const totalPages = Math.ceil(totalRounds / limit);

        res.json({
            rounds,
            totalPages,
            currentPage: page,
            totalRounds
        });
    } catch (err) {
        console.error('Error fetching past rounds:', err);
        res.status(500).json({ error: 'Server error fetching round history.' });
    }
});


app.post('/api/verify', sensitiveActionLimiter,
    [
        body('roundId').notEmpty().withMessage('Round ID is required.').isInt({ min: 1 }).withMessage('Round ID must be a positive integer.').toInt(),
        body('serverSeed').trim().notEmpty().withMessage('Server Seed is required.').isHexadecimal().withMessage('Server Seed must be hexadecimal.').isLength({ min: 64, max: 64 }).withMessage('Server Seed must be 64 characters.'),
        body('clientSeed').trim().notEmpty().withMessage('Client Seed is required.').isString().isLength({ min: 1, max: 128 }).withMessage('Client Seed is too long.') // Allow alphanumeric client seeds
    ],
    handleValidationErrors, async (req, res) => {
    const { roundId, serverSeed, clientSeed } = req.body;
    try {
        const round = await Round.findOne({ roundId: roundId, status: { $in: ['completed', 'completed_pending_acceptance'] } })
            .populate('participants.user', 'username').populate('winner', 'username').lean();

        if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found or not yet verifiable.` });

        // 1. Verify provided Server Seed matches the round's Server Seed Hash
        if (!round.serverSeedHash) return res.json({ verified: false, reason: 'Server Seed Hash for this round is not available (round might be too old or errored before hashing).'});
        const providedServerSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
        if (providedServerSeedHash !== round.serverSeedHash) {
            return res.json({ verified: false, reason: 'Server Seed Hash mismatch. The provided Server Seed does not match the hash published before the round.', expectedServerSeedHash: round.serverSeedHash, providedServerSeed: serverSeed, calculatedHashOfProvidedSeed: providedServerSeedHash });
        }

        // 2. If round is fully completed and official seeds are stored, compare them (optional, for transparency)
        if (round.serverSeed && round.clientSeed) {
            if (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed) {
                // This indicates the user is trying to verify with different seeds than what the server used.
                // The primary verification (above) still holds if the serverSeed matches the hash.
                // For this verification, we will use the server's actual seeds if available.
                console.log(`Verify attempt for round ${roundId} with user-provided seeds. Official seeds differ. Verifying outcome based on official seeds.`);
            }
        }
        // Use the round's actual revealed seeds if available, otherwise use the user's for calculation
        const effectiveServerSeed = round.serverSeed || serverSeed;
        const effectiveClientSeed = round.clientSeed || clientSeed;


        // 3. Calculate Provable Hash from (effective) Server Seed + Client Seed
        const combinedString = effectiveServerSeed + effectiveClientSeed;
        const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');

        // 4. Compare calculated Provable Hash with the round's stored Provable Hash (if available)
        if (round.provableHash && calculatedProvableHash !== round.provableHash) {
            return res.json({ verified: false, reason: 'Calculated Provable Hash mismatch with the official provable hash stored for the round.', expectedProvableHash: round.provableHash, calculatedProvableHashFromInputs: calculatedProvableHash, combinedStringUsed: combinedString });
        }

        // 5. Calculate Winning Ticket
        const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
        const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;

        if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets, cannot verify winner selection mechanics.' });
        const calculatedWinningTicket = decimalFromHash % totalTickets;

        // 6. Compare calculated Winning Ticket with the round's stored Winning Ticket
        if (round.winningTicket !== undefined && calculatedWinningTicket !== round.winningTicket) {
            return res.json({
                verified: false,
                reason: 'Calculated winning ticket number does not match the official winning ticket for the round.',
                calculatedWinningTicket: calculatedWinningTicket,
                officialWinningTicket: round.winningTicket,
                provableHashUsedForCalculation: calculatedProvableHash, // The hash that led to this ticket
                totalTicketsInRound: totalTickets
            });
        }

        // If all checks pass
        res.json({
            verified: true,
            roundId: round.roundId,
            serverSeedUsed: effectiveServerSeed, // The server seed used for this verification
            serverSeedHashExpected: round.serverSeedHash, // The hash that was public
            clientSeedUsed: effectiveClientSeed, // The client seed used for this verification
            combinedStringUsed: combinedString,
            finalHashCalculated: calculatedProvableHash, // The hash derived from combined seeds
            winningTicketCalculated: calculatedWinningTicket,
            officialWinningTicketRecorded: round.winningTicket, // The ticket that actually won
            totalTicketsInRound: totalTickets,
            finalPotValueWon: round.totalValue, // Value after tax
            winnerUsername: round.winner?.username || 'N/A'
        });

    } catch (err) {
        console.error(`Error verifying round ${roundId}:`, err);
        res.status(500).json({ error: 'Server error during verification process.' });
    }
});


async function startApp() {
    console.log("LOG_INFO: Performing initial price cache refresh...");
    await refreshPriceCache(); // Initial refresh
    setInterval(async () => { // Schedule periodic refresh
        try { await refreshPriceCache(); }
        catch (refreshErr) { console.error("Error during scheduled price cache refresh:", refreshErr); }
    }, PRICE_REFRESH_INTERVAL_MS);
    console.log(`LOG_INFO: Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);

    // Periodic cleanup for rounds stuck in 'completed_pending_acceptance'
    setInterval(async () => {
        try {
            const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
            const updateResult = await Round.updateMany(
                {
                    status: 'completed_pending_acceptance',
                    completedTime: { $lt: thirtyMinutesAgo }, // Older than 30 mins
                    // Only clear if payout wasn't successfully processed or actively pending confirmation
                    payoutOfferStatus: { $in: ['PendingAcceptanceByWinner', 'Failed - No Trade URL', 'Failed - Invalid Trade URL Format', 'Unknown', 'Failed - Offer Creation Error'] }
                },
                {
                    $set: {
                        status: 'completed', // Mark as simply 'completed'
                        payoutOfferStatus: 'Failed - Timeout AutoClear' // Indicate reason for status change
                    }
                }
            );
            if (updateResult.modifiedCount > 0) {
                console.log(`LOG_INFO (AutoClear): Cleared ${updateResult.modifiedCount} stuck rounds to 'completed' due to timeout.`);
            }
        } catch (err) {
            console.error("Error during stuck round auto-cleanup:", err);
        }
    }, 5 * 60 * 1000); // Run every 5 minutes

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`LOG_SUCCESS: Server listening on port ${PORT}`);
        console.log(`LOG_INFO: Site URL configured as: ${process.env.SITE_URL}`);
        if (!isBotConfigured) {
            console.log("INFO: Steam Bot not configured. Trade features disabled.");
        } else if (!isBotReady) {
            // This state might occur if initial login is still pending or failed.
            console.log("WARN: Steam Bot initial login may have failed or is pending. Check logs. isBotReady is false.");
        } else {
            console.log("LOG_SUCCESS: Steam Bot is ready (isBotReady is true).");
        }
    });
}

startApp(); // Initialize and start the application

function gracefulShutdown() {
    console.log('LOG_INFO: Received shutdown signal. Closing server...');

    if (cookieRefreshInterval) {
        clearInterval(cookieRefreshInterval);
        cookieRefreshInterval = null;
    }
    if (roundTimer) { // Clear round timer if active
        clearInterval(roundTimer);
        roundTimer = null;
    }

    io.close(() => { // Close all Socket.IO connections
        console.log('LOG_INFO: Socket.IO connections closed.');
        server.close(async () => { // Close HTTP server
            console.log('LOG_INFO: HTTP server closed.');
            try {
                await mongoose.connection.close(); // Close MongoDB connection
                console.log('LOG_INFO: MongoDB connection closed.');
                if (manager && typeof manager.shutdown === 'function') {
                    console.log('LOG_INFO: Stopping TradeOfferManager polling...');
                    manager.shutdown(); // Properly shutdown trade manager
                }
                console.log('LOG_INFO: Graceful shutdown complete. Exiting.');
                process.exit(0);
            } catch (e) {
                console.error("Error during resource cleanup in shutdown:", e);
                process.exit(1);
            }
        });
    });

    // Force shutdown if graceful fails after timeout
    setTimeout(() => {
        console.error('CRITICAL_ERROR: Could not close connections gracefully in time, forcing shutdown.');
        process.exit(1);
    }, 10000); // 10 seconds timeout
}
process.on('SIGTERM', gracefulShutdown); // Handle kill signal
process.on('SIGINT', gracefulShutdown);  // Handle CTRL+C

// Global unhandled error catcher for Express
app.use((err, req, res, next) => {
    console.error("Unhandled Error at Express level:", err.stack || err);
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.');
    if (res.headersSent) { // If headers already sent, delegate to default Express error handler
        return next(err);
    }
    res.status(status).json({ error: message });
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});

// Catch uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // It's generally recommended to gracefully shut down the process after an uncaught exception
  // gracefulShutdown(); // Optionally trigger shutdown
});
