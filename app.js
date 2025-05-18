// app.js (Modified) - Part 1 of 2
// This file contains the backend logic.
// Modifications will focus on ensuring the event sequence and data facilitate the new frontend flow.
// Key changes for your request (like removing a "rolling pop-up") will be in main.js.

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

const MongoStore = require('connect-mongo');

// --- Configuration Constants ---
const requiredEnvVars = [
    'MONGODB_URI', 'SESSION_SECRET', 'STEAM_API_KEY', 'SITE_URL',
    'STEAM_USERNAME', 'STEAM_PASSWORD', 'STEAM_SHARED_SECRET', 'BOT_TRADE_URL', 'SITE_NAME'
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
const ROUND_DURATION = parseInt(process.env.ROUND_DURATION_SECONDS) || 99; // Duration after which the round attempts to end if items are present
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
            "script-src": ["'self'", "/socket.io/socket.io.js", "'unsafe-inline'"], // Allowing inline for now, consider nonce
            "script-src-attr": ["'self'", "'unsafe-inline'"], // For inline event handlers, try to avoid
            "style-src": ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "'unsafe-inline'"], // Allowing inline for now
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
                sources.push("https://rust.scmm.app"); // For price fetching
                return sources;
            })(),
             "frame-src": ["'self'", "https://steamcommunity.com"], // For trade offers
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
        ttl: 14 * 24 * 60 * 60, // Session TTL: 14 days
        autoRemove: 'native'
    }),
    cookie: {
        maxAge: 3600000 * 24, // 24 hours
        secure: process.env.NODE_ENV === 'production', // Set to true if using HTTPS
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
        match: [/^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/, 'Invalid Steam Trade URL format']
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
    status: { type: String, enum: ['pending', 'active', 'rolling', 'completed', 'error'], default: 'pending', index: true },
    startTime: { type: Date },
    endTime: { type: Date }, // This is when the timer visually ends or when rolling starts
    completedTime: { type: Date }, // This is when the round is fully finalized (winner paid or error)
    totalValue: { type: Number, default: 0, min: 0 }, // For active rounds: sum of deposited item values. For completed: value won by winner (after tax).
    items: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }], // For active: all items in pot. For completed: items won by winner.
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
    payoutOfferStatus: { type: String, enum: ['Sent', 'Accepted', 'Declined', 'Canceled', 'Expired', 'InvalidItems', 'Escrow', 'Failed', 'Unknown', 'Pending Send', 'No Items Won'], default: 'Unknown' }
});
roundSchema.index({ 'participants.user': 1 });
roundSchema.index({ winner: 1, status: 1, completedTime: -1 });

const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);


// --- Steam Bot Setup ---
const community = new SteamCommunity();
const manager = new TradeOfferManager({
    steam: community,
    domain: process.env.SITE_URL ? process.env.SITE_URL.replace(/^https?:\/\//, '') : 'localhost',
    language: 'en',
    pollInterval: 10000,
    cancelTime: 10 * 60 * 1000,
});
let isBotReady = false;
const pendingDeposits = new Map();

function generateAuthCode() {
    const secret = process.env.STEAM_SHARED_SECRET;
    if (!secret) { console.error("STEAM_SHARED_SECRET missing. Cannot generate 2FA code."); return null; }
    try { return SteamTotp.generateAuthCode(secret); }
    catch (e) { console.error("Error generating 2FA code:", e); return null; }
}

if (isBotConfigured) {
    const loginCredentials = {
        accountName: process.env.STEAM_USERNAME,
        password: process.env.STEAM_PASSWORD,
        twoFactorCode: generateAuthCode()
    };
    if (loginCredentials.twoFactorCode) {
        console.log(`Attempting Steam login for bot: ${loginCredentials.accountName}...`);
        community.login(loginCredentials, (err, sessionID, cookies, steamguard) => {
            if (err) {
                console.error('STEAM LOGIN ERROR (Callback Err Object):', { message: err.message, eresult: err.eresult, emaildomain: err.emaildomain });
            } else {
                console.log('Steam community.login callback received (no immediate error object reported).');
            }
            if (err || !community.steamID) {
                console.error(`CRITICAL LOGIN FAILURE: Login callback failed or community.steamID is undefined. Error: ${err ? err.message : 'N/A'}, SteamID: ${community.steamID}, EResult: ${err?.eresult}`);
                isBotReady = false;
                if (err?.eresult === 5) console.warn('Login Failure Hint: Invalid Password? Check .env');
                if (err?.eresult === 65) console.warn('Login Failure Hint: Incorrect 2FA Code (Check Shared Secret/Server Time) or Account Rate Limit?');
                if (err?.eresult === 63) console.warn('Login Failure Hint: Account Logon Denied - Check Email Auth/Steam Guard settings via Browser?');
                return;
            }
            console.log(`Steam bot ${loginCredentials.accountName} logged in successfully (SteamID: ${community.steamID}). Attempting to set cookies for TradeOfferManager...`);
            manager.setCookies(cookies, (setCookieErr) => {
                if (setCookieErr) {
                    console.error('TradeOfferManager Error setting cookies:', { error: setCookieErr.message, stack: setCookieErr.stack });
                    isBotReady = false; return;
                }
                console.log('TradeOfferManager cookies set successfully.');
                community.setCookies(cookies);
                isBotReady = true;
                console.log("Steam Bot is ready and operational.");
                ensureInitialRound();
            });
            community.on('friendRelationship', (steamID, relationship) => {
                if (relationship === SteamCommunity.EFriendRelationship.RequestRecipient) {
                    console.log(`Received friend request from ${steamID}. Accepting...`);
                    community.addFriend(steamID, (friendErr) => {
                        if (friendErr) console.error(`Error accepting friend request from ${steamID}:`, friendErr);
                        else console.log(`Accepted friend request from ${steamID}.`);
                    });
                }
            });
        });
    } else {
        console.warn("Could not generate 2FA code. Steam Bot login skipped.");
        isBotReady = false;
    }
}

let currentRound = null; // Holds the current round object (plain JS object after .lean() or .toObject())
let roundTimer = null;   // Holds the setInterval object for the round timer
let isProcessingRoundEnd = false; // Flag to prevent multiple endRound calls for the same round

const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false });

function getFallbackPrice(marketHashName) {
    console.warn(`PRICE_FALLBACK: Using fallback price for "${marketHashName}".`);
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
    if (isProcessingRoundEnd) {
        console.log("Cannot create new round: A round is currently being processed. Will retry soon.");
        return null;
    }
    if (currentRound && currentRound.status === 'active') {
        console.log(`Cannot create new round: Round ${currentRound.roundId} is already active.`);
        return currentRound;
    }

    currentRound = null;
    isProcessingRoundEnd = false;
    if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }

    try {
        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');

        const lastRound = await Round.findOne().sort('-roundId');
        const nextRoundId = lastRound ? lastRound.roundId + 1 : 1;

        const newRoundDoc = new Round({
            roundId: nextRoundId,
            status: 'pending',
            startTime: null,
            serverSeed: serverSeed,
            serverSeedHash: serverSeedHash,
            items: [],
            participants: [],
            totalValue: 0,
            taxAmount: 0,
            taxedItems: [],
            payoutOfferStatus: 'Unknown'
        });
        await newRoundDoc.save();
        currentRound = newRoundDoc.toObject(); // Use plain object for global state

        console.log(`--- Round ${currentRound.roundId} created (Pending) --- ServerSeedHash: ${currentRound.serverSeedHash}`);
        io.emit('roundCreated', { // Frontend uses this to reset its display for a new round
            roundId: currentRound.roundId,
            serverSeedHash: currentRound.serverSeedHash,
            timeLeft: ROUND_DURATION,
            totalValue: 0,
            participants: [],
            items: [],
            status: 'pending'
        });
        // Timer will start when the first participant joins.
        // For now, let's make it active immediately if we want rounds to auto-start.
        // For player-initiated rounds, 'pending' is correct.
        // Let's assume it becomes active on first deposit (handled in deposit logic).
        return currentRound;
    } catch (err) {
        console.error('FATAL: Error creating new round:', err);
        setTimeout(createNewRound, 10000); // Retry after delay
        return null;
    }
}


async function ensureInitialRound() {
    if (isBotConfigured && isBotReady) {
        if (!currentRound || !['active', 'pending'].includes(currentRound.status)) {
            try {
                const existingRound = await Round.findOne({ status: { $in: ['active', 'pending'] } })
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items')
                    .lean();

                if (existingRound) {
                    console.log(`Found existing ${existingRound.status} round ${existingRound.roundId} on startup.`);
                    currentRound = existingRound;

                    if (currentRound.status === 'active') {
                        // If round is active and has participants, and an endTime is set and in the future, resume timer.
                        if (currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                            startRoundTimer(true); // Resume with remaining time
                        } else if (currentRound.participants.length > 0 && !roundTimer) {
                            // If active, has participants, but no valid future endTime, start a new timer cycle.
                            console.warn(`Active round ${currentRound.roundId} found with participants but no valid future endTime. Starting fresh timer.`);
                            startRoundTimer(false);
                        } else if (currentRound.participants.length === 0 && !roundTimer) {
                            // Active round, no participants, no timer - waiting for first deposit.
                            io.emit('roundData', formatRoundForClient(currentRound));
                        }
                    } else if (currentRound.status === 'pending') {
                        io.emit('roundData', formatRoundForClient(currentRound));
                    }
                } else {
                    console.log("No suitable active or pending round found in DB, creating initial round...");
                    await createNewRound();
                }
            } catch (dbErr) {
                console.error("Error ensuring initial round:", dbErr);
                await createNewRound(); // Fallback
            }
        } else {
             console.log(`Initial round check: Current round ${currentRound.roundId} status ${currentRound.status} is suitable.`);
             const roundDataToSend = await Round.findById(currentRound._id)
                .populate('participants.user', 'steamId username avatar')
                .populate('items')
                .populate('winner', 'steamId username avatar')
                .lean();
            io.emit('roundData', formatRoundForClient(roundDataToSend || currentRound));
            if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !roundTimer) {
                if (currentRound.endTime && new Date(currentRound.endTime) > Date.now()) {
                    startRoundTimer(true);
                } else {
                     startRoundTimer(false);
                }
            }
        }
    } else if (isBotConfigured && !isBotReady) {
        console.log("Bot configured but not ready, skipping initial round check until bot is ready.");
    } else {
        console.log("Bot not configured, skipping initial round check.");
    }
}

function startRoundTimer(useRemainingTime = false) {
    if (roundTimer) clearInterval(roundTimer);
    if (!currentRound || currentRound.status !== 'active') {
        console.warn(`Cannot start timer: No active round or round status invalid (ID: ${currentRound?.roundId}, Status: ${currentRound?.status}).`);
        return;
    }
    // Ensure the round is marked as active in the database if it wasn't already
    // This also sets startTime if it's the very first activation of the timer for this round.
    if (!currentRound.startTime) { // If startTime is not set, this is the first timer activation for the round.
        currentRound.startTime = new Date().toISOString();
    }


    let timeLeft;
    let calculatedEndTime;

    if (useRemainingTime && currentRound.endTime && new Date(currentRound.endTime) > Date.now()) {
        calculatedEndTime = new Date(currentRound.endTime);
        timeLeft = Math.max(0, Math.floor((calculatedEndTime.getTime() - Date.now()) / 1000));
        console.log(`Resuming timer for round ${currentRound.roundId} with ${timeLeft}s remaining.`);
    } else {
        timeLeft = ROUND_DURATION;
        calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
        currentRound.endTime = calculatedEndTime.toISOString();
        console.log(`Timer started for round ${currentRound.roundId}. End time: ${currentRound.endTime}.`);
    }

    // Update round in DB with startTime and endTime
    Round.updateOne({ _id: currentRound._id }, { $set: { status: 'active', startTime: new Date(currentRound.startTime), endTime: new Date(currentRound.endTime) } })
        .then(() => console.log(`Round ${currentRound?.roundId} active status, startTime, and endTime updated in DB.`))
        .catch(e => console.error(`Error saving round active status/times for round ${currentRound?.roundId}:`, e));

    io.emit('timerUpdate', { timeLeft, roundId: currentRound.roundId }); // Initial timer update

    roundTimer = setInterval(async () => {
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) {
            clearInterval(roundTimer); roundTimer = null;
            console.warn("Timer stopped: Round state became invalid during countdown.");
            return;
        }

        const now = Date.now();
        let currenttimeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - now) / 1000));

        io.emit('timerUpdate', { timeLeft: currenttimeLeft, roundId: currentRound.roundId });

        if (currenttimeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null;
            console.log(`Round ${currentRound.roundId} timer reached zero.`);
            // Prevent multiple calls if currenttimeLeft hovers at 0
            if (!isProcessingRoundEnd && currentRound.status === 'active') {
                await endRound(); // This is where the round processing starts
            }
        }
    }, 1000);
}

// app.js (Modified) - Part 2 of 2

async function endRound() {
    // This function is called when the round timer hits zero.
    // It manages the process of determining a winner and finalizing the round.

    if (!currentRound || currentRound.status !== 'active') {
        console.warn(`Attempted to end round ${currentRound?.roundId}, but state is invalid (Status: ${currentRound?.status}) or already processing.`);
        return;
    }
    // Ensure only one endRound process runs for a given round
    if (isProcessingRoundEnd && currentRound._id.toString() === (await Round.findOne({roundId: currentRound.roundId}).select('_id').lean())?._id.toString()) {
        console.warn(`endRound called for round ${currentRound.roundId} but it's already in the process of ending.`);
        return;
    }

    isProcessingRoundEnd = true; // Set flag immediately
    const roundIdToEnd = currentRound.roundId;
    const roundMongoId = currentRound._id;
    console.log(`--- Ending round ${roundIdToEnd}... ---`);

    try {
        // 1. Update status to 'rolling' in DB and memory.
        // The 'roundRolling' event signals the frontend to prepare for the animation.
        // Frontend (main.js) should handle this by switching to the animation view
        // without showing any intermediate "rolling thing pop up" if that's undesired.
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } });
        currentRound.status = 'rolling';
        currentRound.endTime = new Date().toISOString(); // Update in-memory representation
        io.emit('roundRolling', { roundId: roundIdToEnd }); // Signal frontend: Prepare for animation

        const round = await Round.findById(roundMongoId)
            .populate('participants.user', 'steamId username avatar tradeUrl')
            .populate('items')
            .lean();

        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update to rolling.`);
        if (round.status !== 'rolling') {
             console.warn(`Round ${roundIdToEnd} status was not 'rolling' in DB after update. Current DB status: ${round.status}. Aborting endRound.`);
             isProcessingRoundEnd = false;
             currentRound = await Round.findById(roundMongoId).lean(); // Re-sync
             // Potentially emit an error or try to re-sync client
             return;
        }
        currentRound = { ...round }; // Update global currentRound with full data for processing

        if (round.participants.length === 0 || round.items.length === 0) {
            console.log(`Round ${round.roundId} ended with no valid participants or items. Total Value: ${round.totalValue}`);
            let finalStatus = 'completed';
            if (round.totalValue <= 0) { // Truly empty round
                 await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date(), winner: null, totalValue: 0 } });
                 io.emit('roundCompleted', { roundId: round.roundId, message: "No participants or items." });
            } else { // Had value but something went wrong, or all taxed
                 console.warn(`Round ${round.roundId} ended with items/participants issue but had value $${round.totalValue}. Marking completed.`);
                 await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date(), winner: null, totalValue: 0, taxAmount: round.totalValue } });
                 io.emit('roundCompleted', { roundId: round.roundId, message: "Round ended; items may have been taxed or an issue occurred." });
            }
            isProcessingRoundEnd = false; currentRound = null;
            setTimeout(createNewRound, 5000); // Schedule next round
            return;
        }

        // Calculate tax
        let finalItemsInPot = [...round.items];
        let originalPotValue = round.participants.reduce((sum, p) => sum + (p?.itemsValue || 0), 0);
        let valueForWinnerCalculation = originalPotValue;
        let taxAmount = 0;
        let taxedItemsInfo = [];
        let itemsToTakeForTaxIds = new Set();

        if (originalPotValue >= MIN_POT_FOR_TAX && finalItemsInPot.length > 0) {
            const targetTaxValue = originalPotValue * (TAX_MIN_PERCENT / 100);
            const maxTaxValue = originalPotValue * (TAX_MAX_PERCENT / 100);
            const sortedItemsForTax = [...finalItemsInPot].sort((a, b) => (a.price || 0) - (b.price || 0));
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
                finalItemsInPot = finalItemsInPot.filter(item => !itemsToTakeForTaxIds.has(item._id.toString()));
                taxAmount = currentTaxValueAccumulated;
                valueForWinnerCalculation = originalPotValue - taxAmount;
                console.log(`Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${itemsToTakeForTaxIds.size} items). Original Value: $${originalPotValue.toFixed(2)}. New Pot Value for Winner: $${valueForWinnerCalculation.toFixed(2)}`);
            }
        }

        // Determine Winner
        const clientSeed = crypto.randomBytes(16).toString('hex'); // Generate client seed at end of round
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16); // Use first 8 hex chars (32 bits)
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);

        if (totalTickets <= 0) {
            console.error(`Cannot determine winner: Total tickets is zero for round ${round.roundId}. Participants: ${round.participants.length}`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', completedTime: new Date(), clientSeed, provableHash, totalValue: 0, taxAmount: originalPotValue, taxedItems: round.items.map(i=> ({assetId: i.assetId, name: i.name, price: i.price})) } });
            io.emit('roundError', { roundId: round.roundId, error: 'No tickets in pot.' });
            io.emit('roundCompleted', { roundId: round.roundId }); // Ensure client knows round is over
            isProcessingRoundEnd = false; currentRound = null; setTimeout(createNewRound, 10000);
            return;
        }
        const winningTicket = decimalFromHash % totalTickets;
        let cumulativeTickets = 0;
        let winnerDBInfo = null;

        for (const participant of round.participants) {
            if (!participant?.tickets || !participant.user) continue;
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winnerDBInfo = participant.user; // participant.user is populated user object
                break;
            }
        }

        if (!winnerDBInfo || !winnerDBInfo._id) {
             console.error(`Winner selection failed for round ${round.roundId}. WinningTicket: ${winningTicket}, TotalTickets: ${totalTickets}`);
             await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', completedTime: new Date(), clientSeed, provableHash } });
             io.emit('roundError', { roundId: round.roundId, error: 'Winner selection process failed.' });
             io.emit('roundCompleted', { roundId: round.roundId });
             isProcessingRoundEnd = false; currentRound = null; setTimeout(createNewRound, 10000);
             return;
        }

        await User.findByIdAndUpdate(winnerDBInfo._id, { $inc: { totalWinningsValue: valueForWinnerCalculation } });
        const updatedWinnerStats = await User.findById(winnerDBInfo._id).lean(); // For logging
        console.log(`Updated winnings stats for ${winnerDBInfo.username}: New total winnings $${(updatedWinnerStats.totalWinningsValue).toFixed(2)} (added $${valueForWinnerCalculation.toFixed(2)})`);

        const finalUpdateData = {
            status: 'completed', completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winnerDBInfo._id,
            taxAmount: taxAmount, taxedItems: taxedItemsInfo,
            totalValue: valueForWinnerCalculation, // This is the value winner gets
            items: finalItemsInPot.map(i => i._id), // IDs of items won
            payoutOfferStatus: 'Pending Send' // Initial status before sending offer
        };

        // 2. Emit 'roundWinner' event.
        // This event signals the frontend to start the main animation and then show the winning screen.
        // The frontend (main.js) will handle the animation, then display winner details (winning screen).
        io.emit('roundWinner', { // Event for animation and winner display
            roundId: round.roundId,
            winner: {
                id: winnerDBInfo._id.toString(), // Ensure ID is string for frontend
                steamId: winnerDBInfo.steamId,
                username: winnerDBInfo.username,
                avatar: winnerDBInfo.avatar
            },
            winningTicket: winningTicket,
            totalValue: valueForWinnerCalculation, // Value after tax
            totalTickets: totalTickets,
            serverSeed: round.serverSeed, // Revealed server seed
            clientSeed: clientSeed,       // Newly generated client seed
            provableHash: provableHash,
            serverSeedHash: round.serverSeedHash // Original hash for verification
        });


        // 3. Send Winnings Trade Offer.
        // This happens after the animation signal. The `tradeOfferSent` event from `sendWinningTradeOffer`
        // will trigger the "accept on Steam" pop-up on the winner's client.
        let completedRoundDocForOffer; // Define here to use in catch block if needed
        if (finalItemsInPot.length > 0) {
             completedRoundDocForOffer = await Round.findOneAndUpdate({ _id: roundMongoId }, { $set: finalUpdateData }, { new: true })
                .populate('winner', 'steamId username avatar tradeUrl _id') // Need _id for io.emit target
                .lean(); // Use lean, but ensure we have what's needed for sendWinningTradeOffer
            if (!completedRoundDocForOffer) throw new Error("Failed to save completed round data or retrieve it before sending offer.");
            await sendWinningTradeOffer(completedRoundDocForOffer, completedRoundDocForOffer.winner, finalItemsInPot);
        } else {
            finalUpdateData.payoutOfferStatus = 'No Items Won'; // No items left after tax
            finalUpdateData.totalValue = 0; // Ensure totalValue is 0 if no items
            completedRoundDocForOffer = await Round.findOneAndUpdate({ _id: roundMongoId }, { $set: finalUpdateData }, { new: true })
                .populate('winner', 'steamId username avatar tradeUrl _id')
                .lean();
            if (!completedRoundDocForOffer) throw new Error("Failed to save completed round data (no items) before sending offer.");
            console.log(`Round ${round.roundId}: No items to send to winner ${winnerDBInfo.username} after tax.`);
            io.emit('notification', { type: 'info', userId: winnerDBInfo._id.toString(), message: `All items from round ${round.roundId} were collected as site tax. No items won.` });
        }


        console.log(`Round ${round.roundId} completed. Winner: ${winnerDBInfo.username} (Ticket: ${winningTicket}/${totalTickets}, Value Won: $${valueForWinnerCalculation.toFixed(2)})`);


        // 4. Emit 'roundCompleted' event for final cleanup on frontend.
        io.emit('roundCompleted', { // Final signal for the round
            roundId: round.roundId,
            winner: {
                id: winnerDBInfo._id.toString(),
                username: winnerDBInfo.username,
                avatar: winnerDBInfo.avatar
            },
            totalValue: valueForWinnerCalculation,
            serverSeed: round.serverSeed,
            clientSeed: clientSeed,
            provableHash: provableHash
        });

    } catch (err) {
        console.error(`CRITICAL ERROR during endRound for round ${roundIdToEnd}:`, err);
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', payoutOfferStatus: 'Failed' } })
            .catch(e => console.error("Error marking round as error after endRound failure:", e));
        io.emit('roundError', { roundId: roundIdToEnd, error: 'Internal server error during round finalization.' });
        io.emit('roundCompleted', { roundId: roundIdToEnd, status: 'error' }); // Ensure client knows round is over
    } finally {
        isProcessingRoundEnd = false; // Reset flag
        currentRound = null; // Clear current round to allow new one to be created
        console.log(`Scheduling next round creation after round ${roundIdToEnd} finalization.`);
        setTimeout(createNewRound, 10000); // Delay before creating a new round
    }
}

async function sendWinningTradeOffer(roundDoc, winner, itemsToSend) {
    // roundDoc is the completed round document, winner is the populated User document for the winner.
    // itemsToSend is an array of Item documents (or objects with assetId, appid, contextid).

    if (!isBotReady) {
        console.error(`PAYOUT_ERROR (Bot Offline): Bot not ready. Cannot send winnings for round ${roundDoc.roundId}. Winner: ${winner.username}`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Bot Error: Payout for round ${roundDoc.roundId} is delayed. Bot offline.` });
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed' } });
        return;
    }
    if (!winner.tradeUrl) {
        console.error(`PAYOUT_ERROR (No Trade URL): Winner ${winner.username} (ID: ${winner._id}) has no Trade URL. Round ${roundDoc.roundId}.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Please set your Steam Trade URL in your profile to receive winnings.' });
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed' } });
        return;
    }
    // This check is now done before calling sendWinningTradeOffer in endRound
    // if (!itemsToSend || itemsToSend.length === 0) { ... }


    console.log(`[Trade Send Attempt] Round ${roundDoc.roundId}: Attempting to send ${itemsToSend.length} items (value: $${roundDoc.totalValue.toFixed(2)}) to ${winner.username} (Trade URL: ${winner.tradeUrl}).`);
    const offer = manager.createOffer(winner.tradeUrl);
    const itemsForOfferObject = itemsToSend.map(item => ({ // Ensure items have assetId
        assetid: item.assetId, // This must be the bot's inventory assetId of the item
        appid: RUST_APP_ID,
        contextid: RUST_CONTEXT_ID
    }));
    offer.addMyItems(itemsForOfferObject); // These are items the BOT owns and is giving
    offer.setMessage(`Congratulations! Your winnings from Round #${roundDoc.roundId} on ${process.env.SITE_NAME}. Total value won: $${roundDoc.totalValue.toFixed(2)}.`);

    const identitySecret = process.env.STEAM_IDENTITY_SECRET; // For auto-confirming trades if bot has mobile auth
    console.log(`[Trade Send Attempt] Round ${roundDoc.roundId}: Calling offer.send(). Identity Secret Used: ${!!identitySecret}`);

    try {
        const sentOfferResult = await new Promise((resolve, reject) => {
            offer.send(!!identitySecret, (err, status) => { // Pass boolean for use_totp
                if (err) {
                    console.error(`[Trade Send Error CB] Round ${roundDoc.roundId}: Offer.send CALLBACK error for offer ${offer.id}. EResult: ${err.eresult}, Message: ${err.message}`, err);
                    return reject(err); // Reject the promise on error
                }
                console.log(`[Trade Send Success CB] Round ${roundDoc.roundId}: Offer.send CALLBACK success for offer ${offer.id}. Status from Steam: ${status}`);
                resolve({ status: status, offerId: offer.id }); // Resolve with status and offer ID
            });
        });

        const offerURL = `https://steamcommunity.com/tradeoffer/${sentOfferResult.offerId}/`;
        let offerStatusForDB = 'Sent'; // Default status
        // Interpret Steam status for DB
        if (sentOfferResult.status === 'pending' || sentOfferResult.status === 'pendingConfirmation' || sentOfferResult.status === 'escrow') {
            offerStatusForDB = 'Escrow'; // Or a more specific status if available from TradeOfferManager.EConfirmationMethod or ETradeOfferState
        } else if (sentOfferResult.status === 'accepted') { // Or compare with TradeOfferManager.ETradeOfferState.Accepted (2)
            offerStatusForDB = 'Accepted';
        }

        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferId: sentOfferResult.offerId, payoutOfferStatus: offerStatusForDB } });
        console.log(`[Trade Send DB Update] Round ${roundDoc.roundId}: PAYOUT_SUCCESS. Offer ${sentOfferResult.offerId} sent to ${winner.username}. Steam Status: ${sentOfferResult.status}, DB Status: ${offerStatusForDB}`);

        // Emit event for the winner's client to show the "Accept on Steam" pop-up
        io.emit('tradeOfferSent', {
            roundId: roundDoc.roundId,
            userId: winner._id.toString(), // Target specific user
            username: winner.username,
            offerId: sentOfferResult.offerId,
            offerURL: offerURL,
            status: sentOfferResult.status, // Pass along the status from Steam
            type: 'winning' // Differentiate from deposit offers if needed
        });

        if (offerStatusForDB === 'Escrow') {
             const notifMsg = `Winnings offer #${sentOfferResult.offerId} sent, but it requires confirmation on Steam or is in escrow. Please check your Steam mobile app or trade offers page.`;
             io.emit('notification', { type: 'warning', userId: winner._id.toString(), message: notifMsg });
        } else if (offerStatusForDB === 'Accepted') {
            io.emit('notification', { type: 'success', userId: winner._id.toString(), message: `Winnings offer #${sentOfferResult.offerId} was successfully sent and appears auto-accepted!` });
        }

    } catch (err) { // Catch errors from offer.send() promise or other issues
        let offerStatusUpdate = 'Failed';
        let userMessage = `An error occurred while sending your winnings for round ${roundDoc.roundId}. Please contact support.`;
        console.error(`[Trade Send Exception] Round ${roundDoc.roundId}: PAYOUT_ERROR for ${winner.username}. EResult: ${err.eresult}, Message: ${err.message}`, err.stack ? err.stack : err);

        // Provide more specific error messages based on EResult or message content
        if (err.message?.includes('trade token') || err.message?.includes('revoked') || err.message?.includes('invalid') || err.eresult === 26) {
            userMessage = 'Your Steam Trade URL is invalid, revoked, or expired. Please update it in your profile to receive your winnings.'; offerStatusUpdate = 'Failed - Bad URL';
        } else if (err.eresult === 15 || err.eresult === 16 || err.message?.includes('cannot trade with')) { // Common inventory/privacy/ban issues
            userMessage = 'Could not send winnings. Please ensure your Steam inventory is set to public and not full, and that you are not trade banned and can receive trades.'; offerStatusUpdate = 'Failed - Inventory/Trade Issue';
        } else if (err.message?.includes('escrow') || err.eresult === 11) { // EResult 11 is k_EResultAccessDenied (often due to escrow)
            userMessage = `Your winnings (Offer for Round #${roundDoc.roundId}) were sent, but may be held in escrow by Steam due to your account settings.`; offerStatusUpdate = 'Escrow';
        } else if (err.message?.includes('timed out')) {
            userMessage = `Sending your winnings for round ${roundDoc.roundId} timed out. Please check Steam or contact support if not received shortly.`; offerStatusUpdate = 'Failed - Timeout';
        }
        // Add more EResult checks as needed from Steam's documentation

        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: userMessage });
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: offerStatusUpdate } });
        console.error(`[Trade Send DB Update Post-Exception] Round ${roundDoc.roundId}: Marked payout as ${offerStatusUpdate}.`);
    }
}


// --- Authentication Routes ---
app.get('/auth/steam', authLimiter, passport.authenticate('steam', { failureRedirect: '/' }));
app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => { res.redirect('/'); } // Redirect to homepage after successful login
);
app.post('/logout', (req, res, next) => {
    req.logout(err => {
        if (err) { return next(err); }
        req.session.destroy(err => {
            if (err) {
                console.error("Error destroying session during logout:", err);
                return res.status(500).json({ error: 'Logout failed.' });
            }
            res.clearCookie('connect.sid'); // Ensure session cookie is cleared
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
    // Send back a safe subset of user data
    const { _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue });
});

app.post('/api/user/tradeurl',
    sensitiveActionLimiter, ensureAuthenticated,
    [
        body('tradeUrl').trim().custom((value) => {
            if (value === '') return true; // Allow empty string to clear
            const urlPattern = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/;
            if (!urlPattern.test(value)) throw new Error('Invalid Steam Trade URL format. Must include partner and token, or be empty.');
            return true;
        })
    ],
    handleValidationErrors,
    async (req, res) => {
        const { tradeUrl } = req.body;
        try {
            const updatedUser = await User.findByIdAndUpdate(req.user._id, { tradeUrl: tradeUrl }, { new: true, runValidators: true });
            if (!updatedUser) return res.status(404).json({ error: 'User not found.' });
            console.log(`Trade URL updated for user: ${updatedUser.username}`);
            res.json({ success: true, tradeUrl: updatedUser.tradeUrl });
        } catch (err) {
            if (err.name === 'ValidationError') {
                 console.error(`Trade URL Validation Error (Mongoose) for user ${req.user._id}:`, err.message);
                 return res.status(400).json({ error: err.message });
            }
            console.error(`Error updating trade URL for user ${req.user._id}:`, err);
            res.status(500).json({ error: 'Server error saving Trade URL.' });
        }
    }
);

app.get('/api/user/winning-history', ensureAuthenticated, async (req, res) => {
    try {
        const winnings = await Round.find({ winner: req.user._id, status: 'completed' })
            .sort({ completedTime: -1 })
            .select('roundId completedTime totalValue payoutOfferId payoutOfferStatus taxAmount')
            .limit(50)
            .lean();

        const history = winnings.map(win => ({
            gameId: win.roundId,
            amountWon: win.totalValue, // This is after-tax value
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


app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    if (!isBotReady) {
        console.warn(`Inventory fetch failed for ${req.user.username}: Bot service is unavailable.`);
        return res.status(503).json({ error: "Steam service temporarily unavailable. Please try again later." });
    }
    try {
        const inventory = await new Promise((resolve, reject) => {
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                if (err) {
                    if (err.message?.includes('profile is private') || err.eresult === 15) {
                        return reject(new Error('Your Steam inventory is private. Please set it to public.'));
                    }
                    console.error(`Inventory Fetch Error (Manager): User ${req.user.steamId}: EResult ${err.eresult} - ${err.message || err}`);
                    return reject(new Error(`Could not fetch inventory. Steam might be busy or inventory private.`));
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
        res.status(500).json({ error: err.message || 'Server error fetching inventory.' });
    }
});

app.post('/api/deposit', depositLimiter, ensureAuthenticated,
    [
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`You can deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items at a time.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.')
    ],
    handleValidationErrors,
    async (req, res) => {
        const user = req.user;
        const requestedAssetIds = req.body.assetIds;

        if (!isBotReady) return res.status(503).json({ error: "Deposit service temporarily unavailable (Bot offline)." });
        if (!user.tradeUrl) return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile before depositing.' });

        if (user.pendingDepositOfferId) {
             try {
                 const offer = await manager.getOffer(user.pendingDepositOfferId);
                 if (offer && [TradeOfferManager.ETradeOfferState.Active, TradeOfferManager.ETradeOfferState.Sent, TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation].includes(offer.state)) {
                     console.log(`User ${user.username} already has pending deposit offer ${user.pendingDepositOfferId}. State: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
                     const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                     return res.status(409).json({ error: 'You already have an active deposit offer waiting. Please accept or decline it on Steam.', offerId: user.pendingDepositOfferId, offerURL: offerURL });
                 } else {
                      console.log(`Clearing stale pending offer ${user.pendingDepositOfferId} for user ${user.username} (State: ${TradeOfferManager.ETradeOfferState[offer?.state]}).`);
                      await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
                 }
             } catch (offerFetchError) {
                 console.warn(`Could not fetch pending offer ${user.pendingDepositOfferId}, clearing flag:`, offerFetchError.message);
                 await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
             }
        }

        if (!currentRound || currentRound.status !== 'active' || isProcessingRoundEnd) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }
        let latestRoundData;
        try {
            latestRoundData = await Round.findById(currentRound._id).select('status participants items').lean().exec();
            if (!latestRoundData || latestRoundData.status !== 'active') {
                 return res.status(400).json({ error: 'Deposits are currently closed (round state changed).' });
            }
            const isNewParticipant = !latestRoundData.participants.some(p => p.user?.toString() === user._id.toString());
            if (isNewParticipant && latestRoundData.participants.length >= MAX_PARTICIPANTS) {
                 return res.status(400).json({ error: `Participant limit (${MAX_PARTICIPANTS}) reached.` });
            }
            if (latestRoundData.items.length + requestedAssetIds.length > MAX_ITEMS_PER_POT) {
                 const slotsLeft = MAX_ITEMS_PER_POT - latestRoundData.items.length;
                 return res.status(400).json({ error: `Depositing ${requestedAssetIds.length} items would exceed pot limit (${MAX_ITEMS_PER_POT}). ${slotsLeft} slots left.` });
            }
        } catch (dbErr) {
            console.error(`Error fetching round data during deposit for ${user.username}:`, dbErr);
            return res.status(500).json({ error: 'Internal server error checking round limits.' });
        }

        let itemsToRequest = [];
        let depositTotalValue = 0;

        try {
            console.log(`Verifying inventory for ${user.username} (SteamID: ${user.steamId}) to confirm deposit items...`);
            const userInventory = await new Promise((resolve, reject) => {
                manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                    if (err) {
                        if (err.message?.includes('profile is private') || err.eresult === 15) return reject(new Error('Your Steam inventory is private.'));
                        console.error(`Inventory Fetch Error (Deposit): User ${user.steamId}: EResult ${err.eresult}`, err);
                        return reject(new Error(`Could not fetch inventory. Ensure it's public.`));
                    }
                    resolve(inv || []);
                });
            });
            const userInventoryMap = new Map(userInventory.map(item => [item.assetid, item]));

            for (const assetId of requestedAssetIds) {
                const inventoryItem = userInventoryMap.get(assetId);
                if (!inventoryItem) throw new Error(`Item Asset ID ${assetId} not in inventory.`);
                if (!inventoryItem.tradable) throw new Error(`Item '${inventoryItem.market_hash_name}' not tradable.`);
                const price = getItemPrice(inventoryItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) throw new Error(`Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below min value ($${MIN_ITEM_VALUE}).`);
                itemsToRequest.push({
                    assetid: inventoryItem.assetid, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID,
                    _price: price, _name: inventoryItem.market_hash_name,
                     _image: `https://community.akamai.steamstatic.com/economy/image/${inventoryItem.icon_url}`
                });
                depositTotalValue += price;
            }
             if (itemsToRequest.length === 0) throw new Error("No items could be verified for deposit.");
             console.log(`Verified ${itemsToRequest.length} items for deposit for ${user.username}. Total Value: $${depositTotalValue.toFixed(2)}`);
        } catch (verificationError) {
            console.warn(`Deposit item verification failed for ${user.username}:`, verificationError.message);
            return res.status(400).json({ error: verificationError.message });
        }

        const depositId = uuidv4();
        const offerMessage = `RustyDegen Deposit ID: ${depositId} | Round: ${latestRoundData.roundId}`;
        let cleanupTimeout = null;

        try {
            const offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsToRequest.map(({ assetid, appid, contextid }) => ({ assetid, appid, contextid })));
            offer.setMessage(offerMessage);
            pendingDeposits.set(depositId, {
                userId: user._id, roundId: latestRoundData._id,
                items: itemsToRequest,
                totalValue: depositTotalValue, steamId: user.steamId
            });
            console.log(`Stored pending deposit ${depositId} for user ${user.steamId} for round ${latestRoundData.roundId}.`);
            cleanupTimeout = setTimeout(() => {
                 if(pendingDeposits.has(depositId)) {
                     console.log(`Deposit attempt ${depositId} expired.`);
                      pendingDeposits.delete(depositId);
                      User.updateOne({ steamId: user.steamId, pendingDepositOfferId: offer?.id || 'expired' }, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user pending flag on expiry:", e));
                 }
            }, manager.cancelTime || 10 * 60 * 1000); // Default 10 min

            console.log(`Sending deposit offer to ${user.username} (Trade URL: ${user.tradeUrl})...`);
            const status = await new Promise((resolve, reject) => {
                offer.send((err, sendStatus) => { if (err) return reject(err); resolve(sendStatus); });
            });
            try {
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: offer.id });
                console.log(`Set pendingDepositOfferId=${offer.id} for user ${user.username}.`);
            } catch (dbUpdateError) {
                 console.error(`CRITICAL: Failed to set pendingDepositOfferId for user ${user.username} after sending offer ${offer.id}.`, dbUpdateError);
                  pendingDeposits.delete(depositId); clearTimeout(cleanupTimeout);
                  return res.status(500).json({ error: 'Failed to finalize deposit request state. Contact support.' });
            }
            console.log(`Deposit offer ${offer.id} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;
            res.json({ success: true, message: 'Deposit offer created! Accept on Steam.', offerId: offer.id, offerURL: offerURL });
        } catch (error) {
            console.error(`Error sending deposit offer for ${user.username} (DepositID: ${depositId}): EResult ${error.eresult}`, error.message);
            pendingDeposits.delete(depositId); if (cleanupTimeout) clearTimeout(cleanupTimeout);
            await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user flag on offer fail:", e));
            let userMessage = 'Failed to create deposit trade offer. Try again later.';
            if (error.message.includes('unable to trade') && error.message.includes('reset your Steam account')) userMessage = `Steam Error: Account has temporary trade restriction. (${error.message})`;
            else if (error.message.includes('Trade URL') || error.message.includes('token') || error.eresult === 26) userMessage = 'Your Steam Trade URL might be invalid/expired. Check profile.';
            else if (error.eresult) userMessage += ` (Code: ${error.eresult})`;
            res.status(500).json({ error: userMessage });
        }
    }
);

// --- Trade Offer Manager Event Handling ---
if (isBotConfigured && manager) {
    manager.on('newOffer', async (offer) => { // Incoming offers to the bot
        if (!isBotReady || offer.isOurOffer) return; // Ignore offers bot sent or if bot not ready
        // Decline unsolicited donations or trades not initiated by the site's deposit flow
        if (offer.itemsToReceive && offer.itemsToReceive.length > 0 && (!offer.itemsToGive || offer.itemsToGive.length === 0)) {
             // This is an offer where the bot receives items and gives nothing.
             // Check if it's a deposit offer sent MANUALLY by user (should not happen with UUID system)
             if (offer.message && offer.message.includes('RustyDegen Deposit ID:')) {
                 // This would be a user trying to manually send items for a deposit ID.
                 // We only process deposits through offers CREATED BY THE BOT.
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like a manual deposit attempt for an existing ID. Declining.`);
                 return offer.decline((err) => { if (err) console.error(`Error declining manual deposit offer ${offer.id}:`, err); });
             } else {
                 // This is likely a donation or an unsolicited item offer.
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like an unsolicited item offer/donation. Declining.`);
                  return offer.decline((err) => { if (err) console.error(`Error declining unsolicited offer ${offer.id}:`, err); });
             }
        }
        // For any other type of incoming offer not matching the above (e.g. bot gives items, user gives items)
        console.log(`Ignoring unexpected incoming offer #${offer.id} from ${offer.partner.getSteamID64()} (itemsToGive: ${offer.itemsToGive.length}, itemsToReceive: ${offer.itemsToReceive.length}). Declining if not recognized pattern.`);
        // Decline any other unexpected incoming offers
        if (offer.state === TradeOfferManager.ETradeOfferState.Active) { // Ensure it's active before trying to decline
            offer.decline(err => {
                if (err) console.error(`Error declining unexpected offer #${offer.id}:`, err);
                else console.log(`Declined unexpected offer #${offer.id}.`);
            });
        }
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        console.log(`Bot Offer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()}) Msg: "${offer.message}"`);

        const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
        const depositId = messageMatch ? messageMatch[1] : null;

        if (depositId && pendingDeposits.has(depositId)) { // It's a deposit offer we initiated
            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                const depositData = pendingDeposits.get(depositId);
                pendingDeposits.delete(depositId); // Remove from pending once processed
                console.log(`Processing accepted deposit offer #${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId}`);
                User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                    .catch(e => console.error("Error clearing user pending flag on deposit accept:", e));

                let roundForDeposit;
                try {
                     roundForDeposit = await Round.findById(depositData.roundId).exec(); // Get full Mongoose doc
                     if (!roundForDeposit || roundForDeposit.status !== 'active' || isProcessingRoundEnd) {
                          console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but round ${depositData.roundId} invalid (status: ${roundForDeposit?.status}, processingEnd: ${isProcessingRoundEnd}). Items NOT added.`);
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Round ended or became invalid before offer #${offer.id} processed. Contact support.` });
                          // TODO: Consider refunding items here or a retry mechanism if bot still has them.
                          return;
                     }
                     const isNewP = !roundForDeposit.participants.some(p => p.user?.toString() === depositData.userId.toString());
                     if (isNewP && roundForDeposit.participants.length >= MAX_PARTICIPANTS) {
                         io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Participant limit reached for offer #${offer.id}. Contact support.` }); return;
                     }
                     if (roundForDeposit.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Pot item limit reached for offer #${offer.id}. Contact support.` }); return;
                     }
                 } catch (roundCheckError) {
                      console.error(`CRITICAL DB ERROR checking round status for deposit ${depositId}:`, roundCheckError);
                      io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Contact support.` });
                      return;
                 }

                let createdItemIds = [];
                try {
                    const itemDocuments = depositData.items.map(itemData => new Item({
                        assetId: itemData.assetid, name: itemData._name, image: itemData._image,
                        price: itemData._price, owner: depositData.userId, roundId: depositData.roundId
                    }));
                    const insertedItemsResult = await Item.insertMany(itemDocuments, { ordered: false });
                    createdItemIds = insertedItemsResult.map(doc => doc._id);
                    console.log(`Deposit ${depositId}: Inserted ${createdItemIds.length} items into DB.`);
                    await User.findByIdAndUpdate( depositData.userId, { $inc: { totalDepositedValue: depositData.totalValue } } );

                    let participantIndex = roundForDeposit.participants.findIndex(p => p.user?.toString() === depositData.userId.toString());
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));
                    if (participantIndex !== -1) {
                           roundForDeposit.participants[participantIndex].itemsValue += depositData.totalValue;
                           roundForDeposit.participants[participantIndex].tickets += depositTickets;
                    } else {
                           if (roundForDeposit.participants.length >= MAX_PARTICIPANTS) throw new Error("Participant limit hit before final save.");
                           roundForDeposit.participants.push({ user: depositData.userId, itemsValue: depositData.totalValue, tickets: depositTickets });
                    }
                    roundForDeposit.totalValue += depositData.totalValue;
                    if (roundForDeposit.items.length + createdItemIds.length > MAX_ITEMS_PER_POT) throw new Error("Pot item limit hit before final save.");
                    roundForDeposit.items.push(...createdItemIds);

                    let roundBecameActive = false;
                    if (roundForDeposit.status === 'pending' && roundForDeposit.participants.length > 0) {
                        roundForDeposit.status = 'active';
                        roundForDeposit.startTime = new Date();
                        roundBecameActive = true;
                    }

                    const savedRound = await roundForDeposit.save();
                    const populatedSavedRound = await Round.findById(savedRound._id)
                        .populate('participants.user', 'steamId username avatar _id')
                        .lean();

                    if (!populatedSavedRound) throw new Error('Failed to fetch updated round data for emission after save.');

                    if (currentRound && currentRound._id.toString() === populatedSavedRound._id.toString()) {
                        currentRound = populatedSavedRound; // Update global currentRound
                    }

                    const updatedParticipantData = populatedSavedRound.participants.find(p => p.user?._id.toString() === depositData.userId.toString());
                    const userInfo = updatedParticipantData?.user;

                    if (updatedParticipantData && userInfo) {
                          io.emit('participantUpdated', { // This event updates frontend about the new deposit
                               roundId: populatedSavedRound.roundId,
                               userId: userInfo._id.toString(),
                               username: userInfo.username,
                               avatar: userInfo.avatar,
                               itemsValue: updatedParticipantData.itemsValue,
                               tickets: updatedParticipantData.tickets,
                               totalValue: populatedSavedRound.totalValue,
                               depositedItems: depositData.items.map(i => ({ assetId: i.assetid, name: i._name, image: i._image, price: i._price }))
                          });
                    }
                    if (roundBecameActive) { // If this deposit made the round active
                          io.emit('roundStatusUpdate', { roundId: populatedSavedRound.roundId, status: 'active', startTime: populatedSavedRound.startTime });
                          startRoundTimer(); // Start the main round timer
                    }
                     console.log(`Deposit success processed for offer #${offer.id}. User: ${userInfo?.username}, Round: ${populatedSavedRound.roundId}`);
                 } catch (dbErr) {
                     console.error(`CRITICAL DB/UPDATE ERROR processing deposit ${offer.id} for round ${depositData.roundId}:`, dbErr);
                     io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Please contact support immediately.` });
                      if (createdItemIds.length > 0) {
                          console.warn(`Attempting to delete ${createdItemIds.length} items due to error in deposit processing for offer ${offer.id}.`);
                          await Item.deleteMany({ _id: { $in: createdItemIds } });
                      }
                      if (currentRound && currentRound._id.toString() === depositData.roundId.toString()) {
                          console.error(`Marking round ${currentRound.roundId} as error due to deposit processing failure.`);
                          await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } });
                          io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error.' });
                          currentRound = null; setTimeout(createNewRound, 15000);
                      }
                 }
            } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired, TradeOfferManager.ETradeOfferState.InvalidItems].includes(offer.state)) {
                const depositData = pendingDeposits.get(depositId);
                if (depositData) {
                    console.warn(`Deposit offer ${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId} was ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                    pendingDeposits.delete(depositId);
                    User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                        .catch(e => console.error("Error clearing user flag on deposit failure:", e));
                    const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                    io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Your deposit offer (#${offer.id}) was ${stateMessage}.` });
                }
            }
        } else if (offer.itemsToGive && offer.itemsToGive.length > 0 && (!offer.itemsToReceive || offer.itemsToReceive.length === 0)) {
            // This is a payout (winnings) offer sent BY THE BOT
            let payoutStatusUpdate = 'Unknown';
            switch (offer.state) {
                case TradeOfferManager.ETradeOfferState.Accepted: payoutStatusUpdate = 'Accepted'; break;
                case TradeOfferManager.ETradeOfferState.Declined: payoutStatusUpdate = 'Declined'; break;
                case TradeOfferManager.ETradeOfferState.Canceled: payoutStatusUpdate = 'Canceled'; break;
                case TradeOfferManager.ETradeOfferState.Expired: payoutStatusUpdate = 'Expired'; break;
                case TradeOfferManager.ETradeOfferState.InvalidItems: payoutStatusUpdate = 'InvalidItems'; break;
                case TradeOfferManager.ETradeOfferState.InEscrow: payoutStatusUpdate = 'Escrow'; break; // For items held by Steam
                default: payoutStatusUpdate = TradeOfferManager.ETradeOfferState[offer.state] || 'Unknown';
            }

            console.log(`Payout offer #${offer.id} to ${offer.partner.getSteamID64()} changed to ${payoutStatusUpdate}.`);
            try {
                const updatedRound = await Round.findOneAndUpdate(
                    { payoutOfferId: offer.id },
                    { $set: { payoutOfferStatus: payoutStatusUpdate } },
                    { new: true }
                ).populate('winner', 'steamId _id');

                if (updatedRound && updatedRound.winner) {
                    const winnerUserId = updatedRound.winner._id.toString();
                     if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                        io.emit('notification', { type: 'success', userId: winnerUserId, message: `Winnings from offer #${offer.id} (Round #${updatedRound.roundId}) received!` });
                    } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired].includes(offer.state)) {
                        io.emit('notification', { type: 'error', userId: winnerUserId, message: `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) was ${payoutStatusUpdate}. Contact support if this was an error.` });
                    } else if (offer.state === TradeOfferManager.ETradeOfferState.InEscrow) {
                         io.emit('notification', { type: 'warning', userId: winnerUserId, message: `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) is held in Steam escrow.` });
                    }
                } else if (!updatedRound) {
                    console.warn(`Could not find round associated with payout offer #${offer.id} to update status.`);
                }
            } catch (dbError) {
                console.error(`Error updating payout status for offer #${offer.id} in DB:`, dbError);
            }
        } else {
            console.warn(`Offer #${offer.id} changed state to ${TradeOfferManager.ETradeOfferState[offer.state]}, but not recognized as pending deposit or standard winnings. Message: "${offer.message}"`);
        }
    });
}

// --- Round Info API Routes ---
function formatRoundForClient(round) {
    if (!round) return null;
    let endTimeDate = null;
    if (round.endTime) {
        try { endTimeDate = new Date(round.endTime); } catch (e) { console.warn("Invalid endTime format in round data:", round.endTime); }
    }

    const timeLeft = (round.status === 'active' && endTimeDate && !isNaN(endTimeDate.getTime()))
        ? Math.max(0, Math.floor((endTimeDate.getTime() - Date.now()) / 1000))
        : (round.status === 'pending' || (round.status === 'active' && round.participants?.length === 0) ? ROUND_DURATION : 0);

    const participantsFormatted = (round.participants || []).map(p => ({
        user: p.user ? { _id: p.user._id?.toString(), steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar } : null,
        itemsValue: p.itemsValue || 0, tickets: p.tickets || 0
    })).filter(p => p.user);

    const itemsFormatted = (round.items || []).map(i => ({ // These items are for display in the pot
        assetId: i.assetId, name: i.name, image: i.image, price: i.price || 0,
        owner: i.owner?.toString()
    }));

    let winnerDetails = null;
    if (round.winner && typeof round.winner === 'object' && round.winner.steamId) {
        winnerDetails = {
            id: round.winner._id?.toString(), steamId: round.winner.steamId,
            username: round.winner.username, avatar: round.winner.avatar
        };
    } else if (round.winner) {
         winnerDetails = { id: round.winner.toString() };
    }

    return {
        _id: round._id?.toString(),
        roundId: round.roundId, status: round.status,
        startTime: round.startTime ? new Date(round.startTime).toISOString() : null,
        endTime: round.endTime ? new Date(round.endTime).toISOString() : null,
        timeLeft: timeLeft,
        totalValue: round.totalValue || 0,
        serverSeedHash: round.serverSeedHash,
        participants: participantsFormatted,
        items: itemsFormatted,
        winner: winnerDetails,
        winningTicket: round.status === 'completed' ? round.winningTicket : undefined,
        serverSeed: round.status === 'completed' ? round.serverSeed : undefined,
        clientSeed: round.status === 'completed' ? round.clientSeed : undefined,
        provableHash: round.status === 'completed' ? round.provableHash : undefined,
        taxAmount: round.status === 'completed' ? round.taxAmount : undefined,
    };
}


app.get('/api/round/current', async (req, res) => {
    let roundToFormat = null;
    try {
        // Prioritize fetching from DB to ensure data consistency, especially on restarts or sync issues.
        roundToFormat = await Round.findOne({ status: { $in: ['active', 'pending', 'rolling'] } })
             .sort({ startTime: -1 }) // Get the latest one if multiple (should not happen for 'active')
             .populate('participants.user', 'steamId username avatar _id')
             .populate('items') // Populate all items in the pot
             .populate('winner', 'steamId username avatar _id') // Winner usually null for active/pending
             .lean();

        if (roundToFormat) {
            currentRound = roundToFormat; // Update global state
            // Timer logic based on DB state
            if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !roundTimer) {
                if (currentRound.endTime && new Date(currentRound.endTime) > Date.now()) {
                    startRoundTimer(true); // Resume existing timer
                } else {
                    startRoundTimer(false); // Start new timer cycle
                }
            } else if (currentRound.status === 'active' && currentRound.participants?.length === 0 && roundTimer) {
                // If round became empty but timer is running, stop it
                clearInterval(roundTimer); roundTimer = null;
            }
        } else {
            // If DB finds nothing, but there's an in-memory 'currentRound' that's somehow still active/pending/rolling
            // this might indicate a disconnect or a recently ended round not yet cleared from memory.
            // Prefer to signal no active round if DB says so, to force creation of a new one if needed.
            if (currentRound && ['active', 'pending', 'rolling'].includes(currentRound.status)) {
                console.warn(`DB query for current round returned null, but an in-memory round (ID: ${currentRound.roundId}, Status: ${currentRound.status}) exists. This might be stale.`);
                // For safety, if DB is source of truth and says no round, then no round.
                // Unless we are in middle of creating one.
                currentRound = null; // Clear potentially stale in-memory round
            }
        }

        const formattedData = formatRoundForClient(currentRound); // Format whatever currentRound is now
        if (formattedData) {
            res.json(formattedData);
        } else {
            // No active/pending/rolling round in DB or memory, client might need to wait for 'roundCreated'
            res.status(404).json({ error: 'No active, pending, or rolling round found. A new round may be starting.' });
            if (!currentRound && !isProcessingRoundEnd) { // If no round and not currently ending one, try to make one
                ensureInitialRound();
            }
        }
    } catch (err) {
        console.error('Error fetching/formatting current round data for API:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' });
    }
});


app.get('/api/rounds', // For past rounds history
    [query('page').optional().isInt({ min: 1 }).toInt(), query('limit').optional().isInt({ min: 1, max: 50 }).toInt()],
    handleValidationErrors, async (req, res) => {
    try {
        const page = req.query.page || 1; const limit = req.query.limit || 10; const skip = (page - 1) * limit;
        const queryFilter = { status: { $in: ['completed', 'error'] } }; // Only completed or error rounds
        const [rounds, totalCount] = await Promise.all([
            Round.find(queryFilter).sort('-roundId').skip(skip).limit(limit)
                 .populate('winner', 'username avatar steamId')
                 .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount taxedItems payoutOfferId payoutOfferStatus')
                 .lean(),
            Round.countDocuments(queryFilter)
        ]);
        res.json({ rounds, totalPages: Math.ceil(totalCount / limit), currentPage: page, totalRounds: totalCount });
    } catch (err) {
        console.error('Error fetching past rounds:', err);
        res.status(500).json({ error: 'Server error fetching round history.' });
    }
});

app.post('/api/verify', sensitiveActionLimiter,
    [
        body('roundId').notEmpty().isInt({ min: 1 }).toInt(),
        body('serverSeed').trim().notEmpty().isHexadecimal().isLength({ min: 64, max: 64 }),
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 }) // Client seed can vary
    ],
    handleValidationErrors, async (req, res) => {
    const { roundId, serverSeed, clientSeed } = req.body;
    try {
        const round = await Round.findOne({ roundId: roundId, status: 'completed' }) // Only verify completed rounds
             .populate('participants.user', 'username').populate('winner', 'username').lean();
        if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found.` });

        // Verify server seed hash
        const providedHashOfServerSeed = crypto.createHash('sha256').update(serverSeed).digest('hex');
        if (providedHashOfServerSeed !== round.serverSeedHash) {
            return res.json({ verified: false, reason: 'Server Seed Hash mismatch.',
                expectedHash: round.serverSeedHash, providedSeed: serverSeed, calculatedHash: providedHashOfServerSeed });
        }

        // If seeds are provided for verification, they must match the round's actual seeds
        if (round.serverSeed && round.clientSeed && (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed)) {
            return res.json({ verified: false, reason: 'Provided seeds do not match official round seeds.',
                expectedServerSeed: round.serverSeed, expectedClientSeed: round.clientSeed,
                providedServerSeed: serverSeed, providedClientSeed: clientSeed });
        }

        // Calculate provable hash from provided seeds
        const combinedString = serverSeed + clientSeed;
        const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        if (round.provableHash && calculatedProvableHash !== round.provableHash) {
            return res.json({ verified: false, reason: 'Calculated Provable Hash mismatch.',
                expectedProvableHash: round.provableHash, calculatedProvableHash, combinedString });
        }

        // Calculate winning ticket
        const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
        const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;
        if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets.' });
        const calculatedWinningTicket = decimalFromHash % totalTickets;

        if (calculatedWinningTicket !== round.winningTicket) {
            return res.json({ verified: false, reason: 'Calculated winning ticket mismatch.',
                calculatedTicket: calculatedWinningTicket, actualWinningTicket: round.winningTicket,
                provableHashUsed: calculatedProvableHash, totalTickets });
        }

        // If all checks pass
        res.json({
            verified: true, roundId: round.roundId, serverSeed, serverSeedHash: round.serverSeedHash, clientSeed,
            combinedString, finalHash: calculatedProvableHash, winningTicket: calculatedWinningTicket,
            totalTickets, totalValue: round.totalValue,
            winnerUsername: round.winner?.username || 'N/A'
        });
    } catch (err) {
        console.error(`Error verifying round ${roundId}:`, err);
        res.status(500).json({ error: 'Server error during verification.' });
    }
});

// --- Socket.io Connection Handling ---
io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.initialize()(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.session()(socket.request, socket.request.res || {}, next); });

let connectedChatUsers = 0;
const userLastMessageTime = new Map(); // For chat cooldown

io.on('connection', (socket) => {
    connectedChatUsers++;
    io.emit('updateUserCount', connectedChatUsers); // Update all clients
    const user = socket.request.user; // User object from Passport
    if (user && user.username) console.log(`User ${user.username} (Socket ID: ${socket.id}) connected.`);
    else console.log(`Anonymous client (Socket ID: ${socket.id}) connected.`);

    // When a client connects, send them the current round data
    socket.on('requestRoundData', async () => { // Client explicitly requests data
        try {
            // Fetch the most current active/pending/rolling round from DB
            let roundToSend = await Round.findOne({ status: { $in: ['active', 'pending', 'rolling'] } })
                 .sort({ startTime: -1 })
                 .populate('participants.user', 'steamId username avatar _id')
                 .populate('items')
                 .populate('winner', 'steamId username avatar _id')
                 .lean();

            if (roundToSend) {
                currentRound = roundToSend; // Update server's global state
                // If fetched round is active with participants and timer not running, start/sync timer
                if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !roundTimer) {
                     if (currentRound.endTime && new Date(currentRound.endTime) > Date.now()) startRoundTimer(true);
                     else startRoundTimer(false);
                }
            } else if (currentRound && ['active', 'pending', 'rolling'].includes(currentRound.status)) {
                // If DB finds nothing, but memory has a round (e.g., very recently created)
                console.warn(`DB found no active/pending/rolling round for socket request, but in-memory currentRound (ID: ${currentRound.roundId}, Status: ${currentRound.status}) exists. Using in-memory.`);
                roundToSend = currentRound; // Send the in-memory one
            } else {
                // No round in DB or memory, attempt to create one if not already processing an end.
                console.log("No round data available for socket request. Attempting to create a new round if none exists.");
                if (!currentRound || !['active', 'pending', 'rolling'].includes(currentRound.status)) {
                    if (!isProcessingRoundEnd) await createNewRound(); // This will set global currentRound
                    roundToSend = currentRound; // Send the newly created or existing currentRound
                } else {
                    roundToSend = currentRound; // Send the existing currentRound (e.g., if it was being processed)
                }
            }

            const formattedData = formatRoundForClient(roundToSend);
            if (formattedData) {
                socket.emit('roundData', formattedData); // Send to the requesting client
            } else {
                socket.emit('noActiveRound'); // Inform client no round is available
                console.log("Emitted noActiveRound as no suitable round could be formatted.");
            }
        } catch (err) {
            console.error(`Error fetching round data for socket ${socket.id}:`, err);
            socket.emit('roundError', { error: 'Failed to load round data.' });
        }
    });


    socket.on('chatMessage', (msg) => {
        if (!user || !user._id) { // Ensure user is authenticated for chat
            socket.emit('notification', {type: 'error', message: 'You must be logged in to chat.'}); return;
        }
        const userId = user._id.toString();
        const now = Date.now();
        const lastMessageTimeForUser = userLastMessageTime.get(userId) || 0;

        if (now - lastMessageTimeForUser < CHAT_COOLDOWN_SECONDS * 1000) {
            const timeLeft = Math.ceil((CHAT_COOLDOWN_SECONDS * 1000 - (now - lastMessageTimeForUser)) / 1000);
            socket.emit('notification', {type: 'warning', message: `Please wait ${timeLeft}s before sending another message.`});
            return;
        }

        if (typeof msg !== 'string' || msg.trim().length === 0 || msg.trim().length > MAX_CHAT_MESSAGE_LENGTH) {
            socket.emit('notification', {type: 'error', message: `Invalid message. Max ${MAX_CHAT_MESSAGE_LENGTH} characters.`});
            return;
        }

        userLastMessageTime.set(userId, now); // Update last message time

        const messageData = {
            username: user.username,
            avatar: user.avatar || '/img/default-avatar.png',
            message: msg.trim(), // Sanitize/validate further if needed
            userId: userId,
            userSteamId: user.steamId, // For potential linking or display
            timestamp: new Date()
        };
        io.emit('chatMessage', messageData); // Broadcast to all clients
        console.log(`Chat (User: ${user.username}, ID: ${userId}): ${msg.trim()}`);
    });

    socket.on('disconnect', (reason) => {
        connectedChatUsers--;
        io.emit('updateUserCount', connectedChatUsers); // Update all clients
         if (user && user.username) console.log(`User ${user.username} disconnected. Reason: ${reason}`);
         else console.log(`Anonymous client disconnected. Reason: ${reason}`);
    });
});

// --- Server Startup ---
async function startApp() {
    console.log("Performing initial price cache refresh...");
    await refreshPriceCache(); // Initial refresh
    setInterval(async () => { // Scheduled refresh
        try { await refreshPriceCache(); }
        catch (refreshErr) { console.error("Error during scheduled price cache refresh:", refreshErr); }
    }, PRICE_REFRESH_INTERVAL_MS);
    console.log(`Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log(`Site URL configured as: ${process.env.SITE_URL}`);
        if (!isBotConfigured) console.log("INFO: Steam Bot not configured. Trade features disabled.");
        else if (!isBotReady) console.log("INFO: Steam Bot login attempt may have failed or is pending.");
        else console.log("INFO: Steam Bot is ready.");
        ensureInitialRound(); // Ensure a round exists or is created on startup
    });
}

startApp();

function gracefulShutdown() {
    console.log('Received shutdown signal. Closing server...');
    io.close(() => { // Close socket.io connections
        console.log('Socket.IO connections closed.');
    });
    server.close(async () => { // Close HTTP server
        console.log('HTTP server closed.');
        try {
            await mongoose.connection.close(); // Close MongoDB connection
            console.log('MongoDB connection closed.');
            if (manager && typeof manager.shutdown === 'function') {
                 console.log('Stopping TradeOfferManager polling...');
                 manager.shutdown(); // Properly shut down the trade offer manager
            } else if (manager) {
                 console.log('TradeOfferManager will stop on process exit (no explicit shutdown method found).');
            }
            process.exit(0);
        } catch (e) {
            console.error("Error during graceful shutdown:", e);
            process.exit(1);
        }
    });
    // Force shutdown if graceful shutdown takes too long
    setTimeout(() => {
        console.error('Could not close connections gracefully within timeout, forcing shutdown.');
        process.exit(1);
    }, 10000); // 10 seconds timeout
}
process.on('SIGTERM', gracefulShutdown); // For `kill`
process.on('SIGINT', gracefulShutdown);  // For Ctrl+C

// Global error handler
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.');
    if (res.headersSent) return next(err); // If headers already sent, delegate to default Express error handler
    res.status(status).json({ error: message });
});

console.log("app.js backend logic initialized. Event sequence for round end: timer ends -> endRound() -> roundRolling event -> roundWinner event -> tradeOfferSent event -> roundCompleted event.");
