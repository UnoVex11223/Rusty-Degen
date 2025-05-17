// app.js (Modified for Individual Deposits & Winner Claim Flow) - Part 1 of 2

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
const TICKET_VALUE_RATIO = parseFloat(process.env.TICKET_VALUE) || 0.01; // e.g., $0.01 per ticket
const PRICE_CACHE_TTL_SECONDS = parseInt(process.env.PRICE_CACHE_TTL_SECONDS) || 15 * 60;
const PRICE_REFRESH_INTERVAL_MS = (parseInt(process.env.PRICE_REFRESH_MINUTES) || 10) * 60 * 1000;
const MIN_ITEM_VALUE = parseFloat(process.env.MIN_ITEM_VALUE) || 0.10;
const PRICE_FETCH_TIMEOUT_MS = 30000;
const MAX_DEPOSITORS_PER_ROUND = parseInt(process.env.MAX_DEPOSITORS_PER_ROUND) || 20; // Max unique users who can deposit
const MAX_TOTAL_DEPOSITS_PER_ROUND = parseInt(process.env.MAX_TOTAL_DEPOSITS_PER_ROUND) || 50; // Max individual deposit entries in a round
const MAX_ITEMS_PER_POT = 200;
const MAX_ITEMS_PER_DEPOSIT = parseInt(process.env.MAX_ITEMS_PER_DEPOSIT) || 20;
const TAX_MIN_PERCENT = parseFloat(process.env.TAX_MIN_PERCENT) || 5;
const TAX_MAX_PERCENT = parseFloat(process.env.TAX_MAX_PERCENT) || 10;
const MIN_POT_FOR_TAX = parseFloat(process.env.MIN_POT_FOR_TAX) || 100;
const MAX_CHAT_MESSAGE_LENGTH = 200;
const CHAT_COOLDOWN_SECONDS = parseInt(process.env.CHAT_COOLDOWN_SECONDS) || 5;
const MAX_CHAT_MESSAGES_TO_LOAD = 15;

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: process.env.SITE_URL || "*", methods: ["GET", "POST"] } });

app.set('trust proxy', 1);
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "default-src": ["'self'"],
            "script-src": ["'self'", "/socket.io/socket.io.js", "'unsafe-inline'"], // Unsafe-inline for now, consider nonce/hash
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
                sources.push("https://rust.scmm.app"); // For price fetching
                return sources;
            })(),
            "frame-src": ["'self'", "https://steamcommunity.com"], // For Steam login/trade offers
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
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Too many chat messages from this IP. Please wait a moment.', standardHeaders: true, legacyHeaders: false });

app.use('/api/', generalApiLimiter);
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
        maxAge: 3600000 * 24, // 1 day
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax'
    }
});
app.use(sessionMiddleware);

app.use(passport.initialize());
app.use(passport.session());

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
    totalDepositedValue: { type: Number, default: 0, min: 0 }, // Sum of all values ever deposited by user
    totalWinningsValue: { type: Number, default: 0, min: 0 }  // Sum of all values ever won by user
});

const itemSchema = new mongoose.Schema({
    assetId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    image: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    ownerSteamId: { type: String, required: true, index: true }, // SteamID of the original depositor
    roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true, index: true },
    depositedAt: { type: Date, default: Date.now }
});

// Schema for individual deposit entries within a round
const depositEntrySchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    depositValue: { type: Number, required: true, default: 0, min: 0 }, // Value of THIS specific deposit
    tickets: { type: Number, required: true, default: 0, min: 0 },      // Tickets from THIS specific deposit
    depositedItems: [{ // Specific items from THIS deposit
        assetId: { type: String, required: true },
        name: { type: String, required: true },
        image: { type: String, required: true },
        price: { type: Number, required: true, min: 0 }
    }],
    depositTimestamp: { type: Date, default: Date.now }
}, { _id: true }); // Each deposit entry will have its own _id


const roundSchema = new mongoose.Schema({
    roundId: { type: Number, required: true, unique: true, index: true },
    status: { type: String, enum: ['pending', 'active', 'rolling', 'completed', 'error'], default: 'pending', index: true },
    startTime: { type: Date },
    endTime: { type: Date }, // When the countdown timer is scheduled to end
    completedTime: { type: Date }, // When the round actually completed (winner determined)
    totalValue: { type: Number, default: 0, min: 0 }, // Sum of all depositValues in depositsInRound
    items: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }], // Flat list of all Item ObjectIds in the pot
    depositsInRound: [depositEntrySchema], // Array of individual deposit entries
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // The user who won
    winningDepositEntryId: { type: mongoose.Schema.Types.ObjectId }, // The _id of the specific depositEntry that won
    winningTicket: { type: Number, min: 0 }, // The actual winning ticket number
    serverSeed: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    serverSeedHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    clientSeed: { type: String, match: /^[a-f0-9]+$/ }, // Can be more complex if needed
    provableHash: { type: String, match: /^[a-f0-9]{64}$/ },
    taxAmount: { type: Number, default: 0, min: 0 },
    taxedItems: [{ assetId: String, name: String, price: { type: Number, min: 0 }, image: String }] // Store details of taxed items
});
roundSchema.index({ 'depositsInRound.user': 1 });

const winningRecordSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    round: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true, index: true },
    roundDisplayId: { type: Number, required: true },
    amountWon: { type: Number, required: true, min: 0 }, // Actual value of items to be sent
    status: {
        type: String,
        enum: ['unclaimed', 'claim_initiated', 'sending_offer', 'offer_sent', 'accepted_by_user', 'declined_by_user', 'offer_expired', 'offer_canceled', 'claim_error', 'unknown_offer_state'],
        default: 'unclaimed'
    },
    tradeOfferId: { type: String, index: true },
    tradeOfferURL: { type: String },
    itemsWonDetails: [{ // Details of the items won, for display and record
        assetId: String,
        name: String,
        price: Number,
        image: String
    }],
    claimedAt: { type: Date },
    errorMessage: { type: String }, // If any error during claim/send
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
    domain: process.env.SITE_URL ? process.env.SITE_URL.replace(/^https?:\/\//, '') : 'localhost', // Example: yourdomain.com
    language: 'en',
    pollInterval: 10000, // Poll for offer updates every 10 seconds
    cancelTime: 10 * 60 * 1000, // Automatically cancel sent offers unanswered after 10 minutes (Steam default is longer)
});
let isBotReady = false;
const pendingDeposits = new Map(); // Stores temporary data for deposits awaiting Steam confirmation

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
                community.setCookies(cookies); // Also set cookies for general community actions if needed
                isBotReady = true;
                console.log("Steam Bot is ready and operational.");
                ensureInitialRound(); // Initialize or find the current round
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

let currentRound = null; // Holds the current round object, populated from DB
let roundTimer = null;   // Stores the setInterval ID for the round countdown
let isRolling = false;   // Flag to prevent actions during winner selection/animation

const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false });

function getFallbackPrice(marketHashName) {
    // Basic fallback, consider more sophisticated methods if needed
    return MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0;
}

async function refreshPriceCache() {
    console.log("PRICE_INFO: Attempting to refresh price cache from rust.scmm.app...");
    const apiUrl = `https://rust.scmm.app/api/item/prices?currency=USD`; // SCMM provides prices in cents
    try {
        const response = await axios.get(apiUrl, { timeout: PRICE_FETCH_TIMEOUT_MS });
        if (response.data && Array.isArray(response.data)) {
            const items = response.data;
            let updatedCount = 0;
            let newItems = [];
            items.forEach(item => {
                // Ensure item has a name and a valid price (number, non-negative)
                if (item?.name && typeof item.price === 'number' && item.price >= 0) {
                    const priceInDollars = item.price / 100.0; // Convert cents to dollars
                    newItems.push({ key: item.name, val: priceInDollars });
                    updatedCount++;
                }
            });
            if (newItems.length > 0) {
                const success = priceCache.mset(newItems); // Bulk set cache entries
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
        return 0; // Return 0 for invalid input
    }
    const cachedPrice = priceCache.get(marketHashName);
    return (cachedPrice !== undefined) ? cachedPrice : getFallbackPrice(marketHashName);
}

async function createNewRound() {
    if (isRolling) {
        console.log("Cannot create new round: Current round is rolling.");
        return null;
    }
    if (currentRound && currentRound.status === 'active') {
        console.log(`Cannot create new round: Round ${currentRound.roundId} is already active.`);
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
            status: 'active', // Start as active
            startTime: new Date(),
            serverSeed: serverSeed,
            serverSeedHash: serverSeedHash,
            items: [],
            depositsInRound: [], // Initialize with empty deposits
            totalValue: 0
        });
        await newRound.save();
        currentRound = newRound.toObject(); // Use .toObject() for a plain JS object if not modifying further with Mongoose methods

        io.emit('roundCreated', {
            roundId: newRound.roundId,
            serverSeedHash: newRound.serverSeedHash,
            timeLeft: ROUND_DURATION, // Initial time for a new round
            totalValue: 0,
            depositsInRound: [],
            items: []
        });
        console.log(`--- Round ${newRound.roundId} created and active ---`);
        return newRound.toObject();
    } catch (err) {
        console.error('FATAL: Error creating new round:', err);
        // Optionally, schedule a retry or enter an error state
        setTimeout(createNewRound, 10000); // Retry after 10 seconds
        return null;
    }
}

async function ensureInitialRound() {
    if (isBotConfigured && isBotReady) {
        if (!currentRound) {
            try {
                // Try to find an existing active round
                const existingActive = await Round.findOne({ status: 'active' })
                    .populate('depositsInRound.user', 'steamId username avatar')
                    .populate('items') // Populate the flat list of items
                    .lean(); // Use lean for performance if not modifying

                if (existingActive) {
                    console.log(`Found existing active round ${existingActive.roundId} on startup.`);
                    currentRound = existingActive;
                    // If the round has depositors and an endTime that's in the future, resume timer
                    const uniqueDepositors = new Set(currentRound.depositsInRound.map(d => d.user._id.toString()));
                    if (uniqueDepositors.size > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        startRoundTimer(true); // Resume timer with remaining time
                    } else if (uniqueDepositors.size > 0 && !currentRound.endTime && !roundTimer) {
                        // If active with depositors but no end time (e.g., from a previous state), start timer now
                        console.warn(`Active round ${currentRound.roundId} found without endTime. Starting timer now.`);
                        startRoundTimer(false); // Start timer fresh
                    }
                } else {
                    console.log("No active round found, creating initial round...");
                    await createNewRound();
                }
            } catch (dbErr) {
                console.error("Error ensuring initial round:", dbErr);
            }
        }
    } else if (isBotConfigured && !isBotReady) {
        console.log("Bot configured but not ready, skipping initial round check until bot is ready.");
    } else {
        console.log("Bot not configured, skipping initial round check.");
    }
}


function startRoundTimer(useRemainingTime = false) {
    if (roundTimer) clearInterval(roundTimer); // Clear any existing timer
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
        // Start a new timer
        timeLeft = ROUND_DURATION;
        calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
        currentRound.endTime = calculatedEndTime; // Update in-memory currentRound
        // Persist endTime to DB
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
            .catch(e => console.error(`Error saving round end time for round ${currentRound?.roundId}:`, e));
        console.log(`Starting timer for round ${currentRound.roundId} (${ROUND_DURATION}s). End time: ${calculatedEndTime.toISOString()}`);
    }

    io.emit('timerUpdate', { timeLeft }); // Emit initial time

    roundTimer = setInterval(async () => {
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) {
            clearInterval(roundTimer); roundTimer = null;
            console.warn("Timer stopped: Round state became invalid during countdown.");
            return;
        }

        const now = Date.now();
        let currenttimeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - now) / 1000));

        io.emit('timerUpdate', { timeLeft: currenttimeLeft }); // Emit updated time

        if (currenttimeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null;
            console.log(`Round ${currentRound.roundId} timer reached zero.`);
            await endRound();
        }
    }, 1000);
}


// app.js (Modified for Individual Deposits & Winner Claim Flow) - Part 2 of 2

async function endRound() {
    if (!currentRound || isRolling || currentRound.status !== 'active') {
        console.warn(`Attempted to end round ${currentRound?.roundId}, but state is invalid (Status: ${currentRound?.status}, Rolling: ${isRolling})`);
        return;
    }
    isRolling = true;
    const roundIdToEnd = currentRound.roundId;
    const roundMongoId = currentRound._id; // Ensure currentRound has _id
    console.log(`--- Ending round ${roundIdToEnd}... ---`);

    try {
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } });
        io.emit('roundRolling', { roundId: roundIdToEnd });

        const round = await Round.findById(roundMongoId)
            .populate('depositsInRound.user', 'steamId username avatar tradeUrl')
            .populate('items') // Populate the flat list of items in the pot
            .lean();

        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);
        if (round.status !== 'rolling') {
             console.warn(`Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Aborting endRound.`);
             isRolling = false; return;
        }
        currentRound = round; // Update in-memory round

        if (round.depositsInRound.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            console.log(`Round ${round.roundId} ended with no valid deposits or value.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date() } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants or items." });
            isRolling = false;
            setTimeout(createNewRound, 5000); // Schedule next round
            return;
        }

        let finalItemsForWinner = [...round.items]; // All items in the pot initially
        let potValueForWinner = round.totalValue; // Initial total value of the pot
        let taxAmount = 0;
        let taxedItemsInfo = []; // To store assetId, name, price of taxed items

        if (potValueForWinner >= MIN_POT_FOR_TAX) {
            const targetTaxValue = potValueForWinner * (TAX_MIN_PERCENT / 100);
            const maxTaxValue = potValueForWinner * (TAX_MAX_PERCENT / 100);
            // Sort all items in the pot by price (ascending) to pick cheapest for tax
            const sortedItemsForTax = [...finalItemsForWinner].sort((a, b) => a.price - b.price);
            let currentTaxValueAccumulated = 0;
            let itemsToTakeForTaxIds = []; // Store ObjectIds of items taken for tax

            for (const item of sortedItemsForTax) {
                if (currentTaxValueAccumulated + item.price <= maxTaxValue) {
                    itemsToTakeForTaxIds.push(item._id.toString()); // Store as string for Set comparison
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price, image: item.image });
                    currentTaxValueAccumulated += item.price;
                    if (currentTaxValueAccumulated >= targetTaxValue) break; // Stop if target tax is met or exceeded
                } else {
                    // Adding this item would exceed maxTaxValue, so stop
                    break;
                }
            }

            if (itemsToTakeForTaxIds.length > 0) {
                const taxedItemObjectIdSet = new Set(itemsToTakeForTaxIds);
                finalItemsForWinner = finalItemsForWinner.filter(item => !taxedItemObjectIdSet.has(item._id.toString()));
                taxAmount = currentTaxValueAccumulated;
                potValueForWinner -= taxAmount;
                console.log(`Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${itemsToTakeForTaxIds.length} items). New Pot Value for Winner: $${potValueForWinner.toFixed(2)}`);
            }
        }

        const clientSeed = crypto.randomBytes(16).toString('hex'); // Generate a client seed
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');

        // Calculate total tickets by summing tickets from each deposit entry
        const totalTickets = round.depositsInRound.reduce((sum, depositEntry) => sum + (depositEntry?.tickets || 0), 0);

        if (totalTickets <= 0) throw new Error(`Cannot determine winner: Total tickets is zero or invalid for round ${round.roundId}.`);

        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16); // Use first 8 hex chars for ticket
        const winningTicketNumber = decimalFromHash % totalTickets;

        let cumulativeTickets = 0;
        let winningUser = null;
        let winningDepositEntryId = null;

        for (const depositEntry of round.depositsInRound) {
            if (!depositEntry?.tickets || !depositEntry.user) continue; // Skip invalid entries
            cumulativeTickets += depositEntry.tickets;
            if (winningTicketNumber < cumulativeTickets) {
                winningUser = depositEntry.user; // This is the populated user object
                winningDepositEntryId = depositEntry._id; // Capture the ID of the winning deposit entry
                break;
            }
        }

        if (!winningUser || !winningUser._id) throw new Error(`Winner selection failed for round ${round.roundId}. Winning Ticket: ${winningTicketNumber}, Total Tickets: ${totalTickets}`);

        // Update winner's total winnings statistics
        try {
            const updatedWinnerUser = await User.findByIdAndUpdate(
                winningUser._id,
                { $inc: { totalWinningsValue: potValueForWinner } }, // potValueForWinner is after-tax
                { new: true }
            );
            if (updatedWinnerUser) {
                console.log(`Updated winnings stats for ${updatedWinnerUser.username}: New total winnings $${updatedWinnerUser.totalWinningsValue.toFixed(2)}`);
            } else {
                console.warn(`Could not find user ${winningUser.username} to update winnings stats.`);
            }
        } catch (statError) {
            console.error(`Error updating winnings stats for user ${winningUser.username}:`, statError);
        }

        // Create WinningRecord
        const winningRecord = await WinningRecord.create({
            user: winningUser._id,
            round: round._id,
            roundDisplayId: round.roundId,
            amountWon: potValueForWinner,
            status: 'unclaimed', // Initial status
            itemsWonDetails: finalItemsForWinner.map(item => ({ assetId: item.assetId, name: item.name, price: item.price, image: item.image })),
            createdAt: new Date()
        });

        const finalUpdateData = {
            status: 'completed', completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicketNumber, winner: winningUser._id,
            winningDepositEntryId: winningDepositEntryId,
            taxAmount: taxAmount, taxedItems: taxedItemsInfo,
            totalValue: potValueForWinner, // Store the after-tax value that was won
            items: finalItemsForWinner.map(i => i._id) // Store ObjectIds of items remaining for winner
        };
        await Round.updateOne({ _id: roundMongoId }, { $set: finalUpdateData });

        console.log(`Round ${round.roundId} completed. Winner: ${winningUser.username} (Ticket No: ${winningTicketNumber} out of ${totalTickets}, Deposit Entry ID: ${winningDepositEntryId}, Value Won: $${potValueForWinner.toFixed(2)})`);

        // Emit general winner info to all clients
        io.emit('roundWinner', {
            roundId: round.roundId,
            winner: { id: winningUser._id, steamId: winningUser.steamId, username: winningUser.username, avatar: winningUser.avatar },
            winningTicket: winningTicketNumber, totalValue: potValueForWinner, totalTickets: totalTickets,
            serverSeed: round.serverSeed, clientSeed: clientSeed, provableHash: provableHash, serverSeedHash: round.serverSeedHash
        });

        // Emit specific event to the winner with details to claim
        const winnerSocket = Object.values(io.sockets.sockets).find(s => s.request.user && s.request.user.id === winningUser._id.toString());
        if (winnerSocket) {
            winnerSocket.emit('youWonRoundDetails', {
                winningRecordId: winningRecord._id,
                roundId: round.roundId,
                amountWon: potValueForWinner,
                itemsWon: finalItemsForWinner.map(item => ({ name: item.name, image: item.image, price: item.price }))
            });
        } else {
            // If winner is not currently connected via socket, they will see claim option on next login/visit
            console.log(`Winner ${winningUser.username} not connected via socket. Winnings can be claimed later.`);
        }

    } catch (err) {
        console.error(`CRITICAL ERROR during endRound for round ${roundIdToEnd}:`, err);
        try {
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error' } });
            io.emit('roundError', { roundId: roundIdToEnd, error: 'Internal server error during round finalization.' });
        } catch (saveErr) {
            console.error(`Failed to mark round ${roundIdToEnd} as error after initial error:`, saveErr);
        }
    } finally {
        isRolling = false;
        console.log(`Scheduling next round creation after round ${roundIdToEnd} finalization.`);
        setTimeout(createNewRound, 10000); // Time before new round starts
    }
}

// Renamed and refactored to be called after winner claims
async function initiateAndSendWinningsOffer(winningRecordId, claimingUserId) {
    const winningRecord = await WinningRecord.findById(winningRecordId)
        .populate('user', 'tradeUrl username steamId') // Populate necessary user fields
        .populate({ path: 'round', select: 'roundId items', populate: { path: 'items' } }); // Get items from the round

    if (!winningRecord) {
        throw new Error('Winning record not found.');
    }
    if (winningRecord.user._id.toString() !== claimingUserId.toString()) {
        throw new Error('User not authorized to claim these winnings.');
    }
    if (winningRecord.status !== 'unclaimed' && winningRecord.status !== 'claim_error') { // Allow retry on claim_error
        // If already claimed or in process, prevent re-sending unless it's a retry scenario
        if (winningRecord.tradeOfferId && winningRecord.tradeOfferURL && (winningRecord.status === 'offer_sent' || winningRecord.status === 'sending_offer')) {
             console.log(`Winnings for record ${winningRecord._id} already have an active offer: ${winningRecord.tradeOfferId}`);
             // Re-emit notification with existing offer details
             io.to(winningRecord.user._id.toString()).emit('tradeOfferSent', {
                 winningRecordId: winningRecord._id,
                 userId: winningRecord.user._id.toString(),
                 username: winningRecord.user.username,
                 offerId: winningRecord.tradeOfferId,
                 offerURL: winningRecord.tradeOfferURL,
                 status: 'resend_notification' // Custom status to indicate it's a re-notification
             });
             return { offerId: winningRecord.tradeOfferId, offerURL: winningRecord.tradeOfferURL, status: winningRecord.status };
        }
        throw new Error(`Winnings have already been processed or are in an invalid state: ${winningRecord.status}.`);
    }

    winningRecord.status = 'sending_offer'; // Mark as processing
    winningRecord.claimedAt = new Date();
    await winningRecord.save();

    const winner = winningRecord.user;
    const itemsToSendFromRecord = winningRecord.itemsWonDetails; // Use details stored in winning record

    if (!isBotReady) {
        winningRecord.status = 'claim_error';
        winningRecord.errorMessage = 'Steam Bot is not ready.';
        await winningRecord.save();
        throw new Error('PAYOUT_ERROR: Cannot send winnings: Steam Bot is not ready.');
    }
    if (!winner.tradeUrl) {
        winningRecord.status = 'claim_error';
        winningRecord.errorMessage = 'Winner has no Trade URL set.';
        await winningRecord.save();
        throw new Error('PAYOUT_ERROR: Winner has no Trade URL set.');
    }
    if (!itemsToSendFromRecord || itemsToSendFromRecord.length === 0) {
        // This case should ideally be handled by tax logic (no items if all taxed)
        console.log(`PAYOUT_INFO: No items to send for winning record ${winningRecord._id}. (Pot value won: ${winningRecord.amountWon})`);
        winningRecord.status = 'accepted_by_user'; // Effectively, nothing to send, consider it "claimed"
        winningRecord.tradeOfferId = `NO_ITEMS_${winningRecord.roundDisplayId}`;
        await winningRecord.save();
        return { message: 'No items to send (e.g., fully taxed). Winnings processed.', status: 'accepted_by_user' };
    }

    console.log(`Attempting to send ${itemsToSendFromRecord.length} winning items for record ${winningRecord._id} to ${winner.username}...`);

    try {
        const offer = manager.createOffer(winner.tradeUrl);
        // We need actual asset IDs from the bot's inventory that match the taxed items.
        // This part is tricky: `itemsToSendFromRecord` has details, not actual bot inventory assetIDs.
        // The `round.items` (after tax) should have the actual Item ObjectIds.
        // We need to fetch these items from the bot's inventory.
        // For now, assuming `round.items` on the populated `winningRecord.round` contains the correct items (ObjectIds).
        // This requires `finalItemsForWinner.map(i => i._id)` to be stored correctly in Round.items.

        const roundItemObjects = await Item.find({ _id: { $in: winningRecord.round.items } }).lean();
        if (roundItemObjects.length !== itemsToSendFromRecord.length) {
             console.warn(`Mismatch between itemsWonDetails (${itemsToSendFromRecord.length}) and actual items found in DB for round (${roundItemObjects.length}) for record ${winningRecord._id}`);
             // Fallback to itemsWonDetails if round.items seems incorrect, but this implies a data issue earlier.
        }
        const itemsForOffer = roundItemObjects.map(item => ({
            assetid: item.assetId, // This MUST be the assetId from the BOT's inventory
            appid: RUST_APP_ID,
            contextid: RUST_CONTEXT_ID
        }));
        // Critical: The assetIds used here must correspond to items the BOT OWNS.
        // The deposit flow moves items to the bot. Taxed items remain with the bot.
        // Winning items are also with the bot. So, the assetIds should be correct if items were tracked properly.

        offer.addMyItems(itemsForOffer);
        const offerMessage = `Congratulations! Your winnings from Round #${winningRecord.roundDisplayId} on ${process.env.SITE_NAME || 'RustyDegen'}. Pot Value (after tax): $${winningRecord.amountWon.toFixed(2)}`;
        offer.setMessage(offerMessage);

        const identitySecret = process.env.STEAM_IDENTITY_SECRET; // For auto-confirming trades if set up
        const sentOfferResult = await new Promise((resolve, reject) => {
            offer.send(!!identitySecret, (err, status) => { // Pass boolean for autoConfirmation
                if (err) {
                    return reject(err);
                }
                resolve({ status: status, offerId: offer.id });
            });
        });

        winningRecord.tradeOfferId = sentOfferResult.offerId;
        winningRecord.tradeOfferURL = `https://steamcommunity.com/tradeoffer/${sentOfferResult.offerId}/`;
        winningRecord.status = (sentOfferResult.status === 'pending' || sentOfferResult.status === 'pendingConfirmation' || sentOfferResult.status === 'sent') ? 'offer_sent' : 'unknown_offer_state';
        await winningRecord.save();

        console.log(`PAYOUT_SUCCESS: Trade offer ${sentOfferResult.offerId} sent to ${winner.username} for record ${winningRecord._id}. Status: ${sentOfferResult.status}`);

        // Notify user via socket
        io.to(winner._id.toString()).emit('tradeOfferSent', {
            winningRecordId: winningRecord._id,
            userId: winner._id.toString(), username: winner.username,
            offerId: sentOfferResult.offerId, offerURL: winningRecord.tradeOfferURL, status: sentOfferResult.status
        });

        let notificationType = 'info';
        let notificationMessage = `Winnings sent (Offer #${sentOfferResult.offerId}). Check Steam.`;
        if (sentOfferResult.status === 'pending' || sentOfferResult.status === 'pendingConfirmation') {
            notificationType = 'warning';
            notificationMessage = `Winnings sent (Offer #${sentOfferResult.offerId}), but confirmation may be needed in Steam.`;
            if (!identitySecret) {
                 notificationMessage = `Winnings sent (Offer #${sentOfferResult.offerId}), but require your confirmation in Steam if you have mobile auth.`;
            }
        }
        io.to(winner._id.toString()).emit('notification', { type: notificationType, message: notificationMessage });
        return { offerId: winningRecord.tradeOfferId, offerURL: winningRecord.tradeOfferURL, status: winningRecord.status };

    } catch (err) {
        console.error(`PAYOUT_ERROR: Error sending trade offer for record ${winningRecord._id}. Offer ID (if any): ${winningRecord.tradeOfferId}. EResult: ${err.eresult}, Msg: ${err.message}`);
        winningRecord.status = 'claim_error';
        winningRecord.errorMessage = err.message || 'Failed to send trade offer.';
        winningRecord.tradeOfferId = winningRecord.tradeOfferId || `ERROR_${Date.now()}`; // Ensure some ID if it failed early
        await winningRecord.save();

        let userMessage = `Error sending winnings for round ${winningRecord.roundDisplayId}. Please contact support.`;
        if (err.message.includes('revoked') || err.message.includes('invalid') || err.eresult === 26) {
            userMessage = 'Your Trade URL is invalid or expired. Please update it to receive winnings.';
        } else if (err.eresult === 15 || err.eresult === 16) { // Access Denied or Timeout
            userMessage = 'Could not send winnings. Ensure your Steam inventory is public and not full.';
        }
        io.to(winner._id.toString()).emit('notification', { type: 'error', message: userMessage });
        throw err; // Re-throw to be caught by the API endpoint handler
    }
}


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
            res.clearCookie('connect.sid'); // Ensure session cookie is cleared
            res.json({ success: true });
        });
    });
});

function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) { return next(); }
    res.status(401).json({ error: 'Not authenticated' });
}
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.warn("Validation Errors:", errors.array());
        return res.status(400).json({ error: errors.array()[0].msg }); // Send first error message
    }
    next();
};

app.get('/api/user', ensureAuthenticated, async (req, res) => {
    const { _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue } = req.user;
    // Check for any unclaimed winnings for this user
    const unclaimedWinnings = await WinningRecord.find({ user: _id, status: 'unclaimed' })
        .select('_id roundDisplayId amountWon itemsWonDetails createdAt')
        .sort({ createdAt: -1 })
        .lean();

    res.json({
        _id, steamId, username, avatar, tradeUrl, createdAt,
        pendingDepositOfferId, totalDepositedValue, totalWinningsValue,
        unclaimedWinnings: unclaimedWinnings.length > 0 ? unclaimedWinnings : [] // Send an array
    });
});


app.get('/api/user/winning-history', ensureAuthenticated, async (req, res) => {
    try {
        const winnings = await WinningRecord.find({ user: req.user._id })
            .sort({ createdAt: -1 })
            .limit(50)
            .select('roundDisplayId amountWon tradeOfferId tradeOfferURL status createdAt itemsWonDetails') // Select relevant fields
            .lean();

        const formattedWinnings = winnings.map(w => ({
            gameId: `R-${w.roundDisplayId}`, // Or use round's provable hash if needed
            roundDisplayId: w.roundDisplayId,
            amountWon: w.amountWon,
            tradeOfferId: w.tradeOfferId,
            tradeOfferURL: w.tradeOfferURL,
            tradeOfferStatus: w.status, // Use the main status field from WinningRecord
            timestamp: w.createdAt,
            itemsWon: w.itemsWonDetails.map(i => ({ name: i.name, image: i.image, price: i.price })) // Simplify items if sent
        }));
        res.json(formattedWinnings);
    } catch (error) {
        console.error(`Error fetching winning history for user ${req.user._id}:`, error);
        res.status(500).json({ error: 'Server error fetching winning history.' });
    }
});

// NEW ENDPOINT TO CLAIM WINNINGS
app.post('/api/winnings/claim/:recordId', sensitiveActionLimiter, ensureAuthenticated,
    [ param('recordId').isMongoId().withMessage('Invalid record ID format.') ],
    handleValidationErrors,
    async (req, res) => {
        const { recordId } = req.params;
        const userId = req.user._id;

        try {
            console.log(`User ${userId} attempting to claim winnings for record ${recordId}`);
            const result = await initiateAndSendWinningsOffer(recordId, userId);
            res.json({ success: true, message: 'Winnings claim processed. Trade offer sent.', data: result });
        } catch (error) {
            console.error(`Error claiming winnings for record ${recordId} by user ${userId}:`, error.message);
            // Provide more specific error messages based on the error type
            let statusCode = 500;
            if (error.message.includes('not found') || error.message.includes('User not authorized')) statusCode = 404;
            else if (error.message.includes('already been processed') || error.message.includes('invalid state')) statusCode = 409; // Conflict
            else if (error.message.includes('Trade URL set') || error.message.includes('Bot is not ready')) statusCode = 400; // Bad request (user or system config issue)

            res.status(statusCode).json({ error: error.message || 'Failed to claim winnings.' });
        }
    }
);


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
            if (err.name === 'ValidationError') {
                 console.error(`Trade URL Validation Error (Mongoose) for user ${req.user._id}:`, err.message);
                 return res.status(400).json({ error: err.message });
            }
            console.error(`Error updating trade URL for user ${req.user._id}:`, err);
            res.status(500).json({ error: 'Server error saving Trade URL.' });
        }
    }
);

app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    if (!isBotReady) {
        console.warn(`Inventory fetch failed for ${req.user.username}: Bot service is unavailable.`);
        return res.status(503).json({ error: "Steam service temporarily unavailable. Please try again later." });
    }
    try {
        const inventory = await new Promise((resolve, reject) => {
            // Use manager.getUserInventoryContents for fetching specific user's inventory via Steam API
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                if (err) {
                    if (err.message?.includes('profile is private') || err.eresult === 15) {
                        return reject(new Error('Your Steam inventory is private. Please set it to public.'));
                    }
                    console.error(`Inventory Fetch Error (Manager): User ${req.user.steamId}: EResult ${err.eresult} - ${err.message || err}`);
                    return reject(new Error(`Could not fetch inventory. Steam might be busy or inventory private.`));
                }
                resolve(inv || []); // Ensure it resolves with an array
            });
        });

        if (!inventory?.length) return res.json([]); // Return empty array if no items

        const validItems = inventory.map(item => {
                const itemName = item.market_hash_name;
                let price = 0;
                if (itemName) price = getItemPrice(itemName); // Get cached price
                else console.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`);

                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

                if (!item.assetid || !item.icon_url || !itemName) {
                    console.warn(`Inventory item missing required properties: assetId ${item?.assetid}, Name ${itemName}, Icon ${item?.icon_url}`);
                    return null; // Skip invalid item
                }
                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`;
                return { assetId: item.assetid, name: itemName, image: imageUrl, price: finalPrice, tradable: item.tradable };
            })
            .filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE); // Filter out non-tradable or below min value
        res.json(validItems);
    } catch (err) {
        console.error(`Error in /api/inventory for ${req.user?.username || req.user?.steamId}:`, err.message);
        res.status(500).json({ error: err.message || 'Server error fetching inventory.' });
    }
});

app.post('/api/deposit', depositLimiter, ensureAuthenticated,
    [
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`You can deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items at a time.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.') // Basic validation
    ],
    handleValidationErrors,
    async (req, res) => {
        const user = req.user;
        const requestedAssetIds = req.body.assetIds;

        if (!isBotReady) return res.status(503).json({ error: "Deposit service temporarily unavailable (Bot offline)." });
        if (!user.tradeUrl) return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile before depositing.' });

        // Check for existing pending deposit offer
        if (user.pendingDepositOfferId) {
             try {
                 const offer = await manager.getOffer(user.pendingDepositOfferId);
                 // Check if the offer is still active/pending on Steam's side
                 if (offer && [TradeOfferManager.ETradeOfferState.Active, TradeOfferManager.ETradeOfferState.Sent, TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation].includes(offer.state)) {
                     console.log(`User ${user.username} already has pending deposit offer ${user.pendingDepositOfferId}. State: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
                     const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                     return res.status(409).json({ error: 'You already have an active deposit offer waiting. Please accept or decline it on Steam.', offerId: user.pendingDepositOfferId, offerURL: offerURL });
                 } else {
                      // If offer not active, clear the flag from the user
                      console.log(`Clearing stale pending offer ${user.pendingDepositOfferId} for user ${user.username} (State: ${TradeOfferManager.ETradeOfferState[offer?.state]}).`);
                      await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
                 }
             } catch (offerFetchError) {
                 // If error fetching (e.g., offer invalid/not found), clear the flag
                 console.warn(`Could not fetch pending offer ${user.pendingDepositOfferId}, clearing flag:`, offerFetchError.message);
                 await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
             }
        }

        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }

        // Check round limits
        let latestRoundData;
        try {
            latestRoundData = await Round.findById(currentRound._id).select('depositsInRound items').lean().exec();
            if (!latestRoundData) throw new Error('Could not fetch current round data.');

            const uniqueDepositorSteamIds = new Set(latestRoundData.depositsInRound.map(d => d.user?.toString())); // Assuming user is ObjectId
            if (!uniqueDepositorSteamIds.has(user._id.toString()) && uniqueDepositorSteamIds.size >= MAX_DEPOSITORS_PER_ROUND) {
                 return res.status(400).json({ error: `Depositor limit (${MAX_DEPOSITORS_PER_ROUND} unique users) reached.` });
            }
            if (latestRoundData.depositsInRound.length >= MAX_TOTAL_DEPOSITS_PER_ROUND) {
                return res.status(400).json({ error: `Maximum number of deposits (${MAX_TOTAL_DEPOSITS_PER_ROUND}) for this round has been reached.` });
            }
            if (latestRoundData.items.length + requestedAssetIds.length > MAX_ITEMS_PER_POT) {
                 const slotsLeft = MAX_ITEMS_PER_POT - latestRoundData.items.length;
                 return res.status(400).json({ error: `Depositing ${requestedAssetIds.length} items would exceed pot limit (${MAX_ITEMS_PER_POT}). ${slotsLeft} slots left.` });
            }
        } catch (dbErr) {
            console.error(`Error fetching round data during deposit for ${user.username}:`, dbErr);
            return res.status(500).json({ error: 'Internal server error checking round limits.' });
        }

        let itemsToRequestDetails = []; // Store item details for DB and socket emission
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
                if (!inventoryItem) throw new Error(`Item Asset ID ${assetId} not in your current inventory.`);
                if (!inventoryItem.tradable) throw new Error(`Item '${inventoryItem.market_hash_name}' is not tradable.`);
                const price = getItemPrice(inventoryItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) throw new Error(`Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below minimum value ($${MIN_ITEM_VALUE.toFixed(2)}).`);

                itemsToRequestDetails.push({
                    assetid: inventoryItem.assetid, // This is USER's assetid
                    name: inventoryItem.market_hash_name,
                    image: `https://community.akamai.steamstatic.com/economy/image/${inventoryItem.icon_url}`,
                    price: price
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
        const offerMessage = `RustyDegen Deposit ID: ${depositId} | Round: ${currentRound.roundId} | User: ${user.username}`;
        let cleanupTimeout = null;

        try {
            const offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsToRequestDetails.map(item => ({ // Items the bot will receive
                assetid: item.assetid, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID
            })));
            offer.setMessage(offerMessage);

            // Store pending deposit data, including item details for later DB insertion
            pendingDeposits.set(depositId, {
                userId: user._id, // MongoDB ObjectId
                steamId: user.steamId,
                roundId: currentRound._id, // MongoDB ObjectId of the current round
                itemsDetails: itemsToRequestDetails, // Array of item objects with name, image, price, assetid
                totalValue: depositTotalValue,
                offerId: null // Will be set after offer is sent
            });
            console.log(`Stored pending deposit ${depositId} for user ${user.steamId}.`);

            // Set a timeout to clean up the pending deposit if not accepted
            cleanupTimeout = setTimeout(() => {
                 if(pendingDeposits.has(depositId)) {
                     console.log(`Deposit attempt ${depositId} expired (timeout).`);
                      pendingDeposits.delete(depositId);
                      const tempOfferId = pendingDeposits.get(depositId)?.offerId || 'expired_before_id';
                      User.updateOne({ steamId: user.steamId, pendingDepositOfferId: tempOfferId }, { pendingDepositOfferId: null })
                        .catch(e => console.error("Error clearing user pending flag on deposit expiry:", e));
                 }
            }, manager.cancelTime || 10 * 60 * 1000); // Use manager's cancelTime or default

            console.log(`Sending deposit offer to ${user.username} (Trade URL: ${user.tradeUrl})...`);
            const status = await new Promise((resolve, reject) => {
                offer.send((err, sendStatus) => {
                    if (err) return reject(err);
                    resolve(sendStatus);
                });
            });

            // Update pending deposit with the actual offer ID
            if(pendingDeposits.has(depositId)) pendingDeposits.get(depositId).offerId = offer.id;

            try {
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: offer.id });
                console.log(`Set pendingDepositOfferId=${offer.id} for user ${user.username}.`);
            } catch (dbUpdateError) {
                 console.error(`CRITICAL: Failed to set pendingDepositOfferId for user ${user.username} after sending offer ${offer.id}.`, dbUpdateError);
                  pendingDeposits.delete(depositId); if (cleanupTimeout) clearTimeout(cleanupTimeout);
                  // Attempt to cancel the offer on Steam's side if possible
                  if(offer.id) offer.cancel().catch(cancelErr => console.error(`Failed to cancel offer ${offer.id} after DB error:`, cancelErr));
                  return res.status(500).json({ error: 'Failed to finalize deposit request state. Contact support. Offer may have been sent.' });
            }

            console.log(`Deposit offer ${offer.id} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;
            res.json({ success: true, message: 'Deposit offer created! Please accept it on Steam.', offerId: offer.id, offerURL: offerURL });

        } catch (error) {
            console.error(`Error sending deposit offer for ${user.username} (DepositID: ${depositId}): EResult ${error.eresult}`, error.message);
            pendingDeposits.delete(depositId); if (cleanupTimeout) clearTimeout(cleanupTimeout);
            // Clear pending flag on user if it was set or if an offer ID was generated
            const offerIdToClear = pendingDeposits.get(depositId)?.offerId || (error.offer?.id);
            if (offerIdToClear) {
                await User.updateOne({ _id: user._id, pendingDepositOfferId: offerIdToClear }, { pendingDepositOfferId: null })
                         .catch(e => console.error("Error clearing user flag on offer send fail:", e));
            } else {
                 await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }) // General clear if no ID known
                          .catch(e => console.error("Error clearing user flag on offer send fail (no specific ID):", e));
            }

            let userMessage = 'Failed to create deposit trade offer. Please try again later.';
            if (error.message.includes('unable to trade') && error.message.includes('reset your Steam account')) userMessage = `Steam Error: Your account has a temporary trade restriction. (${error.message})`;
            else if (error.message.includes('Trade URL') || error.message.includes('token') || error.eresult === 26) userMessage = 'Your Steam Trade URL might be invalid or expired. Please check your profile.';
            else if (error.eresult) userMessage += ` (Steam Error Code: ${error.eresult})`;
            res.status(500).json({ error: userMessage });
        }
    }
);


if (isBotConfigured && manager) {
    manager.on('newOffer', async (offer) => {
        // This bot is primarily for sending winnings and receiving deposits via specific offers.
        // Generally, decline unsolicited offers.
        if (!isBotReady || offer.isOurOffer) return; // Ignore offers sent by the bot itself

        // Decline if it's an offer where the bot is GIVING items, unless it's a known type of offer (e.g. withdrawals if you add them)
        // For now, assume any incoming offer asking for bot items is unsolicited.
        if (offer.itemsToGive && offer.itemsToGive.length > 0) {
             console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} is asking for bot items. Declining.`);
             return offer.decline((err) => { if (err) console.error(`Error declining unsolicited offer ${offer.id} (giving items):`, err); });
        }

        // Decline if it's an offer where the bot receives items BUT it's NOT a recognized deposit offer
        if (offer.itemsToReceive && offer.itemsToReceive.length > 0) {
             if (offer.message && offer.message.includes('RustyDegen Deposit ID:')) {
                 // This should NOT happen if users use the site UI. This implies a manual offer with correct message.
                 // It will be handled by `sentOfferChanged` if the bot *sent* it.
                 // If this is a new offer *from a user* with that message, it's an attempt to bypass the system.
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like a manual deposit attempt with correct message. Declining as it's not initiated by site flow.`);
                 return offer.decline((err) => { if (err) console.error(`Error declining manual deposit offer ${offer.id}:`, err); });
             } else {
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} is an unsolicited item donation. Declining.`);
                  return offer.decline((err) => { if (err) console.error(`Error declining unsolicited item donation ${offer.id}:`, err); });
             }
        }
        console.log(`Ignoring unrecognized incoming offer #${offer.id} from ${offer.partner.getSteamID64()}. ItemsToGive: ${offer.itemsToGive.length}, ItemsToReceive: ${offer.itemsToReceive.length}.`);
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        if (offer.state !== oldState) { // Log only actual state changes
            console.log(`Bot Offer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()}) Msg: "${offer.message}"`);
        }

        // Check if this offer is related to a WinningRecord
        const winningRecord = await WinningRecord.findOne({ tradeOfferId: offer.id });
        if (winningRecord) {
            let newStatusForRecord = winningRecord.status; // Default to current
            let notifyUser = false;
            let notification = { type: 'info', message: ''};

            switch (offer.state) {
                case TradeOfferManager.ETradeOfferState.Accepted:
                    newStatusForRecord = 'accepted_by_user';
                    notification = { type: 'success', message: `Winnings from offer #${offer.id} successfully accepted!`};
                    notifyUser = true;
                    break;
                case TradeOfferManager.ETradeOfferState.Declined:
                    newStatusForRecord = 'declined_by_user';
                    notification = { type: 'error', message: `Your winnings offer #${offer.id} was declined.`};
                    notifyUser = true;
                    break;
                case TradeOfferManager.ETradeOfferState.Canceled: // If bot cancels or Steam cancels
                    newStatusForRecord = 'offer_canceled';
                    notification = { type: 'warning', message: `Winnings offer #${offer.id} was canceled.`};
                    notifyUser = true;
                    break;
                case TradeOfferManager.ETradeOfferState.Expired:
                    newStatusForRecord = 'offer_expired';
                    notification = { type: 'warning', message: `Winnings offer #${offer.id} has expired.`};
                    notifyUser = true;
                    break;
                case TradeOfferManager.ETradeOfferState.InvalidItems: // Should not happen for winnings if items were available
                    newStatusForRecord = 'claim_error'; winningRecord.errorMessage = 'Invalid items in trade offer.';
                    notification = { type: 'error', message: `Problem with winnings offer #${offer.id} (invalid items). Contact support.`};
                    notifyUser = true;
                    break;
                case TradeOfferManager.ETradeOfferState.Sent: // Still just sent
                case TradeOfferManager.ETradeOfferState.Active: // Active can mean sent and waiting for user
                case TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation: // Bot needs to confirm (if 2FA for bot trades is on)
                     newStatusForRecord = 'offer_sent'; // It's out there
                     break;
                case TradeOfferManager.ETradeOfferState.InEscrow: // Escrow is still a form of 'sent' from our perspective
                     newStatusForRecord = 'offer_sent'; // Or a specific 'escrow' status if desired
                     notification = { type: 'warning', message: `Winnings offer #${offer.id} is in Steam Escrow. Please check Steam.`};
                     notifyUser = true;
                     break;
                default: newStatusForRecord = 'unknown_offer_state';
            }
            if (winningRecord.status !== newStatusForRecord) {
                winningRecord.status = newStatusForRecord;
                await winningRecord.save().catch(e => console.error(`Error updating WinningRecord ${winningRecord._id} status to ${newStatusForRecord} for offer ${offer.id}:`, e));
                console.log(`WinningRecord ${winningRecord._id} status updated to ${newStatusForRecord} for offer ${offer.id}`);
                if (notifyUser && winningRecord.user) {
                    io.to(winningRecord.user.toString()).emit('notification', { type: notification.type, message: notification.message });
                }
            }
        }


        // DEPOSIT OFFER PROCESSING
        const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
        const depositId = messageMatch ? messageMatch[1] : null;

        if (depositId && pendingDeposits.has(depositId)) {
            const depositData = pendingDeposits.get(depositId);
            // Ensure this offer ID matches the one stored in pendingDeposits if it was updated
            if(depositData.offerId && depositData.offerId !== offer.id){
                console.warn(`Offer ID mismatch for deposit ${depositId}. Expected ${depositData.offerId}, got ${offer.id}. Ignoring state change for this offer regarding this depositId.`);
                return;
            }


            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                pendingDeposits.delete(depositId); // Remove from pending map
                console.log(`Processing accepted deposit offer #${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId}`);

                // Clear pendingDepositOfferId from User document
                User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                    .then(updateRes => {
                         if(updateRes.modifiedCount > 0) console.log(`Cleared pendingDepositOfferId flag for user ${depositData.steamId}`);
                         else console.warn(`Could not clear pending flag for user ${depositData.steamId} (Offer ID: ${offer.id}) - might have been cleared already or mismatch.`);
                    })
                    .catch(e => console.error("Error clearing user pending flag on deposit accept:", e));

                let depositRound; // The round document to update
                try {
                     depositRound = await Round.findById(depositData.roundId).exec(); // Not lean, as we'll save it
                     if (!depositRound) throw new Error(`Round ${depositData.roundId} not found for deposit processing.`);
                     if (depositRound.status !== 'active' || isRolling) {
                          console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but round invalid. Status: ${depositRound?.status}, Rolling: ${isRolling}. Items NOT added to pot.`);
                          io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Deposit Error: Round ended or is rolling before your deposit (Offer #${offer.id}) was processed. Contact support if items were taken.` });
                          // TODO: Consider returning items to user if taken but not added to pot (complex)
                          return;
                     }
                     // Check limits again just before adding
                     const uniqueDepositors = new Set(depositRound.depositsInRound.map(d => d.user?.toString()));
                     if (!uniqueDepositors.has(depositData.userId.toString()) && uniqueDepositors.size >= MAX_DEPOSITORS_PER_ROUND) {
                         throw new Error(`Depositor limit (${MAX_DEPOSITORS_PER_ROUND}) reached just before final save for deposit ${depositId}.`);
                     }
                     if (depositRound.depositsInRound.length >= MAX_TOTAL_DEPOSITS_PER_ROUND) {
                        throw new Error(`Maximum number of deposits (${MAX_TOTAL_DEPOSITS_PER_ROUND}) reached just before final save for deposit ${depositId}.`);
                     }
                     if (depositRound.items.length + depositData.itemsDetails.length > MAX_ITEMS_PER_POT) {
                          throw new Error(`Pot item limit (${MAX_ITEMS_PER_POT}) reached just before final save for deposit ${depositId}.`);
                     }
                 } catch (roundCheckError) {
                      console.error(`CRITICAL DB ERROR checking round status for accepted deposit ${depositId} (Offer ${offer.id}):`, roundCheckError);
                       io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `CRITICAL Deposit Error for offer #${offer.id}. Please contact support. ${roundCheckError.message}` });
                      // TODO: Handle item return if possible
                      return;
                 }

                // All checks passed, proceed to add items and deposit entry
                let createdItemDocuments = [];
                try {
                    // Create Item documents for each item in the deposit
                    const itemDocumentsToCreate = depositData.itemsDetails.map(itemData => new Item({
                        assetId: itemData.assetid, // This is the assetId from the USER'S inventory at time of deposit request
                        name: itemData.name,
                        image: itemData.image,
                        price: itemData.price,
                        ownerSteamId: depositData.steamId, // Original owner
                        roundId: depositData.roundId,
                        // Note: After the trade, these assetIds might change from Steam's perspective if items are stacked/traded.
                        // For jackpot purposes, we care about the *value* and *visuals*. The bot now owns these items.
                        // If sending winnings, bot uses *its current assetIds* for these items.
                    }));
                    createdItemDocuments = await Item.insertMany(itemDocumentsToCreate, { ordered: false });
                     if (createdItemDocuments.length !== itemDocumentsToCreate.length) {
                         console.warn(`Deposit ${depositId}: Item insert count mismatch. Expected ${itemDocumentsToCreate.length}, got ${createdItemDocuments.length}. This might happen with {ordered: false} if some items failed validation individually.`);
                     }
                    console.log(`Deposit ${depositId}: Inserted ${createdItemDocuments.length} items into DB.`);

                    // Update User's total deposited value
                    const userToUpdateForDeposit = await User.findByIdAndUpdate(
                        depositData.userId,
                        { $inc: { totalDepositedValue: depositData.totalValue } },
                        { new: true } // Return updated document
                    );
                    if (userToUpdateForDeposit) {
                        console.log(`Updated deposit stats for ${userToUpdateForDeposit.username}: New total deposited $${userToUpdateForDeposit.totalDepositedValue.toFixed(2)}`);
                    } else {
                        console.warn(`Could not find user ${depositData.steamId} (ID: ${depositData.userId}) to update deposit stats.`);
                    }

                    // Create the new deposit entry for the round
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));
                    const newDepositEntry = {
                        _id: new mongoose.Types.ObjectId(), // Generate a new ObjectId for this sub-document
                        user: depositData.userId,
                        depositValue: depositData.totalValue,
                        tickets: depositTickets,
                        depositedItems: createdItemDocuments.map(doc => ({ // Store details of items in this deposit
                            assetId: doc.assetId, name: doc.name, image: doc.image, price: doc.price
                        })),
                        depositTimestamp: new Date()
                    };

                    depositRound.depositsInRound.push(newDepositEntry);
                    depositRound.totalValue += depositData.totalValue;
                    depositRound.items.push(...createdItemDocuments.map(doc => doc._id)); // Add to flat list of item ObjectIds in pot

                    const savedRound = await depositRound.save();
                    // Repopulate for emitting to client
                    const latestRoundDataForEmit = await Round.findById(savedRound._id)
                        .populate('depositsInRound.user', 'steamId username avatar')
                        .populate('items')
                        .lean();

                    if (!latestRoundDataForEmit) throw new Error('Failed to fetch updated round data after deposit save for emission.');

                    currentRound = latestRoundDataForEmit; // Update in-memory currentRound

                    // Emit an event to clients about the new deposit
                    io.emit('newDepositInRound', {
                        roundId: latestRoundDataForEmit.roundId,
                        depositEntry: { // Send only the new deposit details
                            _id: newDepositEntry._id, // Send the sub-document ID
                            user: {
                                _id: userToUpdateForDeposit._id, // Populated from userToUpdateForDeposit
                                steamId: userToUpdateForDeposit.steamId,
                                username: userToUpdateForDeposit.username,
                                avatar: userToUpdateForDeposit.avatar
                            },
                            depositValue: newDepositEntry.depositValue,
                            tickets: newDepositEntry.tickets,
                            depositedItems: newDepositEntry.depositedItems, // Send item details
                            depositTimestamp: newDepositEntry.depositTimestamp
                        },
                        totalPotValue: latestRoundDataForEmit.totalValue, // Send new total pot value
                        totalPotItemsCount: latestRoundDataForEmit.items.length,
                        totalDepositsCount: latestRoundDataForEmit.depositsInRound.length,
                        uniqueDepositorsCount: new Set(latestRoundDataForEmit.depositsInRound.map(d => d.user?._id.toString())).size
                    });

                      // Start timer if this is the first deposit in an active round
                      const uniqueUsersInPot = new Set(latestRoundDataForEmit.depositsInRound.map(d => d.user?._id.toString()));
                      if (uniqueUsersInPot.size > 0 && !roundTimer && latestRoundDataForEmit.status === 'active') {
                          console.log(`First unique depositor joined round ${latestRoundDataForEmit.roundId}. Starting timer.`);
                          startRoundTimer(); // Will use ROUND_DURATION
                      }
                     console.log(`Deposit success processed for offer #${offer.id}. User: ${userToUpdateForDeposit?.username}, Value: $${depositData.totalValue.toFixed(2)}`);

                 } catch (dbErr) {
                     console.error(`CRITICAL DATABASE/UPDATE ERROR processing accepted deposit ${offer.id} (DepositID: ${depositId}):`, dbErr);
                     io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `CRITICAL Deposit Error for offer #${offer.id}. Please contact support. ${dbErr.message}` });
                      // Attempt to clean up orphaned items if they were created
                      if (createdItemDocuments.length > 0) {
                          console.warn(`Attempting to delete ${createdItemDocuments.length} orphaned items for deposit ${depositId} due to error: ${dbErr.message}`);
                          await Item.deleteMany({ _id: { $in: createdItemDocuments.map(d => d._id) } });
                      }
                      // Potentially mark the round as error
                      if (currentRound) {
                          await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } }).catch(e => console.error("Failed to set round status to error:", e));
                          io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error.' });
                          currentRound.status = 'error'; // Update in-memory
                      }
                 }
            } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired, TradeOfferManager.ETradeOfferState.InvalidItems, TradeOfferManager.ETradeOfferState.Countered].includes(offer.state)) {
                 console.warn(`Bot Deposit Offer #${offer.id} to ${offer.partner.getSteamID64()} (DepositID: ${depositId}) ended unsuccessfully. State: ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                 pendingDeposits.delete(depositId); // Remove from pending
                 User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                      .then(updateRes => {
                           if(updateRes.modifiedCount > 0) console.log(`Cleared pending flag for user ${depositData.steamId} due to offer failure.`);
                      })
                      .catch(e => console.error("Error clearing user flag on deposit failure:", e));
                  const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                 io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Your deposit offer (#${offer.id}) was ${stateMessage}.` });
            }
        } else if (!winningRecord && !depositId) { // Offer not tied to a known deposit or winning record
            console.warn(`Offer #${offer.id} changed state (${TradeOfferManager.ETradeOfferState[offer.state]}), but not recognized as pending deposit or known winnings. Message: "${offer.message}"`);
        }
    });
}


function formatRoundForClient(roundDoc) {
    if (!roundDoc) return null;
    // If roundDoc is not a lean object, convert it
    const round = (typeof roundDoc.toObject === 'function') ? roundDoc.toObject() : roundDoc;

    const timeLeft = (round.status === 'active' && round.endTime)
        ? Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000))
        : (round.status === 'pending' ? ROUND_DURATION : 0);

    const depositsFormatted = (round.depositsInRound || []).map(depo => ({
        _id: depo._id, // ID of the deposit entry
        user: depo.user ? { _id: depo.user._id, steamId: depo.user.steamId, username: depo.user.username, avatar: depo.user.avatar } : null,
        depositValue: depo.depositValue || 0,
        tickets: depo.tickets || 0,
        depositedItems: (depo.depositedItems || []).map(item => ({ // Map item details
            assetId: item.assetId, name: item.name, image: item.image, price: item.price || 0
        })),
        depositTimestamp: depo.depositTimestamp
    })).filter(depo => depo.user); // Ensure user data is present

    // Populate items with owner details (using ownerSteamId from Item schema)
    // This requires items to be populated first.
    const itemsFormatted = (round.items || []).map(i => ({
        assetId: i.assetId, name: i.name, image: i.image, price: i.price || 0,
        ownerSteamId: i.ownerSteamId, // The SteamID of the user who deposited this item
        _id: i._id
    }));


    let winnerDetails = null;
    if (round.winner && round.winner.steamId) { // If winner is populated
        winnerDetails = {
            id: round.winner._id, steamId: round.winner.steamId,
            username: round.winner.username, avatar: round.winner.avatar
        };
    } else if (round.winner) { // If winner is just an ObjectId
         console.warn("Winner field was not fully populated in formatRoundForClient for round:", round.roundId, round.winner);
         winnerDetails = { id: round.winner.toString() }; // Fallback
    }

    const uniqueDepositorsCount = new Set((round.depositsInRound || []).map(d => d.user?._id?.toString()).filter(id => id)).size;

    return {
        _id: round._id,
        roundId: round.roundId, status: round.status, startTime: round.startTime, endTime: round.endTime,
        timeLeft: timeLeft, totalValue: round.totalValue || 0, serverSeedHash: round.serverSeedHash,
        depositsInRound: depositsFormatted, // Use the new formatted deposits
        items: itemsFormatted, // Send all items in pot with owner info
        winner: winnerDetails,
        winningTicket: round.status === 'completed' ? round.winningTicket : undefined,
        serverSeed: round.status === 'completed' ? round.serverSeed : undefined,
        clientSeed: round.status === 'completed' ? round.clientSeed : undefined,
        provableHash: round.status === 'completed' ? round.provableHash : undefined,
        taxAmount: round.taxAmount,
        uniqueDepositorsCount: uniqueDepositorsCount,
        totalDepositsCount: (round.depositsInRound || []).length
    };
}

app.get('/api/round/current', async (req, res) => {
    let roundToFormat = null;
    try {
        if (currentRound?._id) { // If we have an in-memory currentRound
            roundToFormat = await Round.findById(currentRound._id)
                 .populate('depositsInRound.user', 'steamId username avatar')
                 .populate('items') // Populate items linked in the round.items array
                 .populate('winner', 'steamId username avatar').lean();
            if (!roundToFormat) currentRound = null; // In-memory was stale
            else currentRound = roundToFormat; // Update in-memory with fresh populated data
        }

        if (!roundToFormat) { // If no valid in-memory or it was stale, query DB
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                 .sort({ startTime: -1 }) // Get the latest one
                 .populate('depositsInRound.user', 'steamId username avatar')
                 .populate('items')
                 .populate('winner', 'steamId username avatar').lean();

            if (roundToFormat && !currentRound) { // If found and no current in-memory
                 currentRound = roundToFormat;
                 console.log(`Restored active/pending round ${currentRound.roundId} from DB via API.`);
                 const uniqueUserCount = new Set((currentRound.depositsInRound || []).map(d => d.user?._id?.toString()).filter(id => id)).size;
                 if (currentRound.status === 'active' && uniqueUserCount > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                     startRoundTimer(true); // Resume with remaining time
                 } else if (currentRound.status === 'active' && uniqueUserCount > 0 && !currentRound.endTime && !roundTimer) {
                     startRoundTimer(false); // Start fresh timer
                 }
            }
        }

        const formattedData = formatRoundForClient(roundToFormat);
        if (formattedData) res.json(formattedData);
        else res.status(404).json({ error: 'No active or pending round found.' });

    } catch (err) {
        console.error('Error fetching/formatting current round data:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' });
    }
});

app.get('/api/rounds',
    [query('page').optional().isInt({ min: 1 }).toInt(), query('limit').optional().isInt({ min: 1, max: 50 }).toInt()],
    handleValidationErrors, async (req, res) => {
    try {
        const page = req.query.page || 1; const limit = req.query.limit || 10; const skip = (page - 1) * limit;
        const queryFilter = { status: { $in: ['completed', 'error'] } }; // Fetch completed or errored rounds

        const [roundsData, totalCount] = await Promise.all([
            Round.find(queryFilter).sort('-roundId').skip(skip).limit(limit)
                 .populate('winner', 'username avatar steamId') // Populate winner details
                 // No need to populate depositsInRound.user for history unless displaying all depositors
                 .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount taxedItems')
                 .lean(),
            Round.countDocuments(queryFilter)
        ]);
        res.json({ rounds: roundsData, totalPages: Math.ceil(totalCount / limit), currentPage: page, totalRounds: totalCount });
    } catch (err) {
        console.error('Error fetching past rounds:', err);
        res.status(500).json({ error: 'Server error fetching round history.' });
    }
});

app.post('/api/verify', sensitiveActionLimiter,
    [
        body('roundId').notEmpty().isInt({ min: 1 }).toInt(),
        body('serverSeed').trim().notEmpty().isHexadecimal().isLength({ min: 64, max: 64 }),
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 }) // Client seed can be various lengths
    ],
    handleValidationErrors, async (req, res) => {
    const { roundId, serverSeed, clientSeed } = req.body;
    try {
        const round = await Round.findOne({ roundId: roundId, status: 'completed' })
             // No need to populate depositsInRound for verification if totalTickets is derived correctly during endRound
             .populate('winner', 'username').lean();

        if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found.` });

        // 1. Verify Server Seed Hash
        const providedHashOfServerSeed = crypto.createHash('sha256').update(serverSeed).digest('hex');
        if (providedHashOfServerSeed !== round.serverSeedHash) {
            return res.json({ verified: false, reason: 'Server Seed Hash mismatch.', expectedHash: round.serverSeedHash, providedSeed: serverSeed, calculatedHash: providedHashOfServerSeed });
        }

        // 2. If official seeds are available, compare them
        if (round.serverSeed && round.clientSeed && (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed)) {
            return res.json({ verified: false, reason: 'Provided seeds do not match official round seeds.',
                expectedServerSeed: round.serverSeed, expectedClientSeed: round.clientSeed,
                providedServerSeed: serverSeed, providedClientSeed: clientSeed });
        }

        // 3. Calculate Provable Hash from provided seeds
        const combinedString = serverSeed + clientSeed;
        const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        if (round.provableHash && calculatedProvableHash !== round.provableHash) {
            return res.json({ verified: false, reason: 'Calculated Provable Hash mismatch with stored Provable Hash.',
                expectedProvableHash: round.provableHash, calculatedProvableHash, combinedString });
        }

        // 4. Calculate Winning Ticket
        // Re-fetch round with deposits to correctly calculate totalTickets for verification if not stored or if logic changed
        const roundForTicketVerification = await Round.findById(round._id).select('depositsInRound').lean();
        if (!roundForTicketVerification) return res.status(500).json({error: "Error re-fetching round for ticket verification."});

        const totalTickets = roundForTicketVerification.depositsInRound.reduce((sum, depo) => sum + (depo?.tickets || 0), 0);
        if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets based on its deposit entries.' });

        const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
        const calculatedWinningTicket = decimalFromHash % totalTickets;

        if (calculatedWinningTicket !== round.winningTicket) {
            return res.json({ verified: false, reason: 'Calculated winning ticket mismatch with stored winning ticket.',
                calculatedTicket: calculatedWinningTicket, actualWinningTicket: round.winningTicket,
                provableHashUsed: calculatedProvableHash, totalTicketsFromDeposits: totalTickets });
        }

        // All checks passed
        res.json({
            verified: true, roundId: round.roundId, serverSeed, serverSeedHash: round.serverSeedHash,
            clientSeed, combinedString, finalHash: calculatedProvableHash, winningTicket: calculatedWinningTicket,
            totalTickets: totalTickets, totalValue: round.totalValue, // This is after-tax value
            winnerUsername: round.winner?.username || 'N/A'
        });

    } catch (err) {
        console.error(`Error verifying round ${roundId}:`, err);
        res.status(500).json({ error: 'Server error during verification.' });
    }
});

io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.initialize()(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.session()(socket.request, socket.request.res || {}, next); });

let connectedChatUsers = 0;
const userLastMessageTime = new Map(); // For chat cooldown

io.on('connection', async (socket) => {
    connectedChatUsers++;
    io.emit('updateUserCount', connectedChatUsers);

    const user = socket.request.user; // From Passport deserialization

    if (user && user.username) {
        console.log(`User ${user.username} (Socket ID: ${socket.id}) connected.`);
        // If user has unclaimed winnings, notify them
        const unclaimedWinnings = await WinningRecord.find({ user: user._id, status: 'unclaimed' })
            .select('_id roundDisplayId amountWon itemsWonDetails createdAt')
            .sort({ createdAt: -1 })
            .lean();
        if (unclaimedWinnings.length > 0) {
            socket.emit('unclaimedWinningsNotification', unclaimedWinnings.map(uw => ({
                 winningRecordId: uw._id,
                 roundDisplayId: uw.roundDisplayId,
                 amountWon: uw.amountWon,
                 itemsWon: uw.itemsWonDetails.map(i => ({ name: i.name, image: i.image, price: i.price })),
                 timestamp: uw.createdAt
            })));
        }

    } else {
        console.log(`Anonymous client (Socket ID: ${socket.id}) connected.`);
    }

    try {
        const recentMessages = await ChatMessage.find({})
            .sort({ timestamp: -1 }) // Get newest first
            .limit(MAX_CHAT_MESSAGES_TO_LOAD)
            .populate('user', 'username avatar steamId')
            .lean();

        socket.emit('initialChatMessages', recentMessages.reverse().map(msg => ({
            username: msg.isSystemMessage ? 'System' : (msg.user?.username || msg.username),
            avatar: msg.isSystemMessage ? null : (msg.user?.avatar || msg.avatar),
            message: msg.message,
            userId: msg.user?._id?.toString(),
            userSteamId: msg.user?.steamId || msg.steamId, // Prefer populated, fallback to stored
            timestamp: msg.timestamp,
            type: msg.isSystemMessage ? 'system' : 'user'
        })));
    } catch (err) {
        console.error("Error fetching recent chat messages:", err);
    }


    socket.on('requestRoundData', async () => {
        try {
            let roundToSend = null;
             if (currentRound?._id) { // If there's an in-memory round
                 roundToSend = await Round.findById(currentRound._id)
                       .populate('depositsInRound.user', 'steamId username avatar')
                       .populate('items').populate('winner', 'steamId username avatar').lean();
                 if (!roundToSend) currentRound = null; // Stale in-memory
                 else currentRound = roundToSend;
             }
             if (!roundToSend) { // If no in-memory or was stale
                 roundToSend = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                       .sort({ startTime: -1 })
                       .populate('depositsInRound.user', 'steamId username avatar')
                       .populate('items').populate('winner', 'steamId username avatar').lean();
                 if (roundToSend && !currentRound) {
                      currentRound = roundToSend;
                      console.log(`Restored active/pending round ${currentRound.roundId} from DB on client socket request.`);
                      const uniqueUserCount = new Set((currentRound.depositsInRound || []).map(d => d.user?._id?.toString()).filter(id => id)).size;
                      if (currentRound.status === 'active' && uniqueUserCount > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) startRoundTimer(true);
                      else if (currentRound.status === 'active' && uniqueUserCount > 0 && !currentRound.endTime && !roundTimer) startRoundTimer(false);
                 }
             }
            const formattedData = formatRoundForClient(roundToSend);
            if (formattedData) socket.emit('roundData', formattedData);
            else socket.emit('noActiveRound');
        } catch (err) {
            console.error(`Error fetching round data for socket ${socket.id}:`, err);
            socket.emit('roundError', { error: 'Failed to load round data.' });
        }
    });

    socket.on('chatMessage', async (msg) => {
        if (!user || !user._id) {
            console.warn(`Chat message from unauthenticated socket ${socket.id}.`);
            socket.emit('notification', {type: 'error', message: 'You must be logged in to chat.'});
            return;
        }
        const userId = user._id.toString();
        const now = Date.now();
        const lastMessageTimeUser = userLastMessageTime.get(userId) || 0;

        if (now - lastMessageTimeUser < CHAT_COOLDOWN_SECONDS * 1000) {
            const timeLeft = Math.ceil((CHAT_COOLDOWN_SECONDS * 1000 - (now - lastMessageTimeUser)) / 1000);
            socket.emit('notification', {type: 'warning', message: `Please wait ${timeLeft}s before sending another message.`});
            return;
        }
        if (typeof msg !== 'string' || msg.trim().length === 0 || msg.trim().length > MAX_CHAT_MESSAGE_LENGTH) {
            socket.emit('notification', {type: 'error', message: `Invalid message. Max ${MAX_CHAT_MESSAGE_LENGTH} characters.`});
            return;
        }

        userLastMessageTime.set(userId, now);
        const trimmedMessage = msg.trim();
        const messageData = {
            user: user._id, steamId: user.steamId, username: user.username,
            avatar: user.avatar || '/img/default-avatar.png',
            message: trimmedMessage, timestamp: new Date()
        };

        try {
            const savedMessage = await new ChatMessage(messageData).save();
            // Populate user details for broadcast
            const populatedMessage = await ChatMessage.findById(savedMessage._id).populate('user', 'username avatar steamId').lean();

            io.emit('chatMessage', { // Broadcast the populated message
                username: populatedMessage.user?.username || populatedMessage.username,
                avatar: populatedMessage.user?.avatar || populatedMessage.avatar,
                message: populatedMessage.message,
                userId: populatedMessage.user?._id?.toString(),
                userSteamId: populatedMessage.user?.steamId || populatedMessage.steamId,
                timestamp: populatedMessage.timestamp,
                type: 'user' // To distinguish from system messages on client
            });
            console.log(`Chat (User: ${user.username}, ID: ${userId}): ${trimmedMessage}`);
        } catch (saveError) {
            console.error("Error saving chat message:", saveError);
            socket.emit('notification', {type: 'error', message: 'Error sending message. Please try again.'});
        }
    });

    socket.on('disconnect', (reason) => {
        connectedChatUsers--;
        io.emit('updateUserCount', connectedChatUsers);
         if (user && user.username) {
            console.log(`User ${user.username} (Socket ID: ${socket.id}) disconnected. Reason: ${reason}`);
        } else {
            console.log(`Anonymous client (Socket ID: ${socket.id}) disconnected. Reason: ${reason}`);
        }
    });
});

async function startApp() {
    console.log("Performing initial price cache refresh from rust.scmm.app...");
    await refreshPriceCache(); // Initial refresh
    setInterval(async () => { // Schedule periodic refresh
        try { await refreshPriceCache(); }
        catch (refreshErr) { console.error("Error during scheduled price cache refresh:", refreshErr); }
    }, PRICE_REFRESH_INTERVAL_MS);
    console.log(`Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log(`Site URL configured as: ${process.env.SITE_URL}`);
        if (!isBotConfigured) console.log("INFO: Steam Bot not configured. Trade features disabled.");
        else if (!isBotReady) console.log("INFO: Steam Bot login attempt may have failed or is pending. Check logs.");
        else console.log("INFO: Steam Bot is ready.");
        ensureInitialRound(); // Call after server starts
    });
}
startApp();

function gracefulShutdown() {
    console.log('Received shutdown signal. Closing server...');
    io.close(() => { console.log('Socket.IO connections closed.'); });
    server.close(async () => {
        console.log('HTTP server closed.');
        try {
            await mongoose.connection.close();
            console.log('MongoDB connection closed.');
            if (manager && typeof manager.shutdown === 'function') { // Check if manager exists and has shutdown
                 console.log('Stopping TradeOfferManager polling...');
                 manager.shutdown();
            } else if (manager) { // If manager exists but no shutdown (older versions or other implementations)
                 console.log('TradeOfferManager does not have a direct shutdown method, polling will stop on process exit.');
            }
            process.exit(0);
        } catch (e) {
            console.error("Error during graceful shutdown:", e);
            process.exit(1);
        }
    });
    // Force shutdown if graceful fails
    setTimeout(() => {
        console.error('Could not close connections gracefully in time, forcing shutdown.');
        process.exit(1);
    }, 10000); // 10 seconds timeout
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Global error handler
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' && !err.expose ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.');
    if (res.headersSent) return next(err); // If headers already sent, delegate to Express default handler
    res.status(status).json({ error: message });
});

console.log("app.js modified for individual deposits, winner claim flow, and persistence assurance.");
