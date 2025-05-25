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

// --- UPDATED: More flexible Trade URL validation ---
const TRADE_URL_REGEX = /^https?:\/\/(www\.)?steamcommunity\.com\/tradeoffer\/new\/\?(?=.*partner=\d+)(?=.*token=[a-zA-Z0-9_-]+).*$/i;

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

// MODIFIED itemSchema
const itemSchema = new mongoose.Schema({
    assetId: { type: String, required: true, index: true }, // Current asset ID in bot's inventory
    originalAssetId: { type: String }, // Original asset ID from user's inventory
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
        'PendingAcceptanceByWinner', 'Sent', 'Sent (Confirmed)', 'Accepted', 'Declined', 'Canceled', 'Expired', 'InvalidItems', 'Escrow', 'Failed', 'Unknown',
        'Failed - No Trade URL', 'No Items Won', 'Pending Confirmation', 'Failed - Bot Not Ready', 'Failed - Offer Creation Error',
        'Failed - Bad URL', 'Failed - Inventory/Trade Issue', 'Failed - DB Error Post-Send', 'Failed - Synchronous Offer Prep Error',
        'Failed - Invalid Trade URL Format', 'Failed - Bot Inventory Issue', 'Failed - Bot Session Issue', 'Failed - Manually Cleared',
        'Failed - Timeout AutoClear', 'Failed - Invalid Trade URL Components', 'Failed - Invalid Partner ID', 'Failed - URL Parse Error',
        'Failed - Bot Not Configured', 'Failed - Malformed Trade URL', 'Failed - Inventory Private', 'Failed - Trade Banned',
        'Failed - Rate Limited', 'Failed - System Error', 'Failed - Send Error'
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

// --- MODIFIED confirmTradeOffer Function ---
async function confirmTradeOffer(offerId, offerType = 'trade') {
    const timestamp = new Date().toISOString();

    if (!process.env.STEAM_IDENTITY_SECRET) {
        console.log(`[${timestamp}] LOG_WARN: No STEAM_IDENTITY_SECRET configured for auto-confirmation. Trade ${offerId} (${offerType}) will require manual confirmation.`);
        return { success: false, error: 'No identity secret configured for auto-confirmation' };
    }

    if (!community || !community.steamID) {
        console.error(`[${timestamp}] LOG_ERROR: Community not logged in, cannot confirm trade ${offerId} (${offerType}).`);
        return { success: false, error: 'Bot not logged in' };
    }

    // Small initial delay for Steam to process, can be adjusted or made conditional
    await new Promise(resolve => setTimeout(resolve, 1500)); // e.g., 1.5 seconds

    return new Promise((resolve) => {
        console.log(`[${timestamp}] LOG_INFO: Attempting to auto-confirm ${offerType} offer ${offerId}... (Primary method)`);

        community.acceptConfirmationForObject(
            process.env.STEAM_IDENTITY_SECRET,
            offerId, // This should be the trade offer ID
            (err) => {
                if (err) {
                    console.error(`[${timestamp}] LOG_ERROR: Direct confirmation (acceptConfirmationForObject) failed for ${offerType} offer ${offerId}:`, err.message);
                    console.log(`[${timestamp}] LOG_INFO: Attempting fallback confirmation method for ${offerType} offer ${offerId}.`);

                    const time = Math.floor(Date.now() / 1000);
                    const confKey = SteamTotp.generateConfirmationKey(process.env.STEAM_IDENTITY_SECRET, time, 'conf'); // Key for listing confirmations

                    community.getConfirmations(time, confKey, (err2, confirmations) => {
                        if (err2) {
                            console.error(`[${timestamp}] LOG_ERROR: Failed to get confirmations list for fallback:`, err2.message);
                            resolve({ success: false, error: `Failed to get confirmations list: ${err2.message} (Original error: ${err.message})` });
                            return;
                        }

                        if (!confirmations || confirmations.length === 0) {
                            console.log(`[${timestamp}] LOG_WARN: No pending confirmations found in the list for fallback (Offer ${offerId}).`);
                            resolve({ success: false, error: 'No pending confirmations found to check.' });
                            return;
                        }
                        console.log(`[${timestamp}] LOG_DEBUG: Found ${confirmations.length} pending confirmations in list. Searching for offer ${offerId}.`);

                        // Find the specific confirmation for the given trade offer ID
                        // conf.creator is the ID of the item being confirmed (e.g., trade offer ID)
                        const conf = confirmations.find(c => c.creator && c.creator.toString() === offerId.toString());

                        if (conf) {
                            console.log(`[${timestamp}] LOG_INFO: Found matching confirmation (ConfID: ${conf.id}, Creator/OfferID: ${conf.creator}) for offer ${offerId}. Attempting to respond.`);
                            const allowKey = SteamTotp.generateConfirmationKey(process.env.STEAM_IDENTITY_SECRET, time, 'allow'); // Key for accepting a specific confirmation

                            community.respondToConfirmation(conf.id, conf.key, time, allowKey, true, (err3) => {
                                if (err3) {
                                    console.error(`[${timestamp}] LOG_ERROR: Fallback confirmation method (respondToConfirmation) failed for offer ${offerId} (ConfID: ${conf.id}):`, err3.message);
                                    resolve({ success: false, error: `Fallback confirmation failed: ${err3.message}` });
                                } else {
                                    console.log(`[${timestamp}] LOG_SUCCESS: ${offerType} offer ${offerId} (ConfID: ${conf.id}) confirmed via FALLBACK method!`);
                                    resolve({ success: true });
                                }
                            });
                        } else {
                            console.log(`[${timestamp}] LOG_WARN: No specific confirmation found for offer ${offerId} in the list after direct failure.`);
                            confirmations.forEach(c => console.log(`[${timestamp}] LOG_DEBUG_CONF: Available ConfID: ${c.id}, Creator: ${c.creator}, Title: ${c.title}`));
                            resolve({ success: false, error: 'No specific confirmation found for this offer in the list (fallback).' });
                        }
                    });
                } else {
                    console.log(`[${timestamp}] LOG_SUCCESS: ${offerType} offer ${offerId} auto-confirmed successfully via PRIMARY method!`);
                    resolve({ success: true });
                }
            }
        );
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

    // MODIFIED sentOfferChanged handler
    manager.on('sentOfferChanged', async (offer, oldState) => {
        console.log(`LOG_INFO: Bot's sentOffer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()}) Msg: "${offer.message}"`);

        const depositIdMatch = offer.message.match(/DepositID: ([a-f0-9-]+)/i);
        const depositIdFromMessage = depositIdMatch ? depositIdMatch[1] : null;
        let depositData = null;

        if (depositIdFromMessage && pendingDeposits.has(depositIdFromMessage)) {
            depositData = pendingDeposits.get(depositIdFromMessage);
            if (depositData.offerIdAttempted && depositData.offerIdAttempted !== offer.id) {
                console.warn(`WARN: Offer ID mismatch for DepositID ${depositIdFromMessage}. Tracked: ${depositData.offerIdAttempted}, Event: ${offer.id}. This is unusual. Processing with event offer ID.`);
            } else if (!depositData.offerIdAttempted) {
                depositData.offerIdAttempted = offer.id;
            }
        }

        // --- Handle DEPOSIT offers ---
        if (depositData && offer.id === depositData.offerIdAttempted) {
            console.log(`LOG_DEBUG: Offer #${offer.id} matched pending deposit ${depositIdFromMessage}.`);

            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                pendingDeposits.delete(depositIdFromMessage);
                console.log(`LOG_SUCCESS: Processing accepted deposit offer #${offer.id} (DepositID: ${depositIdFromMessage}) for user ${depositData.steamId}`);

                User.updateOne({ _id: depositData.userId, pendingDepositOfferId: offer.id }, { $set: { pendingDepositOfferId: null }})
                    .catch(e => console.error("DB_ERROR: Error clearing user pending flag on deposit accept:", e));

                let createdItemDocuments = [];
                try {
                    const roundForDeposit = await Round.findById(depositData.roundId).select('status participants items totalValue roundId');
                    if (!roundForDeposit || roundForDeposit.status !== 'active' || isRolling) {
                        console.warn(`WARN: Deposit ${depositIdFromMessage} (Offer ${offer.id}) accepted, but round invalid/rolling. Items NOT added to pot. Round status: ${roundForDeposit?.status}, isRolling: ${isRolling}`);
                        io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Deposit Error: Round for offer #${offer.id} ended/changed before processing. Contact support.` });
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

                    // CRITICAL FIX: Get the new asset IDs from bot's inventory after trade
                    console.log(`LOG_INFO: Fetching bot's inventory to get new asset IDs for deposited items (Offer #${offer.id})...`);
                    // Wait a moment for Steam to process the trade and inventory update
                    await new Promise(resolve => setTimeout(resolve, 3000)); // Increased delay slightly

                    const botInventory = await new Promise((resolve, reject) => {
                        if (!manager) return reject(new Error("TradeOfferManager not initialized for fetching bot inventory."));
                        manager.getInventoryContents(RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inventory) => {
                            if (err) {
                                console.error(`ERROR: Failed to fetch bot inventory after deposit (Offer #${offer.id}):`, err);
                                reject(err);
                            } else {
                                console.log(`LOG_DEBUG: Bot inventory fetched for Offer #${offer.id}. Found ${inventory?.length || 0} items.`);
                                resolve(inventory || []);
                            }
                        });
                    });

                    const assetIdMap = new Map(); // oldAssetId (user's) -> newAssetId (bot's)
                    const mappedNewAssetIds = new Set(); // To ensure a new asset ID is used only once

                    for (const depositedItem of depositData.items) { // items from pendingDeposits map
                        // Find matching item in bot's inventory by name and approximate value.
                        // This assumes item names are unique enough for this purpose or combined with price.
                        // Ensure we don't remap an already mapped new assetId from bot's inventory.
                        const matchingBotItem = botInventory.find(botItem =>
                            botItem.market_hash_name === depositedItem._name &&
                            !mappedNewAssetIds.has(botItem.assetid) && // Check if this new asset ID has already been claimed for mapping
                            Math.abs((getItemPrice(botItem.market_hash_name) || 0) - depositedItem._price) < 0.01 // Price match
                        );

                        if (matchingBotItem) {
                            assetIdMap.set(depositedItem.assetid, matchingBotItem.assetid); // Map old user assetid to new bot assetid
                            mappedNewAssetIds.add(matchingBotItem.assetid); // Mark this bot asset ID as used for mapping
                            console.log(`LOG_INFO: Mapped old assetId ${depositedItem.assetid} to new assetId ${matchingBotItem.assetid} for item "${depositedItem._name}" (Offer #${offer.id})`);
                        } else {
                            console.warn(`WARN: Could not find unique matching item in bot inventory for "${depositedItem._name}" (Old AssetID: ${depositedItem.assetid}, Price: ${depositedItem._price}). Will use old AssetID as fallback. (Offer #${offer.id})`);
                        }
                    }

                    // Create Item documents with NEW asset IDs
                    const itemModelsToSave = depositData.items.map(itemDetail => {
                        const newAssetId = assetIdMap.get(itemDetail.assetid) || itemDetail.assetid; // Fallback to old ID if mapping failed
                        if (newAssetId === itemDetail.assetid && assetIdMap.has(itemDetail.assetid)) {
                            // This case means mapping was successful but for some reason it's same, which is fine.
                        } else if (newAssetId === itemDetail.assetid) {
                             console.warn(`LOG_WARN: Using fallback (old) assetId ${itemDetail.assetid} for item "${itemDetail._name}" as it was not mapped. (Offer #${offer.id})`);
                        }
                        return new Item({
                            assetId: newAssetId, // Use the NEW asset ID from bot's inventory (or fallback)
                            originalAssetId: itemDetail.assetid, // Store original user's asset ID for reference
                            name: itemDetail._name,
                            image: itemDetail._image,
                            price: itemDetail._price,
                            owner: depositData.userId,
                            roundId: depositData.roundId
                        });
                    });

                    createdItemDocuments = await Item.insertMany(itemModelsToSave, { ordered: false });
                    const createdItemIds = createdItemDocuments.map(doc => doc._id);
                    console.log(`LOG_INFO: Deposit ${depositIdFromMessage} (Offer #${offer.id}): Inserted ${createdItemIds.length} items into DB with potentially updated asset IDs.`);

                    // Update user's total deposited value
                    await User.findByIdAndUpdate(depositData.userId, { $inc: { totalDepositedValue: depositData.totalValue } });

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
                    ).populate('participants.user', 'steamId username avatar').lean();

                    if (!updatedRound) throw new Error('Failed to update round data after deposit.');
                    currentRound = updatedRound;

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
                            depositedItems: depositData.items.map(i => ({ assetId: assetIdMap.get(i.assetid) || i.assetid, name: i._name, image: i._image, price: i._price }))
                        });
                        console.log(`LOG_INFO: Emitted 'participantUpdated' for user ${finalParticipantData.user.username} in round ${updatedRound.roundId}.`);
                    }

                    if (updatedRound.participants.length === 1 && !roundTimer && updatedRound.status === 'active') {
                        startRoundTimer();
                    }
                    console.log(`LOG_SUCCESS: Deposit success processed for offer #${offer.id}. User: ${finalParticipantData?.user?.username}`);

                } catch (dbErr) {
                    console.error(`CRITICAL_DB_ERROR processing accepted deposit ${offer.id} (DepositID ${depositIdFromMessage}):`, dbErr);
                    io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `CRITICAL Deposit Error for offer #${offer.id}. Items may be held by bot. Contact support.` });
                    if (createdItemDocuments.length > 0) {
                        await Item.deleteMany({ _id: { $in: createdItemDocuments.map(d => d._id) } });
                        console.log(`LOG_INFO: Rolled back ${createdItemDocuments.length} items from DB for failed deposit ${offer.id}.`);
                    }
                    if (currentRound && currentRound._id?.toString() === depositData.roundId.toString()) {
                        console.error(`CRITICAL_ERROR: Marking round ${currentRound.roundId} as 'error' due to deposit processing failure.`);
                        await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } });
                        io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error led to round error.' });
                        currentRound.status = 'error';
                    }
                }

            } else if ([
                TradeOfferManager.ETradeOfferState.Declined,
                TradeOfferManager.ETradeOfferState.Canceled,
                TradeOfferManager.ETradeOfferState.Expired,
                TradeOfferManager.ETradeOfferState.InvalidItems
                ].includes(offer.state)) {

                pendingDeposits.delete(depositIdFromMessage);
                console.warn(`WARN: Deposit offer ${offer.id} (DepositID: ${depositIdFromMessage}) for user ${depositData.steamId} was ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                User.updateOne({ _id: depositData.userId, pendingDepositOfferId: offer.id }, { $set: {pendingDepositOfferId: null }})
                    .catch(e => console.error("DB_ERROR: Error clearing user pending flag on deposit failure/cancellation:", e));
                const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Your deposit offer (#${offer.id}) was ${stateMessage}.` });
            } else {
                console.log(`LOG_DEBUG: Deposit Offer #${offer.id} (DepositID: ${depositIdFromMessage}) changed to unhandled state: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
            }
        }
        // --- Handle PAYOUT offers (winnings) ---
        else {
            let payoutStatusUpdate = 'Unknown';
            switch (offer.state) {
                case TradeOfferManager.ETradeOfferState.Accepted: payoutStatusUpdate = 'Accepted'; break;
                case TradeOfferManager.ETradeOfferState.Declined: payoutStatusUpdate = 'Declined'; break;
                case TradeOfferManager.ETradeOfferState.Canceled: payoutStatusUpdate = 'Canceled'; break;
                case TradeOfferManager.ETradeOfferState.Expired: payoutStatusUpdate = 'Expired'; break;
                case TradeOfferManager.ETradeOfferState.InvalidItems: payoutStatusUpdate = 'InvalidItems'; break;
                case TradeOfferManager.ETradeOfferState.InEscrow: payoutStatusUpdate = 'Escrow'; break;
                case TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation:
                case TradeOfferManager.ETradeOfferState.PendingConfirmation: // This state means bot sent, awaiting user action or auto-confirm
                    payoutStatusUpdate = 'Pending Confirmation'; break;
                default: payoutStatusUpdate = TradeOfferManager.ETradeOfferState[offer.state] || 'Unknown';
            }
            console.log(`LOG_INFO: Payout offer #${offer.id} to ${offer.partner.getSteamID64()} changed to ${payoutStatusUpdate}.`);
            try {
                const updatedRound = await Round.findOneAndUpdate(
                    { payoutOfferId: offer.id },
                    { $set: { payoutOfferStatus: payoutStatusUpdate } },
                    { new: true }
                ).populate('winner', 'steamId _id username');

                if (updatedRound && updatedRound.winner) {
                    const winnerUserIdStr = updatedRound.winner._id.toString();
                    console.log(`LOG_INFO: Updated payoutOfferStatus to ${payoutStatusUpdate} for round ${updatedRound.roundId}, winner ${updatedRound.winner.username}.`);

                    let notifType = 'info';
                    let notifMessage = `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) status: ${payoutStatusUpdate}.`;

                    if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                        notifType = 'success';
                        notifMessage = `Winnings from offer #${offer.id} (Round #${updatedRound.roundId}) successfully accepted by you!`;
                         // Potentially update user's totalWinningsValue again if it wasn't done predictively
                    } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired].includes(offer.state)) {
                        notifType = 'error';
                        notifMessage = `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) was ${payoutStatusUpdate}. Contact support if this was an error or to re-attempt payout.`;
                        if (offer.state === TradeOfferManager.ETradeOfferState.Expired || offer.state === TradeOfferManager.ETradeOfferState.Canceled) {
                             // Reset status to allow user to try accepting again from UI
                             await Round.updateOne({ _id: updatedRound._id }, { $set: { payoutOfferStatus: 'PendingAcceptanceByWinner', payoutOfferId: null }});
                             notifMessage += " You may be able to try accepting again via your profile/winning history.";
                        }
                    } else if (offer.state === TradeOfferManager.ETradeOfferState.InEscrow) {
                        notifType = 'warning';
                        notifMessage = `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) is in escrow. This typically means a trade hold on your account.`;
                    }
                    io.to(winnerUserIdStr).emit('notification', { type: notifType, message: notifMessage });
                } else if (!updatedRound) {
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
            ensureInitialRound();
        })
        .catch(err => {
            console.error("CRITICAL_ERROR: Initial bot login failed:", err.message);
        });
} else {
    console.warn("WARN: Steam Bot not configured. Trading features will be disabled.");
    isBotReady = false;
}


let currentRound = null;
let roundTimer = null;
let isRolling = false;

const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false });

function getFallbackPrice(marketHashName) {
    return MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0;
}

async function refreshPriceCache() {
    console.log("PRICE_INFO: Attempting to refresh price cache from rust.scmm.app...");
    const apiUrl = `https://rust.scmm.app/api/item/prices?currency=USD`;
    try {
        const response = await axios.get(apiUrl, { timeout: PRICE_FETCH_TIMEOUT_MS });
        if (response.data && Array.isArray(response.data)) {
            const items = response.data;
            let updatedCount = 0;
            let newItems = [];
            items.forEach(item => {
                if (item?.name && typeof item.price === 'number' && item.price >= 0) {
                    const priceInDollars = item.price / 100.0;
                    newItems.push({ key: item.name, val: priceInDollars });
                    updatedCount++;
                }
            });
            if (newItems.length > 0) {
                const success = priceCache.mset(newItems);
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
        return 0;
    }
    const cachedPrice = priceCache.get(marketHashName);
    return (cachedPrice !== undefined) ? cachedPrice : getFallbackPrice(marketHashName);
}

async function createNewRound() {
    if (isRolling) {
        console.log("LOG_INFO: Cannot create new round: Current round is rolling.");
        return null;
    }
    if (currentRound && currentRound.status === 'active') {
        console.log(`LOG_INFO: Cannot create new round: Round ${currentRound.roundId} is already active.`);
        return currentRound;
    }

    try {
        isRolling = false;
        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');

        const lastRound = await Round.findOne().sort('-roundId');
        const nextRoundId = lastRound ? lastRound.roundId + 1 : 1;

        const newRound = new Round({
            roundId: nextRoundId,
            status: 'active',
            startTime: new Date(),
            serverSeed: serverSeed,
            serverSeedHash: serverSeedHash,
            items: [],
            participants: [],
            totalValue: 0,
            payoutOfferStatus: 'Unknown'
        });
        await newRound.save();
        currentRound = newRound.toObject();

        io.emit('roundCreated', {
            roundId: newRound.roundId,
            serverSeedHash: newRound.serverSeedHash,
            timeLeft: ROUND_DURATION,
            totalValue: 0,
            participants: [],
            items: []
        });
        console.log(`LOG_SUCCESS: --- Round ${newRound.roundId} created and active ---`);
        return newRound.toObject();
    } catch (err) {
        console.error('FATAL_ERROR: Error creating new round:', err);
        setTimeout(createNewRound, 10000);
        return null;
    }
}

async function ensureInitialRound() {
    if (isBotConfigured && isBotReady) {
        if (!currentRound) {
            try {
                const existingActive = await Round.findOne({ status: 'active' })
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items')
                    .populate('winner', 'steamId username avatar').lean();

                if (existingActive) {
                    console.log(`LOG_INFO: Found existing active round ${existingActive.roundId} on startup.`);
                    currentRound = existingActive;
                    if (currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        startRoundTimer(true);
                    } else if (currentRound.participants.length > 0 && !currentRound.endTime && !roundTimer) {
                        console.warn(`WARN: Active round ${currentRound.roundId} found without endTime. Starting timer now.`);
                        startRoundTimer(false);
                    }
                } else {
                    console.log("LOG_INFO: No active round found, creating initial round...");
                    await createNewRound();
                }
            } catch (dbErr) {
                console.error("DB_ERROR: Error ensuring initial round:", dbErr);
            }
        }
    } else if (isBotConfigured && !isBotReady) {
        console.log("LOG_INFO: Bot configured but not ready, skipping initial round check until bot is ready.");
    } else {
        console.log("LOG_INFO: Bot not configured, skipping initial round check.");
    }
}


function startRoundTimer(useRemainingTime = false) {
    if (roundTimer) clearInterval(roundTimer);
    if (!currentRound || currentRound.status !== 'active') {
        console.warn("WARN: Cannot start timer: No active round or round status invalid.");
        return;
    }

    let timeLeft;
    let calculatedEndTime;

    if (useRemainingTime && currentRound.endTime) {
        calculatedEndTime = new Date(currentRound.endTime);
        timeLeft = Math.max(0, Math.floor((calculatedEndTime.getTime() - Date.now()) / 1000));
        console.log(`LOG_INFO: Resuming timer for round ${currentRound.roundId} with ${timeLeft}s remaining.`);
    } else {
        timeLeft = ROUND_DURATION;
        calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
        currentRound.endTime = calculatedEndTime;
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime }})
            .catch(e => console.error(`DB_ERROR: Error saving round end time for round ${currentRound?.roundId}:`, e));
        console.log(`LOG_INFO: Starting timer for round ${currentRound.roundId} (${ROUND_DURATION}s). End time: ${calculatedEndTime.toISOString()}`);
    }

    io.emit('timerUpdate', { timeLeft });

    roundTimer = setInterval(async () => {
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) {
            clearInterval(roundTimer); roundTimer = null;
            console.warn("WARN: Timer stopped: Round state became invalid during countdown.");
            return;
        }

        const now = Date.now();
        let currenttimeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - now) / 1000));

        io.emit('timerUpdate', { timeLeft: currenttimeLeft });

        if (currenttimeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null;
            console.log(`LOG_INFO: Round ${currentRound.roundId} timer reached zero.`);
            await endRound();
        }
    }, 1000);
}


async function endRound() {
    if (!currentRound || isRolling || currentRound.status !== 'active') {
        console.warn(`WARN: Attempted to end round ${currentRound?.roundId}, but state is invalid (Status: ${currentRound?.status}, Rolling: ${isRolling})`);
        return;
    }
    isRolling = true;
    const roundIdToEnd = currentRound.roundId;
    const roundMongoId = currentRound._id;
    console.log(`LOG_INFO: --- Ending round ${roundIdToEnd}... ---`);

    try {
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } });
        io.emit('roundRolling', { roundId: roundIdToEnd });

        const round = await Round.findById(roundMongoId)
            .populate('participants.user', 'steamId username avatar tradeUrl')
            .populate('items')
            .lean();

        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);
        if (round.status !== 'rolling') {
            console.warn(`WARN: Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Aborting endRound.`);
            isRolling = false; return;
        }
        currentRound = round;

        if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            console.log(`LOG_INFO: Round ${round.roundId} ended with no valid participants or value.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date() } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants or value." });
            isRolling = false;
            setTimeout(createNewRound, 5000);
            return;
        }

        let finalItems = [...round.items];
        let originalPotValue = round.totalValue;
        let valueForWinner = originalPotValue;
        let taxAmount = 0;
        let taxedItemsInfo = [];
        let itemsToTakeForTaxIds = new Set();

        if (originalPotValue >= MIN_POT_FOR_TAX) {
            const targetTaxValue = originalPotValue * (TAX_MIN_PERCENT / 100);
            const maxTaxValue = originalPotValue * (TAX_MAX_PERCENT / 100);
            const sortedItemsForTax = [...round.items].sort((a, b) => a.price - b.price);
            let currentTaxValueAccumulated = 0;

            for (const item of sortedItemsForTax) {
                if (currentTaxValueAccumulated + item.price <= maxTaxValue) {
                    itemsToTakeForTaxIds.add(item._id.toString());
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price }); // Ensure correct assetId is used if it matters for display
                    currentTaxValueAccumulated += item.price;
                    if (currentTaxValueAccumulated >= targetTaxValue) break;
                } else {
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

        const clientSeed = crypto.randomBytes(16).toString('hex');
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16);
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);

        if (totalTickets <= 0) throw new Error(`Cannot determine winner: Total tickets is zero for round ${round.roundId}.`);
        const winningTicket = decimalFromHash % totalTickets;
        let cumulativeTickets = 0;
        let winnerInfo = null;

        for (const participant of round.participants) {
            if (!participant?.tickets || !participant.user) continue;
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winnerInfo = participant.user;
                break;
            }
        }

        if (!winnerInfo || !winnerInfo._id) throw new Error(`Winner selection failed for round ${round.roundId}.`);

        await User.findByIdAndUpdate(winnerInfo._id, { $inc: { totalWinningsValue: valueForWinner } });
        console.log(`LOG_INFO: Updated winnings stats for ${winnerInfo.username}: added $${valueForWinner.toFixed(2)}`);

        const finalUpdateData = {
            status: 'completed_pending_acceptance',
            completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winnerInfo._id,
            taxAmount: taxAmount, taxedItems: taxedItemsInfo,
            totalValue: valueForWinner,
            items: finalItems.map(i => i._id), // Store IDs of items won (these items now have the bot's assetIds)
            payoutOfferStatus: 'PendingAcceptanceByWinner'
        };

        const completedRound = await Round.findOneAndUpdate({ _id: roundMongoId }, { $set: finalUpdateData }, { new: true });
        if (!completedRound) throw new Error("Failed to save completed round data.");

        console.log(`LOG_SUCCESS: Round ${round.roundId} completed. Winner: ${winnerInfo.username} (Ticket: ${winningTicket}/${totalTickets}, Value Won: $${valueForWinner.toFixed(2)})`);

        io.emit('roundWinnerPendingAcceptance', {
            roundId: round.roundId,
            winner: { id: winnerInfo._id, steamId: winnerInfo.steamId, username: winnerInfo.username, avatar: winnerInfo.avatar },
            winningTicket: winningTicket,
            totalValue: valueForWinner,
            totalTickets: totalTickets,
            serverSeed: round.serverSeed,
            clientSeed: clientSeed,
            provableHash: provableHash,
            serverSeedHash: round.serverSeedHash
        });

    } catch (err) {
        console.error(`CRITICAL_ERROR: Error during endRound for round ${roundIdToEnd}:`, err);
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', payoutOfferStatus: 'Failed' }})
            .catch(e => console.error("DB_ERROR: Error marking round as error after endRound failure:", e));
        io.emit('roundError', { roundId: roundIdToEnd, error: 'Internal server error during round finalization.' });
    } finally {
        isRolling = false;
        console.log(`LOG_INFO: Scheduling next round creation after round ${roundIdToEnd} finalization.`);
        setTimeout(createNewRound, 10000);
    }
}


async function checkOfferStatus(offerId) {
    return new Promise((resolve) => {
        if (!isBotReady || !manager) {
            console.warn(`LOG_WARN: Cannot check offer status for ${offerId}: Bot not ready or manager unavailable.`);
            return resolve(null);
        }
        manager.getOffer(offerId, (err, offer) => {
            if (err) {
                console.log(`LOG_WARN: Could not fetch offer ${offerId} for status check:`, err.message);
                if (err.eresult === 25) {
                    return resolve({ state: -1, stateName: 'NotFoundOrNotOwned' });
                }
                return resolve(null);
            }
            resolve({
                state: offer.state,
                stateName: TradeOfferManager.ETradeOfferState[offer.state]
            });
        });
    });
}

function parseTradeURL(tradeUrl) {
    try {
        const regex = /https?:\/\/(www\.)?steamcommunity\.com\/tradeoffer\/new\/\?partner=(\d+)(&|&amp;)token=([a-zA-Z0-9_-]+)/i;
        const match = tradeUrl.match(regex);

        if (!match) {
            return { valid: false, error: 'Invalid trade URL format' };
        }

        const [, , partnerId, , token] = match;
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

async function sendWinningTradeOffer(roundDoc, winner, itemsToSend) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Starting winning trade offer for Round ${roundDoc.roundId}, Winner: ${winner.username}`);

    if (!roundDoc || !winner || !itemsToSend) {
        console.error(`[${timestamp}] PAYOUT_ERROR: Missing required parameters for round ${roundDoc?._id}, winner ${winner?._id}`);
        if (roundDoc && roundDoc._id) await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - System Error' } });
        return { success: false, error: 'Missing required parameters' };
    }
    if (!winner.tradeUrl) {
        console.error(`[${timestamp}] PAYOUT_ERROR: Winner ${winner.username} has no trade URL for round ${roundDoc.roundId}`);
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - No Trade URL' } });
        io.to(winner._id.toString()).emit('notification', {
            type: 'error',
            message: 'Please set your Steam Trade URL in your profile to receive winnings.'
        });
        return { success: false, error: 'No trade URL' };
    }
    if (!itemsToSend || itemsToSend.length === 0) {
        console.log(`[${timestamp}] PAYOUT_INFO: No items to send for round ${roundDoc.roundId} (all consumed by tax or empty pot).`);
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'No Items Won' } });
        io.to(winner._id.toString()).emit('notification', {
            type: 'info',
            message: `Congratulations on winning round #${roundDoc.roundId}! No items were sent as the pot was empty or consumed by fees.`
        });
        return { success: true, message: 'No items to send' };
    }
    try {
        await ensureValidManager();
        const offer = manager.createOffer(winner.tradeUrl);

        const itemsForOffer = itemsToSend.map(itemDoc => {
            if (!itemDoc.assetId) {
                console.error(`[${timestamp}] PAYOUT_CRITICAL: Item document in itemsToSend is missing assetId! Item ID: ${itemDoc._id}, Name: ${itemDoc.name}. Skipping this item.`);
                return null;
            }
            return {
                assetid: String(itemDoc.assetId),
                appid: RUST_APP_ID,
                contextid: String(RUST_CONTEXT_ID)
            };
        }).filter(item => item !== null);

        if (itemsForOffer.length === 0 && itemsToSend.length > 0) {
             console.error(`[${timestamp}] PAYOUT_ERROR: No valid items could be prepared for offer to ${winner.username} for round ${roundDoc.roundId}, though items were expected.`);
             await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Inventory/Trade Issue' } });
             io.to(winner._id.toString()).emit('notification', { type: 'error', message: 'Winnings payout failed due to an internal inventory issue. Contact support.' });
             return { success: false, error: 'Internal inventory item preparation error for payout.' };
        }
        if (itemsForOffer.length === 0 && itemsToSend.length === 0) {
             console.log(`[${timestamp}] PAYOUT_INFO: Double check - no items to send for round ${roundDoc.roundId}.`);
             return { success: true, message: 'No items to send (confirmed)' };
        }

        offer.addMyItems(itemsForOffer);
        const offerMessage = `脂 Round #${roundDoc.roundId} Winnings - ${process.env.SITE_NAME || 'YourSite'} - Value: $${roundDoc.totalValue.toFixed(2)} 脂`;
        offer.setMessage(offerMessage);

        console.log(`[${timestamp}] Sending winnings offer (${itemsForOffer.length} items) to ${winner.username} for round ${roundDoc.roundId}...`);
        const status = await new Promise((resolve, reject) => {
            offer.send((err, sendStatus) => {
                if (err) return reject(err);
                resolve(sendStatus);
            });
        });

        const offerId = offer.id;
        const offerURL = `https://steamcommunity.com/tradeoffer/${offerId}/`;

        // Initial status update. Confirmation status will update it further.
        await Round.updateOne(
            { _id: roundDoc._id },
            { $set: { payoutOfferId: offerId, payoutOfferStatus: 'Sent' } } // Or 'Pending Confirmation' if status indicates
        );

        io.to(winner._id.toString()).emit('tradeOfferSent', {
            roundId: roundDoc.roundId,
            userId: winner._id.toString(),
            offerId: offerId,
            offerURL: offerURL,
            status: status, // Use actual status from offer.send
            type: 'winning'
        });
        io.to(winner._id.toString()).emit('notification', {
            type: 'success',
            message: `Your winnings for round #${roundDoc.roundId} have been sent! Offer ID: ${offerId}. Steam will require confirmation. Click to view: ${offerURL}`
        });
        console.log(`[${timestamp}] SUCCESS: Winnings offer ${offerId} sent to ${winner.username} for round ${roundDoc.roundId}. Status: ${status}`);

        // --- MODIFIED: Auto-confirmation attempt with delay and retry ---
        if (status === 'sent' || status === 'pending' || status === 'CreatedNeedsConfirmation' || offer.state === TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation) { // 'pending' is often the status before confirmation
            console.log(`[${timestamp}] Offer ${offerId} requires confirmation. Attempting auto-confirmation in 5s.`);
            setTimeout(async () => {
                let confirmResult = await confirmTradeOffer(offerId, 'winnings');
                if (confirmResult.success) {
                    console.log(`[${timestamp}] Winnings offer ${offerId} auto-confirmed for ${winner.username} on first attempt.`);
                    await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Sent (Confirmed)' } });
                } else {
                    console.warn(`[${timestamp}] Failed to auto-confirm winnings offer ${offerId} on first attempt: ${confirmResult.error}. Retrying in 10s.`);
                    // Retry once more after a longer delay
                    setTimeout(async () => {
                        confirmResult = await confirmTradeOffer(offerId, 'winnings');
                        if (confirmResult.success) {
                            console.log(`[${timestamp}] Winnings offer ${offerId} auto-confirmed for ${winner.username} on RETRY.`);
                            await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Sent (Confirmed)' } });
                        } else {
                            console.error(`[${timestamp}] FAILED to auto-confirm winnings offer ${offerId} on retry: ${confirmResult.error}. Offer will require manual confirmation by bot admin.`);
                            // Update status to reflect it needs manual confirmation if not already handled by 'sentOfferChanged'
                            await Round.updateOne({ _id: roundDoc._id, payoutOfferStatus: 'Sent' }, { $set: { payoutOfferStatus: 'Pending Confirmation' } }); // Or a more specific error status
                             io.to(winner._id.toString()).emit('notification', {
                                type: 'warning',
                                message: `Offer ${offerId} sent, but auto-confirmation failed. Bot admin will confirm it shortly.`
                            });
                        }
                    }, 10000); // 10-second delay for retry
                }
            }, 5000); // 5-second initial delay
        } else {
            console.log(`[${timestamp}] Offer ${offerId} status is '${status}', does not require immediate confirmation handling here or already handled.`);
        }
        
        return { success: true, offerId: offerId, offerURL: offerURL, status: status };
    } catch (error) {
        console.error(`[${timestamp}] Error sending winnings offer for round ${roundDoc.roundId} to ${winner.username}:`, error.message, error.eresult);
        let userMessage = 'Failed to send winnings. Please try again or contact support.';
        let dbStatus = 'Failed - Send Error';

        if (error.eresult === 26 || error.message?.toLowerCase().includes('trade url') || error.message?.toLowerCase().includes('invalid for sending an offer')) {
            userMessage = 'Your Steam Trade URL appears to be invalid or has expired. Please update it in your profile and try accepting winnings again, or contact support.';
            dbStatus = 'Failed - Invalid Trade URL';
        } else if (error.eresult === 15) {
            userMessage = 'Your inventory appears to be private. Please make it public to receive winnings and contact support if issues persist.';
            dbStatus = 'Failed - Inventory Private';
        } else if (error.eresult === 16) {
            userMessage = 'You (or the bot) appear to be trade banned. Contact Steam support.';
            dbStatus = 'Failed - Trade Banned';
        } else if (error.eresult === 25 || error.message?.toLowerCase().includes('items_unavailable')) {
            userMessage = 'Some items for your winnings were unavailable at the time of sending. Please contact support.';
            dbStatus = 'Failed - Inventory/Trade Issue';
        } else if (error.message?.includes("No matching items found in bot inventory")) {
            userMessage = 'Winnings payout failed: Could not find specified items in bot inventory. Please contact support.';
            dbStatus = 'Failed - Bot Inventory Issue';
        } else if (error.eresult) {
            userMessage = `Failed to send winnings due to a Steam error (Code: ${error.eresult}). Please try again or contact support.`;
            dbStatus = `Failed - Steam Error ${error.eresult}`;
        }

        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: dbStatus, payoutOfferId: null } });
        io.to(winner._id.toString()).emit('notification', { type: 'error', message: userMessage });
        return { success: false, error: userMessage, errorCode: error.eresult };
    }
}

// Alternative approach: Fix sendWinningTradeOffer to fetch current inventory
async function sendWinningTradeOfferAlternative(roundDoc, winner, itemsToSend) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] (Alternative) Starting winning trade offer for Round ${roundDoc.roundId}, Winner: ${winner.username}`);

    if (!roundDoc || !winner || !itemsToSend) {
        console.error(`[${timestamp}] (Alternative) PAYOUT_ERROR: Missing required parameters`);
        if (roundDoc && roundDoc._id) await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - System Error' } });
        return { success: false, error: 'Missing required parameters' };
    }
    if (!winner.tradeUrl) {
        console.error(`[${timestamp}] (Alternative) PAYOUT_ERROR: Winner ${winner.username} has no trade URL`);
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - No Trade URL' } });
        io.to(winner._id.toString()).emit('notification', {
            type: 'error',
            message: 'Please set your Steam Trade URL in your profile to receive winnings.'
        });
        return { success: false, error: 'No trade URL' };
    }
    if (!itemsToSend || itemsToSend.length === 0) {
        console.log(`[${timestamp}] (Alternative) PAYOUT_INFO: No items to send (all consumed by tax)`);
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'No Items Won' } });
        io.to(winner._id.toString()).emit('notification', {
            type: 'info',
            message: `Congratulations on winning round #${roundDoc.roundId}! No items were sent as the pot was consumed by fees.`
        });
        return { success: true, message: 'No items to send' };
    }

    try {
        await ensureValidManager();
        console.log(`[${timestamp}] (Alternative) Fetching bot's current inventory to match items...`);
        const botInventory = await new Promise((resolve, reject) => {
            if (!manager) return reject(new Error("TradeOfferManager not initialized."));
            manager.getInventoryContents(RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inventory) => {
                if (err) {
                    console.error(`[${timestamp}] (Alternative) ERROR: Failed to fetch bot inventory for winnings:`, err);
                    reject(err);
                } else {
                    resolve(inventory || []);
                }
            });
        });

        const offer = manager.createOffer(winner.tradeUrl);
        const itemsForOffer = [];
        const usedBotAssetIds = new Set();

        for (const itemDocFromRound of itemsToSend) {
            const matchingBotItem = botInventory.find(botItem =>
                botItem.market_hash_name === itemDocFromRound.name &&
                !usedBotAssetIds.has(botItem.assetid) &&
                Math.abs((getItemPrice(botItem.market_hash_name) || 0) - itemDocFromRound.price) < 0.01
            );

            if (matchingBotItem) {
                itemsForOffer.push({
                    assetid: String(matchingBotItem.assetid),
                    appid: RUST_APP_ID,
                    contextid: String(RUST_CONTEXT_ID)
                });
                usedBotAssetIds.add(matchingBotItem.assetid);
                console.log(`[${timestamp}] (Alternative) Matched round item "${itemDocFromRound.name}" to bot inventory assetId: ${matchingBotItem.assetid}`);
            } else {
                console.error(`[${timestamp}] (Alternative) ERROR: Could not find matching item for "${itemDocFromRound.name}" (Price: ${itemDocFromRound.price}) in bot's live inventory for round ${roundDoc.roundId}!`);
            }
        }

        if (itemsForOffer.length === 0 && itemsToSend.length > 0) {
            console.error(`[${timestamp}] (Alternative) PAYOUT_ERROR: No items could be matched in bot inventory for round ${roundDoc.roundId} to ${winner.username}. Expected ${itemsToSend.length} items.`);
            await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Bot Inventory Issue' } });
            io.to(winner._id.toString()).emit('notification', { type: 'error', message: 'Winnings payout failed: Critical item mismatch in bot inventory. Contact support.' });
            return { success: false, error: "No matching items found in bot inventory for payout." };
        }
        if (itemsForOffer.length < itemsToSend.length) {
            console.warn(`[${timestamp}] (Alternative) PAYOUT_WARN: Matched only ${itemsForOffer.length} out of ${itemsToSend.length} expected items for round ${roundDoc.roundId} to ${winner.username}. Some items may be missing from the offer.`);
        }

        offer.addMyItems(itemsForOffer);
        const offerMessage = `脂 Round #${roundDoc.roundId} Winnings (Alternative) - ${process.env.SITE_NAME || 'YourSite'} - Value: $${roundDoc.totalValue.toFixed(2)} 脂`;
        offer.setMessage(offerMessage);

        console.log(`[${timestamp}] (Alternative) Sending winnings offer (${itemsForOffer.length} items) to ${winner.username}...`);
        const status = await new Promise((resolve, reject) => {
            offer.send((err, sendStatus) => {
                if (err) return reject(err);
                resolve(sendStatus);
            });
        });

        const offerId = offer.id;
        const offerURL = `https://steamcommunity.com/tradeoffer/${offerId}/`;

        await Round.updateOne(
            { _id: roundDoc._id },
            { $set: { payoutOfferId: offerId, payoutOfferStatus: 'Sent' } } // Or 'Pending Confirmation'
        );

        io.to(winner._id.toString()).emit('tradeOfferSent', {
            roundId: roundDoc.roundId,
            userId: winner._id.toString(),
            offerId: offerId,
            offerURL: offerURL,
            status: status,
            type: 'winning'
        });
        io.to(winner._id.toString()).emit('notification', {
            type: 'success',
            message: `(Alt) Your winnings for round #${roundDoc.roundId} have been sent! Offer ID: ${offerId}. Steam will require confirmation. Click to accept: ${offerURL}`
        });
        console.log(`[${timestamp}] (Alternative) SUCCESS: Winnings offer ${offerId} sent to ${winner.username}. Status: ${status}`);
        
        // --- MODIFIED: Auto-confirmation attempt with delay and retry (for Alternative) ---
        if (status === 'sent' || status === 'pending' || status === 'CreatedNeedsConfirmation' || offer.state === TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation) {
            console.log(`[${timestamp}] (Alternative) Offer ${offerId} requires confirmation. Attempting auto-confirmation in 5s.`);
            setTimeout(async () => {
                let confirmResult = await confirmTradeOffer(offerId, 'winnings-alt');
                if (confirmResult.success) {
                    console.log(`[${timestamp}] (Alternative) Winnings offer ${offerId} auto-confirmed for ${winner.username} on first attempt.`);
                    await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Sent (Confirmed)' } });
                } else {
                    console.warn(`[${timestamp}] (Alternative) Failed to auto-confirm winnings offer ${offerId} on first attempt: ${confirmResult.error}. Retrying in 10s.`);
                    setTimeout(async () => {
                        confirmResult = await confirmTradeOffer(offerId, 'winnings-alt');
                        if (confirmResult.success) {
                            console.log(`[${timestamp}] (Alternative) Winnings offer ${offerId} auto-confirmed for ${winner.username} on RETRY.`);
                            await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Sent (Confirmed)' } });
                        } else {
                            console.error(`[${timestamp}] (Alternative) FAILED to auto-confirm winnings offer ${offerId} on retry: ${confirmResult.error}. Offer will require manual confirmation by bot admin.`);
                            await Round.updateOne({ _id: roundDoc._id, payoutOfferStatus: 'Sent' }, { $set: { payoutOfferStatus: 'Pending Confirmation' } });
                            io.to(winner._id.toString()).emit('notification', {
                                type: 'warning',
                                message: `(Alt) Offer ${offerId} sent, but auto-confirmation failed. Bot admin will confirm it shortly.`
                            });
                        }
                    }, 10000); // 10-second delay for retry
                }
            }, 5000); // 5-second initial delay
        } else {
             console.log(`[${timestamp}] (Alternative) Offer ${offerId} status is '${status}', does not require immediate confirmation handling here or already handled.`);
        }
        
        return { success: true, offerId: offerId, offerURL: offerURL, status: status };

    } catch (error) {
        console.error(`[${timestamp}] (Alternative) Error sending winnings offer for round ${roundDoc.roundId} to ${winner.username}:`, error.message, error.eresult);
        let userMessage = 'Failed to send winnings (Alt). Please try again or contact support.';
        let dbStatus = 'Failed - Send Error';

        if (error.eresult === 26 || error.message?.toLowerCase().includes('trade url')) {
            userMessage = 'Your Steam Trade URL appears to be invalid (Alt). Please update it and contact support.';
            dbStatus = 'Failed - Invalid Trade URL';
        } else if (error.eresult === 15) {
            userMessage = 'Your inventory appears to be private (Alt). Please make it public.';
            dbStatus = 'Failed - Inventory Private';
        } else if (error.eresult === 16) {
            userMessage = 'You appear to be trade banned (Alt). Contact Steam support.';
            dbStatus = 'Failed - Trade Banned';
        } else if (error.message?.includes("No matching items found in bot inventory for payout.")) {
             dbStatus = 'Failed - Bot Inventory Issue';
             userMessage = error.message;
        } else if (error.eresult) {
            userMessage += ` (Steam Error Code: ${error.eresult})`;
            dbStatus = `Failed - Steam Error ${error.eresult}`;
        }

        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: dbStatus, payoutOfferId: null } });
        io.to(winner._id.toString()).emit('notification', { type: 'error', message: userMessage });
        return { success: false, error: userMessage, errorCode: error.eresult };
    }
}


// --- Authentication Routes ---
app.get('/auth/steam', authLimiter, passport.authenticate('steam', { failureRedirect: '/' }));
app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => { res.redirect('/'); }
);
app.post('/logout', (req, res, next) => {
    req.logout(err => {
        if (err) { return next(err); }
        req.session.destroy(err => {
            if (err) {
                console.error("Error destroying session during logout:", err);
                return res.status(500).json({ error: 'Logout failed due to session error.' });
            }
            res.clearCookie('connect.sid');
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
        return res.status(400).json({ error: errors.array()[0].msg });
    }
    next();
};

app.get('/api/user', ensureAuthenticated, (req, res) => {
    const { _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue });
});

app.post('/api/user/tradeurl',
    sensitiveActionLimiter, ensureAuthenticated,
    [
        body('tradeUrl').trim().custom((value) => {
            if (value === '') return true;
            if (!TRADE_URL_REGEX.test(value)) throw new Error('Invalid Steam Trade URL format. Ensure it includes partner and token parameters.');
            return true;
        })
    ],
    handleValidationErrors,
    async (req, res) => {
        const { tradeUrl } = req.body;
        try {
            const updatedUser = await User.findByIdAndUpdate(req.user._id, { tradeUrl: tradeUrl }, { new: true, runValidators: true });
            if (!updatedUser) return res.status(404).json({ error: 'User not found.' });

            console.log(`LOG_INFO: Trade URL updated for user: ${updatedUser.username} to "${tradeUrl}"`);
            res.json({ success: true, tradeUrl: updatedUser.tradeUrl });
        } catch (err) {
            if (err.name === 'ValidationError') {
                console.error(`Trade URL Validation Error for user ${req.user._id}:`, err.message);
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
            { status: 'completed_pending_acceptance' },
            { $set: { status: 'completed', payoutOfferStatus: 'Failed - Manually Cleared' }},
            { new: true }
        );
        const clearedUsers = await User.updateMany(
            { pendingDepositOfferId: { $ne: null } },
            { $set: { pendingDepositOfferId: null } }
        );

        console.log('LOG_INFO (Admin): Cleared stuck round:', stuckRound?.roundId || 'None found');
        console.log('LOG_INFO (Admin): Cleared pending offers for users:', clearedUsers.modifiedCount);

        if (currentRound && stuckRound && currentRound._id.toString() === stuckRound._id.toString()) {
            currentRound = null;
            await ensureInitialRound();
        }

        res.json({ success: true, clearedRoundId: stuckRound?.roundId, clearedUserOffers: clearedUsers.modifiedCount });
    } catch (error) {
        console.error('Error (Admin) clearing stuck round:', error);
        res.status(500).json({ error: 'Failed to clear stuck round' });
    }
});

// --- NEW Admin Endpoint for Testing Confirmations ---
app.get('/api/admin/test-confirmations', ensureAuthenticated, async (req, res) => {
    if (!process.env.ADMIN_STEAM_IDS || !process.env.ADMIN_STEAM_IDS.split(',').includes(req.user.steamId)) {
        return res.status(403).json({ error: 'Forbidden: Admin access required.' });
    }

    if (!isBotConfigured || !isBotReady || !community || !community.steamID) {
        return res.status(503).json({ error: 'Bot is not configured, not ready, or not logged in.' });
    }
    if (!process.env.STEAM_IDENTITY_SECRET) {
        return res.status(400).json({ error: 'STEAM_IDENTITY_SECRET is not configured.' });
    }

    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ADMIN_ACTION: User ${req.user.username} testing confirmations.`);

    try {
        const time = Math.floor(Date.now() / 1000);
        const confKey = SteamTotp.generateConfirmationKey(process.env.STEAM_IDENTITY_SECRET, time, 'conf');

        community.getConfirmations(time, confKey, (err, confirmations) => {
            if (err) {
                console.error(`[${timestamp}] ADMIN_TEST_CONF_ERROR: Failed to get confirmations:`, err.message);
                return res.status(500).json({ error: 'Failed to get confirmations from Steam.', details: err.message, eresult: err.eresult });
            }

            console.log(`[${timestamp}] ADMIN_TEST_CONF_SUCCESS: Found ${confirmations.length} confirmations.`);
            res.json({
                success: true,
                message: `Found ${confirmations.length} confirmations.`,
                confirmationCount: confirmations.length,
                confirmations: confirmations.map(c => ({
                    id: c.id, // Confirmation ID
                    key: c.key, // Nonce to accept
                    creator: c.creator, // ID of object being confirmed (e.g., trade offer ID)
                    type: c.type, // Type of confirmation (e.g., trade)
                    typeName: SteamCommunity.EConfirmationType[c.type] || 'Unknown',
                    title: c.title, // Human-readable title
                    receiving: c.receiving, // Human-readable of what's being received
                    time: c.time, // Creation time
                    icon: c.icon,
                    summary: c.summary,
                }))
            });
        });
    } catch (e) {
        console.error(`[${timestamp}] ADMIN_TEST_CONF_EXCEPTION: Exception during test:`, e);
        res.status(500).json({ error: 'Server exception during confirmation test.', details: e.message });
    }
});


app.get('/api/user/winning-history', ensureAuthenticated, async (req, res) => {
    try {
        const winnings = await Round.find({ winner: req.user._id, status: { $in: ['completed', 'completed_pending_acceptance', 'error'] } })
            .sort({ completedTime: -1 })
            .select('roundId completedTime totalValue payoutOfferId payoutOfferStatus taxAmount')
            .limit(25)
            .lean();

        const history = winnings.map(win => ({
            gameId: win.roundId,
            amountWon: win.totalValue,
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
        const user = req.user;

        const round = await Round.findOne({
            winner: user._id,
            status: 'completed_pending_acceptance',
            payoutOfferStatus: 'PendingAcceptanceByWinner' // Only allow accepting if it's in this specific state
        }).sort({ completedTime: -1 })
          .populate('winner', 'steamId username avatar tradeUrl') // Ensure winner is populated with tradeUrl
          .populate('items');

        if (!round) {
            console.warn(`LOG_WARN: No winnings pending acceptance found for user ${user.username} or round not in correct state.`);
            return res.status(404).json({ error: 'No winnings currently pending your acceptance or round already processed.' });
        }

        console.log(`LOG_INFO: Found round ${round.roundId} for user ${user.username} to accept winnings. Items in round.items: ${round.items.length}`);

        if (!round.winner || !round.winner.tradeUrl) {
            console.warn(`LOG_WARN: User ${user.username} (or populated winner) has no trade URL for round ${round.roundId}.`);
            await Round.updateOne({ _id: round._id }, { $set: { payoutOfferStatus: 'Failed - No Trade URL' } });
            return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile to accept winnings.' });
        }
        if (!TRADE_URL_REGEX.test(round.winner.tradeUrl)) {
            console.error(`LOG_ERROR: Invalid trade URL format for user ${user.username} (pre-check): "${round.winner.tradeUrl}"`);
            await Round.updateOne({ _id: round._id }, { $set: { payoutOfferStatus: 'Failed - Invalid Trade URL Format' } });
            return res.status(400).json({ error: 'Your Steam Trade URL format is invalid. Please update it.' });
        }

        console.log(`LOG_INFO: Calling sendWinningTradeOffer for round ${round.roundId}, user ${round.winner.username}. Items to send: ${round.items.length}`);
        
        // Ensure payoutOfferStatus is updated to indicate processing has started
        await Round.updateOne({ _id: round._id }, { $set: { payoutOfferStatus: 'Processing Winnings' }});

        // Choose which trade offer sending function to use:
        // const result = await sendWinningTradeOffer(round, round.winner, round.items);
        const result = await sendWinningTradeOfferAlternative(round, round.winner, round.items); // Using alternative as an example

        if (result.success) {
            // The sendWinningTradeOffer function now updates the round's payoutOfferStatus to 'Sent' or 'Pending Confirmation'
            // and handles auto-confirmation attempts. DB updates within sendWinningTradeOffer take precedence for status.
            res.json({
                success: true,
                message: `Winnings acceptance initiated for round #${round.roundId}. Offer ID: ${result.offerId}. Status: ${result.status}. Check Steam for the offer and confirmations.`,
                offerId: result.offerId,
                offerURL: result.offerURL
            });
        } else {
            // Error already handled, logged, and round status updated within sendWinningTradeOffer
            // If it failed before even sending (e.g. bad trade URL), reset to allow another attempt if appropriate
            if (round.payoutOfferStatus === 'Processing Winnings') { // Only reset if it didn't get a more specific error status
                 await Round.updateOne({ _id: round._id }, { $set: { payoutOfferStatus: 'PendingAcceptanceByWinner' } });
            }
            res.status(result.errorCode === 26 || result.errorCode === 15 || result.errorCode === 16 ? 400 : 500).json({ error: result.error || 'Failed to process winnings acceptance.' });
        }

    } catch (error) {
        console.error('CRITICAL_ERROR: Error in /api/round/accept-winnings:', error);
        // Attempt to find the round if an error occurred mid-process to reset its status
        const { roundIdFromBodyOrParams } = req.body; // Assuming roundId might be available if needed
        if (roundIdFromBodyOrParams) {
            await Round.findOneAndUpdate(
                { roundId: roundIdFromBodyOrParams, winner: req.user._id, status: 'completed_pending_acceptance', payoutOfferStatus: 'Processing Winnings' },
                { $set: { payoutOfferStatus: 'PendingAcceptanceByWinner' } }
            ).catch(e => console.error("Error trying to reset round status after accept-winnings exception:", e));
        }
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
        await ensureValidManager();

        const inventory = await new Promise((resolve, reject) => {
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv, currency) => {
                if (err) {
                    if (err.message?.includes('profile is private') || err.eresult === 15) {
                        return reject(new Error('Your Steam inventory is private. Please set it to public.'));
                    }
                    console.error(`Inventory Fetch Error (Manager): User ${req.user.steamId}: EResult ${err.eresult}, Message: ${err.message || err}`);
                    return reject(new Error(`Could not fetch inventory. Steam might be busy (EResult: ${err.eresult || 'N/A'}) or inventory private.`));
                }
                resolve(inv || []);
            });
        });

        if (!inventory?.length) return res.json([]);

        const validItems = inventory.map(item => {
                const itemName = item.market_hash_name;
                let price = 0;
                if (itemName) price = getItemPrice(itemName);
                else console.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`);

                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

                if (!item.assetid || !item.icon_url || !itemName) {
                    console.warn(`Inventory item missing required properties: assetId ${item?.assetid}, Name ${itemName}, Icon ${item?.icon_url}`);
                    return null;
                }
                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`;
                return { assetId: item.assetid, name: itemName, image: imageUrl, price: finalPrice, tradable: item.tradable };
            })
            .filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE);

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
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.')
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

        if (user.pendingDepositOfferId) {
            try {
                const offerStatus = await checkOfferStatus(user.pendingDepositOfferId);
                if (offerStatus && [
                       TradeOfferManager.ETradeOfferState.Active,
                       TradeOfferManager.ETradeOfferState.Sent, // Bot sent to user for deposit confirmation
                       TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation // Bot sent, needs confirmation
                    ].includes(offerStatus.state)) {
                    console.log(`User ${user.username} already has pending deposit offer ${user.pendingDepositOfferId}. State: ${offerStatus.stateName}`);
                    const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                    return res.status(409).json({ error: 'You have an active deposit offer pending. Please accept or decline it on Steam first.', offerId: user.pendingDepositOfferId, offerURL });
                } else {
                    console.log(`Clearing stale/non-active pending offer ${user.pendingDepositOfferId} for user ${user.username} (State: ${offerStatus?.stateName || 'Unknown/Error'}).`);
                    await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
                }
            } catch (offerFetchError) {
                console.warn(`Error checking pending offer ${user.pendingDepositOfferId}, clearing flag:`, offerFetchError.message);
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
            }
        }

        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }

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
            await ensureValidManager();

            const userInventory = await new Promise((resolve, reject) => {
                manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                    if (err) {
                        if (err.message?.includes('profile is private') || err.eresult === 15) return reject(new Error('Your Steam inventory is private.'));
                        console.error(`Inventory Fetch Error (Deposit): User ${user.steamId}: EResult ${err.eresult}`, err);
                        return reject(new Error(`Could not fetch your inventory (EResult: ${err.eresult}). Ensure it's public and tradable.`));
                    }
                    resolve(inv || []);
                });
            });
            const userInventoryMap = new Map(userInventory.map(item => [item.assetid, item]));

            for (const assetId of requestedAssetIds) {
                const inventoryItem = userInventoryMap.get(assetId);
                if (!inventoryItem) throw new Error(`Item (Asset ID ${assetId}) not found in your inventory or already in a trade.`);
                if (!inventoryItem.tradable) throw new Error(`Item '${inventoryItem.market_hash_name}' is not tradable.`);

                const price = getItemPrice(inventoryItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) throw new Error(`Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below the minimum deposit value of $${MIN_ITEM_VALUE.toFixed(2)}.`);

                itemsToRequestDetails.push({ // These details are stored in pendingDeposits
                    assetid: inventoryItem.assetid, // This is the user's original assetid
                    appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID,
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

        const depositId = uuidv4();
        const offerMessage = `Deposit for ${process.env.SITE_NAME || 'Our Site'} | Round: ${currentRound.roundId} | DepositID: ${depositId}`;
        let cleanupTimeout = null;
        let offer = null; // Define offer here to access offer.id in catch block if send fails early

        try {
            offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsToRequestDetails.map(item => ({ assetid: item.assetid, appid: item.appid, contextid: item.contextid })));
            offer.setMessage(offerMessage);

            pendingDeposits.set(depositId, {
                userId: user._id, roundId: currentRound._id, items: itemsToRequestDetails,
                totalValue: depositTotalValue, steamId: user.steamId, offerIdAttempted: null // Will be set after send
            });
            console.log(`Stored pending deposit ${depositId} for user ${user.steamId}.`);

            const offerCancelTime = manager.cancelTime || 10 * 60 * 1000;
            cleanupTimeout = setTimeout(() => {
                if(pendingDeposits.has(depositId)) {
                    const pendingData = pendingDeposits.get(depositId);
                    console.log(`Deposit attempt ${depositId} (Offer: ${pendingData.offerIdAttempted || 'N/A'}) expired or timed out from internal cleanup.`);
                    pendingDeposits.delete(depositId);
                    if (pendingData.offerIdAttempted) { // If an offer ID was recorded
                        User.updateOne({ _id: user._id, pendingDepositOfferId: pendingData.offerIdAttempted }, { $set: { pendingDepositOfferId: null }})
                            .catch(e => console.error("Error clearing user pending flag on deposit expiry/timeout:", e));
                    } else { // If no offer ID was recorded (e.g. failed before send or before ID was known)
                         User.updateOne({ _id: user._id }, { $set: { pendingDepositOfferId: null }}) // Clear any potentially stale flag
                            .catch(e => console.error("Error clearing user pending flag on deposit timeout (no offer id):", e));
                    }
                }
            }, offerCancelTime + 5000); // Cleanup slightly after Steam would cancel

            console.log(`Sending deposit offer to ${user.username} (Trade URL: ${user.tradeUrl}). DepositID: ${depositId}`);
            const status = await new Promise((resolve, reject) => {
                offer.send((err, sendStatus) => {
                    if (err) return reject(err);
                    resolve(sendStatus);
                });
            });
            const actualOfferId = offer.id; // Now offer.id is available
            console.log(`Deposit offer ${actualOfferId} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);

            if (pendingDeposits.has(depositId)) {
                pendingDeposits.get(depositId).offerIdAttempted = actualOfferId;
            }

            try {
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: actualOfferId });
                console.log(`Set pendingDepositOfferId=${actualOfferId} for user ${user.username}.`);
            } catch (dbUpdateError) {
                console.error(`CRITICAL: Failed to set pendingDepositOfferId for user ${user.username} after sending offer ${actualOfferId}.`, dbUpdateError);
                // Offer was sent, but DB flag failed. This is problematic.
                // Consider trying to cancel the offer if this is critical and unrecoverable by user.
            }

            // For deposits, Steam requires the *user* to confirm the trade in their client/app if they have 2FA for trades.
            // The bot is *receiving* items, so it doesn't confirm its side of this specific offer.
            // The `confirmTradeOffer` function is primarily for offers the *bot sends out where it GIVES items*.
            // However, if the deposit offer gets stuck in "CreatedNeedsConfirmation" from the bot's perspective (unusual for deposits),
            // it might indicate an issue with the bot's session or Steam state.
            // Typically, deposit offers go to "Sent" then "Active" (awaiting user acceptance).
            if (status === 'sent' || status === 'pending' || status === 'CreatedNeedsConfirmation') {
                 console.log(`Deposit offer ${actualOfferId} status: ${status}. User ${user.username} needs to accept/confirm it on Steam.`);
            }

            const offerURL = `https://steamcommunity.com/tradeoffer/${actualOfferId}/`;
            res.json({ success: true, message: 'Deposit offer created! Please accept it on Steam.', offerId: actualOfferId, offerURL: offerURL });

        } catch (error) {
            console.error(`Error sending deposit offer for ${user.username} (DepositID: ${depositId}): EResult ${error.eresult}, Msg: ${error.message}`);
            pendingDeposits.delete(depositId);
            if (cleanupTimeout) clearTimeout(cleanupTimeout);

            // Clear pendingDepositOfferId if an offer ID was assigned and failed, or if it was never set.
            // The offer object might exist even if .send() failed.
            const offerIdToClear = offer && offer.id ? offer.id : null;
            User.updateOne({ _id: user._id, pendingDepositOfferId: offerIdToClear }, { $set: { pendingDepositOfferId: null }})
                .catch(e => console.error("Error clearing user flag on deposit offer send fail:", e));

            let userMessage = 'Failed to create deposit trade offer. Please try again later.';
            if (error.eresult === 26 || error.message?.toLowerCase().includes('trade url')) {
                userMessage = 'Your Steam Trade URL might be invalid or expired. Please check your profile.';
            } else if (error.eresult === 15 || error.eresult === 16) { // Inventory private or trade ban
                userMessage = `Could not create deposit offer. Ensure you can trade and your inventory is accessible (Error: ${error.eresult}).`;
            } else if (error.eresult === 25) { // Items unavailable (user might have traded them away)
                userMessage = `Some items selected for deposit are no longer available in your inventory (Error: ${error.eresult}). Please refresh your inventory.`;
            } else if (error.eresult) {
                userMessage += ` (Steam Error Code: ${error.eresult})`;
            }
            res.status(500).json({ error: userMessage });
        }
    }
);


io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.initialize()(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.session()(socket.request, socket.request.res || {}, next); });

let connectedChatUsers = 0;
const userLastMessageTime = new Map();

io.on('connection', (socket) => {
    connectedChatUsers++;
    io.emit('updateUserCount', connectedChatUsers);

    const user = socket.request.user;
    if (user && user.username) {
        console.log(`LOG_INFO: User ${user.username} (Socket ID: ${socket.id}) connected.`);
        // Join a room specific to the user's ID for targeted notifications
        socket.join(user._id.toString());
    } else {
        console.log(`LOG_INFO: Anonymous client (Socket ID: ${socket.id}) connected.`);
    }

    socket.on('requestRoundData', async () => {
        let roundToFormat = null;
        try {
            if (currentRound?._id && ['active', 'rolling', 'pending', 'completed_pending_acceptance'].includes(currentRound.status)) {
                if ( (currentRound.participants && currentRound.participants.length > 0 && typeof currentRound.participants[0]?.user === 'string') ||
                     (currentRound.winner && typeof currentRound.winner === 'string') ) {
                    currentRound = await Round.findById(currentRound._id)
                          .populate('participants.user', 'steamId username avatar')
                          .populate('items') 
                          .populate('winner', 'steamId username avatar').lean();
                }
                roundToFormat = currentRound;
            }
            if (!roundToFormat) {
                roundToFormat = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending', 'completed_pending_acceptance'] } })
                      .sort({ startTime: -1 })
                      .populate('participants.user', 'steamId username avatar')
                      .populate('items')
                      .populate('winner', 'steamId username avatar').lean();
                if (roundToFormat) currentRound = roundToFormat;
            }

            const formattedData = formatRoundForClient(roundToFormat);
            if (formattedData) socket.emit('roundData', formattedData);
            else socket.emit('noActiveRound');
        } catch (err) {
            console.error(`Error fetching round data for socket ${socket.id}:`, err);
            socket.emit('roundError', { error: 'Failed to load round data.' });
        }
    });

    socket.on('chatMessage', chatLimiter, (msg) => { // Added chatLimiter here for socket events if needed, or rely on IP based for HTTP
        if (!user || !user._id) {
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

        userLastMessageTime.set(userId, now);

        const messageData = {
            type: 'user',
            username: user.username,
            avatar: user.avatar || '/img/default-avatar.png',
            message: trimmedMsg,
            userId: userId,
            userSteamId: user.steamId,
            timestamp: new Date()
        };
        io.emit('chatMessage', messageData);
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

    const timeLeft = (round.status === 'active' && round.endTime)
        ? Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000))
        : (round.status === 'pending' ? ROUND_DURATION : 0);

    const participantsFormatted = (round.participants || []).map(p => {
        if (!p.user) return null;
        const userObj = p.user._id ? p.user : { _id: p.user.toString() }; // Handle if not populated
        return {
            user: { _id: userObj._id, steamId: userObj.steamId, username: userObj.username, avatar: userObj.avatar },
            itemsValue: p.itemsValue || 0,
            tickets: p.tickets || 0
        };
    }).filter(p => p !== null && p.user && p.user._id); // Ensure user object is valid

    const itemsFormatted = (round.items || []).map(i => {
        if (!i || typeof i.price !== 'number' || !i.assetId || !i.name || !i.image) { 
            console.warn("formatRoundForClient: Skipping malformed item:", i);
            return null;
        }
        return {
            assetId: i.assetId, 
            originalAssetId: i.originalAssetId, 
            name: i.name, image: i.image, price: i.price,
            owner: i.owner?._id || i.owner?.toString() // Handle if owner not populated
        };
    }).filter(item => item !== null);

    let winnerDetails = null;
    if (round.winner && round.winner.steamId) { // Check if winner is populated
        winnerDetails = {
            id: round.winner._id, steamId: round.winner.steamId,
            username: round.winner.username, avatar: round.winner.avatar
        };
    } else if (round.winner) { // If winner is just an ID
        winnerDetails = { id: round.winner.toString() };
    }

    return {
        roundId: round.roundId,
        status: round.status,
        startTime: round.startTime,
        endTime: round.endTime,
        timeLeft: timeLeft,
        totalValue: round.totalValue || 0,
        serverSeedHash: round.serverSeedHash,
        participants: participantsFormatted,
        items: itemsFormatted, 
        winner: winnerDetails,
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
        // Prioritize using the in-memory currentRound if it's likely valid and populated
        if (currentRound?._id && ['active', 'rolling', 'pending', 'completed_pending_acceptance'].includes(currentRound.status)) {
            // Check if critical fields that need population are actually populated
            const needsRepopulate =
                (currentRound.participants && currentRound.participants.length > 0 && (typeof currentRound.participants[0]?.user === 'string' || !currentRound.participants[0]?.user?._id)) ||
                (currentRound.winner && (typeof currentRound.winner === 'string' || !currentRound.winner?._id)) ||
                (currentRound.items && currentRound.items.length > 0 && (typeof currentRound.items[0] === 'string' || !currentRound.items[0]?.assetId));

            if (needsRepopulate) {
                console.log("LOG_DEBUG: Current round in memory needs repopulation for API.");
                currentRound = await Round.findById(currentRound._id)
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items')
                    .populate('winner', 'steamId username avatar').lean();
            }
            roundToFormat = currentRound;
        }


        if (!roundToFormat) { // If not using in-memory or it was invalid, fetch from DB
            console.log("LOG_DEBUG: No valid in-memory currentRound, fetching from DB for API.");
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending', 'completed_pending_acceptance'] } })
                .sort({ startTime: -1 }) // Get the most recent one if multiple (shouldn't happen for 'active')
                .populate('participants.user', 'steamId username avatar')
                .populate('items')
                .populate('winner', 'steamId username avatar').lean();

            if (roundToFormat) {
                currentRound = roundToFormat; // Update in-memory currentRound
                // If fetched round is active and has participants, ensure timer logic is running
                if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !isRolling) {
                    if (currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        console.log("LOG_DEBUG: Starting timer for fetched active round (API).");
                        startRoundTimer(true); // Resume timer
                    } else if (!currentRound.endTime && !roundTimer) {
                         console.log("LOG_DEBUG: Starting new timer for fetched active round without endTime (API).");
                        startRoundTimer(false); // Start new timer
                    }
                }
            }
        }

        const formattedData = formatRoundForClient(roundToFormat);
        if (formattedData) {
            res.json(formattedData);
        } else {
            if (isBotReady && !isRolling) { // Only try to create new if bot is ready and not currently rolling a round
                console.log("LOG_INFO: No current round found for API, attempting to create one as bot is ready.");
                const newRound = await createNewRound(); // createNewRound updates currentRound and emits
                const newFormattedData = formatRoundForClient(newRound); // newRound from createNewRound is already an object
                if (newFormattedData) return res.json(newFormattedData);
            }
            // If still no data (e.g., bot not ready, or createNewRound failed)
            res.status(404).json({ error: 'No active or pending round found. System might be initializing or between rounds.' });
        }
    } catch (err) {
        console.error('Error fetching/formatting current round data for API:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' });
    }
});


app.get('/api/rounds',
    [
        query('page').optional().isInt({ min: 1 }).toInt().default(1),
        query('limit').optional().isInt({ min: 1, max: 50 }).toInt().default(10)
    ], handleValidationErrors, async (req, res) => {
    try {
        const { page, limit } = req.query;
        const skip = (page - 1) * limit;
        const queryFilter = { status: { $in: ['completed', 'completed_pending_acceptance', 'error'] } };

        const rounds = await Round.find(queryFilter)
            .sort('-roundId')
            .skip(skip)
            .limit(limit)
            .populate('winner', 'username avatar steamId')
            .populate('items', 'name price image assetId originalAssetId') 
            .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount taxedItems payoutOfferId payoutOfferStatus items')
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
        body('clientSeed').trim().notEmpty().withMessage('Client Seed is required.').isString().isLength({ min: 1, max: 128 }).withMessage('Client Seed is too long.')
    ],
    handleValidationErrors, async (req, res) => {
    const { roundId, serverSeed, clientSeed } = req.body;
    try {
        const round = await Round.findOne({ roundId: roundId, status: { $in: ['completed', 'completed_pending_acceptance'] } })
            .populate('participants.user', 'username').populate('winner', 'username').lean();

        if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found or not yet verifiable.` });

        if (!round.serverSeedHash) return res.json({ verified: false, reason: 'Server Seed Hash for this round is not available (round might be too old or errored before hashing).'});
        const providedServerSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
        if (providedServerSeedHash !== round.serverSeedHash) {
            return res.json({ verified: false, reason: 'Server Seed Hash mismatch. The provided Server Seed does not match the hash published before the round.', expectedServerSeedHash: round.serverSeedHash, providedServerSeed: serverSeed, calculatedHashOfProvidedSeed: providedServerSeedHash });
        }

        // Use the round's actual serverSeed and clientSeed for verification if they exist,
        // otherwise, use the user-provided ones (though this path implies the user is testing before official reveal)
        const effectiveServerSeed = round.serverSeed || serverSeed;
        const effectiveClientSeed = round.clientSeed || clientSeed; // If round.clientSeed is null/undefined, use provided

        // If the round is completed and has its own seeds, use them primarily for official verification
        if (round.serverSeed && round.serverSeed !== serverSeed) {
             console.warn(`Verification for round ${roundId}: User provided server seed ${serverSeed} differs from stored ${round.serverSeed}. Using stored for official calc.`);
        }
        if (round.clientSeed && round.clientSeed !== clientSeed) {
             console.warn(`Verification for round ${roundId}: User provided client seed ${clientSeed} differs from stored ${round.clientSeed}. Using stored for official calc.`);
        }


        const combinedString = effectiveServerSeed + effectiveClientSeed;
        const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');

        if (round.provableHash && calculatedProvableHash !== round.provableHash) {
            return res.json({ verified: false, reason: 'Calculated Provable Hash mismatch with the official provable hash stored for the round.', expectedProvableHash: round.provableHash, calculatedProvableHashFromInputs: calculatedProvableHash, combinedStringUsed: combinedString });
        }

        const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
        const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;

        if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets, cannot verify winner selection mechanics.' });
        const calculatedWinningTicket = decimalFromHash % totalTickets;

        if (round.winningTicket !== undefined && calculatedWinningTicket !== round.winningTicket) {
            return res.json({
                verified: false,
                reason: 'Calculated winning ticket number does not match the official winning ticket for the round.',
                calculatedWinningTicket: calculatedWinningTicket,
                officialWinningTicket: round.winningTicket,
                provableHashUsedForCalculation: calculatedProvableHash, // Use the hash from effective seeds
                totalTicketsInRound: totalTickets
            });
        }

        // If we reach here, the user-provided seeds (if they differ from stored ones) produce the same outcome, or the stored seeds were used and verified.
        res.json({
            verified: true,
            roundId: round.roundId,
            serverSeedUsedForVerification: effectiveServerSeed,
            serverSeedHashExpected: round.serverSeedHash,
            clientSeedUsedForVerification: effectiveClientSeed,
            combinedStringUsed: combinedString,
            finalHashCalculated: calculatedProvableHash,
            winningTicketCalculated: calculatedWinningTicket,
            officialWinningTicketRecorded: round.winningTicket, // This is the definitive one from the round
            totalTicketsInRound: totalTickets,
            finalPotValueWon: round.totalValue, // Value corresponding to the winner
            winnerUsername: round.winner?.username || 'N/A'
        });

    } catch (err) {
        console.error(`Error verifying round ${roundId}:`, err);
        res.status(500).json({ error: 'Server error during verification process.' });
    }
});


async function startApp() {
    console.log("LOG_INFO: Performing initial price cache refresh...");
    await refreshPriceCache();
    setInterval(async () => {
        try { await refreshPriceCache(); }
        catch (refreshErr) { console.error("Error during scheduled price cache refresh:", refreshErr); }
    }, PRICE_REFRESH_INTERVAL_MS);
    console.log(`LOG_INFO: Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);

    setInterval(async () => {
        try {
            const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
            const updateResult = await Round.updateMany(
                {
                    status: 'completed_pending_acceptance',
                    completedTime: { $lt: thirtyMinutesAgo },
                    payoutOfferStatus: { $in: ['PendingAcceptanceByWinner', 'Failed - No Trade URL', 'Failed - Invalid Trade URL Format', 'Unknown', 'Failed - Offer Creation Error', 'Failed - Send Error', 'Failed - Invalid Trade URL', 'Failed - Inventory Private', 'Failed - Trade Banned', 'Failed - Bot Inventory Issue', 'Pending Confirmation'] } 
                },
                {
                    $set: {
                        status: 'completed', // Mark as completed if user didn't accept in time
                        payoutOfferStatus: 'Failed - Timeout AutoClear' // Items would be considered forfeit or returned to house
                    }
                }
            );
            if (updateResult.modifiedCount > 0) {
                console.log(`LOG_INFO (AutoClear): Cleared ${updateResult.modifiedCount} stuck rounds to 'completed' (Timeout AutoClear) due to user not accepting winnings.`);
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
            console.log("WARN: Steam Bot initial login may have failed or is pending. Check logs. isBotReady is false.");
        } else {
            console.log("LOG_SUCCESS: Steam Bot is ready (isBotReady is true).");
        }
    });
}

startApp();

function gracefulShutdown() {
    console.log('LOG_INFO: Received shutdown signal. Closing server...');

    if (cookieRefreshInterval) {
        clearInterval(cookieRefreshInterval);
        cookieRefreshInterval = null;
    }
    if (roundTimer) {
        clearInterval(roundTimer);
        roundTimer = null;
    }

    io.close(() => {
        console.log('LOG_INFO: Socket.IO connections closed.');
        server.close(async () => {
            console.log('LOG_INFO: HTTP server closed.');
            try {
                await mongoose.connection.close();
                console.log('LOG_INFO: MongoDB connection closed.');
                if (manager && typeof manager.shutdown === 'function') {
                    console.log('LOG_INFO: Stopping TradeOfferManager polling...');
                    manager.shutdown();
                }
                console.log('LOG_INFO: Graceful shutdown complete. Exiting.');
                process.exit(0);
            } catch (e) {
                console.error("Error during resource cleanup in shutdown:", e);
                process.exit(1);
            }
        });
    });

    setTimeout(() => {
        console.error('CRITICAL_ERROR: Could not close connections gracefully in time, forcing shutdown.');
        process.exit(1);
    }, 10000); // 10 seconds timeout
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

app.use((err, req, res, next) => {
    console.error("Unhandled Error at Express level:", err.stack || err);
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.');
    if (res.headersSent) {
        return next(err);
    }
    res.status(status).json({ error: message });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optionally: Implement more robust error tracking/reporting here
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Optionally: Implement more robust error tracking/reporting here
  // For uncaught exceptions, it's often recommended to gracefully shutdown
  // process.exit(1); // After logging, consider exiting if state is corrupt
});
