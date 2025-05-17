// app.js (Corrected for errors and warnings, and features) - Part 1 of 2

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
const MAX_DEPOSITORS_PER_ROUND = parseInt(process.env.MAX_DEPOSITORS_PER_ROUND) || 20;
const MAX_TOTAL_DEPOSITS_PER_ROUND = parseInt(process.env.MAX_TOTAL_DEPOSITS_PER_ROUND) || 50;
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
    totalDepositedValue: { type: Number, default: 0, min: 0 },
    totalWinningsValue: { type: Number, default: 0, min: 0 }
});

const itemSchema = new mongoose.Schema({
    assetId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    image: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    ownerSteamId: { type: String, required: true, index: true },
    roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true, index: true },
    depositedAt: { type: Date, default: Date.now }
});

const depositEntrySchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // Index here
    depositValue: { type: Number, required: true, default: 0, min: 0 },
    tickets: { type: Number, required: true, default: 0, min: 0 },
    depositedItems: [{ // Store details of items in this specific deposit entry
        assetId: { type: String, required: true },
        name: { type: String, required: true },
        image: { type: String, required: true },
        price: { type: Number, required: true, min: 0 }
    }],
    depositTimestamp: { type: Date, default: Date.now }
}, { _id: true }); // Ensure sub-documents get their own _id


const roundSchema = new mongoose.Schema({
    roundId: { type: Number, required: true, unique: true, index: true },
    status: { type: String, enum: ['pending', 'active', 'rolling', 'completed', 'error'], default: 'pending', index: true },
    startTime: { type: Date },
    endTime: { type: Date },
    completedTime: { type: Date },
    totalValue: { type: Number, default: 0, min: 0 }, // Sum of all depositValues in depositsInRound
    items: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }], // Flat list of all Item ObjectIds in the pot
    depositsInRound: [depositEntrySchema], // Array of individual deposit entries
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    winningDepositEntryId: { type: mongoose.Schema.Types.ObjectId }, // ID of the specific depositEntry that won
    winningTicket: { type: Number, min: 0 },
    serverSeed: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    serverSeedHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    clientSeed: { type: String, match: /^[a-f0-9]+$/ },
    provableHash: { type: String, match: /^[a-f0-9]{64}$/ },
    taxAmount: { type: Number, default: 0, min: 0 },
    taxedItems: [{ assetId: String, name: String, price: { type: Number, min: 0 }, image: String }]
});
// Removed redundant index: roundSchema.index({ 'depositsInRound.user': 1 }); // Index is now on depositEntrySchema.user

const winningRecordSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    round: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true, index: true },
    roundDisplayId: { type: Number, required: true },
    amountWon: { type: Number, required: true, min: 0 },
    status: {
        type: String,
        enum: ['unclaimed', 'claim_initiated', 'sending_offer', 'offer_sent', 'accepted_by_user', 'declined_by_user', 'offer_expired', 'offer_canceled', 'claim_error', 'unknown_offer_state'],
        default: 'unclaimed'
    },
    tradeOfferId: { type: String, index: true },
    tradeOfferURL: { type: String },
    itemsWonDetails: [{ // Details of items for this win record
        assetId: String,
        name: String,
        price: Number,
        image: String
    }],
    claimedAt: { type: Date },
    errorMessage: { type: String },
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

async function createNewRound() {
    if (isRolling) {
        console.log("Cannot create new round: Current round is rolling.");
        return null;
    }
    if (currentRound && currentRound.status === 'active') {
        console.log(`Cannot create new round: Round ${currentRound.roundId} is already active.`);
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
            depositsInRound: [],
            totalValue: 0
        });
        await newRound.save();
        currentRound = newRound.toObject(); // Convert to plain JS object for consistency

        io.emit('roundCreated', {
            roundId: newRound.roundId,
            serverSeedHash: newRound.serverSeedHash,
            timeLeft: ROUND_DURATION,
            totalValue: 0,
            depositsInRound: [],
            items: [],
            uniqueDepositorsCount: 0,
            totalDepositsCount: 0
        });
        console.log(`--- Round ${newRound.roundId} created and active ---`);
        return newRound.toObject();
    } catch (err) {
        console.error('FATAL: Error creating new round:', err);
        setTimeout(createNewRound, 10000);
        return null;
    }
}

async function ensureInitialRound() {
    if (isBotConfigured && isBotReady) {
        if (!currentRound) {
            try {
                const existingActive = await Round.findOne({ status: 'active' })
                    .populate('depositsInRound.user', 'steamId username avatar tradeUrl')
                    .populate('items')
                    .lean();

                if (existingActive) {
                    console.log(`Found existing active round ${existingActive.roundId} on startup.`);
                    currentRound = existingActive;

                    const deposits = Array.isArray(currentRound.depositsInRound) ? currentRound.depositsInRound : [];
                    const uniqueDepositors = new Set(
                        deposits.filter(d => d.user && d.user._id)
                                .map(d => d.user._id.toString())
                    );

                    if (uniqueDepositors.size > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        startRoundTimer(true);
                    } else if (uniqueDepositors.size > 0 && !currentRound.endTime && !roundTimer) {
                        console.warn(`Active round ${currentRound.roundId} found without endTime. Starting timer now.`);
                        startRoundTimer(false);
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
    if (roundTimer) clearInterval(roundTimer);
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
        timeLeft = ROUND_DURATION;
        calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
        currentRound.endTime = calculatedEndTime; // Update in-memory
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } }) // Persist
            .catch(e => console.error(`Error saving round end time for round ${currentRound?._id}:`, e));
        console.log(`Starting timer for round ${currentRound.roundId} (${ROUND_DURATION}s). End time: ${calculatedEndTime.toISOString()}`);
    }

    io.emit('timerUpdate', { timeLeft });

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
            await endRound();
        }
    }, 1000);
}
// app.js (Corrected for errors and warnings, and features) - Part 2 of 2

async function endRound() {
    if (!currentRound || isRolling || currentRound.status !== 'active') {
        console.warn(`Attempted to end round ${currentRound?.roundId}, but state is invalid (Status: ${currentRound?.status}, Rolling: ${isRolling})`);
        return;
    }
    isRolling = true;
    const roundIdToEnd = currentRound.roundId;
    const roundMongoId = currentRound._id;
    console.log(`--- Ending round ${roundIdToEnd}... ---`);

    try {
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } });
        io.emit('roundRolling', { roundId: roundIdToEnd });

        const round = await Round.findById(roundMongoId)
            .populate('depositsInRound.user', 'steamId username avatar tradeUrl') // Ensure tradeUrl is populated for winner
            .populate('items') // Populate the flat list of items (these are Item documents)
            .lean();

        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);
        if (round.status !== 'rolling') {
             console.warn(`Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Aborting endRound.`);
             isRolling = false; return;
        }
        currentRound = round; // Update in-memory currentRound with populated data

        if (round.depositsInRound.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            console.log(`Round ${round.roundId} ended with no valid deposits or value.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date() } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants or items." });
            isRolling = false;
            setTimeout(createNewRound, 5000);
            return;
        }

        let finalItemsForWinner = [...round.items]; // These are Item documents
        let potValueForWinner = round.totalValue;
        let taxAmount = 0;
        let taxedItemsInfo = []; // For storing details of items taken for tax

        if (potValueForWinner >= MIN_POT_FOR_TAX) {
            const targetTaxValue = potValueForWinner * (TAX_MIN_PERCENT / 100);
            const maxTaxValue = potValueForWinner * (TAX_MAX_PERCENT / 100);
            // Sort all Item documents in the pot by price (ascending) to pick cheapest for tax
            const sortedItemsForTax = [...finalItemsForWinner].sort((a, b) => a.price - b.price);
            let currentTaxValueAccumulated = 0;
            let itemsToTakeForTaxIds = []; // Store ObjectIds of items taken for tax

            for (const item of sortedItemsForTax) {
                if (currentTaxValueAccumulated + item.price <= maxTaxValue) {
                    itemsToTakeForTaxIds.push(item._id.toString());
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price, image: item.image });
                    currentTaxValueAccumulated += item.price;
                    if (currentTaxValueAccumulated >= targetTaxValue) break;
                } else {
                    break;
                }
            }

            if (itemsToTakeForTaxIds.length > 0) {
                const taxedItemObjectIdSet = new Set(itemsToTakeForTaxIds);
                // Filter out the Item documents that were taxed
                finalItemsForWinner = finalItemsForWinner.filter(item => !taxedItemObjectIdSet.has(item._id.toString()));
                taxAmount = currentTaxValueAccumulated;
                potValueForWinner -= taxAmount;
                console.log(`Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${itemsToTakeForTaxIds.length} items). New Pot Value for Winner: $${potValueForWinner.toFixed(2)}`);
            }
        }

        const clientSeed = crypto.randomBytes(16).toString('hex');
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        const totalTickets = round.depositsInRound.reduce((sum, depositEntry) => sum + (depositEntry?.tickets || 0), 0);

        if (totalTickets <= 0) throw new Error(`Cannot determine winner: Total tickets is zero or invalid for round ${round.roundId}.`);

        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16);
        const winningTicketNumber = decimalFromHash % totalTickets;

        let cumulativeTickets = 0;
        let winningUser = null; // This will be the populated User object from winning deposit entry
        let winningDepositEntryId = null;

        for (const depositEntry of round.depositsInRound) {
            if (!depositEntry?.tickets || !depositEntry.user) continue;
            cumulativeTickets += depositEntry.tickets;
            if (winningTicketNumber < cumulativeTickets) {
                winningUser = depositEntry.user;
                winningDepositEntryId = depositEntry._id; // This is ObjectId of the subdocument
                break;
            }
        }

        if (!winningUser || !winningUser._id) throw new Error(`Winner selection failed for round ${round.roundId}. Winning Ticket: ${winningTicketNumber}, Total Tickets: ${totalTickets}`);

        try {
            const updatedWinnerUser = await User.findByIdAndUpdate(
                winningUser._id,
                { $inc: { totalWinningsValue: potValueForWinner } },
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
            amountWon: potValueForWinner, // This is the after-tax value
            status: 'unclaimed',
            // Store details of the actual items the winner will receive (after tax)
            itemsWonDetails: finalItemsForWinner.map(item => ({ assetId: item.assetId, name: item.name, price: item.price, image: item.image })),
            createdAt: new Date()
        });

        const finalUpdateData = {
            status: 'completed', completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicketNumber, winner: winningUser._id,
            winningDepositEntryId: winningDepositEntryId, // Store ID of the winning deposit entry
            taxAmount: taxAmount, taxedItems: taxedItemsInfo,
            totalValue: potValueForWinner, // Store the after-tax value that was won
            items: finalItemsForWinner.map(i => i._id) // Store ObjectIds of Item documents remaining for winner
        };
        await Round.updateOne({ _id: roundMongoId }, { $set: finalUpdateData });

        console.log(`Round ${round.roundId} completed. Winner: ${winningUser.username} (Ticket No: ${winningTicketNumber}/${totalTickets}, Deposit ID: ${winningDepositEntryId}, Value Won: $${potValueForWinner.toFixed(2)})`);

        io.emit('roundWinner', {
            roundId: round.roundId,
            winner: { id: winningUser._id.toString(), steamId: winningUser.steamId, username: winningUser.username, avatar: winningUser.avatar },
            winningTicket: winningTicketNumber, totalValue: potValueForWinner, totalTickets: totalTickets,
            serverSeed: round.serverSeed, clientSeed: clientSeed, provableHash: provableHash, serverSeedHash: round.serverSeedHash,
            winningDepositEntryId: winningDepositEntryId.toString() // Send this to client for roulette/display
        });

        // Emit specific event to the winner with details to claim
        // Use the user's MongoDB ID as the room name
        const winnerSockets = await io.in(winningUser._id.toString()).fetchSockets();
        if (winnerSockets && winnerSockets.length > 0) {
            winnerSockets.forEach(winnerSocket => {
                winnerSocket.emit('youWonRoundDetails', {
                    winningRecordId: winningRecord._id.toString(), // Send the ID of the WinningRecord
                    roundId: round.roundId,
                    amountWon: potValueForWinner,
                    itemsWon: finalItemsForWinner.map(item => ({ name: item.name, image: item.image, price: item.price })) // Send details of items won
                });
            });
        } else {
            console.log(`Winner ${winningUser.username} not connected via socket. Winnings can be claimed later from profile.`);
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
        setTimeout(createNewRound, 10000);
    }
}

async function initiateAndSendWinningsOffer(winningRecordId, claimingUserId) {
    const winningRecord = await WinningRecord.findById(winningRecordId)
        .populate('user', 'tradeUrl username steamId _id') // Populate necessary user fields, ensure _id
        .populate({ path: 'round', select: 'roundId items', populate: { path: 'items' } }); // Get items from the round that were part of the win

    if (!winningRecord) {
        throw new Error('Winning record not found.');
    }
    if (winningRecord.user._id.toString() !== claimingUserId.toString()) {
        throw new Error('User not authorized to claim these winnings.');
    }
    if (winningRecord.status !== 'unclaimed' && winningRecord.status !== 'claim_error') {
        if (winningRecord.tradeOfferId && winningRecord.tradeOfferURL && (winningRecord.status === 'offer_sent' || winningRecord.status === 'sending_offer')) {
             console.log(`Winnings for record ${winningRecord._id} already have an active offer: ${winningRecord.tradeOfferId}`);
             const winnerSockets = await io.in(winningRecord.user._id.toString()).fetchSockets();
             if (winnerSockets && winnerSockets.length > 0) {
                winnerSockets.forEach(socket => {
                    socket.emit('tradeOfferSent', { // Re-notify client
                        winningRecordId: winningRecord._id.toString(),
                        userId: winningRecord.user._id.toString(),
                        username: winningRecord.user.username,
                        offerId: winningRecord.tradeOfferId,
                        offerURL: winningRecord.tradeOfferURL,
                        status: 'resend_notification' // Custom status for client to handle this
                    });
                });
             }
             return { offerId: winningRecord.tradeOfferId, offerURL: winningRecord.tradeOfferURL, status: winningRecord.status, message: "Offer already sent." };
        }
        throw new Error(`Winnings have already been processed or are in an invalid state: ${winningRecord.status}.`);
    }

    winningRecord.status = 'sending_offer'; // Mark as processing
    winningRecord.claimedAt = new Date();
    await winningRecord.save();

    const winner = winningRecord.user;
    // The items to send are those stored in the Round.items array *after* tax,
    // which should be referenced by winningRecord.round.items
    const itemsFromRoundRecord = winningRecord.round.items; // These should be the actual Item documents

    if (!isBotReady) {
        winningRecord.status = 'claim_error'; winningRecord.errorMessage = 'Steam Bot is not ready.';
        await winningRecord.save();
        throw new Error('PAYOUT_ERROR: Cannot send winnings: Steam Bot is not ready.');
    }
    if (!winner.tradeUrl) {
        winningRecord.status = 'claim_error'; winningRecord.errorMessage = 'Winner has no Trade URL set.';
        await winningRecord.save();
        throw new Error('PAYOUT_ERROR: Winner has no Trade URL set.');
    }

    // Map the Item documents to the format required by TradeOfferManager
    const itemsForOffer = itemsFromRoundRecord.map(item => ({
        assetid: item.assetId, // This is the assetId of the item as known to the bot
        appid: RUST_APP_ID,
        contextid: RUST_CONTEXT_ID
    }));

    if (itemsForOffer.length === 0 && winningRecord.amountWon > 0) {
        console.log(`PAYOUT_INFO: No physical items to send for winning record ${winningRecord._id}, but amountWon is ${winningRecord.amountWon}. This scenario should be reviewed.`);
        winningRecord.status = 'accepted_by_user'; // Assuming "accepted" means processed if no items
        winningRecord.tradeOfferId = `NO_ITEMS_${winningRecord.roundDisplayId}_AMT_${winningRecord.amountWon.toFixed(2)}`;
        await winningRecord.save();
        return { message: 'Winnings processed (no physical items to send).', status: 'accepted_by_user' };
    } else if (itemsForOffer.length === 0 && winningRecord.amountWon <= 0) { // No items and no value
        console.log(`PAYOUT_INFO: No items and no value to send for winning record ${winningRecord._id}.`);
        winningRecord.status = 'accepted_by_user';
        winningRecord.tradeOfferId = `NO_ITEMS_NO_VALUE_${winningRecord.roundDisplayId}`;
        await winningRecord.save();
        return { message: 'No items to send. Winnings processed.', status: 'accepted_by_user' };
    }


    console.log(`Attempting to send ${itemsForOffer.length} winning items for record ${winningRecord._id} to ${winner.username}...`);

    try {
        const offer = manager.createOffer(winner.tradeUrl);
        offer.addMyItems(itemsForOffer);
        const offerMessage = `Congratulations! Your winnings from Round #${winningRecord.roundDisplayId} on ${process.env.SITE_NAME || 'RustyDegen'}. Pot Value (after tax): $${winningRecord.amountWon.toFixed(2)}`;
        offer.setMessage(offerMessage);

        const identitySecret = process.env.STEAM_IDENTITY_SECRET;
        const sentOfferResult = await new Promise((resolve, reject) => {
            offer.send(!!identitySecret, (err, status) => {
                if (err) return reject(err);
                resolve({ status: status, offerId: offer.id });
            });
        });

        winningRecord.tradeOfferId = sentOfferResult.offerId;
        winningRecord.tradeOfferURL = `https://steamcommunity.com/tradeoffer/${sentOfferResult.offerId}/`;
        winningRecord.status = (sentOfferResult.status === 'pending' || sentOfferResult.status === 'pendingConfirmation' || sentOfferResult.status === 'sent') ? 'offer_sent' : 'unknown_offer_state';
        await winningRecord.save();

        console.log(`PAYOUT_SUCCESS: Trade offer ${sentOfferResult.offerId} sent to ${winner.username} for record ${winningRecord._id}. Status: ${sentOfferResult.status}`);

        const winnerSockets = await io.in(winner._id.toString()).fetchSockets();
        if (winnerSockets && winnerSockets.length > 0) {
            winnerSockets.forEach(socket => {
                socket.emit('tradeOfferSent', { // Notify client that offer is sent
                    winningRecordId: winningRecord._id.toString(), userId: winner._id.toString(), username: winner.username,
                    offerId: sentOfferResult.offerId, offerURL: winningRecord.tradeOfferURL, status: sentOfferResult.status
                });
                let notifType = 'info';
                let notifMsg = `Winnings sent (Offer #${sentOfferResult.offerId}). Check Steam.`;
                if (sentOfferResult.status === 'pending' || sentOfferResult.status === 'pendingConfirmation') {
                    notifType = 'warning';
                    notifMsg = `Winnings sent (Offer #${sentOfferResult.offerId}), but confirmation may be needed in Steam.`;
                }
                socket.emit('notification', { type: notifType, message: notifMsg });
            });
        }
        return { offerId: winningRecord.tradeOfferId, offerURL: winningRecord.tradeOfferURL, status: winningRecord.status, message: "Trade offer sent successfully." };

    } catch (err) {
        console.error(`PAYOUT_ERROR: Error sending trade offer for record ${winningRecord._id}. Offer ID (if any): ${winningRecord.tradeOfferId}. EResult: ${err.eresult}, Msg: ${err.message}`);
        winningRecord.status = 'claim_error';
        winningRecord.errorMessage = err.message || 'Failed to send trade offer.';
        winningRecord.tradeOfferId = winningRecord.tradeOfferId || `ERROR_SEND_${Date.now()}`;
        await winningRecord.save();

        let userMessage = `Error sending winnings for round ${winningRecord.roundDisplayId}. Please contact support.`;
        if (err.message.includes('revoked') || err.message.includes('invalid') || err.eresult === 26) {
            userMessage = 'Your Trade URL is invalid or expired. Please update it to receive winnings.';
        } else if (err.eresult === 15 || err.eresult === 16) {
            userMessage = 'Could not send winnings. Ensure your Steam inventory is public and not full.';
        }
        const winnerSockets = await io.in(winner._id.toString()).fetchSockets();
        if (winnerSockets && winnerSockets.length > 0) {
            winnerSockets.forEach(socket => socket.emit('notification', { type: 'error', message: userMessage }));
        }
        throw err; // Re-throw to be handled by the API endpoint
    }
}


// Routes and other logic start here
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

app.get('/api/user', ensureAuthenticated, async (req, res) => {
    const user = req.user.toObject(); // Get plain object
    const unclaimedWinnings = await WinningRecord.find({ user: user._id, status: 'unclaimed' })
        .select('_id roundDisplayId amountWon itemsWonDetails createdAt')
        .sort({ createdAt: -1 })
        .lean();
    res.json({
        ...user, // Spread user properties
        unclaimedWinnings: unclaimedWinnings.length > 0 ? unclaimedWinnings.map(uw => ({...uw, winningRecordId: uw._id.toString() })) : []
    });
});


app.get('/api/user/winning-history', ensureAuthenticated, async (req, res) => {
    try {
        const winnings = await WinningRecord.find({ user: req.user._id })
            .sort({ createdAt: -1 })
            .limit(50)
            .select('roundDisplayId amountWon tradeOfferId tradeOfferURL status createdAt itemsWonDetails')
            .lean();
        const formattedWinnings = winnings.map(w => ({
            gameId: `R-${w.roundDisplayId}`, roundDisplayId: w.roundDisplayId, amountWon: w.amountWon,
            tradeOfferId: w.tradeOfferId, tradeOfferURL: w.tradeOfferURL, tradeOfferStatus: w.status,
            timestamp: w.createdAt, itemsWon: w.itemsWonDetails.map(i => ({ name: i.name, image: i.image, price: i.price }))
        }));
        res.json(formattedWinnings);
    } catch (error) {
        console.error(`Error fetching winning history for user ${req.user._id}:`, error);
        res.status(500).json({ error: 'Server error fetching winning history.' });
    }
});

app.post('/api/winnings/claim/:recordId', sensitiveActionLimiter, ensureAuthenticated,
    [ param('recordId').isMongoId().withMessage('Invalid record ID format.') ],
    handleValidationErrors,
    async (req, res) => {
        const { recordId } = req.params;
        const userId = req.user._id;
        try {
            const result = await initiateAndSendWinningsOffer(recordId, userId);
            res.json({ success: true, message: result.message || 'Winnings claim processed.', data: result });
        } catch (error) {
            let statusCode = 500;
            if (error.message.includes('not found') || error.message.includes('User not authorized')) statusCode = 404;
            else if (error.message.includes('already been processed') || error.message.includes('invalid state')) statusCode = 409;
            else if (error.message.includes('Trade URL set') || error.message.includes('Bot is not ready')) statusCode = 400;
            console.error(`Claim Winnings Error (API): Record ${recordId}, User ${userId}, Status ${statusCode}, Msg: ${error.message}`);
            res.status(statusCode).json({ error: error.message || 'Failed to claim winnings.' });
        }
    }
);


app.post('/api/user/tradeurl', sensitiveActionLimiter, ensureAuthenticated,
    [ body('tradeUrl').trim().custom((value) => {
            if (value === '') return true;
            const pattern = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/;
            if (!pattern.test(value)) throw new Error('Invalid Steam Trade URL format.');
            return true;
        })
    ], handleValidationErrors, async (req, res) => {
        try {
            const user = await User.findByIdAndUpdate(req.user._id, { tradeUrl: req.body.tradeUrl }, { new: true, runValidators: true });
            if (!user) return res.status(404).json({ error: 'User not found.' });
            res.json({ success: true, tradeUrl: user.tradeUrl });
        } catch (err) {
            if (err.name === 'ValidationError') return res.status(400).json({ error: err.message });
            res.status(500).json({ error: 'Server error saving Trade URL.' });
        }
    }
);

app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    if (!isBotReady) return res.status(503).json({ error: "Steam service temporarily unavailable." });
    try {
        const inventory = await new Promise((resolve, reject) => {
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                if (err) {
                    if (err.message?.includes('profile is private') || err.eresult === 15) return reject(new Error('Your Steam inventory is private.'));
                    return reject(new Error(`Could not fetch inventory (EResult: ${err.eresult}).`));
                } resolve(inv || []);
            });
        });
        const validItems = inventory.map(item => {
            const price = getItemPrice(item.market_hash_name);
            if (!item.assetid || !item.icon_url || !item.market_hash_name) return null;
            return { assetId: item.assetid, name: item.market_hash_name, image: `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`, price, tradable: item.tradable };
        }).filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE);
        res.json(validItems);
    } catch (err) { res.status(500).json({ error: err.message || 'Server error fetching inventory.' }); }
});

app.post('/api/deposit', depositLimiter, ensureAuthenticated,
    [
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`Max ${MAX_ITEMS_PER_DEPOSIT} items per deposit.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID.')
    ], handleValidationErrors, async (req, res) => {
        const user = req.user; const assetIds = req.body.assetIds;
        if (!isBotReady) return res.status(503).json({ error: "Deposit service unavailable (Bot offline)." });
        if (!user.tradeUrl) return res.status(400).json({ error: 'Set Trade URL in profile.' });

        if (user.pendingDepositOfferId) {
            try { const offer = await manager.getOffer(user.pendingDepositOfferId);
                if (offer && [1,2,9].includes(offer.state)) /* Active, Sent, NeedsConfirmation */
                    return res.status(409).json({ error: 'Existing pending deposit offer.', offerId: user.pendingDepositOfferId, offerURL: `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/` });
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
            } catch { await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }); }
        }
        if (!currentRound || currentRound.status !== 'active' || isRolling) return res.status(400).json({ error: 'Deposits closed.' });

        try {
            const roundData = await Round.findById(currentRound._id).select('depositsInRound items').lean();
            if (!roundData) throw new Error('Round data missing.');
            const uniqueUsers = new Set(roundData.depositsInRound.map(d => d.user?.toString()));
            if (!uniqueUsers.has(user._id.toString()) && uniqueUsers.size >= MAX_DEPOSITORS_PER_ROUND) return res.status(400).json({ error: `Depositor limit (${MAX_DEPOSITORS_PER_ROUND}) reached.` });
            if (roundData.depositsInRound.length >= MAX_TOTAL_DEPOSITS_PER_ROUND) return res.status(400).json({ error: `Max deposits (${MAX_TOTAL_DEPOSITS_PER_ROUND}) for round reached.`});
            if (roundData.items.length + assetIds.length > MAX_ITEMS_PER_POT) return res.status(400).json({ error: `Pot item limit (${MAX_ITEMS_PER_POT}) would be exceeded.`});
        } catch(e) { return res.status(500).json({ error: 'Error checking round limits.'}); }

        let itemsToReq = []; let totalVal = 0;
        try {
            const inv = await new Promise((rs, rj) => manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (e,i) => e ? rj(e) : rs(i||[])));
            const invMap = new Map(inv.map(i=>[i.assetid, i]));
            for(const id of assetIds){
                const item = invMap.get(id);
                if(!item) throw new Error(`Item ${id} not in inventory.`);
                if(!item.tradable) throw new Error(`Item ${item.market_hash_name} not tradable.`);
                const price = getItemPrice(item.market_hash_name);
                if(price < MIN_ITEM_VALUE) throw new Error(`Item ${item.market_hash_name} below min value.`);
                itemsToReq.push({assetid:id, name:item.market_hash_name, image:`https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`, price});
                totalVal += price;
            }
            if(itemsToReq.length === 0) throw new Error("No valid items.");
        } catch(e){ return res.status(400).json({error: e.message}); }

        const depositAttemptId = uuidv4();
        const offerMsg = `RustyDegen Deposit: ${depositAttemptId} | R:${currentRound.roundId}`;
        let cleanup;
        try {
            const offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsToReq.map(i=>({assetid:i.assetid, appid:RUST_APP_ID, contextid:RUST_CONTEXT_ID})));
            offer.setMessage(offerMsg);
            pendingDeposits.set(depositAttemptId, {userId:user._id, steamId:user.steamId, roundId:currentRound._id, itemsDetails:itemsToReq, totalValue:totalVal, offerId:null});
            cleanup = setTimeout(()=> {
                if(pendingDeposits.has(depositAttemptId)){
                    const d = pendingDeposits.get(depositAttemptId); pendingDeposits.delete(depositAttemptId);
                    User.updateOne({_id:d.userId, pendingDepositOfferId:d.offerId}, {pendingDepositOfferId:null}).catch(()=>{});
                }
            }, manager.cancelTime || 600000);
            const status = await new Promise((rs,rj)=>offer.send((e,s)=>e?rj(e):rs(s)));
            if(pendingDeposits.has(depositAttemptId)) pendingDeposits.get(depositAttemptId).offerId = offer.id;
            await User.findByIdAndUpdate(user._id, {pendingDepositOfferId: offer.id});
            res.json({success:true, message:'Offer sent. Accept on Steam.', offerId:offer.id, offerURL:`https://steamcommunity.com/tradeoffer/${offer.id}/`});
        } catch(e) {
            const pd = pendingDeposits.get(depositAttemptId); pendingDeposits.delete(depositAttemptId); if(cleanup) clearTimeout(cleanup);
            if(pd?.offerId) await User.updateOne({_id:user._id, pendingDepositOfferId: pd.offerId}, {pendingDepositOfferId:null});
            else await User.findByIdAndUpdate(user._id, {pendingDepositOfferId:null});
            res.status(500).json({error: e.message || 'Failed to send offer.'});
        }
    }
);

if (isBotConfigured && manager) {
    manager.on('newOffer', async (offer) => {
        if (!isBotReady || offer.isOurOffer) return;
        if (offer.itemsToGive && offer.itemsToGive.length > 0) {
             return offer.decline((err) => { if (err) console.error(`Error declining unsolicited offer ${offer.id} (giving items):`, err); });
        }
        if (offer.itemsToReceive && offer.itemsToReceive.length > 0) {
             if (!offer.message || !offer.message.includes('RustyDegen Deposit ID:')) {
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} is an unsolicited item donation/other. Declining.`);
                  return offer.decline((err) => { if (err) console.error(`Error declining unsolicited item offer ${offer.id}:`, err); });
             }
        }
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        if (offer.state !== oldState) {
            console.log(`Bot Offer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()}) Msg: "${offer.message}"`);
        }

        const winningRecord = await WinningRecord.findOne({ tradeOfferId: offer.id });
        if (winningRecord) {
            let newStatusForRecord = winningRecord.status; let notifyUser = false;
            let notification = { type: 'info', message: ''};
            switch (offer.state) {
                case TradeOfferManager.ETradeOfferState.Accepted: newStatusForRecord = 'accepted_by_user'; notification = { type: 'success', message: `Winnings from offer #${offer.id} successfully accepted!`}; notifyUser = true; break;
                case TradeOfferManager.ETradeOfferState.Declined: newStatusForRecord = 'declined_by_user'; notification = { type: 'error', message: `Your winnings offer #${offer.id} was declined.`}; notifyUser = true; break;
                case TradeOfferManager.ETradeOfferState.Canceled: newStatusForRecord = 'offer_canceled'; notification = { type: 'warning', message: `Winnings offer #${offer.id} was canceled.`}; notifyUser = true; break;
                case TradeOfferManager.ETradeOfferState.Expired: newStatusForRecord = 'offer_expired'; notification = { type: 'warning', message: `Winnings offer #${offer.id} has expired.`}; notifyUser = true; break;
                case TradeOfferManager.ETradeOfferState.InvalidItems: newStatusForRecord = 'claim_error'; winningRecord.errorMessage = 'Invalid items in trade offer.'; notification = { type: 'error', message: `Problem with winnings offer #${offer.id}. Contact support.`}; notifyUser = true; break;
                case TradeOfferManager.ETradeOfferState.Sent: case TradeOfferManager.ETradeOfferState.Active: case TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation: newStatusForRecord = 'offer_sent'; break;
                case TradeOfferManager.ETradeOfferState.InEscrow: newStatusForRecord = 'offer_sent'; notification = { type: 'warning', message: `Winnings offer #${offer.id} is in Steam Escrow.`}; notifyUser = true; break;
                default: newStatusForRecord = 'unknown_offer_state';
            }
            if (winningRecord.status !== newStatusForRecord) {
                winningRecord.status = newStatusForRecord;
                await winningRecord.save();
                if (notifyUser && winningRecord.user) {
                    const sockets = await io.in(winningRecord.user.toString()).fetchSockets();
                    sockets.forEach(s => s.emit('notification', { type: notification.type, message: notification.message }));
                }
            }
        }

        const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
        const depositId = messageMatch ? messageMatch[1] : null;
        if (depositId && pendingDeposits.has(depositId)) {
            const depositData = pendingDeposits.get(depositId);
            if(depositData.offerId && depositData.offerId !== offer.id) return;

            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                pendingDeposits.delete(depositId);
                User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user pending flag:", e));
                let depositRound;
                try {
                     depositRound = await Round.findById(depositData.roundId).exec();
                     if (!depositRound || depositRound.status !== 'active' || isRolling) {
                          throw new Error(`Round invalid or not active for deposit ${depositId}. Status: ${depositRound?.status}, Rolling: ${isRolling}`);
                     }
                     const uniqueDepositors = new Set(depositRound.depositsInRound.map(d => d.user?.toString()));
                     if (!uniqueDepositors.has(depositData.userId.toString()) && uniqueDepositors.size >= MAX_DEPOSITORS_PER_ROUND) throw new Error(`Depositor limit reached for deposit ${depositId}.`);
                     if (depositRound.depositsInRound.length >= MAX_TOTAL_DEPOSITS_PER_ROUND) throw new Error(`Max total deposits reached for ${depositId}.`);
                     if (depositRound.items.length + depositData.itemsDetails.length > MAX_ITEMS_PER_POT) throw new Error(`Pot item limit reached for ${depositId}.`);

                    const itemDocsToCreate = depositData.itemsDetails.map(item => new Item({ ...item, ownerSteamId: depositData.steamId, roundId: depositData.roundId }));
                    const createdItemDocs = await Item.insertMany(itemDocsToCreate, { ordered: false });
                    const userToUpdate = await User.findByIdAndUpdate(depositData.userId, { $inc: { totalDepositedValue: depositData.totalValue } }, { new: true });
                    const tickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));
                    const newDepoEntry = {
                        _id: new mongoose.Types.ObjectId(), user: depositData.userId, depositValue: depositData.totalValue, tickets: tickets,
                        depositedItems: createdItemDocs.map(d => ({ assetId: d.assetId, name: d.name, image: d.image, price: d.price })), // Store details
                        depositTimestamp: new Date()
                    };
                    depositRound.depositsInRound.push(newDepoEntry);
                    depositRound.totalValue += depositData.totalValue;
                    depositRound.items.push(...createdItemDocs.map(d => d._id)); // Add actual Item ObjectIds to round's items
                    const savedRound = await depositRound.save();
                    const populatedRoundForEmit = await Round.findById(savedRound._id).populate('depositsInRound.user', 'steamId username avatar').populate('items').lean();
                    currentRound = populatedRoundForEmit;
                    io.emit('newDepositInRound', {
                        roundId: populatedRoundForEmit.roundId,
                        depositEntry: { ...newDepoEntry, user: { _id: userToUpdate._id, steamId: userToUpdate.steamId, username: userToUpdate.username, avatar: userToUpdate.avatar } },
                        totalPotValue: populatedRoundForEmit.totalValue,
                        totalPotItemsCount: populatedRoundForEmit.items.length,
                        totalDepositsCount: populatedRoundForEmit.depositsInRound.length,
                        uniqueDepositorsCount: new Set(populatedRoundForEmit.depositsInRound.map(d => d.user?._id.toString())).size
                    });
                    const currentUniqueDepositors = new Set(populatedRoundForEmit.depositsInRound.map(d => d.user?._id.toString())).size;
                    if (currentUniqueDepositors > 0 && !roundTimer && populatedRoundForEmit.status === 'active') startRoundTimer();

                 } catch (dbErr) {
                     console.error(`CRITICAL DB/UPDATE ERROR for deposit ${depositId}:`, dbErr);
                     const userSocket = await io.in(depositData.userId.toString()).fetchSockets();
                     if(userSocket.length > 0) userSocket[0].emit('notification', { type: 'error', message: `CRITICAL Deposit Error for offer #${offer.id}. ${dbErr.message}` });
                 }
            } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired].includes(offer.state)) {
                 pendingDeposits.delete(depositId);
                 User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user flag on deposit failure:", e));
                 const stateMsg = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                 const userSocket = await io.in(depositData.userId.toString()).fetchSockets();
                 if(userSocket.length > 0) userSocket[0].emit('notification', { type: 'error', message: `Your deposit offer (#${offer.id}) was ${stateMsg}.` });
            }
        } else if (!winningRecord && !depositId) {
            console.warn(`Offer #${offer.id} changed state (${TradeOfferManager.ETradeOfferState[offer.state]}), but not recognized.`);
        }
    });
}


function formatRoundForClient(roundDoc) {
    if (!roundDoc) return null;
    const round = (typeof roundDoc.toObject === 'function') ? roundDoc.toObject() : roundDoc;
    const timeLeft = (round.status === 'active' && round.endTime)
        ? Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000))
        : (round.status === 'pending' ? ROUND_DURATION : 0);

    const depositsFormatted = (round.depositsInRound || []).map(depo => ({
        _id: depo._id.toString(),
        user: depo.user ? { _id: depo.user._id.toString(), steamId: depo.user.steamId, username: depo.user.username, avatar: depo.user.avatar } : null,
        depositValue: depo.depositValue || 0,
        tickets: depo.tickets || 0,
        depositedItems: (depo.depositedItems || []).map(item => ({ assetId: item.assetId, name: item.name, image: item.image, price: item.price || 0 })),
        depositTimestamp: depo.depositTimestamp
    })).filter(depo => depo.user);

    const itemsFormatted = (round.items || []).map(i => ({ // i here is an Item document if populated, or ObjectId
        _id: i._id?.toString() || i.toString(), // Handle both populated and non-populated
        assetId: i.assetId, name: i.name, image: i.image, price: i.price || 0,
        ownerSteamId: i.ownerSteamId,
    }));

    let winnerDetails = null;
    if (round.winner && round.winner.steamId) { // If winner is populated
        winnerDetails = { id: round.winner._id.toString(), steamId: round.winner.steamId, username: round.winner.username, avatar: round.winner.avatar };
    } else if (round.winner) { winnerDetails = { id: round.winner.toString() }; }

    const uniqueDepositorsCount = new Set((round.depositsInRound || []).map(d => d.user?._id?.toString()).filter(id => id)).size;

    return {
        _id: round._id.toString(), roundId: round.roundId, status: round.status, startTime: round.startTime, endTime: round.endTime,
        timeLeft: timeLeft, totalValue: round.totalValue || 0, serverSeedHash: round.serverSeedHash,
        depositsInRound: depositsFormatted, items: itemsFormatted, winner: winnerDetails,
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
        if (currentRound?._id) {
            roundToFormat = await Round.findById(currentRound._id)
                 .populate('depositsInRound.user', 'steamId username avatar tradeUrl')
                 .populate('items')
                 .populate('winner', 'steamId username avatar').lean();
            if (!roundToFormat) currentRound = null;
            else currentRound = roundToFormat;
        }
        if (!roundToFormat) {
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                 .sort({ startTime: -1 })
                 .populate('depositsInRound.user', 'steamId username avatar tradeUrl')
                 .populate('items')
                 .populate('winner', 'steamId username avatar').lean();
            if (roundToFormat && !currentRound) {
                 currentRound = roundToFormat;
                 const deposits = Array.isArray(currentRound.depositsInRound) ? currentRound.depositsInRound : [];
                 const uniqueUserCount = new Set(deposits.filter(d => d.user && d.user._id).map(d => d.user._id.toString())).size;
                 if (currentRound.status === 'active' && uniqueUserCount > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) startRoundTimer(true);
                 else if (currentRound.status === 'active' && uniqueUserCount > 0 && !currentRound.endTime && !roundTimer) startRoundTimer(false);
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
        const queryFilter = { status: { $in: ['completed', 'error'] } };
        const [roundsData, totalCount] = await Promise.all([
            Round.find(queryFilter).sort('-roundId').skip(skip).limit(limit)
                 .populate('winner', 'username avatar steamId')
                 .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount taxedItems winningDepositEntryId')
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
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 })
    ],
    handleValidationErrors, async (req, res) => {
    const { roundId, serverSeed, clientSeed } = req.body;
    try {
        const round = await Round.findOne({ roundId: roundId, status: 'completed' })
             .populate('winner', 'username')
             .lean();
        if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found.` });
        const providedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
        if (providedHash !== round.serverSeedHash) return res.json({ verified: false, reason: 'Server Seed Hash mismatch.', expectedHash: round.serverSeedHash, providedSeed: serverSeed, calculatedHash: providedHash });
        if (round.serverSeed && round.clientSeed && (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed)) {
            return res.json({ verified: false, reason: 'Provided seeds do not match official round seeds.', expectedServerSeed: round.serverSeed, expectedClientSeed: round.clientSeed, providedServerSeed: serverSeed, providedClientSeed: clientSeed });
        }
        const combinedString = serverSeed + clientSeed;
        const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        if (round.provableHash && calculatedProvableHash !== round.provableHash) return res.json({ verified: false, reason: 'Calculated Provable Hash mismatch.', expectedProvableHash: round.provableHash, calculatedProvableHash, combinedString });

        const roundForTicketVerification = await Round.findById(round._id).select('depositsInRound').lean(); // Re-fetch for accurate ticket sum
        if (!roundForTicketVerification) return res.status(500).json({error: "Error re-fetching round for ticket verification."});
        const totalTickets = roundForTicketVerification.depositsInRound.reduce((sum, depo) => sum + (depo?.tickets || 0), 0);

        if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets based on its deposit entries.' });
        const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
        const calculatedWinningTicket = decimalFromHash % totalTickets;
        if (calculatedWinningTicket !== round.winningTicket) return res.json({ verified: false, reason: 'Calculated winning ticket mismatch.', calculatedTicket: calculatedWinningTicket, actualWinningTicket: round.winningTicket, provableHashUsed: calculatedProvableHash, totalTickets: totalTickets });
        res.json({
            verified: true, roundId: round.roundId, serverSeed, serverSeedHash: round.serverSeedHash, clientSeed,
            combinedString, finalHash: calculatedProvableHash, winningTicket: calculatedWinningTicket,
            totalTickets, totalValue: round.totalValue, winnerUsername: round.winner?.username || 'N/A'
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
const userLastMessageTime = new Map();

io.on('connection', async (socket) => {
    connectedChatUsers++;
    io.emit('updateUserCount', connectedChatUsers);
    const user = socket.request.user;
    if (user && user.username) {
        console.log(`User ${user.username} (Socket ID: ${socket.id}) connected.`);
        socket.join(user._id.toString()); // User joins a room identified by their MongoDB ID

        const unclaimedWinnings = await WinningRecord.find({ user: user._id, status: 'unclaimed' })
            .select('_id roundDisplayId amountWon itemsWonDetails createdAt')
            .sort({ createdAt: -1 })
            .lean();
        if (unclaimedWinnings.length > 0) {
            socket.emit('unclaimedWinningsNotification', unclaimedWinnings.map(uw => ({...uw, winningRecordId: uw._id.toString() })));
        }
    } else {
        console.log(`Anonymous client (Socket ID: ${socket.id}) connected.`);
    }

    try {
        const recentMessages = await ChatMessage.find({}).sort({ timestamp: -1 }).limit(MAX_CHAT_MESSAGES_TO_LOAD).populate('user', 'username avatar steamId').lean();
        socket.emit('initialChatMessages', recentMessages.reverse().map(msg => ({
            username: msg.isSystemMessage ? 'System' : (msg.user?.username || msg.username),
            avatar: msg.isSystemMessage ? null : (msg.user?.avatar || msg.avatar),
            message: msg.message, userId: msg.user?._id?.toString(), userSteamId: msg.user?.steamId || msg.steamId,
            timestamp: msg.timestamp, type: msg.isSystemMessage ? 'system' : 'user'
        })));
    } catch (err) { console.error("Error fetching recent chat messages:", err); }

    socket.on('requestRoundData', async () => {
        try {
            let roundToSend = null;
             if (currentRound?._id) {
                 roundToSend = await Round.findById(currentRound._id)
                       .populate('depositsInRound.user', 'steamId username avatar tradeUrl')
                       .populate('items').populate('winner', 'steamId username avatar').lean();
                 if (!roundToSend) currentRound = null; else currentRound = roundToSend;
             }
             if (!roundToSend) {
                 roundToSend = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                       .sort({ startTime: -1 })
                       .populate('depositsInRound.user', 'steamId username avatar tradeUrl')
                       .populate('items').populate('winner', 'steamId username avatar').lean();
                 if (roundToSend && !currentRound) {
                      currentRound = roundToSend;
                      const deposits = Array.isArray(currentRound.depositsInRound) ? currentRound.depositsInRound : [];
                      const uniqueUserCount = new Set(deposits.filter(d => d.user && d.user._id).map(d => d.user._id.toString())).size;
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
            socket.emit('notification', {type: 'error', message: 'You must be logged in to chat.'}); return;
        }
        const userId = user._id.toString(); const now = Date.now();
        const lastMessageTimeUser = userLastMessageTime.get(userId) || 0;
        if (now - lastMessageTimeUser < CHAT_COOLDOWN_SECONDS * 1000) {
            const timeLeft = Math.ceil((CHAT_COOLDOWN_SECONDS * 1000 - (now - lastMessageTimeUser)) / 1000);
            socket.emit('notification', {type: 'warning', message: `Please wait ${timeLeft}s before sending another message.`}); return;
        }
        if (typeof msg !== 'string' || msg.trim().length === 0 || msg.trim().length > MAX_CHAT_MESSAGE_LENGTH) {
            socket.emit('notification', {type: 'error', message: `Invalid message. Max ${MAX_CHAT_MESSAGE_LENGTH} characters.`}); return;
        }
        userLastMessageTime.set(userId, now);
        const trimmedMessage = msg.trim();
        const messageData = {
            user: user._id, steamId: user.steamId, username: user.username, avatar: user.avatar || '/img/default-avatar.png',
            message: trimmedMessage, timestamp: new Date()
        };
        try {
            const savedMessage = await new ChatMessage(messageData).save();
            const populatedMessage = await ChatMessage.findById(savedMessage._id).populate('user', 'username avatar steamId').lean();
            io.emit('chatMessage', {
                username: populatedMessage.user?.username || populatedMessage.username, avatar: populatedMessage.user?.avatar || populatedMessage.avatar,
                message: populatedMessage.message, userId: populatedMessage.user?._id?.toString(), userSteamId: populatedMessage.user?.steamId || populatedMessage.steamId,
                timestamp: populatedMessage.timestamp, type: 'user'
            });
        } catch (saveError) {
            console.error("Error saving chat message:", saveError);
            socket.emit('notification', {type: 'error', message: 'Error sending message.'});
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
    await refreshPriceCache();
    setInterval(async () => {
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
        ensureInitialRound();
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
            if (manager && typeof manager.shutdown === 'function') {
                 console.log('Stopping TradeOfferManager polling...');
                 manager.shutdown();
            } else if (manager) {
                 console.log('TradeOfferManager does not have a direct shutdown method, polling will stop on process exit.');
            }
            process.exit(0);
        } catch (e) {
            console.error("Error during graceful shutdown:", e);
            process.exit(1);
        }
    });
    setTimeout(() => {
        console.error('Could not close connections gracefully in time, forcing shutdown.');
        process.exit(1);
    }, 10000);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' && !err.expose ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.');
    if (res.headersSent) return next(err);
    res.status(status).json({ error: message });
});

console.log("app.js (Corrected) full structure loaded.");
