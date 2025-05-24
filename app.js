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
const SteamID = require('steamid');

// --- Enhanced: connect-mongo for persistent sessions ---
const MongoStore = require('connect-mongo');

// --- FIXED: More flexible Trade URL validation that handles common variations ---
const TRADE_URL_REGEX = /^https?:\/\/(www\.)?steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+(&|&amp;)token=[a-zA-Z0-9_-]+$/i;

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
const BOT_SESSION_LOCK_TIMEOUT = 30000; // 30 seconds max wait for bot operations

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
            "script-src": ["'self'", "/socket.io/socket.io.js", "'unsafe-inline'"],
            "script-src-attr": ["'self'", "'unsafe-inline'"],
            "style-src": ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "'unsafe-inline'"],
            "img-src": ["'self'", "data:", "*.steamstatic.com", "*.akamaihd.net", "steamcdn-a.akamaihd.net"],
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
                sources.push("https://rust.scmm.app");
                sources.push("https://api.steampowered.com");
                sources.push("https://steamcommunity.com");
                return sources;
            })(),
            "frame-src": ["'self'", "https://steamcommunity.com"],
            "frame-ancestors": ["'self'", "https://steamcommunity.com"],
            "object-src": ["'none'"],
            "upgrade-insecure-requests": [],
        },
    })
);

// Rate limiters
const generalApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many login attempts from this IP, please try again after 10 minutes', standardHeaders: true, legacyHeaders: false });
const sensitiveActionLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, message: 'Too many requests for this action, please try again after 5 minutes', standardHeaders: true, legacyHeaders: false });
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 10, message: 'Too many deposit attempts, please wait a minute.', standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Too many chat messages from this IP. Please wait a moment.', standardHeaders: true, legacyHeaders: false });
const tradeLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, message: 'Too many trade requests. Please wait before trying again.', standardHeaders: true, legacyHeaders: false });

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
        ttl: 14 * 24 * 60 * 60,
        autoRemove: 'native'
    }),
    cookie: {
        maxAge: 3600000 * 24,
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax'
    }
});
app.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

// --- Steam Strategy ---
passport.use(new SteamStrategy({
    returnURL: `${process.env.SITE_URL}/auth/steam/return`,
    realm: process.env.SITE_URL,
    apiKey: process.env.STEAM_API_KEY
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
                        tradeUrl: '',
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
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
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
        validate: {
            validator: function(v) {
                if (v === '') return true;
                return TRADE_URL_REGEX.test(v);
            },
            message: 'Invalid Steam Trade URL format.'
        }
    },
    createdAt: { type: Date, default: Date.now },
    banned: { type: Boolean, default: false },
    pendingDepositOfferId: { type: String, default: null, index: true },
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
    roundId: { type: Number, required: true, unique: true, index: true },
    status: { type: String, enum: ['pending', 'active', 'rolling', 'completed', 'completed_pending_acceptance', 'error'], default: 'pending', index: true },
    startTime: { type: Date },
    endTime: { type: Date },
    completedTime: { type: Date },
    totalValue: { type: Number, default: 0, min: 0 },
    items: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }],
    participants: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        itemsValue: { type: Number, required: true, default: 0, min: 0 },
        tickets: { type: Number, required: true, default: 0, min: 0 }
    }],
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    winningTicket: { type: Number, min: 0 },
    serverSeed: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    serverSeedHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    clientSeed: { type: String, match: /^[a-f0-9]+$/ },
    provableHash: { type: String, match: /^[a-f0-9]{64}$/ },
    taxAmount: { type: Number, default: 0, min: 0 },
    taxedItems: [{ assetId: String, name: String, price: { type: Number, min: 0 } }],
    payoutOfferId: { type: String, index: true },
    payoutOfferStatus: {
        type: String,
        enum: [
            'PendingAcceptanceByWinner', 'Sent', 'Accepted', 'Declined', 'Canceled', 'Expired',
            'InvalidItems', 'Escrow', 'Failed', 'Unknown', 'Failed - No Trade URL',
            'No Items Won', 'Pending Confirmation', 'Failed - Bot Not Ready',
            'Failed - Offer Creation Error', 'Failed - Bad URL', 'Failed - Inventory/Trade Issue',
            'Failed - DB Error Post-Send', 'Failed - Synchronous Offer Prep Error',
            'Failed - Invalid Trade URL Format', 'Failed - Bot Inventory Issue',
            'Failed - Bot Session Issue', 'Failed - Manually Cleared', 'Failed - Timeout AutoClear',
            'Failed - Invalid Trade URL Components', 'Failed - Invalid Partner ID',
            'Failed - URL Parse Error', 'Failed - Bot Not Configured', 'Failed - Malformed Trade URL',
            'Failed - Inventory Private', 'Failed - Trade Banned', 'Failed - Rate Limited',
            'Failed - System Error', 'Failed - Send Error'
        ],
        default: 'Unknown'
    }
});
roundSchema.index({ 'participants.user': 1 });
roundSchema.index({ winner: 1, status: 1, completedTime: -1 });

const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);

// --- FIXED: Bot Session Lock Manager ---
class BotSessionLock {
    constructor() {
        this.locked = false;
        this.queue = [];
    }

    async acquire(operation = 'unknown') {
        const timestamp = new Date().toISOString();
        if (!this.locked) {
            this.locked = true;
            console.log(`[${timestamp}] BOT_LOCK: Acquired immediately for ${operation}`);
            return;
        }

        console.log(`[${timestamp}] BOT_LOCK: Waiting for lock (${operation})`);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                const index = this.queue.findIndex(item => item.resolve === resolve);
                if (index !== -1) {
                    this.queue.splice(index, 1);
                    reject(new Error(`Bot lock timeout for ${operation}`));
                }
            }, BOT_SESSION_LOCK_TIMEOUT);

            this.queue.push({ resolve, reject, timeout, operation });
        });
    }

    release(operation = 'unknown') {
        const timestamp = new Date().toISOString();
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            clearTimeout(next.timeout);
            console.log(`[${timestamp}] BOT_LOCK: Released by ${operation}, given to ${next.operation}`);
            next.resolve();
        } else {
            console.log(`[${timestamp}] BOT_LOCK: Released by ${operation}`);
            this.locked = false;
        }
    }
}

const botSessionLock = new BotSessionLock();

// --- Steam Bot Setup ---
const community = new SteamCommunity();
let manager = null;
let currentBotCookies = null;
let cookieRefreshInterval = null;
let lastCookieValidation = 0;

// --- FIXED: Enhanced cookie validation with proper error handling ---
async function validateAndRefreshCookies() {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] LOG_INFO: Validating bot cookies...`);

    if (!currentBotCookies || currentBotCookies.length === 0) {
        console.log(`[${timestamp}] LOG_WARN: No cookies available, executing full login...`);
        return executeBotLogin();
    }

    return new Promise((resolve, reject) => {
        if (!community.steamID) {
            console.log(`[${timestamp}] LOG_WARN: No steamID on community object, cookies likely expired. Re-logging in...`);
            return executeBotLogin().then(resolve).catch(reject);
        }

        // Set a timeout for validation
        const validationTimeout = setTimeout(() => {
            console.log(`[${timestamp}] LOG_WARN: Cookie validation timeout, assuming invalid. Re-logging in...`);
            executeBotLogin().then(resolve).catch(reject);
        }, 10000); // 10 second timeout

        community.getSteamUser(community.steamID, (err, user) => {
            clearTimeout(validationTimeout);

            if (err) {
                console.log(`[${timestamp}] LOG_WARN: Cookie validation failed (getSteamUser error), re-logging in...`, err.message);
                return executeBotLogin().then(resolve).catch(reject);
            }

            console.log(`[${timestamp}] LOG_SUCCESS: Cookies validated successfully. User: ${user.name}`);
            lastCookieValidation = Date.now();
            resolve();
        });
    });
}

// --- FIXED: Ensure valid manager with proper locking ---
async function ensureValidManager() {
    const timestamp = new Date().toISOString();

    await botSessionLock.acquire('ensureValidManager');

    try {
        if (!manager) {
            console.log(`[${timestamp}] LOG_INFO: Manager doesn't exist, creating new instance...`);
            if (!currentBotCookies || currentBotCookies.length === 0) {
                await validateAndRefreshCookies();
            }
            await createTradeOfferManager(currentBotCookies);
            return;
        }

        const timeSinceLastValidation = Date.now() - lastCookieValidation;
        if (timeSinceLastValidation > 5 * 60 * 1000) {
            console.log(`[${timestamp}] LOG_INFO: Time for cookie validation (${Math.floor(timeSinceLastValidation / 1000)}s since last check)`);
            await validateAndRefreshCookies();

            if (manager && currentBotCookies) {
                await new Promise((resolve, reject) => {
                    manager.setCookies(currentBotCookies, (err) => {
                        if (err) {
                            console.error(`[${timestamp}] LOG_ERROR: Failed to update cookies on existing manager:`, err);
                            createTradeOfferManager(currentBotCookies).then(resolve).catch(reject);
                        } else {
                            console.log(`[${timestamp}] LOG_SUCCESS: Updated cookies on existing manager`);
                            resolve();
                        }
                    });
                });
            }
        }
    } finally {
        botSessionLock.release('ensureValidManager');
    }
}

// --- FIXED: Create trade offer manager with better cleanup ---
async function createTradeOfferManager(cookies) {
    const timestamp = new Date().toISOString();

    if (manager) {
        console.log(`[${timestamp}] LOG_INFO: Shutting down existing TradeOfferManager instance before creating a new one.`);
        try {
            manager.shutdown();
            // Wait a bit for cleanup
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (shutdownErr) {
            console.error(`[${timestamp}] LOG_ERROR: Error during manager shutdown:`, shutdownErr);
        }
        manager = null;
    }

    manager = new TradeOfferManager({
        steam: community,
        domain: process.env.SITE_URL ? process.env.SITE_URL.replace(/^https?:\/\//, '') : 'localhost',
        language: 'en',
        pollInterval: 10000,
        cancelTime: 10 * 60 * 1000,
        dataDirectory: null // Disable caching to prevent stale data issues
    });

    setupManagerEventHandlers();

    return new Promise((resolve, reject) => {
        if (!cookies || cookies.length === 0) {
            const errMsg = `[${timestamp}] LOG_ERROR: Attempted to set empty cookies on TradeOfferManager.`;
            console.error(errMsg);
            return reject(new Error("Empty cookies provided to TradeOfferManager."));
        }

        manager.setCookies(cookies, (err) => {
            if (err) {
                console.error(`[${timestamp}] LOG_ERROR: Failed to set cookies on new TradeOfferManager:`, err);
                reject(err);
            } else {
                console.log(`[${timestamp}] LOG_SUCCESS: Cookies set on new TradeOfferManager instance.`);
                lastCookieValidation = Date.now();
                resolve();
            }
        });
    });
}

// Steam confirmations
if (process.env.STEAM_IDENTITY_SECRET) {
    community.on('confKeyNeeded', (tag, callback) => {
        const time = Math.floor(Date.now() / 1000);
        if (SteamTotp && typeof SteamTotp.generateConfirmationKey === 'function') {
            const confKey = SteamTotp.generateConfirmationKey(process.env.STEAM_IDENTITY_SECRET, time, tag);
            callback(null, time, confKey);
        } else {
            console.error("FATAL: SteamTotp.generateConfirmationKey is not available");
            callback(new Error("Confirmation key generation failed"), null, null);
        }
    });
}

let isBotReady = false;
const pendingDeposits = new Map();

// --- FIXED: Periodic cleanup for pendingDeposits to prevent memory leaks ---
setInterval(() => {
    const now = Date.now();
    const timeout = 15 * 60 * 1000; // 15 minutes

    for (const [depositId, deposit] of pendingDeposits.entries()) {
        if (now - deposit.timestamp > timeout) {
            console.log(`Cleaning up stale pending deposit ${depositId}`);
            pendingDeposits.delete(depositId);
        }
    }
}, 5 * 60 * 1000); // Run every 5 minutes

function generateAuthCode() {
    const secret = process.env.STEAM_SHARED_SECRET;
    if (!secret) {
        console.error("STEAM_SHARED_SECRET missing. Cannot generate 2FA code.");
        return null;
    }
    try {
        const code = SteamTotp.generateAuthCode(secret);
        console.log("LOG_DEBUG: Generated 2FA code:", code);
        return code;
    } catch (e) {
        console.error("Error generating 2FA code:", e);
        return null;
    }
}

let isLoginInProgress = false;
const LOGIN_RETRY_COOLDOWN = 60 * 1000;
let lastLoginAttemptTimestamp = 0;

// --- FIXED: Bot login with proper locking ---
async function executeBotLogin() {
    if (isLoginInProgress) {
        console.log("LOG_INFO: Bot login attempt already in progress. Skipping.");
        return Promise.reject(new Error("Login already in progress."));
    }

    const now = Date.now();
    if (now - lastLoginAttemptTimestamp < LOGIN_RETRY_COOLDOWN) {
        console.log(`LOG_INFO: Bot login attempt was made recently. Waiting for cooldown.`);
        return Promise.reject(new Error("Login attempt cooldown active."));
    }

    isLoginInProgress = true;
    lastLoginAttemptTimestamp = now;
    isBotReady = false;

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
            twoFactorCode: generateAuthCode()
        };

        if (!loginCredentials.twoFactorCode) {
            console.warn("WARN: Could not generate 2FA code for login attempt.");
            isLoginInProgress = false;
            reject(new Error("2FA code generation failed for login."));
            return;
        }

        console.log(`LOG_INFO: Attempting Steam login for bot: ${loginCredentials.accountName}...`);

        community.login(loginCredentials, async (err, sessionID, cookies, steamguard) => {
            if (err || !community.steamID) {
                console.error('STEAM LOGIN ERROR:', {
                    message: err?.message,
                    eresult: err?.eresult,
                    steamguard,
                    steamID: community.steamID
                });

                if (err?.eresult === 5) console.warn('Login Failure Hint: Invalid Password?');
                if (err?.eresult === 65) console.warn('Login Failure Hint: Incorrect 2FA Code or Rate Limit?');
                if (err?.eresult === 63) console.warn('Login Failure Hint: Account Logon Denied - Check Email/Steam Guard?');

                isLoginInProgress = false;
                currentBotCookies = null;
                reject(err || new Error(`Login failed: community.steamID undefined.`));
                return;
            }

            console.log(`LOG_SUCCESS: Steam bot ${loginCredentials.accountName} logged in (SteamID: ${community.steamID}).`);
            currentBotCookies = cookies;
            community.setCookies(cookies);

            try {
                await createTradeOfferManager(cookies);
                isLoginInProgress = false;
                isBotReady = true;
                lastCookieValidation = Date.now();
                console.log("LOG_SUCCESS: Steam Bot is fully ready and operational.");
                resolve(true);
            } catch (managerErr) {
                isLoginInProgress = false;
                currentBotCookies = null;
                console.error('TradeOfferManager Error:', managerErr);
                reject(managerErr);
            }
        });
    });
}

// --- FIXED: Refresh bot session with lock ---
async function refreshBotSession() {
    console.log("LOG_INFO: Refreshing bot session...");
    if (!isBotConfigured) {
        isBotReady = false;
        return Promise.reject(new Error("Bot not configured, cannot refresh session."));
    }

    try {
        await ensureValidManager();
        isBotReady = true;
        return Promise.resolve();
    } catch (err) {
        console.error("LOG_ERROR: Failed to refresh bot session:", err);
        isBotReady = false;
        return Promise.reject(err);
    }
}

function startPeriodicCookieRefresh() {
    if (cookieRefreshInterval) {
        clearInterval(cookieRefreshInterval);
    }

    cookieRefreshInterval = setInterval(async () => {
        if (isBotReady && currentBotCookies) {
            try {
                console.log("LOG_INFO: Performing periodic cookie refresh...");
                await validateAndRefreshCookies();
            } catch (err) {
                console.error("LOG_ERROR: Periodic cookie refresh failed:", err);
            }
        }
    }, COOKIE_REFRESH_INTERVAL_MS);
}

function setupManagerEventHandlers() {
    if (!manager) return;

    manager.on('newOffer', async (offer) => {
        console.log(`LOG_DEBUG: manager.on('newOffer') received. Offer ID: ${offer.id}, Partner: ${offer.partner.getSteamID64()}, Our Offer: ${offer.isOurOffer}`);

        if (!isBotReady || offer.isOurOffer) {
            if (offer.isOurOffer) {
                console.log(`LOG_DEBUG: Ignoring newOffer event for our own offer #${offer.id}`);
            } else {
                console.log(`LOG_DEBUG: Ignoring newOffer event #${offer.id} because bot not ready.`);
            }
            return;
        }

        // Decline unsolicited offers
        if (offer.itemsToReceive.length > 0 && offer.itemsToGive.length === 0) {
            console.log(`LOG_WARN: Received unsolicited item offer #${offer.id} from ${offer.partner.getSteamID64()}. Declining.`);
            offer.decline((err) => {
                if (err) console.error(`LOG_ERROR: Error declining unsolicited offer ${offer.id}:`, err);
            });
            return;
        }

        console.log(`LOG_INFO: Ignoring other unexpected incoming offer #${offer.id} from ${offer.partner.getSteamID64()}.`);
        offer.decline(err => {
            if(err) console.error(`Error declining unexpected offer ${offer.id}:`, err);
        });
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        console.log(`LOG_INFO: Bot's sentOffer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()})`);

        const depositIdMatch = offer.message.match(/DepositID: ([a-f0-9-]+)/i);
        const depositIdFromMessage = depositIdMatch ? depositIdMatch[1] : null;
        let depositData = null;

        if (depositIdFromMessage && pendingDeposits.has(depositIdFromMessage)) {
            depositData = pendingDeposits.get(depositIdFromMessage);
            if (depositData.offerIdAttempted && depositData.offerIdAttempted !== offer.id) {
                console.warn(`WARN: Offer ID mismatch for DepositID ${depositIdFromMessage}.`);
            } else if (!depositData.offerIdAttempted) {
                depositData.offerIdAttempted = offer.id;
            }
        }

        // --- Handle DEPOSIT offers ---
        if (depositData && offer.id === depositData.offerIdAttempted) {
            console.log(`LOG_DEBUG: Offer #${offer.id} matched pending deposit ${depositIdFromMessage}.`);

            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                pendingDeposits.delete(depositIdFromMessage);
                console.log(`LOG_SUCCESS: Processing accepted deposit offer #${offer.id} for user ${depositData.steamId}`);

                // Clear the user's pending flag
                User.updateOne(
                    { _id: depositData.userId, pendingDepositOfferId: offer.id },
                    { $set: { pendingDepositOfferId: null }}
                ).catch(e => console.error("DB_ERROR: Error clearing user pending flag:", e));

                try {
                    // Use MongoDB transaction for atomic operations
                    const session = await mongoose.startSession();
                    await session.withTransaction(async () => {
                        // Fetch fresh round data
                        const roundForDeposit = await Round.findById(depositData.roundId)
                            .select('status participants items totalValue roundId')
                            .session(session);

                        if (!roundForDeposit || roundForDeposit.status !== 'active' || isRolling) {
                            console.warn(`WARN: Deposit ${depositIdFromMessage} accepted, but round invalid/rolling.`);
                            io.to(depositData.userId.toString()).emit('notification', {
                                type: 'error',
                                message: `Deposit Error: Round ended before processing. Contact support.`
                            });
                            return;
                        }

                        // Check limits
                        const isNewP = !roundForDeposit.participants.some(p => p.user?.toString() === depositData.userId.toString());
                        if (isNewP && roundForDeposit.participants.length >= MAX_PARTICIPANTS) {
                            console.warn(`WARN: Deposit ${depositIdFromMessage} accepted, but participant limit reached.`);
                            io.to(depositData.userId.toString()).emit('notification', {
                                type: 'error',
                                message: `Deposit Error: Participant limit reached. Contact support.`
                            });
                            return;
                        }

                        if (roundForDeposit.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                            console.warn(`WARN: Deposit ${depositIdFromMessage} accepted, but pot item limit reached.`);
                            io.to(depositData.userId.toString()).emit('notification', {
                                type: 'error',
                                message: `Deposit Error: Pot item limit reached. Contact support.`
                            });
                            return;
                        }

                        // Create Item documents
                        const itemModelsToSave = depositData.items.map(itemDetail => new Item({
                            assetId: itemDetail.assetid,
                            name: itemDetail._name,
                            image: itemDetail._image,
                            price: itemDetail._price,
                            owner: depositData.userId,
                            roundId: depositData.roundId
                        }));

                        const createdItemDocuments = await Item.insertMany(itemModelsToSave, {
                            ordered: false,
                            session
                        });

                        const createdItemIds = createdItemDocuments.map(doc => doc._id);
                        console.log(`LOG_INFO: Deposit ${depositIdFromMessage}: Inserted ${createdItemIds.length} items into DB.`);

                        // Update user's total deposited value
                        await User.findByIdAndUpdate(
                            depositData.userId,
                            { $inc: { totalDepositedValue: depositData.totalValue } },
                            { session }
                        );

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
                                    participants: {
                                        user: depositData.userId,
                                        itemsValue: depositData.totalValue,
                                        tickets: depositTickets
                                    },
                                    items: { $each: createdItemIds }
                                },
                                $inc: { totalValue: depositData.totalValue }
                            };
                        }

                        const arrayFilters = participantExists ? [{ 'elem.user': depositData.userId }] : [];
                        const updatedRound = await Round.findByIdAndUpdate(
                            depositData.roundId,
                            participantUpdateQuery,
                            {
                                new: true,
                                arrayFilters: arrayFilters.length > 0 ? arrayFilters : undefined,
                                session
                            }
                        ).populate('participants.user', 'steamId username avatar').lean();

                        if (!updatedRound) throw new Error('Failed to update round data after deposit.');

                        currentRound = updatedRound;

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
                                depositedItems: depositData.items.map(i => ({
                                    assetId: i.assetid,
                                    name: i._name,
                                    image: i._image,
                                    price: i._price
                                }))
                            });
                            console.log(`LOG_INFO: Emitted 'participantUpdated' for user ${finalParticipantData.user.username}`);
                        }

                        // Start timer if this is the first participant
                        if (updatedRound.participants.length === 1 && !roundTimer && updatedRound.status === 'active') {
                            startRoundTimer();
                        }

                        console.log(`LOG_SUCCESS: Deposit processed for offer #${offer.id}. User: ${finalParticipantData?.user?.username}`);
                    });

                    await session.endSession();

                } catch (dbErr) {
                    console.error(`CRITICAL_DB_ERROR processing accepted deposit ${offer.id}:`, dbErr);
                    io.to(depositData.userId.toString()).emit('notification', {
                        type: 'error',
                        message: `CRITICAL Deposit Error. Contact support.`
                    });
                }

            } else if ([
                TradeOfferManager.ETradeOfferState.Declined,
                TradeOfferManager.ETradeOfferState.Canceled,
                TradeOfferManager.ETradeOfferState.Expired,
                TradeOfferManager.ETradeOfferState.InvalidItems
            ].includes(offer.state)) {
                pendingDeposits.delete(depositIdFromMessage);
                console.warn(`WARN: Deposit offer ${offer.id} was ${TradeOfferManager.ETradeOfferState[offer.state]}.`);

                User.updateOne(
                    { _id: depositData.userId, pendingDepositOfferId: offer.id },
                    { $set: {pendingDepositOfferId: null }}
                ).catch(e => console.error("DB_ERROR: Error clearing user pending flag:", e));

                const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                io.to(depositData.userId.toString()).emit('notification', {
                    type: 'error',
                    message: `Your deposit offer (#${offer.id}) was ${stateMessage}.`
                });
            } else {
                console.log(`LOG_DEBUG: Deposit Offer #${offer.id} changed to state: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
            }
        }
        // --- Handle PAYOUT offers ---
        else {
            let payoutStatusUpdate = 'Unknown';
            switch (offer.state) {
                case TradeOfferManager.ETradeOfferState.Accepted:
                    payoutStatusUpdate = 'Accepted';
                    break;
                case TradeOfferManager.ETradeOfferState.Declined:
                    payoutStatusUpdate = 'Declined';
                    break;
                case TradeOfferManager.ETradeOfferState.Canceled:
                    payoutStatusUpdate = 'Canceled';
                    break;
                case TradeOfferManager.ETradeOfferState.Expired:
                    payoutStatusUpdate = 'Expired';
                    break;
                case TradeOfferManager.ETradeOfferState.InvalidItems:
                    payoutStatusUpdate = 'InvalidItems';
                    break;
                case TradeOfferManager.ETradeOfferState.InEscrow:
                    payoutStatusUpdate = 'Escrow';
                    break;
                case TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation:
                case TradeOfferManager.ETradeOfferState.PendingConfirmation:
                    payoutStatusUpdate = 'Pending Confirmation';
                    break;
                default:
                    payoutStatusUpdate = TradeOfferManager.ETradeOfferState[offer.state] || 'Unknown';
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
                    console.log(`LOG_INFO: Updated payoutOfferStatus to ${payoutStatusUpdate} for round ${updatedRound.roundId}`);

                    let notifType = 'info';
                    let notifMessage = `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) status: ${payoutStatusUpdate}.`;

                    if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                        notifType = 'success';
                        notifMessage = `Winnings from offer #${offer.id} (Round #${updatedRound.roundId}) successfully accepted!`;
                    } else if ([
                        TradeOfferManager.ETradeOfferState.Declined,
                        TradeOfferManager.ETradeOfferState.Canceled,
                        TradeOfferManager.ETradeOfferState.Expired
                    ].includes(offer.state)) {
                        notifType = 'error';
                        notifMessage = `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) was ${payoutStatusUpdate}. Contact support.`;

                        if (offer.state === TradeOfferManager.ETradeOfferState.Expired ||
                            offer.state === TradeOfferManager.ETradeOfferState.Canceled) {
                            await Round.updateOne(
                                { _id: updatedRound._id },
                                { $set: { payoutOfferStatus: 'PendingAcceptanceByWinner', payoutOfferId: null }}
                            );
                            notifMessage += " You can try accepting again.";
                        }
                    } else if (offer.state === TradeOfferManager.ETradeOfferState.InEscrow) {
                        notifType = 'warning';
                    }

                    io.to(winnerUserIdStr).emit('notification', { type: notifType, message: notifMessage });
                } else if (!updatedRound) {
                    console.warn(`WARN: Could not find round associated with payout offer #${offer.id}`);
                }
            } catch (dbError) {
                console.error(`DB_ERROR: Error updating payout status for offer #${offer.id}:`, dbError);
            }
        }
    });
}

// Bot initialization
if (isBotConfigured) {
    console.log("LOG_INFO: Bot is configured. Attempting initial login.");
    executeBotLogin()
        .then(() => {
            console.log("LOG_SUCCESS: Initial bot login successful.");

            // Auto-accept friend requests
            community.on('friendRelationship', (steamID, relationship) => {
                if (relationship === SteamCommunity.EFriendRelationship.RequestRecipient) {
                    console.log(`LOG_INFO: Received friend request from ${steamID}. Accepting...`);
                    community.addFriend(steamID, (friendErr) => {
                        if (friendErr) {
                            console.error(`LOG_ERROR: Error accepting friend request from ${steamID}:`, friendErr);
                        } else {
                            console.log(`LOG_SUCCESS: Accepted friend request from ${steamID}.`);
                        }
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

// --- Price Cache ---
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
                if(success) {
                    console.log(`PRICE_SUCCESS: Refreshed price cache with ${updatedCount} items.`);
                } else {
                    console.error("PRICE_ERROR: Failed to bulk set price cache.");
                }
            } else {
                console.warn("PRICE_WARN: No valid items found in the response.");
            }
        } else {
            console.error("PRICE_ERROR: Invalid response received from rust.scmm.app");
        }
    } catch (error) {
        console.error(`PRICE_ERROR: Failed to fetch prices from ${apiUrl}.`);
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            console.error(` -> Error: Request timed out after ${PRICE_FETCH_TIMEOUT_MS}ms.`);
        } else if (error.response) {
            console.error(` -> Status: ${error.response.status}`);
        } else if (error.request) {
            console.error(` -> Error: No response received (Network issue?).`);
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

// --- Core Game Logic ---
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
                    .lean();

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
        console.log("LOG_INFO: Bot configured but not ready, skipping initial round check.");
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
            .catch(e => console.error(`DB_ERROR: Error saving round end time:`, e));

        console.log(`LOG_INFO: Starting timer for round ${currentRound.roundId} (${ROUND_DURATION}s).`);
    }

    io.emit('timerUpdate', { timeLeft });

    roundTimer = setInterval(async () => {
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) {
            clearInterval(roundTimer);
            roundTimer = null;
            console.warn("WARN: Timer stopped: Round state became invalid during countdown.");
            return;
        }

        const now = Date.now();
        let currenttimeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - now) / 1000));

        io.emit('timerUpdate', { timeLeft: currenttimeLeft });

        if (currenttimeLeft <= 0) {
            clearInterval(roundTimer);
            roundTimer = null;
            console.log(`LOG_INFO: Round ${currentRound.roundId} timer reached zero.`);
            await endRound();
        }
    }, 1000);
}

async function endRound() {
    if (!currentRound || isRolling || currentRound.status !== 'active') {
        console.warn(`WARN: Attempted to end round ${currentRound?.roundId}, but state is invalid`);
        return;
    }

    isRolling = true;
    const roundIdToEnd = currentRound.roundId;
    const roundMongoId = currentRound._id;

    console.log(`LOG_INFO: --- Ending round ${roundIdToEnd}... ---`);

    const session = await mongoose.startSession();

    try {
        await session.withTransaction(async () => {
            // Update round status to 'rolling' in DB
            await Round.updateOne(
                { _id: roundMongoId },
                { $set: { status: 'rolling', endTime: new Date() } },
                { session }
            );

            io.emit('roundRolling', { roundId: roundIdToEnd });

            // Fetch the full round data for processing
            const round = await Round.findById(roundMongoId)
                .populate('participants.user', 'steamId username avatar tradeUrl')
                .populate('items')
                .session(session)
                .lean();

            if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);
            if (round.status !== 'rolling') {
                console.warn(`WARN: Round ${roundIdToEnd} status changed unexpectedly.`);
                isRolling = false;
                return;
            }

            currentRound = round;

            // Handle rounds with no participants or no value
            if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
                console.log(`LOG_INFO: Round ${round.roundId} ended with no valid participants or value.`);
                await Round.updateOne(
                    { _id: roundMongoId },
                    { $set: { status: 'completed', completedTime: new Date() } },
                    { session }
                );
                io.emit('roundCompleted', { roundId: round.roundId, message: "No participants or value." });
                isRolling = false;
                setTimeout(createNewRound, 5000);
                return;
            }

            // --- Tax Calculation ---
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
                        taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price });
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
                    console.log(`LOG_INFO: Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)}`);
                }
            }

            // --- Winner Selection (Provably Fair) ---
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

            // Update winner's stats
            await User.findByIdAndUpdate(
                winnerInfo._id,
                { $inc: { totalWinningsValue: valueForWinner } },
                { session }
            );

            console.log(`LOG_INFO: Updated winnings stats for ${winnerInfo.username}: added $${valueForWinner.toFixed(2)}`);

            // Finalize round data
            const finalUpdateData = {
                status: 'completed_pending_acceptance',
                completedTime: new Date(),
                clientSeed: clientSeed,
                provableHash: provableHash,
                winningTicket: winningTicket,
                winner: winnerInfo._id,
                taxAmount: taxAmount,
                taxedItems: taxedItemsInfo,
                totalValue: valueForWinner,
                items: finalItems.map(i => i._id),
                payoutOfferStatus: 'PendingAcceptanceByWinner'
            };

            const completedRound = await Round.findOneAndUpdate(
                { _id: roundMongoId },
                { $set: finalUpdateData },
                { new: true, session }
            );

            if (!completedRound) throw new Error("Failed to save completed round data.");

            console.log(`LOG_SUCCESS: Round ${round.roundId} completed. Winner: ${winnerInfo.username}`);

            // Emit event to clients
            io.emit('roundWinnerPendingAcceptance', {
                roundId: round.roundId,
                winner: {
                    id: winnerInfo._id,
                    steamId: winnerInfo.steamId,
                    username: winnerInfo.username,
                    avatar: winnerInfo.avatar
                },
                winningTicket: winningTicket,
                totalValue: valueForWinner,
                totalTickets: totalTickets,
                serverSeed: round.serverSeed,
                clientSeed: clientSeed,
                provableHash: provableHash,
                serverSeedHash: round.serverSeedHash
            });
        });

        await session.endSession();

    } catch (err) {
        console.error(`CRITICAL_ERROR: Error during endRound for round ${roundIdToEnd}:`, err);
        await session.endSession();

        await Round.updateOne(
            { _id: roundMongoId },
            { $set: { status: 'error', payoutOfferStatus: 'Failed' }}
        ).catch(e => console.error("DB_ERROR: Error marking round as error:", e));

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
            console.warn(`LOG_WARN: Cannot check offer status for ${offerId}: Bot not ready`);
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

// --- FIXED: Unified Trade URL parsing function ---
function parseTradeURL(tradeUrl) {
    try {
        // Clean up common issues first
        let cleanUrl = tradeUrl.trim()
            .replace(/&amp;/g, '&') // Fix HTML entities
            .replace(/^http:/i, 'https:') // Force HTTPS
            .replace(/\/$/, ''); // Remove trailing slash

        // More flexible regex that handles variations
        const regex = /^https?:\/\/(www\.)?steamcommunity\.com\/tradeoffer\/new\/\?partner=(\d+)(&|&amp;)token=([a-zA-Z0-9_-]+)$/i;
        const match = cleanUrl.match(regex);

        if (!match) {
            return { valid: false, error: 'Invalid trade URL format' };
        }

        const [, , partnerId, , token] = match;

        // Validate partner ID is a reasonable number
        const partnerIdNum = parseInt(partnerId);
        if (isNaN(partnerIdNum) || partnerIdNum <= 0 || partnerIdNum > 4294967295) {
            return { valid: false, error: 'Invalid partner ID' };
        }

        // Convert partner ID to SteamID64
        const steamId = new SteamID();
        steamId.universe = SteamID.Universe.PUBLIC;
        steamId.type = SteamID.Type.INDIVIDUAL;
        steamId.instance = SteamID.Instance.DESKTOP;
        steamId.accountid = partnerIdNum;

        return {
            valid: true,
            partnerId: partnerId,
            token: token,
            steamId64: steamId.getSteamID64(),
            steamIdObject: steamId,
            cleanUrl: cleanUrl
        };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

// --- FIXED: Enhanced sendWinningTradeOffer with better error handling and simplified logic ---
async function sendWinningTradeOffer(roundDoc, winner, itemsToSend, retryAttempt = 0) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ========== STARTING WINNING TRADE OFFER ==========`);
    console.log(`[${timestamp}] Round: ${roundDoc.roundId}, Winner: ${winner?.username}`);
    console.log(`[${timestamp}] Trade URL: ${winner?.tradeUrl}`);
    console.log(`[${timestamp}] Items to send: ${itemsToSend?.length || 0}`);

    // Validate inputs
    if (!roundDoc || !winner || !itemsToSend) {
        console.error(`[${timestamp}] PAYOUT_ERROR: Missing required parameters`);
        if (roundDoc && roundDoc._id) {
            await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - System Error' } });
        }
        return;
    }

    // Check trade URL exists
    if (!winner.tradeUrl) {
        console.error(`[${timestamp}] PAYOUT_ERROR: Winner ${winner.username} has no trade URL`);
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - No Trade URL' } });
        if (io && winner._id) {
            io.to(winner._id.toString()).emit('notification', {
                type: 'error',
                message: 'Please set your Steam Trade URL in your profile to receive winnings.'
            });
        }
        return;
    }

    // Parse and validate trade URL
    const parsed = parseTradeURL(winner.tradeUrl);
    console.log(`[${timestamp}] Trade URL parse result:`, parsed);

    if (!parsed.valid) {
        console.error(`[${timestamp}] PAYOUT_ERROR: ${parsed.error}. URL: "${winner.tradeUrl}"`);
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
        console.log(`[${timestamp}] PAYOUT_INFO: No items to send (all consumed by tax or empty pot).`);
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'No Items Won' } });
        if (io && winner._id) {
            io.to(winner._id.toString()).emit('notification', {
                type: 'info',
                message: `Congratulations on winning round #${roundDoc.roundId}! No items were sent as the pot was consumed by fees.`
            });
        }
        return;
    }

    // Ensure bot is ready with lock
    try {
        await ensureValidManager();
        console.log(`[${timestamp}] Bot session validated for round ${roundDoc.roundId}.`);

        if (!manager) {
            throw new Error("TradeOfferManager is null after session validation.");
        }
    } catch (sessionError) {
        console.error(`[${timestamp}] PAYOUT_ERROR: Bot session error:`, sessionError.message);

        if (retryAttempt < MAX_TRADE_RETRY_ATTEMPTS) {
            console.log(`[${timestamp}] Retrying payout (attempt ${retryAttempt + 2})...`);
            await new Promise(resolve => setTimeout(resolve, 5000 * (retryAttempt + 1)));
            return sendWinningTradeOffer(roundDoc, winner, itemsToSend, retryAttempt + 1);
        }

        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Bot Session Issue' } });
        if (io && winner._id) {
            io.to(winner._id.toString()).emit('notification', {
                type: 'error',
                message: 'Bot service is temporarily unavailable. Please try again or contact support.'
            });
        }
        return;
    }

    // Create offer using parsed trade URL
    let offer = null;

    try {
        // --- OLD METHOD ---
        // console.log(`[${timestamp}] Creating offer using SteamID: ${parsed.steamId64}`);
        // Use the SteamID object directly
        // offer = manager.createOffer(parsed.steamIdObject);
        // offer.setToken(parsed.token);

        // --- NEW METHOD ---
        // Use the full, cleaned trade URL directly
        console.log(`[${timestamp}] Creating offer using full trade URL: ${parsed.cleanUrl}`);
        offer = manager.createOffer(parsed.cleanUrl);
        // We are assuming manager.createOffer(parsed.cleanUrl) will correctly use the token from the URL for the recipient.
        // If this doesn't work, one could try re-adding offer.setToken(parsed.token) here,
        // but the primary test is to see if createOffer(fullUrl) works on its own.


        if (!offer || typeof offer.addMyItems !== 'function') {
            throw new Error("Invalid offer object created or library did not correctly parse URL for sending.");
        }

        console.log(`[${timestamp}] ✓ Offer object created successfully using full trade URL`);

    } catch (error) {
        console.error(`[${timestamp}] CRITICAL: Offer creation failed:`, error.message);

        if (retryAttempt < MAX_TRADE_RETRY_ATTEMPTS) {
            console.log(`[${timestamp}] Retrying payout (attempt ${retryAttempt + 2})...`);
            await new Promise(resolve => setTimeout(resolve, 6000 * (retryAttempt + 1)));
            return sendWinningTradeOffer(roundDoc, winner, itemsToSend, retryAttempt + 1);
        }

        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Offer Creation Error' } });
        if (io && winner._id) {
            io.to(winner._id.toString()).emit('notification', {
                type: 'error',
                message: 'Could not create trade offer. Please verify your trade URL and try again.'
            });
        }
        return;
    }

    // Add items and send offer
    try {
        console.log(`[${timestamp}] Adding items and sending offer...`);

        const itemsForOffer = itemsToSend.map(item => ({
            assetid: String(item.assetId || item.id),
            appid: RUST_APP_ID,
            contextid: String(RUST_CONTEXT_ID)
        }));

        console.log(`[${timestamp}] Items being added:`, itemsForOffer.map(i => i.assetid));

        // Add items to the offer
        offer.addMyItems(itemsForOffer);

        if (!offer.itemsToGive || offer.itemsToGive.length !== itemsForOffer.length) {
            console.error(`[${timestamp}] PAYOUT_ERROR: Bot failed to add all items. Expected ${itemsForOffer.length}, got ${offer.itemsToGive?.length || 0}`);
            await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Bot Inventory Issue' } });
            if (io && winner._id) {
                io.to(winner._id.toString()).emit('notification', {
                    type: 'error',
                    message: `Critical error: Bot could not find all items. Contact support.`
                });
            }
            return;
        }

        console.log(`[${timestamp}] Successfully added ${offer.itemsToGive.length} items to offer`);

        const offerMessage = `🎉 Round #${roundDoc.roundId} Winnings - ${process.env.SITE_NAME || 'YourSite'} - Value: $${roundDoc.totalValue.toFixed(2)} 🎉 Congratulations!`;
        offer.setMessage(offerMessage);

        console.log(`[${timestamp}] Sending offer...`);

        const sendResponse = await new Promise((resolve, reject) => {
            offer.send((err, status) => {
                const callbackTimestamp = new Date().toISOString();
                if (err) {
                    console.error(`[${callbackTimestamp}] PAYOUT_SEND_ERROR:`, err);
                    if (offer.id) err.offerId = offer.id;
                    return reject(err);
                }
                console.log(`[${callbackTimestamp}] PAYOUT_SEND_SUCCESS: Status: ${status}, Offer ID: ${offer.id}`);
                resolve({ status, offerId: offer.id, offerState: offer.state });
            });
        });

        const { status: steamStatus, offerId: actualOfferId, offerState } = sendResponse;
        const offerURL = `https://steamcommunity.com/tradeoffer/${actualOfferId}/`;
        let initialPayoutStatus = 'Sent';

        if (offerState === TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation ||
            offerState === TradeOfferManager.ETradeOfferState.PendingConfirmation ||
            (steamStatus === 'pending' && process.env.STEAM_IDENTITY_SECRET)) {
            initialPayoutStatus = 'Pending Confirmation';
        } else if (offerState === TradeOfferManager.ETradeOfferState.InEscrow) {
            initialPayoutStatus = 'Escrow';
        }

        await Round.updateOne(
            { _id: roundDoc._id },
            { $set: { payoutOfferId: actualOfferId, payoutOfferStatus: initialPayoutStatus } }
        );

        console.log(`[${timestamp}] PAYOUT_DB_UPDATE: Offer ${actualOfferId} saved with status: ${initialPayoutStatus}`);

        if (io && winner._id) {
            io.to(winner._id.toString()).emit('tradeOfferSent', {
                roundId: roundDoc.roundId,
                userId: winner._id.toString(),
                offerId: actualOfferId,
                offerURL,
                status: initialPayoutStatus,
                type: 'winning'
            });

            let notifMessage = `Winnings offer #${actualOfferId} has been sent! Click to view: ${offerURL}`;
            if (initialPayoutStatus === 'Pending Confirmation') {
                notifMessage = `Winnings offer #${actualOfferId} needs confirmation. Please check Steam.`;
            } else if (initialPayoutStatus === 'Escrow') {
                notifMessage = `Winnings offer #${actualOfferId} is in Steam escrow. Please check your trades.`;
            }

            io.to(winner._id.toString()).emit('notification', {
                type: initialPayoutStatus === 'Sent' ? 'success' : 'info',
                message: notifMessage
            });
        }

        console.log(`[${timestamp}] ========== WINNING TRADE OFFER COMPLETED ==========`);

    } catch (sendProcessError) {
        const errorTimestamp = new Date().toISOString();
        console.error(`[${errorTimestamp}] PAYOUT_PROCESS_ERROR:`, sendProcessError.message);

        let offerStatusUpdate = 'Failed - Send Error';
        let userMessage = `Error sending winnings for round ${roundDoc.roundId}.`;
        let shouldRetrySend = false;

        if (sendProcessError.eresult) {
            userMessage += ` (Code: ${sendProcessError.eresult})`;
            switch (sendProcessError.eresult) {
                case 26:
                    offerStatusUpdate = 'Failed - Invalid Trade URL';
                    userMessage = 'Your Steam Trade URL is invalid or expired. Please update it.';
                    break;
                case 15:
                    offerStatusUpdate = 'Failed - Inventory Private';
                    userMessage = 'Could not send winnings. Please ensure your Steam inventory is public.';
                    break;
                case 16:
                    offerStatusUpdate = 'Failed - Trade Banned';
                    userMessage = 'You appear to be trade banned. Contact Steam support.';
                    break;
                case 11:
                    offerStatusUpdate = 'Failed - Bot Session Issue';
                    userMessage = 'Bot session error. Please try again.';
                    shouldRetrySend = true;
                    break;
                case 25:
                    offerStatusUpdate = 'Failed - Rate Limited';
                    userMessage = 'Too many trade offers. Please try again later.';
                    shouldRetrySend = true;
                    break;
                default:
                    shouldRetrySend = true;
            }
        }

        if (shouldRetrySend && retryAttempt < MAX_TRADE_RETRY_ATTEMPTS) {
            console.log(`[${errorTimestamp}] Retrying payout (attempt ${retryAttempt + 2})...`);
            if (sendProcessError.eresult === 11) {
                await validateAndRefreshCookies();
            }
            await new Promise(resolve => setTimeout(resolve, 7000 * (retryAttempt + 1)));
            return sendWinningTradeOffer(roundDoc, winner, itemsToSend, retryAttempt + 1);
        }

        const offerIdWithError = sendProcessError.offerId || offer?.id || null;
        await Round.updateOne(
            { _id: roundDoc._id },
            { $set: { payoutOfferId: offerIdWithError, payoutOfferStatus: offerStatusUpdate } }
        );

        if (io && winner._id) {
            io.to(winner._id.toString()).emit('notification', { type: 'error', message: userMessage });
        }

        console.log(`[${errorTimestamp}] ========== WINNING TRADE OFFER FAILED - Status: ${offerStatusUpdate} ==========`);
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
            if (value === '') return true; // Allow empty string to clear URL
            // Use the more flexible regex
            const flexibleRegex = /^https?:\/\/(www\.)?steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+(&|&amp;)token=[a-zA-Z0-9_-]+$/i;
            if (!flexibleRegex.test(value)) {
                throw new Error('Invalid Steam Trade URL format. Ensure it includes partner and token parameters.');
            }
            return true;
        })
    ],
    handleValidationErrors,
    async (req, res) => {
        const { tradeUrl } = req.body;

        try {
            const updatedUser = await User.findByIdAndUpdate(
                req.user._id,
                { tradeUrl: tradeUrl },
                { new: true, runValidators: true }
            );

            if (!updatedUser) return res.status(404).json({ error: 'User not found.' });

            console.log(`LOG_INFO: Trade URL updated for user: ${updatedUser.username}`);
            res.json({ success: true, tradeUrl: updatedUser.tradeUrl });
        } catch (err) {
            if (err.name === 'ValidationError') {
                console.error(`Trade URL Validation Error:`, err.message);
                const messages = Object.values(err.errors).map(e => e.message);
                return res.status(400).json({ error: messages.join(', ') || 'Invalid Trade URL.' });
            }
            console.error(`Error updating trade URL:`, err);
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

        res.json({
            success: true,
            clearedRoundId: stuckRound?.roundId,
            clearedUserOffers: clearedUsers.modifiedCount
        });
    } catch (error) {
        console.error('Error (Admin) clearing stuck round:', error);
        res.status(500).json({ error: 'Failed to clear stuck round' });
    }
});

app.get('/api/user/winning-history', ensureAuthenticated, async (req, res) => {
    try {
        const winnings = await Round.find({
            winner: req.user._id,
            status: { $in: ['completed', 'completed_pending_acceptance', 'error'] }
        })
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
        console.error(`Error fetching winning history:`, error);
        res.status(500).json({ error: 'Server error fetching winning history.' });
    }
});

app.post('/api/round/accept-winnings', ensureAuthenticated, sensitiveActionLimiter, tradeLimiter, async (req, res) => {
    console.log(`LOG_INFO: Received POST /api/round/accept-winnings for user ${req.user.username}`);

    try {
        const user = req.user;

        // Find the latest round won by the user that is pending their acceptance
        const round = await Round.findOne({
            winner: user._id,
            status: 'completed_pending_acceptance',
            payoutOfferStatus: 'PendingAcceptanceByWinner'
        })
            .sort({ completedTime: -1 })
            .populate('winner', 'steamId username avatar tradeUrl')
            .populate('items');

        if (!round) {
            console.warn(`LOG_WARN: No winnings pending acceptance found for user ${user.username}`);
            return res.status(404).json({ error: 'No winnings pending your acceptance found.' });
        }

        console.log(`LOG_INFO: Found round ${round.roundId} for user ${user.username} to accept winnings.`);

        if (!round.winner || !round.winner.tradeUrl) {
            console.warn(`LOG_WARN: User ${user.username} has no trade URL for round ${round.roundId}.`);
            await Round.updateOne({ _id: round._id }, { $set: { payoutOfferStatus: 'Failed - No Trade URL' } });
            return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile to accept winnings.' });
        }

        // Pre-validate trade URL
        const parsed = parseTradeURL(round.winner.tradeUrl);
        if (!parsed.valid) {
            console.error(`LOG_ERROR: Invalid trade URL format: "${round.winner.tradeUrl}"`);
            await Round.updateOne({ _id: round._id }, { $set: { payoutOfferStatus: 'Failed - Invalid Trade URL Format' } });
            return res.status(400).json({ error: 'Your Steam Trade URL format is invalid. Please update it.' });
        }

        console.log(`LOG_INFO: Calling sendWinningTradeOffer for round ${round.roundId}`);

        // Call sendWinningTradeOffer asynchronously
        sendWinningTradeOffer(round, round.winner, round.items)
            .catch(error => {
                console.error('Error in background sendWinningTradeOffer:', error);
            });

        // Immediately respond to user
        res.json({
            success: true,
            message: 'Winnings accepted. Trade offer processing initiated. Watch for Steam notifications.'
        });

    } catch (error) {
        console.error('CRITICAL_ERROR: Error in /api/round/accept-winnings:', error);
        res.status(500).json({ error: 'Server error while accepting winnings. Please try again or contact support.' });
    }
});

app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    if (!isBotConfigured) return res.status(503).json({ error: "Trading service is currently offline." });
    if (!isBotReady) {
        console.warn(`Inventory fetch failed for ${req.user.username}: Bot service is unavailable`);
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
                    console.error(`Inventory Fetch Error: User ${req.user.steamId}:`, err);
                    return reject(new Error(`Could not fetch inventory. Steam might be busy.`));
                }
                resolve(inv || []);
            });
        });

        if (!inventory?.length) return res.json([]);

        const validItems = inventory.map(item => {
            const itemName = item.market_hash_name;
            let price = 0;
            if (itemName) {
                price = getItemPrice(itemName);
            } else {
                console.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`);
            }

            const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

            if (!item.assetid || !item.icon_url || !itemName) {
                console.warn(`Inventory item missing required properties`);
                return null;
            }

            const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`;
            return {
                assetId: item.assetid,
                name: itemName,
                image: imageUrl,
                price: finalPrice,
                tradable: item.tradable
            };
        })
            .filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE);

        res.json(validItems);
    } catch (err) {
        console.error(`Error in /api/inventory for ${req.user?.username}:`, err.message);
        const clientErrorMessage = err.message === 'Your Steam inventory is private. Please set it to public.'
            ? err.message
            : 'Server error fetching inventory.';
        res.status(err.message.includes('private') ? 403 : 500).json({ error: clientErrorMessage });
    }
});

app.post('/api/deposit', depositLimiter, ensureAuthenticated,
    [
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT })
            .withMessage(`You can deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.')
    ],
    handleValidationErrors,
    async (req, res) => {
        const user = req.user;
        const requestedAssetIds = req.body.assetIds;

        if (!isBotConfigured) return res.status(503).json({ error: "Trading service is currently offline." });
        if (!isBotReady) {
            console.warn(`Deposit attempt by ${user.username} while bot not ready.`);
            return res.status(503).json({ error: "Deposit service temporarily unavailable." });
        }
        if (!user.tradeUrl || !TRADE_URL_REGEX.test(user.tradeUrl)) {
            return res.status(400).json({ error: 'Valid Steam Trade URL required in profile for deposits.' });
        }

        // Check for existing pending deposit offer
        if (user.pendingDepositOfferId) {
            try {
                const offerStatus = await checkOfferStatus(user.pendingDepositOfferId);

                if (offerStatus && [
                    TradeOfferManager.ETradeOfferState.Active,
                    TradeOfferManager.ETradeOfferState.Sent,
                    TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation
                ].includes(offerStatus.state)) {
                    console.log(`User ${user.username} already has pending deposit offer ${user.pendingDepositOfferId}`);
                    const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                    return res.status(409).json({
                        error: 'You have an active deposit offer pending. Please accept or decline it on Steam first.',
                        offerId: user.pendingDepositOfferId,
                        offerURL
                    });
                } else {
                    console.log(`Clearing stale pending offer ${user.pendingDepositOfferId} for user ${user.username}`);
                    await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
                }
            } catch (offerFetchError) {
                console.warn(`Error checking pending offer ${user.pendingDepositOfferId}:`, offerFetchError.message);
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
            }
        }

        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }

        // Verify round limits
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
                return res.status(400).json({ error: `Depositing these items would exceed the pot limit. ${slotsLeft} slots left.` });
            }
        } catch (dbErr) {
            console.error(`Error fetching round data during deposit:`, dbErr);
            return res.status(500).json({ error: 'Internal server error checking round limits.' });
        }

        let itemsToRequestDetails = [];
        let depositTotalValue = 0;

        try {
            console.log(`Verifying inventory for ${user.username} to confirm ${requestedAssetIds.length} deposit items...`);
            await ensureValidManager();

            const userInventory = await new Promise((resolve, reject) => {
                manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                    if (err) {
                        if (err.message?.includes('profile is private') || err.eresult === 15) {
                            return reject(new Error('Your Steam inventory is private.'));
                        }
                        console.error(`Inventory Fetch Error (Deposit):`, err);
                        return reject(new Error(`Could not fetch your inventory. Ensure it's public and tradable.`));
                    }
                    resolve(inv || []);
                });
            });

            const userInventoryMap = new Map(userInventory.map(item => [item.assetid, item]));

            for (const assetId of requestedAssetIds) {
                const inventoryItem = userInventoryMap.get(assetId);
                if (!inventoryItem) {
                    throw new Error(`Item (Asset ID ${assetId}) not found in your inventory or already in a trade.`);
                }
                if (!inventoryItem.tradable) {
                    throw new Error(`Item '${inventoryItem.market_hash_name}' is not tradable.`);
                }

                const price = getItemPrice(inventoryItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) {
                    throw new Error(`Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below the minimum deposit value of $${MIN_ITEM_VALUE.toFixed(2)}.`);
                }

                itemsToRequestDetails.push({
                    assetid: inventoryItem.assetid,
                    appid: RUST_APP_ID,
                    contextid: RUST_CONTEXT_ID,
                    _price: price,
                    _name: inventoryItem.market_hash_name,
                    _image: `https://community.akamai.steamstatic.com/economy/image/${inventoryItem.icon_url}`
                });
                depositTotalValue += price;
            }

            if (itemsToRequestDetails.length === 0) {
                throw new Error("No valid items could be verified for deposit.");
            }

            console.log(`Verified ${itemsToRequestDetails.length} items for deposit. Total Value: $${depositTotalValue.toFixed(2)}`);
        } catch (verificationError) {
            console.warn(`Deposit item verification failed for ${user.username}:`, verificationError.message);
            return res.status(400).json({ error: verificationError.message });
        }

        const depositId = uuidv4();
        const offerMessage = `Deposit for ${process.env.SITE_NAME || 'Our Site'} | Round: ${currentRound.roundId} | DepositID: ${depositId}`;
        let cleanupTimeout = null;

        try {
            const offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsToRequestDetails.map(item => ({
                assetid: item.assetid,
                appid: item.appid,
                contextid: item.contextid
            })));
            offer.setMessage(offerMessage);

            // Store pending deposit info with timestamp
            pendingDeposits.set(depositId, {
                userId: user._id,
                roundId: currentRound._id,
                items: itemsToRequestDetails,
                totalValue: depositTotalValue,
                steamId: user.steamId,
                offerIdAttempted: null,
                timestamp: Date.now() // Add timestamp for cleanup
            });

            console.log(`Stored pending deposit ${depositId} for user ${user.steamId}.`);

            // Timeout to remove from pendingDeposits if not processed
            const offerCancelTime = manager.cancelTime || 10 * 60 * 1000;
            cleanupTimeout = setTimeout(() => {
                if(pendingDeposits.has(depositId)) {
                    const pendingData = pendingDeposits.get(depositId);
                    console.log(`Deposit attempt ${depositId} expired or timed out.`);
                    pendingDeposits.delete(depositId);

                    if (pendingData.offerIdAttempted) {
                        User.updateOne(
                            { _id: user._id, pendingDepositOfferId: pendingData.offerIdAttempted },
                            { $set: { pendingDepositOfferId: null }}
                        ).catch(e => console.error("Error clearing user pending flag on deposit expiry:", e));
                    }
                }
            }, offerCancelTime + 5000);

            console.log(`Sending deposit offer to ${user.username}`);

            const status = await new Promise((resolve, reject) => {
                offer.send((err, sendStatus) => {
                    if (err) return reject(err);
                    resolve(sendStatus);
                });
            });

            const actualOfferId = offer.id;
            console.log(`Deposit offer ${actualOfferId} sent to ${user.username}. Status: ${status}.`);

            if (pendingDeposits.has(depositId)) {
                pendingDeposits.get(depositId).offerIdAttempted = actualOfferId;
            }

            try {
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: actualOfferId });
                console.log(`Set pendingDepositOfferId=${actualOfferId} for user ${user.username}.`);
            } catch (dbUpdateError) {
                console.error(`CRITICAL: Failed to set pendingDepositOfferId:`, dbUpdateError);
            }

            const offerURL = `https://steamcommunity.com/tradeoffer/${actualOfferId}/`;
            res.json({
                success: true,
                message: 'Deposit offer created! Please accept it on Steam.',
                offerId: actualOfferId,
                offerURL: offerURL
            });

        } catch (error) {
            console.error(`Error sending deposit offer for ${user.username}:`, error);
            pendingDeposits.delete(depositId);
            if (cleanupTimeout) clearTimeout(cleanupTimeout);

            User.updateOne(
                { _id: user._id, pendingDepositOfferId: offer?.id || null },
                { $set: { pendingDepositOfferId: null }}
            ).catch(e => console.error("Error clearing user flag on deposit offer send fail:", e));

            let userMessage = 'Failed to create deposit trade offer. Please try again later.';
            if (error.eresult === 26 || error.message?.toLowerCase().includes('trade url')) {
                userMessage = 'Your Steam Trade URL might be invalid or expired. Please check your profile.';
            } else if (error.eresult === 15 || error.eresult === 16) {
                userMessage = `Could not create deposit offer. Ensure you can trade and your inventory is accessible.`;
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

let connectedChatUsers = 0;
const userLastMessageTime = new Map();

io.on('connection', (socket) => {
    connectedChatUsers++;
    io.emit('updateUserCount', connectedChatUsers);

    const user = socket.request.user;
    if (user && user.username) {
        console.log(`LOG_INFO: User ${user.username} (Socket ID: ${socket.id}) connected.`);
    } else {
        console.log(`LOG_INFO: Anonymous client (Socket ID: ${socket.id}) connected.`);
    }

    socket.on('requestRoundData', async () => {
        let roundToFormat = null;
        try {
            if (currentRound?._id && ['active', 'rolling', 'pending', 'completed_pending_acceptance'].includes(currentRound.status)) {
                if ((currentRound.participants && currentRound.participants.length > 0 && typeof currentRound.participants[0]?.user === 'string') ||
                    (currentRound.winner && typeof currentRound.winner === 'string')) {
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
            if (formattedData) {
                socket.emit('roundData', formattedData);
            } else {
                socket.emit('noActiveRound');
            }
        } catch (err) {
            console.error(`Error fetching round data for socket ${socket.id}:`, err);
            socket.emit('roundError', { error: 'Failed to load round data.' });
        }
    });

    socket.on('chatMessage', (msg) => {
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
        const userObj = p.user._id ? p.user : { _id: p.user.toString() };
        return {
            user: {
                _id: userObj._id,
                steamId: userObj.steamId,
                username: userObj.username,
                avatar: userObj.avatar
            },
            itemsValue: p.itemsValue || 0,
            tickets: p.tickets || 0
        };
    }).filter(p => p !== null);

    const itemsFormatted = (round.items || []).map(i => {
        if (!i || typeof i.price !== 'number' || !i.assetId || !i.name || !i.image) {
            console.warn("formatRoundForClient: Skipping malformed item:", i);
            return null;
        }
        return {
            assetId: i.assetId,
            name: i.name,
            image: i.image,
            price: i.price,
            owner: i.owner?._id || i.owner?.toString()
        };
    }).filter(item => item !== null);

    let winnerDetails = null;
    if (round.winner && round.winner.steamId) {
        winnerDetails = {
            id: round.winner._id,
            steamId: round.winner.steamId,
            username: round.winner.username,
            avatar: round.winner.avatar
        };
    } else if (round.winner) {
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
        if (currentRound?._id && ['active', 'rolling', 'pending', 'completed_pending_acceptance'].includes(currentRound.status)) {
            if ((currentRound.participants && currentRound.participants.length > 0 && typeof currentRound.participants[0]?.user === 'string') ||
                (currentRound.winner && typeof currentRound.winner === 'string') ||
                (currentRound.items && currentRound.items.length > 0 && typeof currentRound.items[0] === 'string')) {
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

            if (roundToFormat) {
                currentRound = roundToFormat;
                if (currentRound.status === 'active' && currentRound.participants?.length > 0) {
                    if (currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        startRoundTimer(true);
                    } else if (!currentRound.endTime && !roundTimer) {
                        startRoundTimer(false);
                    }
                }
            }
        }

        const formattedData = formatRoundForClient(roundToFormat);
        if (formattedData) {
            res.json(formattedData);
        } else {
            if (isBotReady && !isRolling) {
                console.log("LOG_INFO: No current round found for API, attempting to create one.");
                const newRound = await createNewRound();
                const newFormattedData = formatRoundForClient(newRound);
                if (newFormattedData) return res.json(newFormattedData);
            }
            res.status(404).json({ error: 'No active or pending round found.' });
        }
    } catch (err) {
        console.error('Error fetching/formatting current round data:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' });
    }
});

app.get('/api/rounds',
    [
        query('page').optional().isInt({ min: 1 }).toInt().default(1),
        query('limit').optional().isInt({ min: 1, max: 50 }).toInt().default(10)
    ],
    handleValidationErrors,
    async (req, res) => {
        try {
            const { page, limit } = req.query;
            const skip = (page - 1) * limit;

            const queryFilter = { status: { $in: ['completed', 'completed_pending_acceptance', 'error'] } };

            const rounds = await Round.find(queryFilter)
                .sort('-roundId')
                .skip(skip)
                .limit(limit)
                .populate('winner', 'username avatar steamId')
                .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount taxedItems payoutOfferId payoutOfferStatus')
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
    }
);

app.post('/api/verify', sensitiveActionLimiter,
    [
        body('roundId').notEmpty().withMessage('Round ID is required.').isInt({ min: 1 }).withMessage('Round ID must be a positive integer.').toInt(),
        body('serverSeed').trim().notEmpty().withMessage('Server Seed is required.').isHexadecimal().withMessage('Server Seed must be hexadecimal.').isLength({ min: 64, max: 64 }).withMessage('Server Seed must be 64 characters.'),
        body('clientSeed').trim().notEmpty().withMessage('Client Seed is required.').isString().isLength({ min: 1, max: 128 }).withMessage('Client Seed is too long.')
    ],
    handleValidationErrors,
    async (req, res) => {
        const { roundId, serverSeed, clientSeed } = req.body;

        try {
            const round = await Round.findOne({
                roundId: roundId,
                status: { $in: ['completed', 'completed_pending_acceptance'] }
            })
                .populate('participants.user', 'username')
                .populate('winner', 'username')
                .lean();

            if (!round) {
                return res.status(404).json({ error: `Completed round #${roundId} not found or not yet verifiable.` });
            }

            // 1. Verify Server Seed Hash
            if (!round.serverSeedHash) {
                return res.json({
                    verified: false,
                    reason: 'Server Seed Hash for this round is not available.'
                });
            }

            const providedServerSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
            if (providedServerSeedHash !== round.serverSeedHash) {
                return res.json({
                    verified: false,
                    reason: 'Server Seed Hash mismatch.',
                    expectedServerSeedHash: round.serverSeedHash,
                    providedServerSeed: serverSeed,
                    calculatedHashOfProvidedSeed: providedServerSeedHash
                });
            }

            // 2. Use actual seeds for calculation
            const effectiveServerSeed = round.serverSeed || serverSeed;
            const effectiveClientSeed = round.clientSeed || clientSeed;

            // 3. Calculate Provable Hash
            const combinedString = effectiveServerSeed + effectiveClientSeed;
            const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');

            // 4. Compare Provable Hash
            if (round.provableHash && calculatedProvableHash !== round.provableHash) {
                return res.json({
                    verified: false,
                    reason: 'Calculated Provable Hash mismatch.',
                    expectedProvableHash: round.provableHash,
                    calculatedProvableHashFromInputs: calculatedProvableHash,
                    combinedStringUsed: combinedString
                });
            }

            // 5. Calculate Winning Ticket
            const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
            const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;

            if (totalTickets <= 0) {
                return res.json({
                    verified: false,
                    reason: 'Round had zero total tickets.'
                });
            }

            const calculatedWinningTicket = decimalFromHash % totalTickets;

            // 6. Compare Winning Ticket
            if (round.winningTicket !== undefined && calculatedWinningTicket !== round.winningTicket) {
                return res.json({
                    verified: false,
                    reason: 'Calculated winning ticket number does not match.',
                    calculatedWinningTicket: calculatedWinningTicket,
                    officialWinningTicket: round.winningTicket,
                    provableHashUsedForCalculation: calculatedProvableHash,
                    totalTicketsInRound: totalTickets
                });
            }

            // All checks passed
            res.json({
                verified: true,
                roundId: round.roundId,
                serverSeedUsed: effectiveServerSeed,
                serverSeedHashExpected: round.serverSeedHash,
                clientSeedUsed: effectiveClientSeed,
                combinedStringUsed: combinedString,
                finalHashCalculated: calculatedProvableHash,
                winningTicketCalculated: calculatedWinningTicket,
                officialWinningTicketRecorded: round.winningTicket,
                totalTicketsInRound: totalTickets,
                finalPotValueWon: round.totalValue,
                winnerUsername: round.winner?.username || 'N/A'
            });

        } catch (err) {
            console.error(`Error verifying round ${roundId}:`, err);
            res.status(500).json({ error: 'Server error during verification process.' });
        }
    }
);

async function startApp() {
    console.log("LOG_INFO: Performing initial price cache refresh...");
    await refreshPriceCache();

    setInterval(async () => {
        try {
            await refreshPriceCache();
        } catch (refreshErr) {
            console.error("Error during scheduled price cache refresh:", refreshErr);
        }
    }, PRICE_REFRESH_INTERVAL_MS);

    console.log(`LOG_INFO: Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);

    // Periodic cleanup for rounds stuck in 'completed_pending_acceptance'
    setInterval(async () => {
        try {
            const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
            const updateResult = await Round.updateMany(
                {
                    status: 'completed_pending_acceptance',
                    completedTime: { $lt: thirtyMinutesAgo },
                    payoutOfferStatus: {
                        $in: ['PendingAcceptanceByWinner', 'Failed - No Trade URL', 'Failed - Invalid Trade URL Format', 'Unknown', 'Failed - Offer Creation Error']
                    }
                },
                {
                    $set: {
                        status: 'completed',
                        payoutOfferStatus: 'Failed - Timeout AutoClear'
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
            console.log("WARN: Steam Bot initial login may have failed or is pending. Check logs.");
        } else {
            console.log("LOG_SUCCESS: Steam Bot is ready.");
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

    // Force shutdown if graceful fails after timeout
    setTimeout(() => {
        console.error('CRITICAL_ERROR: Could not close connections gracefully in time, forcing shutdown.');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Global unhandled error catcher for Express
app.use((err, req, res, next) => {
    console.error("Unhandled Error at Express level:", err.stack || err);
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.');
    if (res.headersSent) {
        return next(err);
    }
    res.status(status).json({ error: message });
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Catch uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // It's generally recommended to gracefully shut down the process after an uncaught exception
    // gracefulShutdown(); // Optionally trigger shutdown
});
