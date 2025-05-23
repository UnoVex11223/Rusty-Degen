// app.js (Fixed with Enhanced Cookie Management and TradeOfferManager Reliability)

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
            "img-src": ["'self'", "data:", "*.steamstatic.com", "*.akamai.steamstatic.com"],
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
                return sources;
            })(),
            "frame-src": ["'self'", "https://steamcommunity.com"],
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
    apiKey: process.env.STEAM_API_KEY,
    providerURL: 'https://steamcommunity.com/openid'
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
        match: [TRADE_URL_REGEX, 'Invalid Steam Trade URL format']
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
    payoutOfferStatus: { type: String, enum: ['PendingAcceptanceByWinner', 'Sent', 'Accepted', 'Declined', 'Canceled', 'Expired', 'InvalidItems', 'Escrow', 'Failed', 'Unknown', 'Failed - No Trade URL', 'No Items Won', 'Pending Confirmation', 'Failed - Bot Not Ready', 'Failed - Offer Creation Error', 'Failed - Bad URL', 'Failed - Inventory/Trade Issue', 'Failed - DB Error Post-Send', 'Failed - Synchronous Offer Prep Error', 'Failed - Invalid Trade URL Format', 'Failed - Bot Inventory Issue', 'Failed - Bot Session Issue'], default: 'Unknown' }
});
roundSchema.index({ 'participants.user': 1 });
roundSchema.index({ winner: 1, status: 1, completedTime: -1 });

const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);

// --- Steam Bot Setup ---
const community = new SteamCommunity();
let manager = null; // Initialize as null, will create after login

// FIXED: Create a new TradeOfferManager instance with fresh cookies
function createTradeOfferManager(cookies) {
    if (manager) {
        console.log("LOG_INFO: Shutting down existing TradeOfferManager instance");
        manager.shutdown();
        manager = null;
    }

    manager = new TradeOfferManager({
        steam: community,
        domain: process.env.SITE_URL ? process.env.SITE_URL.replace(/^https?:\/\//, '') : 'localhost',
        language: 'en',
        pollInterval: 10000,
        cancelTime: 10 * 60 * 1000,
    });

    // Set up event handlers for the new manager instance
    setupManagerEventHandlers();

    // Set cookies on the new manager
    return new Promise((resolve, reject) => {
        manager.setCookies(cookies, (err) => {
            if (err) {
                console.error('LOG_ERROR: Failed to set cookies on new TradeOfferManager:', err);
                reject(err);
            } else {
                console.log('LOG_SUCCESS: Cookies set on new TradeOfferManager instance');
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
const pendingDeposits = new Map();

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
    isBotReady = false; // Mark as not ready until successful
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

        console.log(`LOG_INFO: Attempting Steam login for bot: ${loginCredentials.accountName} (via executeBotLogin)...`);
        community.login(loginCredentials, async (err, sessionID, cookies, steamguard) => {
            if (err || !community.steamID) {
                console.error('STEAM LOGIN ERROR (executeBotLogin):', { message: err?.message, eresult: err?.eresult, steamguard, steamID: community.steamID });
                if (err?.eresult === 5) console.warn('Login Failure Hint: Invalid Password?');
                if (err?.eresult === 65) console.warn('Login Failure Hint: Incorrect 2FA Code or Account Rate Limit?');
                if (err?.eresult === 63) console.warn('Login Failure Hint: Account Logon Denied - Check Email/Steam Guard?');
                isLoginInProgress = false;
                reject(err || new Error(`Login failed: community.steamID undefined. EResult: ${err?.eresult}`));
                return;
            }

            console.log(`LOG_SUCCESS (executeBotLogin): Steam bot ${loginCredentials.accountName} logged in (SteamID: ${community.steamID}). Setting cookies...`);
            community.setCookies(cookies);

            try {
                // FIXED: Create a new TradeOfferManager instance with fresh cookies
                await createTradeOfferManager(cookies);
                isLoginInProgress = false;
                isBotReady = true;
                console.log("LOG_SUCCESS (executeBotLogin): Steam Bot is fully ready and operational.");
                resolve(true);
            } catch (setCookieErr) {
                isLoginInProgress = false;
                console.error('TradeOfferManager Error setting cookies after login (executeBotLogin):', setCookieErr);
                reject(setCookieErr);
            }
        });
    });
}

async function refreshBotSession() {
    console.log("LOG_INFO: Checking/Refreshing bot session for TradeOfferManager...");

    if (!isBotConfigured) {
        isBotReady = false;
        return Promise.reject(new Error("Bot not configured, cannot refresh session."));
    }
    if (!community) return Promise.reject(new Error("SteamCommunity instance unavailable."));

    const isSessionLikelyDead = !community.steamID || !community.cookies || community.cookies.length === 0;

    if (isSessionLikelyDead) {
        console.warn("LOG_WARN: Bot session appears compromised (no steamID or no cookies in SteamCommunity). Attempting re-login.");
        try {
            await executeBotLogin();
            if (!isBotReady) {
                throw new Error("Re-login attempt did not result in a ready bot state.");
            }
            console.log("LOG_SUCCESS: Re-login successful via refreshBotSession, session should be active for manager.");
            return Promise.resolve();
        } catch (reloginErr) {
            console.error("LOG_ERROR: Re-login attempt failed during session refresh:", reloginErr.message);
            isBotReady = false;
            return Promise.reject(new Error(`Bot re-login failed: ${reloginErr.message}`));
        }
    } else {
        // FIXED: Always recreate manager with fresh cookies when refreshing
        console.log(`LOG_INFO: SteamCommunity session appears active (SteamID: ${community.steamID}). Creating new TradeOfferManager with fresh cookies.`);
        try {
            await createTradeOfferManager(community.cookies);
            isBotReady = true;
            console.log("LOG_SUCCESS: TradeOfferManager recreated with fresh cookies from active community session.");
            return Promise.resolve();
        } catch (err) {
            console.error("LOG_ERROR: Failed to create new TradeOfferManager with fresh cookies:", err);
            isBotReady = false;
            return Promise.reject(err);
        }
    }
}

// FIXED: Move event handler setup to a separate function
function setupManagerEventHandlers() {
    if (!manager) return;

    manager.on('newOffer', async (offer) => {
        console.log(`LOG_DEBUG: manager.on('newOffer') received. Offer ID: ${offer.id}, Partner: ${offer.partner.getSteamID64()}, Our Offer: ${offer.isOurOffer}`);
        if (!isBotReady || offer.isOurOffer) {
            if (offer.isOurOffer) console.log(`LOG_DEBUG: Ignoring newOffer event for our own offer #${offer.id} (likely a deposit or payout).`);
            else console.log(`LOG_DEBUG: Ignoring newOffer event #${offer.id} because bot not ready.`);
            return;
        }
        if (offer.itemsToReceive.length > 0 && offer.itemsToGive.length === 0) {
            if (offer.message && offer.message.includes('DepositID:')) {
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
                console.warn(`WARN: Offer ID mismatch for DepositID ${depositIdFromMessage}. Tracked: ${depositData.offerIdAttempted}, Event: ${offer.id}. This is unusual.`);
            }
        }

        if (depositData) {
            console.log(`LOG_DEBUG: Offer #${offer.id} matched pending deposit ${depositIdFromMessage}.`);
            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                pendingDeposits.delete(depositIdFromMessage);
                console.log(`LOG_SUCCESS: Processing accepted deposit offer #${offer.id} (DepositID: ${depositIdFromMessage}) for user ${depositData.steamId}`);
                
                User.updateOne({ _id: depositData.userId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                    .catch(e => console.error("DB_ERROR: Error clearing user pending flag on deposit accept:", e));

                let createdItemDocuments = [];
                try {
                    const roundForDeposit = await Round.findById(depositData.roundId).select('status participants items').exec();
                    if (!roundForDeposit || roundForDeposit.status !== 'active' || isRolling) {
                        console.warn(`WARN: Deposit ${depositIdFromMessage} (Offer ${offer.id}) accepted, but round invalid/rolling. Items NOT added to pot. Round status: ${roundForDeposit?.status}, isRolling: ${isRolling}`);
                        io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Round for offer #${offer.id} ended/changed before processing. Contact support.` });
                        return;
                    }
                    const isNewP = !roundForDeposit.participants.some(p => p.user?.toString() === depositData.userId.toString());
                    if (isNewP && roundForDeposit.participants.length >= MAX_PARTICIPANTS) {
                        console.warn(`WARN: Deposit ${depositIdFromMessage} accepted, but participant limit for round ${roundForDeposit.roundId} reached.`);
                        io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Participant limit reached for offer #${offer.id}. Contact support.` }); return;
                    }
                    if (roundForDeposit.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                        console.warn(`WARN: Deposit ${depositIdFromMessage} accepted, but pot item limit for round ${roundForDeposit.roundId} reached.`);
                        io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Pot item limit reached for offer #${offer.id}. Contact support.` }); return;
                    }

                    const itemModelsToSave = depositData.items.map(itemDetail => new Item({
                        assetId: itemDetail.assetid,
                        name: itemDetail._name,
                        image: itemDetail._image,
                        price: itemDetail._price,
                        owner: depositData.userId,
                        roundId: depositData.roundId
                    }));
                    createdItemDocuments = await Item.insertMany(itemModelsToSave, { ordered: false });
                    const createdItemIds = createdItemDocuments.map(doc => doc._id);
                    console.log(`LOG_INFO: Deposit ${depositIdFromMessage}: Inserted ${createdItemIds.length} items into DB.`);
                    
                    await User.findByIdAndUpdate( depositData.userId, { $inc: { totalDepositedValue: depositData.totalValue } } );

                    const updatedRound = await Round.findByIdAndUpdate(
                        depositData.roundId,
                        { },
                        { new: true }
                    ).populate('participants.user', 'steamId username avatar');

                    const roundToUpdate = await Round.findById(depositData.roundId);
                    if (!roundToUpdate || roundToUpdate.status !== 'active') {
                        console.warn(`WARN: Deposit ${depositIdFromMessage} - Round ${depositData.roundId} became invalid before final DB update. Status: ${roundToUpdate?.status}`);
                        throw new Error("Round status invalid before final deposit update.");
                    }
                    let participantIndex = roundToUpdate.participants.findIndex(p => p.user?.toString() === depositData.userId.toString());
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));
                    if (participantIndex !== -1) {
                        roundToUpdate.participants[participantIndex].itemsValue += depositData.totalValue;
                        roundToUpdate.participants[participantIndex].tickets += depositTickets;
                    } else {
                        if (roundToUpdate.participants.length >= MAX_PARTICIPANTS) {
                            console.warn(`WARN: Deposit ${depositIdFromMessage} - Participant limit hit before final save for round ${roundToUpdate.roundId}.`);
                            throw new Error("Participant limit hit before final save.");
                        }
                        roundToUpdate.participants.push({ user: depositData.userId, itemsValue: depositData.totalValue, tickets: depositTickets });
                    }
                    roundToUpdate.totalValue += depositData.totalValue;
                    if (roundToUpdate.items.length + createdItemIds.length > MAX_ITEMS_PER_POT) {
                        console.warn(`WARN: Deposit ${depositIdFromMessage} - Pot item limit hit before final save for round ${roundToUpdate.roundId}.`);
                        throw new Error("Pot item limit hit before final save.");
                    }
                    roundToUpdate.items.push(...createdItemIds);
                    
                    const savedRound = await roundToUpdate.save();
                    const latestRoundDataForEmit = await Round.findById(savedRound._id).populate('participants.user', 'steamId username avatar').lean();
                    if (!latestRoundDataForEmit) throw new Error('Failed to fetch updated round data for emission after deposit.');
                    
                    currentRound = latestRoundDataForEmit;
                    
                    const finalParticipantData = latestRoundDataForEmit.participants.find(p => p.user?._id.toString() === depositData.userId.toString());
                    if (finalParticipantData && finalParticipantData.user) {
                        io.emit('participantUpdated', {
                            roundId: latestRoundDataForEmit.roundId,
                            userId: finalParticipantData.user._id.toString(),
                            username: finalParticipantData.user.username,
                            avatar: finalParticipantData.user.avatar,
                            itemsValue: finalParticipantData.itemsValue,
                            tickets: finalParticipantData.tickets,
                            totalValue: latestRoundDataForEmit.totalValue,
                            depositedItems: depositData.items.map(i => ({ assetId: i.assetid, name: i._name, image: i._image, price: i._price }))
                        });
                        console.log(`LOG_INFO: Emitted 'participantUpdated' for user ${finalParticipantData.user.username} in round ${latestRoundDataForEmit.roundId}.`);
                    }
                    if (latestRoundDataForEmit.participants.length === 1 && !roundTimer && latestRoundDataForEmit.status === 'active') {
                        startRoundTimer();
                    }
                    console.log(`LOG_SUCCESS: Deposit success processed for offer #${offer.id}. User: ${finalParticipantData?.user?.username}`);

                } catch (dbErr) {
                    console.error(`CRITICAL_DB_ERROR processing accepted deposit ${offer.id} (DepositID ${depositIdFromMessage}):`, dbErr);
                    io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Items may be held by bot. Contact support.` });
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
                User.updateOne({ _id: depositData.userId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                    .catch(e => console.error("DB_ERROR: Error clearing user pending flag on deposit failure/cancellation:", e));
                const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Your deposit offer (#${offer.id}) was ${stateMessage}.` });
            } else {
                console.log(`LOG_DEBUG: Deposit Offer #${offer.id} (DepositID: ${depositIdFromMessage}) changed to unhandled state: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
            }
        } else {
            let payoutStatusUpdate = 'Unknown';
            switch (offer.state) {
                case TradeOfferManager.ETradeOfferState.Accepted: payoutStatusUpdate = 'Accepted'; break;
                case TradeOfferManager.ETradeOfferState.Declined: payoutStatusUpdate = 'Declined'; break;
                case TradeOfferManager.ETradeOfferState.Canceled: payoutStatusUpdate = 'Canceled'; break;
                case TradeOfferManager.ETradeOfferState.Expired: payoutStatusUpdate = 'Expired'; break;
                case TradeOfferManager.ETradeOfferState.InvalidItems: payoutStatusUpdate = 'InvalidItems'; break;
                case TradeOfferManager.ETradeOfferState.InEscrow: payoutStatusUpdate = 'Escrow'; break;
                case TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation:
                case TradeOfferManager.ETradeOfferState.PendingConfirmation:
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
                        notifMessage = `Winnings from offer #${offer.id} (Round #${updatedRound.roundId}) successfully accepted!`;
                    } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired].includes(offer.state)) {
                        notifType = 'error';
                        notifMessage = `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) was ${payoutStatusUpdate}. Contact support if this was an error.`;
                    } else if (offer.state === TradeOfferManager.ETradeOfferState.InEscrow) {
                        notifType = 'warning';
                    }
                    io.emit('notification', { type: notifType, userId: winnerUserIdStr, message: notifMessage });
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
                if (success) console.log(`PRICE_SUCCESS: Refreshed price cache with ${updatedCount} items from rust.scmm.app.`);
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
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
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
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants." });
            isRolling = false;
            setTimeout(createNewRound, 5000);
            return;
        }

        let finalItems = [...round.items];
        let originalPotValue = round.participants.reduce((sum, p) => sum + (p?.itemsValue || 0), 0);
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
        console.log(`LOG_INFO: Updated winnings stats for ${winnerInfo.username}: New total winnings will be $${( (await User.findById(winnerInfo._id).lean()).totalWinningsValue ).toFixed(2)} (added $${valueForWinner.toFixed(2)})`);

        const finalUpdateData = {
            status: 'completed_pending_acceptance',
            completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winnerInfo._id,
            taxAmount: taxAmount, taxedItems: taxedItemsInfo,
            totalValue: valueForWinner,
            items: finalItems.map(i => i._id),
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
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', payoutOfferStatus: 'Failed' } }).catch(e => console.error("DB_ERROR: Error marking round as error after endRound failure:", e));
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
                resolve(null);
            } else {
                resolve({
                    state: offer.state,
                    stateName: TradeOfferManager.ETradeOfferState[offer.state]
                });
            }
        });
    });
}

// FIXED: Enhanced sendWinningTradeOffer with better cookie management
async function sendWinningTradeOffer(roundDoc, winner, itemsToSend) {
    const timestamp = new Date().toISOString();

    console.log(`[${timestamp}] DEBUG_TRADE_URL (Round ${roundDoc.roundId}): Winner tradeUrl:`, winner?.tradeUrl);
    
    if (winner?.tradeUrl) {
        const isValidFormat = TRADE_URL_REGEX.test(winner.tradeUrl);
        console.log(`[${timestamp}]   TradeUrl format valid:`, isValidFormat);
        if (!isValidFormat) {
            console.error(`[${timestamp}] PAYOUT_ERROR (Round ${roundDoc.roundId}): Trade URL format validation failed.`);
            Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Invalid Trade URL Format' } }).catch(dbErr => console.error(`[${timestamp}] DB_ERROR:`, dbErr));
            if (io && winner && winner._id) io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Trade URL format is invalid. Please update it.' });
            return;
        }
    }

    if (!isBotConfigured) {
        console.error(`[${timestamp}] PAYOUT_ERROR (Round ${roundDoc.roundId}): Bot not configured. Cannot send trade.`);
        Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Bot Not Ready' } }).catch(dbErr => console.error(dbErr));
        return;
    }
    
    if (!isBotReady) {
        console.error(`[${timestamp}] PAYOUT_ERROR (Round ${roundDoc.roundId}): Bot not ready (isBotReady is false). Attempting session refresh.`);
        try {
            await refreshBotSession();
            if (!isBotReady) {
                console.error(`[${timestamp}] PAYOUT_ABORT (Round ${roundDoc.roundId}): Bot still not ready after refresh attempt.`);
                Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Bot Not Ready' } }).catch(dbErr => console.error(dbErr));
                if (io && winner && winner._id) io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Bot service is temporarily unavailable for round ${roundDoc.roundId} payout. Please try again.` });
                return;
            }
            console.log(`[${timestamp}] LOG_SUCCESS: Bot became ready after session refresh. Proceeding with payout for round ${roundDoc.roundId}.`);
        } catch (refreshErr) {
            console.error(`[${timestamp}] PAYOUT_ABORT (Round ${roundDoc.roundId}): Critical failure refreshing bot session:`, refreshErr.message);
            Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Bot Session Issue' } }).catch(dbErr => console.error(dbErr));
            if (io && winner && winner._id) io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Bot session error for round ${roundDoc.roundId}. Please try 'Accept Winnings' again or contact support.` });
            return;
        }
    }
    
    if (!winner || !winner.tradeUrl) {
        console.error(`[${timestamp}] PAYOUT_ERROR (Round ${roundDoc.roundId}): Winner ${winner?.username || 'N/A'} has no Trade URL.`);
        Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - No Trade URL' } }).catch(dbErr => console.error(dbErr));
        if (io && winner && winner._id) io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Please set your Steam Trade URL.' });
        return;
    }
    if (!itemsToSend || itemsToSend.length === 0) {
        console.log(`[${timestamp}] PAYOUT_INFO (Round ${roundDoc.roundId}): No items to send.`);
        Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'No Items Won' } }).catch(dbErr => console.error(dbErr));
        return;
    }

    console.log(`[${timestamp}] LOG_INFO (Round ${roundDoc.roundId}): Preparing to send ${itemsToSend.length} items to ${winner.username}. Value: $${roundDoc.totalValue.toFixed(2)}`);

    // FIXED: Always refresh the manager with fresh cookies before payout
    try {
        await refreshBotSession();
        console.log(`[${timestamp}] LOG_SUCCESS: Bot session (TradeOfferManager cookies) proactively refreshed before payout for round ${roundDoc.roundId}.`);
    } catch (sessionErr) {
        console.error(`[${timestamp}] PAYOUT_ABORT (Round ${roundDoc.roundId}): Critical failure during proactive session refresh:`, sessionErr.message);
        Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Bot Session Issue' } })
            .catch(dbErr => { console.error(`[${timestamp}] DB_ERROR (Round ${roundDoc.roundId}): Failed to update round status (bot session issue):`, dbErr); });
        if (io && winner && winner._id) {
            io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Bot session error during payout for round ${roundDoc.roundId}. Please try 'Accept Winnings' again or contact support.` });
        }
        return;
    }

    try {
        const offer = manager.createOffer(winner.tradeUrl);

        console.log(`[${timestamp}] LOG_DEBUG: Offer object created (Round ${roundDoc.roundId}):`, {
            id: offer.id, state: offer.state, partner: offer.partner?.getSteamID64(),
            isOurOffer: offer.isOurOffer
        });
        
        // FIXED: Check if manager actually has valid cookies by verifying the offer's cookie jar
        if (!offer._cookies || Object.keys(offer._cookies).length === 0) {
            console.error(`[${timestamp}] PAYOUT_CRITICAL_ERROR (Round ${roundDoc.roundId}): Trade offer has no cookies set. Manager may have lost session state.`);
            
            // Try one more refresh
            try {
                await refreshBotSession();
                // Recreate the offer with the refreshed manager
                const newOffer = manager.createOffer(winner.tradeUrl);
                if (!newOffer._cookies || Object.keys(newOffer._cookies).length === 0) {
                    throw new Error("Manager still has no cookies after refresh");
                }
                // Use the new offer
                offer = newOffer;
                console.log(`[${timestamp}] LOG_SUCCESS: Created new offer with refreshed manager cookies.`);
            } catch (retryErr) {
                console.error(`[${timestamp}] PAYOUT_ABORT (Round ${roundDoc.roundId}): Failed to recover manager cookies:`, retryErr.message);
                Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Bot Session Issue' } })
                    .catch(dbErr => { console.error(`[${timestamp}] DB_ERROR:`, dbErr); });
                if (io && winner && winner._id) {
                    io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Critical session error for round ${roundDoc.roundId}. Please contact support.` });
                }
                return;
            }
        }

        if (!offer || typeof offer.send !== 'function') {
            console.error(`[${timestamp}] PAYOUT_CRITICAL_ERROR (Round ${roundDoc.roundId}): Failed to create a valid offer object. TradeURL: ${winner.tradeUrl}`);
            Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Offer Creation Error' } }).catch(dbErr => console.error(dbErr));
            if (io && winner && winner._id) io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Error creating trade offer. System error.` });
            return;
        }

        const itemsForOffer = roundDoc._matchedItemsForOffer || itemsToSend.map(item => ({
            assetid: item.assetId, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID
        }));
        
        console.log(`[${timestamp}] LOG_DEBUG: Items being added to offer (Round ${roundDoc.roundId}):`, itemsForOffer);
        offer.addMyItems(itemsForOffer);
        offer.setMessage(`Winnings from Round #${roundDoc.roundId} on ${process.env.SITE_NAME}. Value: $${roundDoc.totalValue.toFixed(2)} Congrats!`);

        function offerSentCallback(err, status) {
            const callbackTimestamp = new Date().toISOString();
            console.log(`[${callbackTimestamp}] CALLBACK_REACHED (Round ${roundDoc.roundId}): Error: ${err ? 'YES' : 'NO'}, Status: ${status}`);

            if (err) {
                console.error(`[${callbackTimestamp}] PAYOUT_ERROR (Round ${roundDoc.roundId}): Raw error object:`, err);
                let offerStatusUpdate = 'Failed';
                let userMessage = `Error sending winnings for round ${roundDoc.roundId}. (Code: ${err.eresult || 'N/A'})`;

                if (err.message?.includes('(26)') || err.eresult === 26) {
                    userMessage = 'Your Trade URL is invalid/expired. Please update it.';
                    offerStatusUpdate = 'Failed - Bad URL';
                } else if (err.eresult === 15 || err.eresult === 16) {
                    userMessage = 'Could not send winnings. Ensure inventory is public/not full.';
                    offerStatusUpdate = 'Failed - Inventory/Trade Issue';
                } else if (err.message?.includes('escrow') || err.eresult === 11) {
                    userMessage = `Winnings sent, may be in Steam escrow. (Offer ID: ${offer.id || 'N/A'})`;
                    offerStatusUpdate = 'Escrow';
                }
                if (io && winner && winner._id) io.emit('notification', { type: 'error', userId: winner._id.toString(), message: userMessage });
                Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferId: offer.id || null, payoutOfferStatus: offerStatusUpdate } }).catch(dbErr => console.error(dbErr));
                return;
            }

            console.log(`[${callbackTimestamp}] LOG_INFO (Round ${roundDoc.roundId}): offer.send success. Status: ${status}, Offer ID: ${offer.id}, State: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
            const actualOfferId = offer.id;
            const offerURL = `https://steamcommunity.com/tradeoffer/${actualOfferId}/`;
            let initialPayoutStatus = 'Sent';

            if (offer.state === TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation || offer.state === TradeOfferManager.ETradeOfferState.PendingConfirmation) {
                initialPayoutStatus = 'Pending Confirmation';
            } else if (offer.state === TradeOfferManager.ETradeOfferState.InEscrow) {
                initialPayoutStatus = 'Escrow';
            } else if (status === 'pending' && process.env.STEAM_IDENTITY_SECRET && offer.state !== TradeOfferManager.ETradeOfferState.Active) {
                initialPayoutStatus = 'Pending Confirmation';
            }
            
            Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferId: actualOfferId, payoutOfferStatus: initialPayoutStatus } })
            .then(() => {
                console.log(`[${callbackTimestamp}] PAYOUT_SUCCESS (Round ${roundDoc.roundId}): DB updated for offer ${actualOfferId}. Status: ${initialPayoutStatus}.`);
                if (io && winner && winner._id) {
                    io.emit('tradeOfferSent', { roundId: roundDoc.roundId, userId: winner._id.toString(), offerId: actualOfferId, offerURL, status: initialPayoutStatus, type: 'winning' });
                    let notifMessage = `Winnings offer #${actualOfferId} sent! Status: ${initialPayoutStatus}.`;
                    if (initialPayoutStatus === 'Pending Confirmation') notifMessage = `Winnings offer #${actualOfferId} needs bot confirmation.`;
                    else if (initialPayoutStatus === 'Escrow') notifMessage = `Winnings offer #${actualOfferId} in Steam escrow.`;
                    io.emit('notification', { type: initialPayoutStatus === 'Sent' ? 'success' : 'info', userId: winner._id.toString(), message: notifMessage });
                }
            }).catch(dbErr => {
                console.error(`[${callbackTimestamp}] DB_ERROR (Round ${roundDoc.roundId}): Error updating round with offer ID ${actualOfferId}:`, dbErr);
                Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - DB Error Post-Send' } }).catch(finalDbErr => console.error(finalDbErr));
            });
        }
        offer.send(offerSentCallback);
        console.log(`[${timestamp}] LOG_DEBUG (Round ${roundDoc.roundId}): offer.send() called.`);
    } catch (err) {
        const catchTimestamp = new Date().toISOString();
        console.error(`[${catchTimestamp}] PAYOUT_CRITICAL_ERROR (Round ${roundDoc.roundId}): Synchronous error preparing/sending offer:`, err);
        Round.updateOne( { _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - Synchronous Offer Prep Error' } }).catch(dbErr => console.error(dbErr));
        if (io && winner && winner._id) io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Error creating trade offer. (Code: PREPFAIL)` });
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
                return res.status(500).json({ error: 'Logout failed.' });
            }
            res.clearCookie('connect.sid');
            res.json({ success: true });
        });
    });
});

// --- Middleware & API Routes ---
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) { return next(); }
    res.status(401).json({ error: 'Not authenticated' });
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
            if (!TRADE_URL_REGEX.test(value)) throw new Error('Invalid Steam Trade URL format.');
            return true;
        })
    ],
    handleValidationErrors,
    async (req, res) => {
        const { tradeUrl } = req.body;
        try {
            const updatedUser = await User.findByIdAndUpdate(req.user._id, { tradeUrl: tradeUrl }, { new: true, runValidators: true });
            if (!updatedUser) return res.status(404).json({ error: 'User not found.' });
            console.log(`LOG_INFO: Trade URL updated for user: ${updatedUser.username}`);
            res.json({ success: true, tradeUrl: updatedUser.tradeUrl });
        } catch (err) {
            if (err.name === 'ValidationError') {
                console.error(`Trade URL Validation Error for user ${req.user._id}:`, err.message);
                return res.status(400).json({ error: err.message });
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
        
        console.log('LOG_INFO (Admin): Cleared stuck round:', stuckRound?.roundId);
        console.log('LOG_INFO (Admin): Cleared pending offers for users:', clearedUsers.modifiedCount);
        
        if (currentRound && currentRound.status === 'completed_pending_acceptance') {
            currentRound = null;
            await ensureInitialRound();
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
            .sort({ completedTime: -1 })
            .select('roundId completedTime totalValue payoutOfferId payoutOfferStatus taxAmount')
            .limit(10)
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
            payoutOfferStatus: 'PendingAcceptanceByWinner'
        }).sort({ completedTime: -1 })
          .populate('winner', 'steamId username avatar tradeUrl')
          .populate('items');

        if (!round) {
            console.warn(`LOG_WARN: No winnings pending acceptance found for user ${user.username}`);
            return res.status(404).json({ error: 'No winnings pending your acceptance found or round already processed.' });
        }

        console.log(`LOG_INFO: Found round ${round.roundId} for user ${user.username} to accept winnings.`);
        
        if (!round.winner || !round.winner.tradeUrl) {
            console.warn(`LOG_WARN: User ${user.username} (or populated winner) has no trade URL for round ${round.roundId}.`);
            await Round.updateOne({ _id: round._id }, { $set: { payoutOfferStatus: 'Failed - No Trade URL' } });
            return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile to accept winnings.' });
        }
        if (!TRADE_URL_REGEX.test(round.winner.tradeUrl)) {
            console.error(`LOG_ERROR: Invalid trade URL format for user ${user.username}: "${round.winner.tradeUrl}"`);
            await Round.updateOne({ _id: round._id }, { $set: { payoutOfferStatus: 'Failed - Invalid Trade URL Format' } });
            return res.status(400).json({ error: 'Your Steam Trade URL format is invalid. Please update it.' });
        }

        console.log(`LOG_INFO: Calling sendWinningTradeOffer for round ${round.roundId}, user ${round.winner.username}. Items: ${round.items.length}`);
        await sendWinningTradeOffer(round, round.winner, round.items);

        res.json({ success: true, message: 'Winnings accepted. Trade offer processing initiated.' });

    } catch (error) {
        console.error('CRITICAL_ERROR: Error in /api/round/accept-winnings:', error);
        res.status(500).json({ error: 'Server error while accepting winnings. Please try again or contact support.' });
    }
});

app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    if (!isBotReady) {
        console.warn(`Inventory fetch failed for ${req.user.username}: Bot service is unavailable (isBotReady: false).`);
        return res.status(503).json({ error: "Steam service temporarily unavailable. Please try again later." });
    }
    try {
        const inventory = await new Promise((resolve, reject) => {
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
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
        res.status(500).json({ error: clientErrorMessage });
    }
});

app.post('/api/deposit', depositLimiter, ensureAuthenticated,
    [
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`You can deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID.')
    ],
    handleValidationErrors,
    async (req, res) => {
        const user = req.user;
        const requestedAssetIds = req.body.assetIds;

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
                       TradeOfferManager.ETradeOfferState.Sent,
                       TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation
                    ].includes(offerStatus.state)) {
                    console.log(`User ${user.username} already has pending deposit offer ${user.pendingDepositOfferId}. State: ${offerStatus.stateName}`);
                    const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                    return res.status(409).json({ error: 'Active deposit offer pending. Accept/decline on Steam.', offerId: user.pendingDepositOfferId, offerURL });
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
                return res.status(400).json({ error: `Participant limit (${MAX_PARTICIPANTS}) reached.` });
            }
            if (latestRoundData.items.length + requestedAssetIds.length > MAX_ITEMS_PER_POT) {
                const slotsLeft = MAX_ITEMS_PER_POT - latestRoundData.items.length;
                return res.status(400).json({ error: `Max items per pot (${MAX_ITEMS_PER_POT}) would be exceeded. ${slotsLeft > 0 ? slotsLeft + ' slots left.' : 'Pot is full.'}` });
            }
        } catch (dbErr) {
            console.error(`Error fetching round data during deposit for ${user.username}:`, dbErr);
            return res.status(500).json({ error: 'Internal server error checking round limits.' });
        }

        let itemsToRequestDetails = [];
        let depositTotalValue = 0;

        try {
            console.log(`Verifying inventory for ${user.username} (SteamID: ${user.steamId}) to confirm ${requestedAssetIds.length} deposit items...`);
            const userInventory = await new Promise((resolve, reject) => {
                manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                    if (err) {
                        if (err.message?.includes('profile is private') || err.eresult === 15) return reject(new Error('Your Steam inventory is private.'));
                        console.error(`Inventory Fetch Error (Deposit): User ${user.steamId}: EResult ${err.eresult}`, err);
                        return reject(new Error(`Could not fetch your inventory (EResult: ${err.eresult}). Ensure it's public.`));
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
                if (price < MIN_ITEM_VALUE) throw new Error(`Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below minimum value ($${MIN_ITEM_VALUE}).`);
                
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
            if (itemsToRequestDetails.length === 0) throw new Error("No valid items could be verified for deposit.");
            console.log(`Verified ${itemsToRequestDetails.length} items for deposit for ${user.username}. Total Value: $${depositTotalValue.toFixed(2)}`);
        } catch (verificationError) {
            console.warn(`Deposit item verification failed for ${user.username}:`, verificationError.message);
            return res.status(400).json({ error: verificationError.message });
        }

        const depositId = uuidv4();
        const offerMessage = `Deposit for ${process.env.SITE_NAME || 'Our Site'} | Round: ${currentRound.roundId} | DepositID: ${depositId}`;
        let cleanupTimeout = null;

        try {
            const offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsToRequestDetails.map(item => ({ assetid: item.assetid, appid: item.appid, contextid: item.contextid })));
            offer.setMessage(offerMessage);

            pendingDeposits.set(depositId, {
                userId: user._id, roundId: currentRound._id, items: itemsToRequestDetails,
                totalValue: depositTotalValue, steamId: user.steamId, offerIdAttempted: null
            });
            console.log(`Stored pending deposit ${depositId} for user ${user.steamId}.`);
            
            cleanupTimeout = setTimeout(() => {
                if(pendingDeposits.has(depositId)) {
                    const pendingData = pendingDeposits.get(depositId);
                    console.log(`Deposit attempt ${depositId} (Offer: ${pendingData.offerIdAttempted || 'N/A'}) expired.`);
                    pendingDeposits.delete(depositId);
                    if (pendingData.offerIdAttempted) {
                        User.updateOne({ _id: user._id, pendingDepositOfferId: pendingData.offerIdAttempted }, { pendingDepositOfferId: null })
                            .catch(e => console.error("Error clearing user pending flag on deposit expiry:", e));
                    }
                }
            }, (manager.cancelTime || 10 * 60 * 1000) + 5000);

            console.log(`Sending deposit offer to ${user.username} (Trade URL: ${user.tradeUrl}). DepositID: ${depositId}`);
            const status = await new Promise((resolve, reject) => {
                offer.send((err, sendStatus) => {
                    if (err) return reject(err);
                    resolve(sendStatus);
                });
            });
            const actualOfferId = offer.id;
            console.log(`Deposit offer ${actualOfferId} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);

            if (pendingDeposits.has(depositId)) {
                pendingDeposits.get(depositId).offerIdAttempted = actualOfferId;
            }

            try {
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: actualOfferId });
                console.log(`Set pendingDepositOfferId=${actualOfferId} for user ${user.username}.`);
            } catch (dbUpdateError) {
                console.error(`CRITICAL: Failed to set pendingDepositOfferId for user ${user.username} after sending offer ${actualOfferId}.`, dbUpdateError);
            }
            
            const offerURL = `https://steamcommunity.com/tradeoffer/${actualOfferId}/`;
            res.json({ success: true, message: 'Deposit offer created! Please accept it on Steam.', offerId: actualOfferId, offerURL: offerURL });

        } catch (error) {
            console.error(`Error sending deposit offer for ${user.username} (DepositID: ${depositId}): EResult ${error.eresult}, Msg: ${error.message}`);
            pendingDeposits.delete(depositId);
            if (cleanupTimeout) clearTimeout(cleanupTimeout);
            
            User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user flag on deposit offer send fail:", e));
            
            let userMessage = 'Failed to create deposit trade offer. Please try again later.';
            if (error.eresult === 26 || error.message?.toLowerCase().includes('trade url')) {
                userMessage = 'Your Steam Trade URL might be invalid or expired. Please check your profile.';
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
                if (!currentRound.participants || typeof currentRound.participants[0]?.user === 'string') {
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
        return {
            user: { _id: p.user._id, steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar },
            itemsValue: p.itemsValue || 0, tickets: p.tickets || 0
        };
    }).filter(p => p !== null);

    const itemsFormatted = (round.items || []).map(i => {
        if (!i || typeof i.price !== 'number' || !i.assetId || !i.name || !i.image) {
            console.warn("formatRoundForClient: Skipping malformed item:", i);
            return null;
        }
        return {
            assetId: i.assetId, name: i.name, image: i.image, price: i.price,
            owner: i.owner?._id || i.owner
        };
    }).filter(item => item !== null);

    let winnerDetails = null;
    if (round.winner && round.winner.steamId) {
        winnerDetails = {
            id: round.winner._id, steamId: round.winner.steamId,
            username: round.winner.username, avatar: round.winner.avatar
        };
    } else if (round.winner) {
        winnerDetails = { id: round.winner.toString() };
    }

    return {
        roundId: round.roundId, status: round.status, startTime: round.startTime, endTime: round.endTime,
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
            if (!currentRound.participants || typeof currentRound.participants[0]?.user === 'string') {
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
                    if (currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) startRoundTimer(true);
                    else if (!currentRound.endTime && !roundTimer) startRoundTimer(false);
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
            res.status(404).json({ error: 'No active or pending round found, and could not create one.' });
        }
    } catch (err) {
        console.error('Error fetching/formatting current round data:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' });
    }
});

app.get('/api/rounds', async (req, res) => {
    try {
        const queryFilter = { status: { $in: ['completed', 'completed_pending_acceptance', 'error'] } };
        
        const rounds = await Round.find(queryFilter)
            .sort('-roundId')
            .limit(10)
            .populate('winner', 'username avatar steamId')
            .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount taxedItems payoutOfferId payoutOfferStatus')
            .lean();

        res.json({
            rounds,
            totalPages: 1,
            currentPage: 1,
            totalRounds: rounds.length
        });
    } catch (err) {
        console.error('Error fetching past rounds:', err);
        res.status(500).json({ error: 'Server error fetching round history.' });
    }
});

app.post('/api/verify', sensitiveActionLimiter,
    [
        body('roundId').notEmpty().isInt({ min: 1 }).toInt(),
        body('serverSeed').trim().notEmpty().isHexadecimal().isLength({ min: 64, max: 64 }),
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 })
    ],
    handleValidationErrors, async (req, res) => {
    const { roundId, serverSeed, clientSeed } = req.body;
    try {
        const round = await Round.findOne({ roundId: roundId, status: { $in: ['completed', 'completed_pending_acceptance'] } })
            .populate('participants.user', 'username').populate('winner', 'username').lean();
        
        if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found.` });
        
        if (!round.serverSeedHash) return res.json({ verified: false, reason: 'Server Seed Hash for this round is not available.'});
        const providedServerSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
        if (providedServerSeedHash !== round.serverSeedHash) {
            return res.json({ verified: false, reason: 'Server Seed Hash mismatch.', expectedHash: round.serverSeedHash, providedSeed: serverSeed, calculatedHashOfProvidedSeed: providedServerSeedHash });
        }

        if (round.serverSeed && round.clientSeed) {
            if (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed) {
                console.log(`Verify attempt for round ${roundId} with user-provided seeds. Official seeds differ but will verify official outcome.`);
            }
        }
        
        const effectiveServerSeed = round.serverSeed || serverSeed;
        const effectiveClientSeed = round.clientSeed || clientSeed;

        const combinedString = effectiveServerSeed + effectiveClientSeed;
        const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');

        if (round.provableHash && calculatedProvableHash !== round.provableHash) {
            return res.json({ verified: false, reason: 'Calculated Provable Hash mismatch with official hash.', expectedProvableHash: round.provableHash, calculatedProvableHash, combinedString });
        }

        const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
        const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;

        if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets for verification.' });
        
        const calculatedWinningTicket = decimalFromHash % totalTickets;

        if (round.winningTicket !== undefined && calculatedWinningTicket !== round.winningTicket) {
            return res.json({
                verified: false,
                reason: 'Calculated winning ticket mismatch with official ticket.',
                calculatedTicket: calculatedWinningTicket,
                actualWinningTicket: round.winningTicket,
                provableHashUsed: calculatedProvableHash,
                totalTickets
            });
        }
        
        res.json({
            verified: true, roundId: round.roundId,
            serverSeedUsed: effectiveServerSeed,
            serverSeedHash: round.serverSeedHash,
            clientSeedUsed: effectiveClientSeed,
            combinedString, finalHash: calculatedProvableHash,
            winningTicketCalculated: calculatedWinningTicket,
            officialWinningTicket: round.winningTicket,
            totalTickets, totalValue: round.totalValue,
            winnerUsername: round.winner?.username || 'N/A'
        });

    } catch (err) {
        console.error(`Error verifying round ${roundId}:`, err);
        res.status(500).json({ error: 'Server error during verification.' });
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
                    payoutOfferStatus: { $nin: ['Accepted', 'Sent', 'Pending Confirmation', 'Escrow'] }
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
    }, 5 * 60 * 1000);
    
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
    }, 10000);
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
