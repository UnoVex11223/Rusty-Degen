// app.js (Corrected and Complete with Winning History & Chat Persistence) - Part 1 of 2

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
const bodyParser = require('body-parser');
const SteamTotp = require('steam-totp');
const axios = require('axios');
const NodeCache = require('node-cache');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, query, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const MongoStore = require('connect-mongo');

const requiredEnvVars = [
    'MONGODB_URI', 'SESSION_SECRET', 'STEAM_API_KEY', 'SITE_URL',
    'STEAM_USERNAME', 'STEAM_PASSWORD', 'STEAM_SHARED_SECRET', 'BOT_TRADE_URL', 'SITE_NAME'
];
const isBotConfigured = process.env.STEAM_USERNAME && process.env.STEAM_PASSWORD && process.env.STEAM_SHARED_SECRET && process.env.BOT_TRADE_URL;
let missingVars = requiredEnvVars.filter(v => !process.env[v] && !(v.startsWith('STEAM_') || v === 'BOT_TRADE_URL' || v === 'SITE_NAME') && isBotConfigured);
if (!isBotConfigured) {
    console.warn("WARN: Steam Bot credentials/config incomplete in .env file. Trading features (including automated rounds and deposits) will be disabled.");
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
const MAX_CHAT_MESSAGES_TO_LOAD = 15; // User requested 15 messages

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: process.env.SITE_URL || "*", methods: ["GET", "POST"] } });

app.set('trust proxy', 1);
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "default-src": ["'self'"],
            "script-src": ["'self'", "/socket.io/socket.io.js", "'unsafe-inline'"], // Allow socket.io and inline scripts if needed (main.js might be inline)
            "script-src-attr": ["'self'", "'unsafe-inline'"],
            "style-src": ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "'unsafe-inline'"],
            "img-src": ["'self'", "data:", "*.steamstatic.com", "*.akamai.steamstatic.com"], // Allow Steam images
            "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            "connect-src": (() => {
                const sources = ["'self'"];
                const siteUrl = process.env.SITE_URL;
                if (siteUrl) {
                    try {
                        const url = new URL(siteUrl);
                        sources.push(`ws://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(`wss://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(siteUrl); // For API calls from client
                    } catch (e) {
                        console.error("Invalid SITE_URL for CSP connect-src:", siteUrl, e);
                    }
                }
                sources.push("https://rust.scmm.app"); // For price fetching
                return sources;
            })(),
            "frame-src": ["'self'", "https://steamcommunity.com"], // For Steam login iframe
            "frame-ancestors": ["'self'", "https://steamcommunity.com"], // Allow embedding by Steam if needed
            "object-src": ["'none'"], // Disallow <object>
            "upgrade-insecure-requests": [], // Upgrade HTTP to HTTPS
        },
    })
);

const generalApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many login attempts from this IP, please try again after 10 minutes', standardHeaders: true, legacyHeaders: false });
const sensitiveActionLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, message: 'Too many requests for this action, please try again after 5 minutes', standardHeaders: true, legacyHeaders: false });
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 10, message: 'Too many deposit attempts, please wait a minute.', standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Too many chat messages from this IP. Please wait a moment.', standardHeaders: true, legacyHeaders: false });

app.use('/api/', generalApiLimiter); // Apply general limiter to all /api routes
app.use(cors({ origin: process.env.SITE_URL || "*", credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

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
        maxAge: 3600000 * 24, // 24 hours
        secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
        httpOnly: true,
        sameSite: 'lax' // Recommended for most cases
    }
});
app.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

// IMPORTANT: Steam Bot login is CRITICAL for game rounds and deposits.
// Ensure STEAM_USERNAME, STEAM_PASSWORD, and STEAM_SHARED_SECRET are correct in your .env file.
// Check server logs for bot login status.
passport.use(new SteamStrategy({
    returnURL: `${process.env.SITE_URL}/auth/steam/return`,
    realm: process.env.SITE_URL,
    apiKey: process.env.STEAM_API_KEY,
    providerURL: 'https://steamcommunity.com/openid' // Standard OpenID URL for Steam
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

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Successfully connected to MongoDB.'))
    .catch(err => {
        console.error('MongoDB Connection Error:', err);
        process.exit(1);
    });

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
    endTime: { type: Date },
    completedTime: { type: Date },
    totalValue: { type: Number, default: 0, min: 0 }, // This will be the after-tax value for winner
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
    taxedItems: [{ assetId: String, name: String, price: { type: Number, min: 0 }, image: String }] // Added image for tax record
});
roundSchema.index({ 'participants.user': 1 });

const winningRecordSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    round: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true, index: true },
    roundDisplayId: { type: Number, required: true },
    amountWon: { type: Number, required: true, min: 0 },
    tradeOfferId: { type: String, index: true },
    tradeOfferURL: { type: String },
    tradeOfferStatus: {
        type: String,
        enum: ['pending', 'sent', 'accepted', 'declined', 'expired', 'canceled', 'error', 'unknown'],
        default: 'pending'
    },
    itemsWon: [{ assetId: String, name: String, price: Number, image: String }],
    createdAt: { type: Date, default: Date.now }
});

const chatMessageSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    steamId: { type: String, index: true },
    username: { type: String, required: true },
    avatar: { type: String },
    message: { type: String, required: true, maxlength: MAX_CHAT_MESSAGE_LENGTH },
    isSystemMessage: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now, index: true }
});


const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);
const WinningRecord = mongoose.model('WinningRecord', winningRecordSchema);
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);


const community = new SteamCommunity();
const manager = new TradeOfferManager({
    steam: community,
    domain: process.env.SITE_URL ? process.env.SITE_URL.replace(/^https?:\/\//, '') : 'localhost',
    language: 'en',
    pollInterval: 10000, // Poll for new trade offers every 10 seconds
    cancelTime: 10 * 60 * 1000, // Automatically cancel sent offers after 10 minutes if not accepted
});
let isBotReady = false; // This flag is crucial for deposits to be open
const pendingDeposits = new Map(); // Stores info about deposit offers sent to users

function generateAuthCode() {
    const secret = process.env.STEAM_SHARED_SECRET;
    if (!secret) { console.error("STEAM_SHARED_SECRET missing in .env. Cannot generate 2FA code for bot login."); return null; }
    try { return SteamTotp.generateAuthCode(secret); }
    catch (e) { console.error("Error generating 2FA code for bot:", e); return null; }
}

if (isBotConfigured) {
    const loginCredentials = {
        accountName: process.env.STEAM_USERNAME,
        password: process.env.STEAM_PASSWORD,
        twoFactorCode: generateAuthCode()
    };
    if (loginCredentials.twoFactorCode) {
        console.log(`Attempting Steam login for bot: ${loginCredentials.accountName}... (This is essential for game rounds and deposits)`);
        community.login(loginCredentials, (err, sessionID, cookies, steamguard) => {
            if (err) {
                console.error('STEAM BOT LOGIN ERROR (Callback Err Object):', { message: err.message, eresult: err.eresult, emaildomain: err.emaildomain });
            } else {
                console.log('Steam community.login callback received (no immediate error object reported).');
            }
            if (err || !community.steamID) {
                console.error(`CRITICAL BOT LOGIN FAILURE: Login callback failed or community.steamID is undefined. Error: ${err ? err.message : 'N/A'}, SteamID: ${community.steamID}, EResult: ${err?.eresult}`);
                console.error("==> BOT LOGIN FAILED. Game rounds and deposits will NOT function correctly. Check .env credentials and Steam Guard. <==");
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
                    console.error("==> BOT COOKIE SETUP FAILED. Trading functions may not work. <==");
                    isBotReady = false; return;
                }
                console.log('TradeOfferManager cookies set successfully.');
                community.setCookies(cookies); // Also set cookies for general community interactions
                isBotReady = true;
                console.log("SUCCESS: Steam Bot is ready and operational. Game rounds and deposits should now function.");
                ensureInitialRound(); // Try to start a round now that bot is ready
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
        console.warn("Could not generate 2FA code. Steam Bot login skipped. Deposits and rounds will not work.");
        isBotReady = false;
    }
} else {
    console.warn("Steam Bot not configured in .env file. Deposits and automated game rounds will be disabled.");
    isBotReady = false;
}

let currentRound = null;
let roundTimer = null;
let isRolling = false; // Flag to indicate if a round is currently in the "rolling" (winner selection) phase

const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false });

function getFallbackPrice(marketHashName) {
    // console.warn(`Price not found for "${marketHashName}". Using fallback: $${MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0}`);
    return MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0; // Return minimum value or 0 if not set
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
                    const priceInDollars = item.price / 100.0; // Convert cents to dollars
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

async function createNewRound() {
    if (isRolling) {
        console.log("Cannot create new round: Current round is rolling.");
        return null;
    }
    // It's okay if currentRound exists and is active, this function might be called to ensure one is running.
    // However, we should avoid creating multiple parallel active rounds. This check can be more robust.
    if (currentRound && currentRound.status === 'active') {
        console.log(`Cannot create new round: Round ${currentRound.roundId} is already active.`);
        return currentRound; // Return the existing active round
    }

    try {
        isRolling = false; // Ensure rolling flag is reset
        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');

        const lastRound = await Round.findOne().sort('-roundId');
        const nextRoundId = lastRound ? lastRound.roundId + 1 : 1;

        const newRound = new Round({
            roundId: nextRoundId,
            status: 'active', // New rounds start as active
            startTime: new Date(),
            serverSeed: serverSeed,
            serverSeedHash: serverSeedHash,
            items: [],
            participants: [],
            totalValue: 0
        });
        await newRound.save();
        currentRound = newRound.toObject(); // Update global currentRound

        io.emit('roundCreated', {
            roundId: newRound.roundId,
            serverSeedHash: newRound.serverSeedHash,
            timeLeft: ROUND_DURATION, // Initial time for a new round
            totalValue: 0,
            participants: [],
            items: []
        });
        console.log(`--- Round ${newRound.roundId} created and active ---`);
        // If no participants yet, the timer won't start automatically here.
        // It starts when the first participant joins (handled in deposit logic) or if loaded from DB with participants.
        return newRound.toObject();
    } catch (err) {
        console.error('FATAL: Error creating new round:', err);
        setTimeout(createNewRound, 10000); // Retry after 10 seconds
        return null;
    }
}
// MODIFIED ensureInitialRound:
// This function is crucial. If the bot is ready, it ensures there's an active round.
// If 'currentRound' exists but is in a stale state (e.g. 'pending' or 'error'),
// it will now attempt to find another active round in DB or create a new one.
async function ensureInitialRound() {
    if (isBotConfigured && isBotReady) {
        // If currentRound is falsy, or if it exists but is not 'active' and not 'rolling'
        // (e.g., stuck in 'pending' or 'error' from a previous state, or completed but next one not made)
        // This ensures we try to get an active round if the current one isn't usable for new deposits.
        if (!currentRound || (currentRound && currentRound.status !== 'active' && currentRound.status !== 'rolling')) {
            console.log(`ensureInitialRound: Current round state is (currentRound: ${!!currentRound}, status: ${currentRound?.status}). Re-evaluating or creating round.`);
            try {
                // First, try to find an existing truly 'active' round in the database
                const existingActiveDbRound = await Round.findOne({ status: 'active' })
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items')
                    .lean();

                if (existingActiveDbRound) {
                    console.log(`ensureInitialRound: Found existing active round ${existingActiveDbRound.roundId} in DB.`);
                    currentRound = existingActiveDbRound;
                    // If this round has participants and an end time that's in the future, and no timer is running, start it.
                    if (currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        console.log(`Resuming timer for round ${currentRound.roundId} from DB state.`);
                        startRoundTimer(true); // true to use remaining time
                    } else if (currentRound.participants.length > 0 && !currentRound.endTime && !roundTimer) {
                        // If it has participants but somehow no end time (should be rare for an active round from DB), start timer now.
                        console.warn(`Active round ${currentRound.roundId} from DB has participants but no endTime. Starting timer.`);
                        startRoundTimer(false);
                    }
                    // If it's active but has no participants, timer will start on first deposit.
                } else {
                    // No active round found in DB, so create a brand new one.
                    console.log("ensureInitialRound: No active round found in DB, creating initial round...");
                    await createNewRound(); // This will set currentRound, status 'active', and emit 'roundCreated'
                                            // Timer for this new empty round will start on first deposit.
                }
            } catch (dbErr) {
                console.error("Error during ensureInitialRound's DB check/creation:", dbErr);
                // Potentially retry or handle error, for now, it might lead to no active round.
            }
        } else if (currentRound && currentRound.status === 'active') {
             console.log(`ensureInitialRound: Round ${currentRound.roundId} is already active. Participants: ${currentRound.participants?.length || 0}. Timer running: ${!!roundTimer}`);
             // If it's active, has participants, an end time in future, but timer isn't running (e.g. after a quick restart)
             if (currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                 console.log(`Resuming timer for already active round ${currentRound.roundId}.`);
                 startRoundTimer(true);
             } else if (currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) {
                 console.warn(`Current active round ${currentRound.roundId} has participants but no endTime. Starting timer.`);
                 startRoundTimer(false);
             }
        } else if (currentRound && currentRound.status === 'rolling') {
            console.log(`ensureInitialRound: Round ${currentRound.roundId} is currently rolling. Waiting for it to complete.`);
            // No action needed, endRound will eventually call createNewRound.
        }
    } else if (isBotConfigured && !isBotReady) {
        console.log("Bot is configured but not ready. Skipping initial round check. Deposits will be closed until bot is operational.");
    } else {
        console.log("Bot is not configured. Skipping initial round check. Deposits will be closed.");
    }
}


function startRoundTimer(useRemainingTime = false) {
    if (roundTimer) clearInterval(roundTimer); // Clear existing timer
    if (!currentRound || currentRound.status !== 'active') {
        console.warn("Cannot start timer: No active round or round status invalid.");
        return;
    }

    let timeLeft;
    let calculatedEndTime;

    if (useRemainingTime && currentRound.endTime) {
        calculatedEndTime = new Date(currentRound.endTime);
        timeLeft = Math.max(0, Math.floor((calculatedEndTime.getTime() - Date.now()) / 1000));
        console.log(`Resuming timer for round ${currentRound.roundId} with ${timeLeft}s remaining.`);
    } else {
        // Standard start for a new round or if remaining time cannot be used
        timeLeft = ROUND_DURATION;
        calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
        currentRound.endTime = calculatedEndTime; // Update in-memory round object
        // Asynchronously update the database
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
            .catch(e => console.error(`Error saving round end time for round ${currentRound?.roundId}:`, e));
        console.log(`Starting timer for round ${currentRound.roundId} (${ROUND_DURATION}s). End time: ${calculatedEndTime.toISOString()}`);
    }

    io.emit('timerUpdate', { timeLeft }); // Initial timer update to clients

    roundTimer = setInterval(async () => {
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) {
            clearInterval(roundTimer); roundTimer = null;
            console.warn("Timer stopped: Round state became invalid during countdown.");
            return;
        }

        const now = Date.now();
        let currenttimeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - now) / 1000));

        io.emit('timerUpdate', { timeLeft: currenttimeLeft });

        if (currenttimeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null;
            console.log(`Round ${currentRound.roundId} timer reached zero.`);
            await endRound(); // End the round
        }
    }, 1000);
}

// app.js (Corrected and Complete with Winning History & Chat Persistence) - Part 2 of 2

async function endRound() {
    if (!currentRound || isRolling || currentRound.status !== 'active') {
        console.warn(`Attempted to end round ${currentRound?.roundId}, but state is invalid (Status: ${currentRound?.status}, Rolling: ${isRolling})`);
        return;
    }
    isRolling = true; // Set rolling flag at the beginning
    const roundIdToEnd = currentRound.roundId;
    const roundMongoId = currentRound._id; // Use the MongoDB _id for updates
    console.log(`--- Ending round ${roundIdToEnd}... ---`);

    try {
        // Update status to 'rolling' in DB first
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } });
        io.emit('roundRolling', { roundId: roundIdToEnd }); // Notify clients

        // Fetch the complete round data for processing
        const round = await Round.findById(roundMongoId)
            .populate('participants.user', 'steamId username avatar tradeUrl') // Ensure tradeUrl is populated for winner
            .populate('items')
            .lean(); // Use lean for performance as we're not modifying this fetched doc directly for save

        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);
        if (round.status !== 'rolling') {
             console.warn(`Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Current status: ${round.status}. Aborting endRound.`);
             isRolling = false; // Reset rolling state if something went wrong
             return;
        }
        currentRound = round; // Update global currentRound to this 'rolling' state (it's a lean object)

        // Handle cases with no participants or value
        if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            console.log(`Round ${round.roundId} ended with no valid participants or value.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date() } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants." });
            isRolling = false;
            setTimeout(createNewRound, 5000); // Schedule next round
            return;
        }

        // --- Tax Calculation ---
        let finalItemsForWinner = [...round.items]; // Items to potentially give to winner
        let potValueForWinner = round.totalValue;
        let taxAmount = 0;
        let taxedItemsInfo = []; // For storing info about items taken as tax
        let itemsToTakeForTaxIds = []; // Store ObjectIds of items taken for tax

        if (potValueForWinner >= MIN_POT_FOR_TAX) {
            const targetTaxValue = potValueForWinner * (TAX_MIN_PERCENT / 100);
            const maxTaxValue = potValueForWinner * (TAX_MAX_PERCENT / 100);
            // Sort items by price (ascending) to take smallest items first for tax
            const sortedItemsForTax = [...finalItemsForWinner].sort((a, b) => a.price - b.price);
            let currentTaxValueAccumulated = 0;

            for (const item of sortedItemsForTax) {
                if (currentTaxValueAccumulated + item.price <= maxTaxValue) {
                    itemsToTakeForTaxIds.push(item._id.toString()); // Store the MongoDB _id as string
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price, image: item.image });
                    currentTaxValueAccumulated += item.price;
                    if (currentTaxValueAccumulated >= targetTaxValue) break; // Stop if target tax is met or exceeded
                } else {
                    // Adding this item would exceed maxTaxValue, so stop
                    break;
                }
            }

            if (itemsToTakeForTaxIds.length > 0) {
                const taxedItemsObjectIdSet = new Set(itemsToTakeForTaxIds);
                finalItemsForWinner = finalItemsForWinner.filter(item => !taxedItemsObjectIdSet.has(item._id.toString()));
                taxAmount = currentTaxValueAccumulated;
                potValueForWinner -= taxAmount; // Adjust winner's pot value
                console.log(`Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${itemsToTakeForTaxIds.length} items). New Pot Value for Winner: $${potValueForWinner.toFixed(2)}`);
            }
        }
        // --- End Tax Calculation ---

        // --- Winner Selection ---
        const clientSeed = crypto.randomBytes(16).toString('hex'); // Generate client seed at end of round
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');

        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16); // Use first 8 hex chars for decimal
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);

        if (totalTickets <= 0) throw new Error(`Cannot determine winner: Total tickets is zero or invalid for round ${round.roundId}.`);

        const winningTicket = decimalFromHash % totalTickets;
        let cumulativeTickets = 0;
        let winnerInfo = null; // This will be the full user object from populated participants

        for (const participant of round.participants) {
            if (!participant?.tickets || !participant.user) continue; // Skip if participant data is malformed
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winnerInfo = participant.user; // winnerInfo is now the populated user object
                break;
            }
        }

        if (!winnerInfo || !winnerInfo._id) throw new Error(`Winner selection failed for round ${round.roundId}. Winning Ticket: ${winningTicket}, Total Tickets: ${totalTickets}`);
        // --- End Winner Selection ---

        // Update winner's stats
        try {
            const updatedWinnerUser = await User.findByIdAndUpdate(
                winnerInfo._id,
                { $inc: { totalWinningsValue: potValueForWinner } },
                { new: true }
            );
            if (updatedWinnerUser) {
                console.log(`Updated winnings stats for ${updatedWinnerUser.username}: New total winnings $${updatedWinnerUser.totalWinningsValue.toFixed(2)}`);
            } else {
                console.warn(`Could not find user ${winnerInfo.username} to update winnings stats.`);
            }
        } catch (statError) {
            console.error(`Error updating winnings stats for user ${winnerInfo.username}:`, statError);
        }


        const finalUpdateData = {
            status: 'completed',
            completedTime: new Date(),
            clientSeed: clientSeed,
            provableHash: provableHash,
            winningTicket: winningTicket,
            winner: winnerInfo._id, // Store winner's ObjectId
            taxAmount: taxAmount,
            taxedItems: taxedItemsInfo, // Store info of items taken as tax
            totalValue: potValueForWinner, // Store the after-tax value actually won
            items: finalItemsForWinner.map(i => i._id) // Store ObjectIds of items given to winner
        };

        await Round.updateOne({ _id: roundMongoId }, { $set: finalUpdateData });
        console.log(`Round ${round.roundId} completed. Winner: ${winnerInfo.username} (Ticket: ${winningTicket}/${totalTickets}, Value Won: $${potValueForWinner.toFixed(2)})`);

        io.emit('roundWinner', {
            roundId: round.roundId,
            winner: { id: winnerInfo._id, steamId: winnerInfo.steamId, username: winnerInfo.username, avatar: winnerInfo.avatar },
            winningTicket: winningTicket,
            totalValue: potValueForWinner, // After-tax value
            totalTickets: totalTickets,
            serverSeed: round.serverSeed, // Reveal server seed
            clientSeed: clientSeed,
            provableHash: provableHash,
            serverSeedHash: round.serverSeedHash // Original hash
        });

        // Send trade offer with remaining items
        await sendWinningTradeOffer(round, winnerInfo, finalItemsForWinner, potValueForWinner);

    } catch (err) {
        console.error(`CRITICAL ERROR during endRound for round ${roundIdToEnd}:`, err);
        try {
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error' } });
            io.emit('roundError', { roundId: roundIdToEnd, error: 'Internal server error during round finalization.' });
        } catch (saveErr) {
            console.error(`Failed to mark round ${roundIdToEnd} as error after initial error:`, saveErr);
        }
    } finally {
        isRolling = false; // Reset rolling flag
        console.log(`Scheduling next round creation after round ${roundIdToEnd} finalization.`);
        setTimeout(createNewRound, 10000); // Schedule the creation of the next round
    }
}

async function sendWinningTradeOffer(roundData, winner, itemsToSend, amountActuallyWon) {
    if (!isBotReady) {
        console.error(`PAYOUT_ERROR: Cannot send winnings for round ${roundData.roundId}: Steam Bot is not ready.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Bot Error: Payout for round ${roundData.roundId} requires manual processing. Contact support.` });
        await WinningRecord.create({
            user: winner._id, round: roundData._id, roundDisplayId: roundData.roundId,
            amountWon: amountActuallyWon, itemsWon: itemsToSend.map(i => ({ assetId: i.assetId, name: i.name, price: i.price, image: i.image })),
            tradeOfferStatus: 'error', tradeOfferId: null, tradeOfferURL: null
        }).catch(e => console.error("Error creating error winning record (bot not ready):", e));
        return;
    }
    if (!winner.tradeUrl) {
        console.error(`PAYOUT_ERROR: Cannot send winnings for round ${roundData.roundId}: Winner ${winner.username} has no Trade URL set.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Please set your Trade URL in your profile to receive winnings.' });
        await WinningRecord.create({
            user: winner._id, round: roundData._id, roundDisplayId: roundData.roundId,
            amountWon: amountActuallyWon, itemsWon: itemsToSend.map(i => ({ assetId: i.assetId, name: i.name, price: i.price, image: i.image })),
            tradeOfferStatus: 'error', tradeOfferId: null, tradeOfferURL: 'No Trade URL'
        }).catch(e => console.error("Error creating error winning record (no trade url):", e));
        return;
    }
    if (!itemsToSend || itemsToSend.length === 0) {
        console.log(`PAYOUT_INFO: No items to send for round ${roundData.roundId}.`);
        // If pot was fully taxed out
        if (roundData.taxAmount > 0 && amountActuallyWon <= 0) {
            io.emit('notification', { type: 'info', userId: winner._id.toString(), message: `Round ${roundData.roundId} winnings ($${roundData.taxAmount.toFixed(2)}) were processed as site tax. No items to send.` });
            await WinningRecord.create({
                user: winner._id, round: roundData._id, roundDisplayId: roundData.roundId,
                amountWon: 0, itemsWon: [],
                tradeOfferStatus: 'accepted', // Marking as accepted as it's "processed"
                tradeOfferId: `TAXED_OUT_${roundData.roundId}`, tradeOfferURL: null,
                // tradeOfferMessage: 'Winnings fully consumed by site tax.' // Not a field in schema, can add if needed
            }).catch(e => console.error("Error creating winning record (taxed out):", e));
        }
        return;
    }

    console.log(`Attempting to send ${itemsToSend.length} winning items (value: $${amountActuallyWon.toFixed(2)}) for round ${roundData.roundId} to ${winner.username}...`);
    let winningRecord;

    try {
        const offer = manager.createOffer(winner.tradeUrl);
        offer.addMyItems(itemsToSend.map(item => ({
            assetid: item.assetId, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID
        })));
        const offerMessage = `Congratulations! Your winnings from Round #${roundData.roundId} on ${process.env.SITE_NAME || 'RustyDegen'}. Pot Value (after tax): $${amountActuallyWon.toFixed(2)}`;
        offer.setMessage(offerMessage);

        winningRecord = await WinningRecord.create({
            user: winner._id,
            round: roundData._id,
            roundDisplayId: roundData.roundId,
            amountWon: amountActuallyWon,
            itemsWon: itemsToSend.map(i => ({ assetId: i.assetId, name: i.name, price: i.price, image: i.image })),
            tradeOfferStatus: 'pending',
        });

        const identitySecret = process.env.STEAM_IDENTITY_SECRET; // For auto-confirming trades if set
        offer.send(!!identitySecret, async (err, status) => {
            if (err) {
                console.error(`PAYOUT_ERROR: Error sending trade offer for round ${roundData.roundId}. Offer ID (if any): ${offer.id}. EResult: ${err.eresult}, Msg: ${err.message}`);
                let userMessage = `Error sending winnings for round ${roundData.roundId}. Please contact support.`;
                let offerStatusForRecord = 'error';

                if (err.message.includes('revoked') || err.message.includes('invalid') || err.eresult === 26) { // ETradeOfferConfirmationMethod.InvalidToken
                    userMessage = 'Your Trade URL is invalid or expired. Please update it to receive winnings.';
                } else if (err.eresult === 15 || err.eresult === 16) { // k_EResultAccessDenied, k_EResultTimeout
                    userMessage = 'Could not send winnings. Ensure your Steam inventory is public and not full.';
                } else if (err.message?.includes('escrow') || err.eresult === 11) { // k_EResultFail (often for escrow)
                    userMessage = `Winnings sent (Offer #${offer.id}), but may be held in escrow by Steam.`;
                    offerStatusForRecord = 'pending'; // Still pending from our side, Steam holds it
                }
                io.emit('notification', { type: 'error', userId: winner._id.toString(), message: userMessage });

                if (winningRecord) {
                    winningRecord.tradeOfferId = offer.id || `ERROR_${Date.now()}`;
                    winningRecord.tradeOfferStatus = offerStatusForRecord;
                    winningRecord.tradeOfferURL = offer.id ? `https://steamcommunity.com/tradeoffer/${offer.id}/` : null;
                    await winningRecord.save().catch(e => console.error("Error updating winning record on send failure:", e));
                }
                return;
            }

            console.log(`PAYOUT_SUCCESS: Trade offer ${offer.id} sent to ${winner.username} for round ${roundData.roundId}. Status: ${status}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;

            if (winningRecord) {
                winningRecord.tradeOfferId = offer.id;
                winningRecord.tradeOfferURL = offerURL;
                winningRecord.tradeOfferStatus = (status === 'pending' || status === 'pendingConfirmation' || status === 'sent') ? 'sent' : 'unknown';
                await winningRecord.save().catch(e => console.error("Error updating winning record on send success:", e));
            }

            io.emit('tradeOfferSent', {
                roundId: roundData.roundId, userId: winner._id.toString(), username: winner.username,
                offerId: offer.id, offerURL: offerURL, status: status
            });

            let notificationType = 'info';
            let notificationMessage = `Winnings sent (Offer #${offer.id}). Check Steam.`;
            if (status === 'pending' || status === 'pendingConfirmation') {
                notificationType = 'warning';
                notificationMessage = `Winnings sent (Offer #${offer.id}), but confirmation may be needed in Steam.`;
                if (!identitySecret) {
                    notificationMessage = `Winnings sent (Offer #${offer.id}), but require confirmation in Steam.`;
                }
            }
            io.emit('notification', { type: notificationType, userId: winner._id.toString(), message: notificationMessage });
        });
    } catch (err) {
        console.error(`PAYOUT_ERROR: Unexpected error creating/sending trade offer for round ${roundData.roundId}:`, err);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Error sending winnings for round ${roundData.roundId}. Please contact support.` });
        if (winningRecord && !winningRecord.tradeOfferId) {
            winningRecord.tradeOfferStatus = 'error';
            winningRecord.tradeOfferId = `SETUP_ERROR_${Date.now()}`;
            await winningRecord.save().catch(e => console.error("Error updating winning record on critical payout error:", e));
        } else if (winningRecord) {
            winningRecord.tradeOfferStatus = 'error';
             await winningRecord.save().catch(e => console.error("Error updating winning record on critical payout error (ID known):", e));
        }
    }
}


// --- AUTH ROUTES ---
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

// Middleware to ensure authentication
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) { return next(); }
    res.status(401).json({ error: 'Not authenticated' });
}
// Middleware for handling validation errors
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.warn("Validation Errors:", errors.array());
        return res.status(400).json({ error: errors.array()[0].msg }); // Return only the first error message
    }
    next();
};

// --- API ROUTES ---
app.get('/api/user', ensureAuthenticated, (req, res) => {
    // Send relevant user data, excluding sensitive info like mongoose version key
    const { _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue });
});

app.get('/api/user/winning-history', ensureAuthenticated, async (req, res) => {
    try {
        const winnings = await WinningRecord.find({ user: req.user._id })
            .populate('round', 'roundId provableHash')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        const formattedWinnings = winnings.map(w => ({
            gameId: w.round?.provableHash || `R-${w.roundDisplayId}`,
            roundDisplayId: w.roundDisplayId,
            amountWon: w.amountWon,
            tradeOfferId: w.tradeOfferId,
            tradeOfferURL: w.tradeOfferURL,
            tradeOfferStatus: w.tradeOfferStatus,
            timestamp: w.createdAt,
        }));
        res.json(formattedWinnings);
    } catch (error) {
        console.error(`Error fetching winning history for user ${req.user._id}:`, error);
        res.status(500).json({ error: 'Server error fetching winning history.' });
    }
});


app.post('/api/user/tradeurl',
    sensitiveActionLimiter, ensureAuthenticated,
    [
        body('tradeUrl').trim().custom((value) => {
            if (value === '') return true; // Allow empty string to clear URL
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
            if (err.name === 'ValidationError') { // Mongoose validation error
                 console.error(`Trade URL Validation Error (Mongoose) for user ${req.user._id}:`, err.message);
                 return res.status(400).json({ error: err.message });
            }
            console.error(`Error updating trade URL for user ${req.user._id}:`, err);
            res.status(500).json({ error: 'Server error saving Trade URL.' });
        }
    }
);

app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    if (!isBotReady) { // Bot must be ready to interact with Steam inventories via manager
        console.warn(`Inventory fetch failed for ${req.user.username}: Bot service is unavailable.`);
        return res.status(503).json({ error: "Steam service temporarily unavailable. Please try again later." });
    }
    try {
        const inventory = await new Promise((resolve, reject) => {
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                if (err) {
                    if (err.message?.includes('profile is private') || err.eresult === 15) { // k_EResultAccessDenied
                        return reject(new Error('Your Steam inventory is private. Please set it to public.'));
                    }
                    console.error(`Inventory Fetch Error (Manager): User ${req.user.steamId}: EResult ${err.eresult} - ${err.message || err}`);
                    return reject(new Error(`Could not fetch inventory. Steam might be busy or inventory private.`));
                }
                resolve(inv || []); // Ensure it's an array
            });
        });

        if (!inventory?.length) return res.json([]); // Return empty array if no items

        const validItems = inventory.map(item => {
                const itemName = item.market_hash_name;
                let price = 0;
                if (itemName) price = getItemPrice(itemName); // Get price from cache or fallback
                else console.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`);

                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

                if (!item.assetid || !item.icon_url || !itemName) { // Essential properties
                    console.warn(`Inventory item missing required properties: assetId ${item?.assetid}, Name ${itemName}, Icon ${item?.icon_url}`);
                    return null; // Skip this item
                }
                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`;
                return { assetId: item.assetid, name: itemName, image: imageUrl, price: finalPrice, tradable: item.tradable };
            })
            .filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE); // Filter out untradable, null, or below min value
        res.json(validItems);
    } catch (err) {
        console.error(`Error in /api/inventory for ${req.user?.username || req.user?.steamId}:`, err.message);
        res.status(500).json({ error: err.message || 'Server error fetching inventory.' });
    }
});

app.post('/api/deposit', depositLimiter, ensureAuthenticated,
    [
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`You can deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items at a time.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.') // Basic validation for asset IDs
    ],
    handleValidationErrors,
    async (req, res) => {
        const user = req.user;
        const requestedAssetIds = req.body.assetIds;

        if (!isBotReady) return res.status(503).json({ error: "Deposit service temporarily unavailable (Bot offline)." });
        if (!user.tradeUrl) return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile before depositing.' });

        // Check for existing pending deposit offer for this user
        if (user.pendingDepositOfferId) {
             try {
                 const offer = await manager.getOffer(user.pendingDepositOfferId);
                 // Check if the offer is still active or awaiting action from user/bot
                 if (offer && [TradeOfferManager.ETradeOfferState.Active, TradeOfferManager.ETradeOfferState.Sent, TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation].includes(offer.state)) {
                     console.log(`User ${user.username} already has pending deposit offer ${user.pendingDepositOfferId}. State: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
                     const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                     return res.status(409).json({ error: 'You already have an active deposit offer waiting. Please accept or decline it on Steam.', offerId: user.pendingDepositOfferId, offerURL: offerURL });
                 } else {
                      // Offer is no longer active (e.g., accepted, declined, expired), clear the flag
                      console.log(`Clearing stale pending offer ${user.pendingDepositOfferId} for user ${user.username} (State: ${TradeOfferManager.ETradeOfferState[offer?.state]}).`);
                      await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
                 }
             } catch (offerFetchError) {
                 // If getOffer fails (e.g., offer doesn't exist anymore), clear the flag
                 console.warn(`Could not fetch pending offer ${user.pendingDepositOfferId}, clearing flag:`, offerFetchError.message);
                 await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
             }
        }
        // This is the primary server-side check for allowing deposits into a round
        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }

        // Check round limits (participants, items)
        let latestRoundData;
        try {
            latestRoundData = await Round.findById(currentRound._id).select('participants items').lean().exec();
            if (!latestRoundData) throw new Error('Could not fetch current round data for limits check.');

            const isNewParticipant = !latestRoundData.participants.some(p => p.user?.toString() === user._id.toString());
            if (isNewParticipant && latestRoundData.participants.length >= MAX_PARTICIPANTS) {
                 return res.status(400).json({ error: `Participant limit (${MAX_PARTICIPANTS}) reached for this round.` });
            }
            if (latestRoundData.items.length + requestedAssetIds.length > MAX_ITEMS_PER_POT) {
                 const slotsLeft = MAX_ITEMS_PER_POT - latestRoundData.items.length;
                 return res.status(400).json({ error: `Depositing ${requestedAssetIds.length} items would exceed pot limit (${MAX_ITEMS_PER_POT}). ${slotsLeft > 0 ? `${slotsLeft} slots left.` : 'Pot is full.'}` });
            }
        } catch (dbErr) {
            console.error(`Error fetching round data during deposit for ${user.username}:`, dbErr);
            return res.status(500).json({ error: 'Internal server error checking round limits.' });
        }

        let itemsToRequest = []; // Items verified and ready for the trade offer
        let depositTotalValue = 0;

        // Verify items in user's inventory
        try {
            console.log(`Verifying inventory for ${user.username} (SteamID: ${user.steamId}) to confirm deposit items...`);
            const userInventory = await new Promise((resolve, reject) => {
                manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                    if (err) {
                        if (err.message?.includes('profile is private') || err.eresult === 15) return reject(new Error('Your Steam inventory is private.'));
                        console.error(`Inventory Fetch Error (Deposit Verification): User ${user.steamId}: EResult ${err.eresult}`, err);
                        return reject(new Error(`Could not fetch your inventory. Ensure it's public.`));
                    }
                    resolve(inv || []);
                });
            });
            const userInventoryMap = new Map(userInventory.map(item => [item.assetid, item])); // Map for quick lookup

            for (const assetId of requestedAssetIds) {
                const inventoryItem = userInventoryMap.get(assetId);
                if (!inventoryItem) throw new Error(`Item with Asset ID ${assetId} was not found in your inventory.`);
                if (!inventoryItem.tradable) throw new Error(`Item '${inventoryItem.market_hash_name}' is not tradable.`);

                const price = getItemPrice(inventoryItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) throw new Error(`Item '${inventoryItem.market_hash_name}' (value $${price.toFixed(2)}) is below the minimum deposit value of $${MIN_ITEM_VALUE}.`);

                itemsToRequest.push({ // Store item details for processing after trade acceptance
                    assetid: inventoryItem.assetid, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID,
                    _price: price, // Store price directly for later use
                    _name: inventoryItem.market_hash_name,
                     _image: `https://community.akamai.steamstatic.com/economy/image/${inventoryItem.icon_url}`
                });
                depositTotalValue += price;
            }
             if (itemsToRequest.length === 0) throw new Error("No valid items could be verified for deposit from your selection.");
             console.log(`Verified ${itemsToRequest.length} items for deposit for ${user.username}. Total Value: $${depositTotalValue.toFixed(2)}`);
        } catch (verificationError) {
            console.warn(`Deposit item verification failed for ${user.username}:`, verificationError.message);
            return res.status(400).json({ error: verificationError.message });
        }

        const depositId = uuidv4(); // Unique ID for this deposit attempt
        const offerMessage = `RustyDegen Deposit ID: ${depositId} | Round: ${currentRound.roundId} | Items: ${itemsToRequest.length} | Value: $${depositTotalValue.toFixed(2)}`;
        let cleanupTimeout = null; // For cleaning up pendingDeposits entry if offer expires

        try {
            const offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsToRequest.map(({ assetid, appid, contextid }) => ({ assetid, appid, contextid }))); // We are requesting THEIR items
            offer.setMessage(offerMessage);

            // Store pending deposit details
            pendingDeposits.set(depositId, {
                userId: user._id, roundId: currentRound._id, items: itemsToRequest, // itemsToRequest contains _price, _name, _image
                totalValue: depositTotalValue, steamId: user.steamId
            });
            console.log(`Stored pending deposit ${depositId} for user ${user.steamId}. Waiting for offer send.`);

            // Set a timeout to clean up this pending deposit if the offer isn't accepted/declined in time
            cleanupTimeout = setTimeout(() => {
                 if(pendingDeposits.has(depositId)) {
                     console.log(`Deposit attempt ${depositId} associated with offer ${offer?.id || 'unknown'} expired without Steam action.`);
                      pendingDeposits.delete(depositId);
                      // Also attempt to clear the user's pendingDepositOfferId if it matches this offer
                      User.updateOne({ steamId: user.steamId, pendingDepositOfferId: offer?.id || 'expired_unknown_id' }, { pendingDepositOfferId: null })
                         .catch(e => console.error("Error clearing user pending flag on deposit expiry timeout:", e));
                 }
            }, manager.cancelTime || 10 * 60 * 1000); // Use manager's cancelTime or default

            console.log(`Sending deposit offer to ${user.username} (Trade URL: ${user.tradeUrl}). DepositID: ${depositId}`);
            const status = await new Promise((resolve, reject) => { // Promisify offer.send
                offer.send((err, sendStatus) => { if (err) return reject(err); resolve(sendStatus); });
            });

            // IMPORTANT: Update user's pendingDepositOfferId AFTER successfully sending the offer
            try {
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: offer.id });
                console.log(`Set pendingDepositOfferId=${offer.id} for user ${user.username}.`);
            } catch (dbUpdateError) {
                 console.error(`CRITICAL: Failed to set pendingDepositOfferId for user ${user.username} after sending offer ${offer.id}. This might lead to issues with future deposits.`, dbUpdateError);
                  // Cleanup to prevent inconsistent state
                  pendingDeposits.delete(depositId);
                  if (cleanupTimeout) clearTimeout(cleanupTimeout);
                  // Attempt to cancel the sent offer if possible, though TradeOfferManager handles expirations.
                  // offer.cancel().catch(cancelErr => console.error("Error trying to cancel offer after DB update fail:", cancelErr));
                  return res.status(500).json({ error: 'Failed to finalize deposit request state. Contact support if items are held.' });
            }

            console.log(`Deposit offer ${offer.id} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;
            res.json({ success: true, message: 'Deposit offer created! Please accept it on Steam.', offerId: offer.id, offerURL: offerURL });

        } catch (error) { // Errors from offer.send() or other parts of the try block
            console.error(`Error sending deposit offer for ${user.username} (DepositID: ${depositId}): EResult ${error.eresult}`, error.message, error);
            pendingDeposits.delete(depositId); // Clean up pending deposit entry
            if (cleanupTimeout) clearTimeout(cleanupTimeout);

            // Ensure user's pending flag is cleared if offer sending failed before or during send
            await User.updateOne({ steamId: user.steamId, pendingDepositOfferId: user.pendingDepositOfferId /* current flag */ }, { pendingDepositOfferId: null })
                 .catch(e => console.error("Error clearing user's pending flag on deposit offer send failure:", e));

            let userMessage = 'Failed to create deposit trade offer. Please try again later.';
            if (error.message.includes('unable to trade') && error.message.includes('reset your Steam account')) userMessage = `Steam Error: Your account has a temporary trade restriction. (${error.message})`;
            else if (error.message.includes('Trade URL') || error.message.includes('token') || error.eresult === 26) userMessage = 'Your Steam Trade URL might be invalid or has expired. Please check your profile settings.';
            else if (error.eresult) userMessage += ` (Steam Error Code: ${error.eresult})`; // Provide Steam error code if available
            res.status(500).json({ error: userMessage });
        }
    }
);


// --- TRADE OFFER MANAGER EVENT HANDLERS ---
if (isBotConfigured && manager) {
    manager.on('newOffer', async (offer) => { // Handles incoming offers to the bot
        if (!isBotReady || offer.isOurOffer) return; // Ignore offers sent by the bot itself or if bot not ready

        // Decline unsolicited offers (where bot receives items without giving any)
        // This helps prevent scam attempts or unwanted items.
        if (offer.itemsToReceive && offer.itemsToReceive.length > 0 && (!offer.itemsToGive || offer.itemsToGive.length === 0)) {
             // Check if it's a manual deposit attempt (has our site's deposit message format)
             if (offer.message && offer.message.includes('RustyDegen Deposit ID:')) {
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like a manual deposit attempt (has deposit ID in message). Declining as official deposits must be initiated via site.`);
                 return offer.decline((err) => { if (err) console.error(`Error declining manual deposit offer ${offer.id}:`, err); });
             } else {
                 // Generic unsolicited offer
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} is an unsolicited item donation/offer. Declining.`);
                  return offer.decline((err) => { if (err) console.error(`Error declining unsolicited offer ${offer.id}:`, err); });
             }
        }
        // For other types of incoming offers (e.g., bot giving items, or items both ways not initiated by site), log and ignore for now.
        // Specific handling can be added if the bot is meant to engage in other trade types.
        console.log(`Ignoring unexpected incoming trade offer #${offer.id} from ${offer.partner.getSteamID64()} (ItemsToGive: ${offer.itemsToGive?.length || 0}, ItemsToReceive: ${offer.itemsToReceive?.length || 0}). Message: "${offer.message}"`);
    });

    manager.on('sentOfferChanged', async (offer, oldState) => { // Handles changes in offers sent BY THE BOT
        if (offer.state !== oldState) { // Log if state actually changed
            console.log(`Bot Offer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()}) Msg: "${offer.message}"`);
        }

        // Update WinningRecord if this offer was a payout
        const winningRecord = await WinningRecord.findOne({ tradeOfferId: offer.id });
        if (winningRecord) {
            let newStatus = 'unknown'; // Default status
            switch (offer.state) {
                case TradeOfferManager.ETradeOfferState.Accepted: newStatus = 'accepted'; break;
                case TradeOfferManager.ETradeOfferState.Declined: newStatus = 'declined'; break;
                case TradeOfferManager.ETradeOfferState.Canceled: newStatus = 'canceled'; break; // If WE cancel it
                case TradeOfferManager.ETradeOfferState.Expired: newStatus = 'expired'; break;
                case TradeOfferManager.ETradeOfferState.Sent: // Offer is out there
                case TradeOfferManager.ETradeOfferState.Active: // Active can mean sent and waiting for user
                case TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation: // Bot needs to confirm (if 2FA on bot items)
                     newStatus = 'sent'; break;
                case TradeOfferManager.ETradeOfferState.InvalidItems: // Problem with items
                case TradeOfferManager.ETradeOfferState.InEscrow: // Escrow is still a form of 'sent' from our perspective
                     newStatus = 'sent'; // Or a specific 'escrow' status if desired for frontend
                     break;
                default: newStatus = 'unknown';
            }
            if (winningRecord.tradeOfferStatus !== newStatus) {
                winningRecord.tradeOfferStatus = newStatus;
                await winningRecord.save().catch(e => console.error(`Error updating WinningRecord ${winningRecord._id} for offer ${offer.id} status to ${newStatus}:`, e));
                console.log(`WinningRecord ${winningRecord._id} (User: ${winningRecord.user}) status updated to ${newStatus} for offer ${offer.id}`);
            }
        }


        if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
            // Check if it's a deposit offer that was accepted by the user
            const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
            const depositId = messageMatch ? messageMatch[1] : null;
            let createdItemIds = []; // To store ObjectIds of items created in DB for this deposit

            if (depositId && pendingDeposits.has(depositId)) {
                const depositData = pendingDeposits.get(depositId);
                pendingDeposits.delete(depositId); // Remove from pending as it's being processed
                console.log(`Processing accepted deposit offer #${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId}`);

                // Clear the pendingDepositOfferId from the user's profile
                User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                    .then(updateRes => {
                         if(updateRes.modifiedCount > 0) console.log(`Cleared pendingDepositOfferId flag for user ${depositData.steamId} after successful deposit.`);
                         else console.warn(`Could not clear pending flag for user ${depositData.steamId} (Offer ID: ${offer.id}) - might have been cleared already or mismatch.`);
                    })
                    .catch(e => console.error("Error clearing user pending flag on deposit accept:", e));

                let depositRound; // To store the round document
                try {
                     // Fetch the round AT THE TIME OF PROCESSING to ensure it's still valid for deposit
                     depositRound = await Round.findById(depositData.roundId).select('status participants items').exec(); // No lean, need to save
                     if (!depositRound) throw new Error(`Round ${depositData.roundId} not found for deposit processing.`);

                     if (depositRound.status !== 'active' || isRolling) { // Double check round status
                          console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but round no longer active or is rolling. Status: ${depositRound?.status}, Rolling: ${isRolling}. Items will NOT be added to pot.`);
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Round ended or is rolling before your deposit (Offer #${offer.id}) was processed. Please contact support if items were taken.` });
                          // Potentially return items to user here if they were taken by bot but not added to pot (complex, requires bot to send items back)
                          return;
                     }
                     // Check participant and item limits again just before adding
                     const isNewParticipantCheck = !depositRound.participants.some(p => p.user?.toString() === depositData.userId.toString());
                     if (isNewParticipantCheck && depositRound.participants.length >= MAX_PARTICIPANTS) {
                         console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but participant limit reached just before adding. Items NOT added.`);
                         io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Participant limit reached before your deposit (Offer #${offer.id}) could be processed. Contact support.` });
                         return;
                     }
                     if (depositRound.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                          console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but pot item limit reached just before adding. Items NOT added.`);
                           const slotsLeft = MAX_ITEMS_PER_POT - depositRound.items.length;
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Pot item limit reached for offer #${offer.id}. ${slotsLeft > 0 ? `Only ${slotsLeft} slots were available.` : 'Pot full.'} Contact support.` });
                          return;
                     }
                 } catch (roundCheckError) {
                      console.error(`CRITICAL DB ERROR checking round status for accepted deposit ${depositId} (Offer ${offer.id}):`, roundCheckError);
                       io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Please contact support.` });
                      // If items were taken by bot but cannot be added to pot, this is a serious issue.
                      return;
                 }

                // Proceed to add items to the pot
                try {
                    const itemDocuments = depositData.items.map(itemData => new Item({
                        assetId: itemData.assetid, name: itemData._name, image: itemData._image,
                        price: itemData._price, owner: depositData.userId, roundId: depositData.roundId
                    }));
                    const insertedItemsResult = await Item.insertMany(itemDocuments, { ordered: false }); // ordered:false to insert all possible
                     if (insertedItemsResult.length !== itemDocuments.length) console.warn(`Deposit ${depositId}: Item insert count mismatch. Expected ${itemDocuments.length}, got ${insertedItemsResult.length}. Some items might not have been saved.`);
                    createdItemIds = insertedItemsResult.map(doc => doc._id);
                    console.log(`Deposit ${depositId}: Inserted ${createdItemIds.length} items into DB for round ${depositData.roundId}.`);

                    // Update user's total deposited value
                    const userToUpdateForDeposit = await User.findByIdAndUpdate(
                        depositData.userId,
                        { $inc: { totalDepositedValue: depositData.totalValue } },
                        { new: true } // Return the updated document
                    );
                    if (userToUpdateForDeposit) {
                        console.log(`Updated deposit stats for ${userToUpdateForDeposit.username}: New total deposited $${userToUpdateForDeposit.totalDepositedValue.toFixed(2)}`);
                    } else {
                        console.warn(`Could not find user ${depositData.steamId} (ID: ${depositData.userId}) to update deposit stats.`);
                    }

                    // Update the round itself (fetched earlier as depositRound, not lean)
                    if (!depositRound) throw new Error("Round disappeared before final update after item insertion."); // Should not happen if fetched correctly
                    if (depositRound.status !== 'active') throw new Error("Round status changed to non-active before final deposit update.");

                    let participantIndex = depositRound.participants.findIndex(p => p.user?.toString() === depositData.userId.toString());
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO)); // Min 1 ticket

                    if (participantIndex !== -1) { // Existing participant
                           depositRound.participants[participantIndex].itemsValue += depositData.totalValue;
                           depositRound.participants[participantIndex].tickets += depositTickets;
                    } else { // New participant
                           if (depositRound.participants.length >= MAX_PARTICIPANTS) throw new Error(`Participant limit (${MAX_PARTICIPANTS}) reached for ${depositData.steamId} just before final save to round.`);
                           depositRound.participants.push({ user: depositData.userId, itemsValue: depositData.totalValue, tickets: depositTickets });
                    }
                    depositRound.totalValue += depositData.totalValue;
                    if (depositRound.items.length + createdItemIds.length > MAX_ITEMS_PER_POT) throw new Error(`Pot item limit (${MAX_ITEMS_PER_POT}) reached for ${depositData.steamId} just before final save to round.`);
                    depositRound.items.push(...createdItemIds); // Add new item ObjectIds to round's items array

                    const savedRound = await depositRound.save(); // Save the updated round document
                    // Fetch the fully populated round data again for broadcasting to clients
                    const latestRoundDataForEmit = await Round.findById(savedRound._id)
                                                        .populate('participants.user', 'steamId username avatar')
                                                        .lean(); // Lean for emission
                    if (!latestRoundDataForEmit) throw new Error('Failed to fetch updated round data after deposit save for emission.');

                    currentRound = latestRoundDataForEmit; // Update global currentRound with latest state

                    // Find the participant's data in the newly fetched round data for emission
                    const updatedParticipantDataForEmit = latestRoundDataForEmit.participants.find(p => p.user?._id.toString() === depositData.userId.toString());
                    const userInfoForEmit = updatedParticipantDataForEmit?.user;

                    if (updatedParticipantDataForEmit && userInfoForEmit) {
                          io.emit('participantUpdated', {
                               roundId: latestRoundDataForEmit.roundId,
                               userId: userInfoForEmit._id.toString(), // User's MongoDB ID
                               username: userInfoForEmit.username,
                               avatar: userInfoForEmit.avatar,
                               itemsValue: updatedParticipantDataForEmit.itemsValue, // User's new total value in this round
                               tickets: updatedParticipantDataForEmit.tickets,       // User's new total tickets in this round
                               totalValue: latestRoundDataForEmit.totalValue,        // Pot's new total value
                               depositedItems: depositData.items.map(i => ({ assetId: i.assetid, name: i._name, image: i._image, price: i._price })) // The items just deposited
                          });
                    } else {
                          console.error(`Failed to find updated participant data for user ${depositData.steamId} in round ${latestRoundDataForEmit.roundId} for client emission.`);
                    }

                    // Start round timer if this is the first participant and round is active
                      if (latestRoundDataForEmit.participants.length === 1 && !roundTimer && latestRoundDataForEmit.status === 'active') {
                          console.log(`First participant (${userInfoForEmit?.username}) joined round ${latestRoundDataForEmit.roundId}. Starting timer.`);
                          startRoundTimer(); // Start with default duration
                      }
                     console.log(`Deposit success processed for offer #${offer.id}. User: ${userInfoForEmit?.username}, Value: $${depositData.totalValue.toFixed(2)} added to round ${latestRoundDataForEmit.roundId}.`);

                 } catch (dbErr) { // Errors during item insertion, user stat update, or round update
                     console.error(`CRITICAL DATABASE/UPDATE ERROR processing accepted deposit ${offer.id} (DepositID: ${depositId}):`, dbErr);
                     io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Please contact support immediately.` });
                      // Attempt to roll back item creation if DB update failed mid-way
                      if (createdItemIds.length > 0) {
                          console.warn(`Attempting to delete ${createdItemIds.length} orphaned items for deposit ${depositId} due to error: ${dbErr.message}`);
                          await Item.deleteMany({ _id: { $in: createdItemIds } });
                      }
                      // If round processing failed catastrophically, mark round as error
                      if (currentRound && currentRound._id === depositData.roundId) { // Ensure it's the same round
                          await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } }).catch(e => console.error("Failed to set round status to error after deposit failure:", e));
                          io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error. Round halted.' });
                          // Consider what to do next - try to create a new round?
                      }
                 }
            } else if (winningRecord) { // It's a payout (winnings) offer accepted by user
                 console.log(`Payout offer #${offer.id} for WinningRecord ${winningRecord._id} accepted by recipient ${offer.partner.getSteamID64()}.`);
                  // Notify user of successful payout
                  User.findOne({ steamId: offer.partner.getSteamID64() }).lean().then(user => {
                      if (user) io.emit('notification', { type: 'success', userId: user._id.toString(), message: `Winnings from offer #${offer.id} successfully received!` });
                  }).catch(e => console.error("Error finding user for payout accepted notification:", e));
            } else {
                   // Offer accepted, but not recognized as a pending deposit (no matching depositId) or a known winnings payout
                   console.warn(`Offer #${offer.id} accepted by ${offer.partner.getSteamID64()}, but it was not a recognized pending deposit or winnings payout. Message: "${offer.message}" Items Taken: ${offer.itemsToGive?.length || 0}, Items Given: ${offer.itemsToReceive?.length || 0}`);
                   // This could be a manual trade or an offer related to a system not handled here.
                   // If items were taken from the bot (itemsToGive > 0), it needs investigation.
            }
        } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired, TradeOfferManager.ETradeOfferState.InvalidItems, TradeOfferManager.ETradeOfferState.Countered].includes(offer.state)) {
             // Offer sent by bot was not successful
             console.warn(`Bot Offer #${offer.id} to ${offer.partner.getSteamID64()} ended unsuccessfully. State: ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
             const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
             const depositId = messageMatch ? messageMatch[1] : null;

             if (depositId && pendingDeposits.has(depositId)) { // If it was a known deposit attempt
                 const depositData = pendingDeposits.get(depositId);
                 console.warn(`Deposit offer ${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId} was ${TradeOfferManager.ETradeOfferState[offer.state]}. Removing from pending.`);
                 pendingDeposits.delete(depositId); // Remove from pending map

                 // Clear the pending flag from user's profile
                 User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                      .then(updateRes => {
                           if(updateRes.modifiedCount > 0) console.log(`Cleared pending flag for user ${depositData.steamId} due to offer failure/cancellation.`);
                           // else console.warn(`Could not clear pending flag for ${depositData.steamId} for offer ${offer.id} - already cleared or mismatch.`);
                      })
                      .catch(e => console.error("Error clearing user flag on deposit failure/cancellation:", e));

                  const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                 io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Your deposit offer (#${offer.id}) was ${stateMessage}. Please try again if you wish to deposit.` });
             } else if (winningRecord) { // If it was a failed payout offer
                  console.warn(`Payout offer #${offer.id} for WinningRecord ${winningRecord._id} (User: ${winningRecord.user}) failed. State: ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                  User.findOne({ _id: winningRecord.user }).lean().then(user => { // Find user by ObjectId from record
                      if (user) {
                           const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                           io.emit('notification', { type: 'error', userId: user._id.toString(), message: `Failed to deliver winnings (Offer #${offer.id}). The offer was ${stateMessage}. Please contact support if this persists.` });
                      }
                  }).catch(e => console.error("Error finding user for payout fail notification:", e));
              }
              // Else, it was an unknown offer type that failed.
        }
        // Other states (e.g. ETradeOfferState.Active but not changed from Active) are generally ignored here unless specific logic is needed.
    });
}


// --- SOCKET.IO AND CLIENT INTERACTION ---

// Helper to format round data for client
function formatRoundForClient(round) {
    if (!round) return null;

    // Calculate timeLeft based on round status and endTime
    const timeLeft = (round.status === 'active' && round.endTime)
        ? Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000))
        : (round.status === 'pending' ? ROUND_DURATION : 0); // Show full duration for pending, 0 for others if no endTime

    // Format participants
    const participantsFormatted = (round.participants || []).map(p => ({
        user: p.user ? { _id: p.user._id, steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar } : null,
        itemsValue: p.itemsValue || 0,
        tickets: p.tickets || 0
    })).filter(p => p.user); // Ensure only valid participants are sent

    // Format items
    const itemsFormatted = (round.items || []).map(i => ({
        assetId: i.assetId, name: i.name, image: i.image, price: i.price || 0,
        owner: i.owner // Send owner ObjectId (client might use it for coloring or other logic)
    }));

    // Format winner details if round is completed
    let winnerDetails = null;
    if (round.status === 'completed' && round.winner && round.winner.steamId) { // Ensure winner is populated
        winnerDetails = {
            id: round.winner._id, steamId: round.winner.steamId,
            username: round.winner.username, avatar: round.winner.avatar
        };
    } else if (round.status === 'completed' && round.winner) { // Winner ObjectId exists but not populated (should be rare if populated correctly)
         console.warn("Winner field was not fully populated in formatRoundForClient for round:", round.roundId, round.winner);
         winnerDetails = { id: round.winner.toString() }; // Send ID as string
    }

    return {
        _id: round._id, // Send MongoDB ID
        roundId: round.roundId,
        status: round.status,
        startTime: round.startTime,
        endTime: round.endTime,
        timeLeft: timeLeft, // Calculated timeLeft
        totalValue: round.totalValue || 0,
        serverSeedHash: round.serverSeedHash,
        participants: participantsFormatted,
        items: itemsFormatted,
        winner: winnerDetails, // Populated winner details if completed
        // Provably fair details only if completed
        winningTicket: round.status === 'completed' ? round.winningTicket : undefined,
        serverSeed: round.status === 'completed' ? round.serverSeed : undefined,
        clientSeed: round.status === 'completed' ? round.clientSeed : undefined,
        provableHash: round.status === 'completed' ? round.provableHash : undefined,
        taxAmount: round.taxAmount
    };
}

// API endpoint to get current round data (e.g., on page load)
app.get('/api/round/current', async (req, res) => {
    let roundToFormat = null;
    try {
        // Prioritize the in-memory currentRound if it's valid (active or rolling)
        if (currentRound?._id && (currentRound.status === 'active' || currentRound.status === 'rolling')) {
            // Ensure it's fully populated for the client if it's the lean object from memory
            if (!currentRound.participants?.[0]?.user?.username) { // Heuristic: check if participants are populated
                 roundToFormat = await Round.findById(currentRound._id)
                     .populate('participants.user', 'steamId username avatar')
                     .populate('items').populate('winner', 'steamId username avatar').lean();
                 if (roundToFormat) currentRound = roundToFormat; // Update in-memory with populated version
                 else currentRound = null; // Couldn't find it in DB, nullify
            } else {
                roundToFormat = currentRound; // Already populated enough
            }
        }

        // If in-memory currentRound isn't suitable, try fetching from DB
        if (!roundToFormat) {
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } }) // Look for any non-completed/error round
                 .sort({ startTime: -1 }) // Get the latest one
                 .populate('participants.user', 'steamId username avatar')
                 .populate('items').populate('winner', 'steamId username avatar').lean();

            if (roundToFormat && (!currentRound || currentRound._id !== roundToFormat._id)) { // If DB round is different or currentRound was null
                 currentRound = roundToFormat; // Update global currentRound
                 console.log(`Restored current round to ${currentRound.roundId} (Status: ${currentRound.status}) from DB via API.`);
                 // If this restored round should have a timer, ensure it's started/resumed
                 if (currentRound.status === 'active' && currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                     startRoundTimer(true); // Resume with remaining time
                 } else if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) {
                     startRoundTimer(false); // Start timer now if endTime was missing
                 }
            }
        }

        const formattedData = formatRoundForClient(roundToFormat);
        if (formattedData) res.json(formattedData);
        else {
            // If no round found at all, and bot is ready, it implies ensureInitialRound might need to run or has failed
            if (isBotReady && !currentRound) { // Attempt to create one if none exists and bot is ready
                console.log("/api/round/current: No round found, attempting to ensure initial round...");
                await ensureInitialRound(); // This will try to create a new round
                const newFormattedData = formatRoundForClient(currentRound); // Try formatting again
                if (newFormattedData) return res.json(newFormattedData);
            }
            res.status(404).json({ error: 'No active or pending round found.' });
        }
    } catch (err) {
        console.error('Error fetching/formatting current round data for API:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' });
    }
});


// API endpoint for past rounds (history)
app.get('/api/rounds',
    [query('page').optional().isInt({ min: 1 }).toInt(), query('limit').optional().isInt({ min: 1, max: 50 }).toInt()],
    handleValidationErrors, async (req, res) => {
    try {
        const page = req.query.page || 1; const limit = req.query.limit || 10; const skip = (page - 1) * limit;
        const queryFilter = { status: { $in: ['completed', 'error'] } }; // Only completed or error rounds for history
        const [rounds, totalCount] = await Promise.all([
            Round.find(queryFilter).sort('-roundId') // Sort by roundId descending (newest first)
                 .skip(skip).limit(limit)
                 .populate('winner', 'username avatar steamId') // Populate winner details
                 .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount taxedItems') // Select specific fields
                 .lean(),
            Round.countDocuments(queryFilter)
        ]);
        res.json({ rounds, totalPages: Math.ceil(totalCount / limit), currentPage: page, totalRounds: totalCount });
    } catch (err) {
        console.error('Error fetching past rounds:', err);
        res.status(500).json({ error: 'Server error fetching round history.' });
    }
});

// API for Provably Fair verification
app.post('/api/verify', sensitiveActionLimiter,
    [
        body('roundId').notEmpty().isInt({ min: 1 }).toInt(),
        body('serverSeed').trim().notEmpty().isHexadecimal().isLength({ min: 64, max: 64 }),
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 }) // Allow flexible client seed length
    ],
    handleValidationErrors, async (req, res) => {
    const { roundId, serverSeed, clientSeed } = req.body;
    try {
        const round = await Round.findOne({ roundId: roundId, status: 'completed' }) // Only verify completed rounds
             .populate('participants.user', 'username').populate('winner', 'username').lean();

        if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found.` });

        // Verify Server Seed Hash
        const providedServerSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
        if (providedServerSeedHash !== round.serverSeedHash) {
            return res.json({ verified: false, reason: 'Server Seed Hash mismatch.',
                expectedHash: round.serverSeedHash, providedSeed: serverSeed, calculatedHash: providedServerSeedHash });
        }

        // If official seeds are present in DB, compare them too for full verification (optional, client might provide different client seed for testing)
        // For official verification, clientSeed from user should match round.clientSeed
        if (round.serverSeed && round.clientSeed && (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed)) {
            // This indicates user might be trying to verify with different seeds than what was officially used,
            // which is fine for "what if" scenarios, but not an official verification of *that specific round's outcome*.
            // Let the hash check below determine actual verification.
             console.log(`Verify API: User provided seeds for round ${roundId} differ from DB stored seeds. Proceeding with user's seeds for calculation.`);
        }

        // Calculate Provable Hash using provided seeds
        const combinedString = serverSeed + clientSeed;
        const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');

        // Compare with stored Provable Hash
        if (round.provableHash && calculatedProvableHash !== round.provableHash) {
            return res.json({ verified: false, reason: 'Calculated Provable Hash mismatch with stored hash.',
                expectedProvableHash: round.provableHash, calculatedProvableHash, combinedString });
        }

        // Calculate Winning Ticket
        const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
        const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;
        if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets, cannot verify ticket.' });

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
            totalTickets, totalValue: round.totalValue, // This is after-tax value won
            winnerUsername: round.winner?.username || 'N/A'
        });
    } catch (err) {
        console.error(`Error verifying round ${roundId}:`, err);
        res.status(500).json({ error: 'Server error during verification.' });
    }
});

// Socket.IO session handling
io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.initialize()(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.session()(socket.request, socket.request.res || {}, next); });

let connectedChatUsers = 0;
const userLastMessageTime = new Map(); // For chat cooldown per user

io.on('connection', async (socket) => {
    connectedChatUsers++;
    io.emit('updateUserCount', connectedChatUsers); // Broadcast new count

    const user = socket.request.user; // User object from Passport session

    if (user && user.username) {
        console.log(`User ${user.username} (Socket ID: ${socket.id}) connected.`);
    } else {
        console.log(`Anonymous client (Socket ID: ${socket.id}) connected.`);
    }

    // Send recent chat messages on connection
    try {
        const recentMessages = await ChatMessage.find({})
            .sort({ timestamp: -1 })
            .limit(MAX_CHAT_MESSAGES_TO_LOAD)
            .populate('user', 'username avatar steamId') // Populate user details for chat
            .lean();

        socket.emit('initialChatMessages', recentMessages.reverse().map(msg => ({ // Send oldest first
            username: msg.isSystemMessage ? 'System' : (msg.user?.username || msg.username),
            avatar: msg.isSystemMessage ? null : (msg.user?.avatar || msg.avatar),
            message: msg.message,
            userId: msg.user?._id?.toString(),
            userSteamId: msg.user?.steamId || msg.steamId,
            timestamp: msg.timestamp,
            type: msg.isSystemMessage ? 'system' : 'user'
        })));
    } catch (err) {
        console.error("Error fetching recent chat messages for new connection:", err);
    }


    socket.on('requestRoundData', async () => { // Client requests current round data
        try {
            // This logic mirrors /api/round/current to ensure consistency
            let roundToSend = null;
             if (currentRound?._id && (currentRound.status === 'active' || currentRound.status === 'rolling')) {
                 if (!currentRound.participants?.[0]?.user?.username) {
                     roundToSend = await Round.findById(currentRound._id)
                           .populate('participants.user', 'steamId username avatar')
                           .populate('items').populate('winner', 'steamId username avatar').lean();
                     if (roundToSend) currentRound = roundToSend; else currentRound = null;
                 } else { roundToSend = currentRound; }
             }
             if (!roundToSend) {
                 roundToSend = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                       .sort({ startTime: -1 })
                       .populate('participants.user', 'steamId username avatar')
                       .populate('items').populate('winner', 'steamId username avatar').lean();
                 if (roundToSend && (!currentRound || currentRound._id !== roundToSend._id)) {
                      currentRound = roundToSend;
                      console.log(`Restored current round to ${currentRound.roundId} (Status: ${currentRound.status}) from DB on client socket request.`);
                      if (currentRound.status === 'active' && currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) startRoundTimer(true);
                      else if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) startRoundTimer(false);
                 }
             }
            const formattedData = formatRoundForClient(roundToSend);
            if (formattedData) socket.emit('roundData', formattedData);
            else socket.emit('noActiveRound'); // Inform client if no round is available
        } catch (err) {
            console.error(`Error fetching round data for socket ${socket.id}:`, err);
            socket.emit('roundError', { error: 'Failed to load round data.' });
        }
    });

    socket.on('chatMessage', async (msg) => { // Apply chatLimiter at HTTP route level if chat is also sent via HTTP
        if (!user || !user._id) { // Check if user is authenticated (from Passport session)
            console.warn(`Chat message from unauthenticated socket ${socket.id}. Message: "${msg}"`);
            socket.emit('notification', {type: 'error', message: 'You must be logged in to chat.'});
            return;
        }
        const userId = user._id.toString();
        const now = Date.now();
        const lastMessageTimeForUser = userLastMessageTime.get(userId) || 0;

        if (now - lastMessageTimeForUser < CHAT_COOLDOWN_SECONDS * 1000) {
            const timeLeftCooldown = Math.ceil((CHAT_COOLDOWN_SECONDS * 1000 - (now - lastMessageTimeForUser)) / 1000);
            socket.emit('notification', {type: 'warning', message: `Please wait ${timeLeftCooldown}s before sending another message.`});
            return;
        }
        if (typeof msg !== 'string' || msg.trim().length === 0 || msg.trim().length > MAX_CHAT_MESSAGE_LENGTH) {
            socket.emit('notification', {type: 'error', message: `Invalid message. Max ${MAX_CHAT_MESSAGE_LENGTH} characters, cannot be empty.`});
            return;
        }

        userLastMessageTime.set(userId, now); // Update last message time
        const trimmedMessage = msg.trim(); // Sanitize/trim message
        const messageData = { // Data to save to DB
            user: user._id,
            steamId: user.steamId,
            username: user.username, // Username at time of message
            avatar: user.avatar || '/img/default-avatar.png', // Avatar at time of message
            message: trimmedMessage,
            timestamp: new Date()
        };

        try {
            const savedMessage = await new ChatMessage(messageData).save();
            // Populate user details for broadcasting, ensuring consistent data structure
            const populatedMessageForEmit = await ChatMessage.findById(savedMessage._id).populate('user', 'username avatar steamId').lean();

            io.emit('chatMessage', { // Broadcast the populated message to all clients
                username: populatedMessageForEmit.user?.username || populatedMessageForEmit.username,
                avatar: populatedMessageForEmit.user?.avatar || populatedMessageForEmit.avatar,
                message: populatedMessageForEmit.message,
                userId: populatedMessageForEmit.user?._id?.toString(),
                userSteamId: populatedMessageForEmit.user?.steamId || populatedMessageForEmit.steamId,
                timestamp: populatedMessageForEmit.timestamp,
                type: 'user' // Explicitly user message
            });
            console.log(`Chat (User: ${user.username}, ID: ${userId}): ${trimmedMessage}`);
        } catch (saveError) {
            console.error("Error saving chat message:", saveError);
            socket.emit('notification', {type: 'error', message: 'Error sending message. Please try again.'});
        }
    });

    socket.on('disconnect', (reason) => {
        connectedChatUsers--;
        io.emit('updateUserCount', connectedChatUsers); // Broadcast new count
         if (user && user.username) {
            console.log(`User ${user.username} (Socket ID: ${socket.id}) disconnected. Reason: ${reason}`);
        } else {
            console.log(`Anonymous client (Socket ID: ${socket.id}) disconnected. Reason: ${reason}`);
        }
    });
});

// --- APPLICATION START ---
async function startApp() {
    console.log("Performing initial price cache refresh from rust.scmm.app...");
    await refreshPriceCache(); // Initial fetch
    // Schedule periodic refresh
    setInterval(async () => {
        try { await refreshPriceCache(); }
        catch (refreshErr) { console.error("Error during scheduled price cache refresh:", refreshErr); }
    }, PRICE_REFRESH_INTERVAL_MS);
    console.log(`Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log(`Site URL configured as: ${process.env.SITE_URL}`);
        if (!isBotConfigured) {
            console.log("INFO: Steam Bot not configured. Trade features, automated rounds, and deposits are disabled.");
        } else if (!isBotReady) {
            // This message will appear if bot login is attempted but fails or is pending.
            // If it persists, check .env for STEAM_USERNAME, STEAM_PASSWORD, STEAM_SHARED_SECRET
            // and ensure the bot account has Steam Guard Mobile Authenticator correctly set up.
            console.log("INFO: Steam Bot login attempt may have failed or is pending. Check server logs for details. Deposits/rounds may not work until bot is ready.");
        } else {
            console.log("INFO: Steam Bot is ready. Attempting to ensure an initial game round.");
        }
        // ensureInitialRound is called after bot login success, or here if bot was already ready (e.g. after restart with session)
        // However, better to call it once bot status is definitively known from login attempt or if already logged in.
        // If bot login is asynchronous, ensureInitialRound should be reliably called AFTER it's confirmed ready.
        // Current logic calls it after successful manager.setCookies or if not configured.
        // Adding a call here to catch cases where it might have been missed if bot was pre-ready.
        if (isBotReady) {
            ensureInitialRound();
        }
    });
}
startApp();

// Graceful shutdown
function gracefulShutdown() {
    console.log('Received shutdown signal. Closing server...');
    io.close(() => { console.log('Socket.IO connections closed.'); }); // Close Socket.IO connections
    server.close(async () => {
        console.log('HTTP server closed.');
        try {
            await mongoose.connection.close();
            console.log('MongoDB connection closed.');
            if (manager && typeof manager.shutdown === 'function') { // Check if manager has shutdown method
                 console.log('Stopping TradeOfferManager polling...');
                 manager.shutdown(); // Gracefully stop polling for offers
            } else if (manager) {
                 console.log('TradeOfferManager does not have a direct shutdown method, polling will stop on process exit.');
            }
            process.exit(0);
        } catch (e) {
            console.error("Error during graceful shutdown:", e);
            process.exit(1);
        }
    });
    // Force shutdown if graceful close takes too long
    setTimeout(() => {
        console.error('Could not close connections gracefully within timeout, forcing shutdown.');
        process.exit(1);
    }, 10000); // 10 seconds timeout
}
process.on('SIGTERM', gracefulShutdown); // For `kill`
process.on('SIGINT', gracefulShutdown);  // For `Ctrl+C`

// Global error handler (must be last middleware)
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.');
    if (res.headersSent) return next(err); // If headers already sent, delegate to Express default handler
    res.status(status).json({ error: message });
});

console.log("app.js loaded. Check console for bot status and round initialization.");
