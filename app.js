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
const cors =require('cors');
const SteamTotp = require('steam-totp');
const axios = require('axios');
const NodeCache = require('node-cache');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
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
const ROUND_DURATION = parseInt(process.env.ROUND_DURATION_SECONDS) || 90; // Default 90 seconds
const TICKET_VALUE_RATIO = parseFloat(process.env.TICKET_VALUE) || 0.01; // 1 ticket per $0.01
const PRICE_CACHE_TTL_SECONDS = parseInt(process.env.PRICE_CACHE_TTL_SECONDS) || 15 * 60; // 15 minutes
const PRICE_REFRESH_INTERVAL_MS = (parseInt(process.env.PRICE_REFRESH_MINUTES) || 10) * 60 * 1000; // 10 minutes
const MIN_ITEM_VALUE = parseFloat(process.env.MIN_ITEM_VALUE) || 0.10; // Min item value to deposit
const PRICE_FETCH_TIMEOUT_MS = 30000; // 30 seconds for price API timeout
const MAX_PARTICIPANTS = parseInt(process.env.MAX_PARTICIPANTS) || 20;
const MAX_ITEMS_PER_POT = parseInt(process.env.MAX_ITEMS_PER_POT) || 200;
const MAX_ITEMS_PER_DEPOSIT = parseInt(process.env.MAX_ITEMS_PER_DEPOSIT) || 15; // Max items user can select for one deposit
const TAX_MIN_PERCENT = parseFloat(process.env.TAX_MIN_PERCENT) || 5; // Minimum 5% tax
const TAX_MAX_PERCENT = parseFloat(process.env.TAX_MAX_PERCENT) || 10; // Maximum 10% tax
const MIN_POT_FOR_TAX = parseFloat(process.env.MIN_POT_FOR_TAX) || 50; // Min pot value to apply tax
const MAX_CHAT_MESSAGE_LENGTH = 200;
const CHAT_COOLDOWN_SECONDS = parseInt(process.env.CHAT_COOLDOWN_SECONDS) || 3;
const ROUND_CREATION_DELAY_MS = 3000; // Reduced delay for creating a new round after one ends

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
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 5, message: 'Too many deposit attempts, please wait a minute.', standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, message: 'Too many chat messages. Please wait.', standardHeaders: true, legacyHeaders: false});

app.use('/api/', generalApiLimiter);
app.use(cors({ origin: process.env.SITE_URL || "*", credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session Configuration
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
                console.error('STEAM LOGIN ERROR:', { message: err.message, eresult: err.eresult });
                isBotReady = false; return;
            }
            if (!community.steamID) {
                 console.error(`CRITICAL LOGIN FAILURE: community.steamID is undefined after login callback. EResult: ${err?.eresult}`);
                 isBotReady = false; return;
            }
            console.log(`Steam bot ${loginCredentials.accountName} logged in (SteamID: ${community.steamID}). Setting cookies for TradeOfferManager...`);
            manager.setCookies(cookies, (setCookieErr) => {
                if (setCookieErr) {
                    console.error('TradeOfferManager Error setting cookies:', setCookieErr.message);
                    isBotReady = false; return;
                }
                console.log('TradeOfferManager cookies set successfully.');
                community.setCookies(cookies);
                isBotReady = true;
                console.log("Steam Bot is ready.");
                ensureInitialRound();
            });
            community.on('friendRelationship', (steamID, relationship) => {
                if (relationship === SteamCommunity.EFriendRelationship.RequestRecipient) {
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

// --- Game State ---
let currentRound = null;
let roundTimer = null;
let isRolling = false; // This flag is important to prevent actions during the critical rolling phase

const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false });

async function refreshPriceCache() {
    console.log("PRICE_INFO: Refreshing price cache from rust.scmm.app...");
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
                priceCache.mset(newItems);
                console.log(`PRICE_SUCCESS: Refreshed price cache with ${updatedCount} items.`);
            } else {
                console.warn("PRICE_WARN: No valid items found in price refresh response.");
            }
        } else {
            console.error("PRICE_ERROR: Invalid response from price refresh. Status:", response.status);
        }
    } catch (error) {
        console.error(`PRICE_ERROR: Failed to fetch prices. Code: ${error.code}, Message: ${error.message}`);
    }
}

function getItemPrice(marketHashName) {
    if (typeof marketHashName !== 'string' || !marketHashName) return 0;
    const cachedPrice = priceCache.get(marketHashName);
    return (cachedPrice !== undefined) ? cachedPrice : MIN_ITEM_VALUE;
}

// --- Core Game Logic ---
async function createNewRound() {
    if (isRolling) { // Still check isRolling to avoid conflicts if called during the very brief rolling DB updates
        console.log("Cannot create new round: Round is currently processing winner. Will retry soon.");
        return null;
    }
    if (currentRound && ['active', 'pending'].includes(currentRound.status)) {
        console.log(`Cannot create new round: Round ${currentRound.roundId} is already ${currentRound.status}.`);
        return currentRound;
    }

    currentRound = null; // Clear previous
    isRolling = false;   // Ensure isRolling is reset
    if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }

    try {
        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
        const lastRound = await Round.findOne().sort('-roundId');
        const nextRoundId = lastRound ? lastRound.roundId + 1 : 1;

        const newRoundDoc = new Round({
            roundId: nextRoundId,
            status: 'pending', // Start as 'pending', ready for first deposit
            serverSeed: serverSeed,
            serverSeedHash: serverSeedHash,
        });
        await newRoundDoc.save();
        currentRound = newRoundDoc.toObject();

        console.log(`--- Round ${currentRound.roundId} created (Pending) --- ServerSeedHash: ${currentRound.serverSeedHash}`);
        io.emit('roundCreated', formatRoundForClient(currentRound));
        // Timer will start only when the first deposit is accepted and round becomes 'active'
        return currentRound;
    } catch (err) {
        console.error('FATAL: Error creating new round:', err);
        setTimeout(createNewRound, 10000); // Retry
        return null;
    }
}

// app.js (Backend Logic - Refined)
// Part 2 of 2

async function ensureInitialRound() {
    if (!isBotConfigured || !isBotReady) {
        console.log("Bot not ready or not configured, skipping initial round check.");
        return;
    }

    if (!currentRound || !['active', 'pending', 'rolling'].includes(currentRound.status)) {
        try {
            const existingRound = await Round.findOne({ status: { $in: ['active', 'pending'] } })
                .populate('participants.user', 'steamId username avatar _id')
                .populate('items')
                .lean();

            if (existingRound) {
                console.log(`Found existing ${existingRound.status} round ${existingRound.roundId} on startup.`);
                currentRound = existingRound;

                if (currentRound.status === 'active' && currentRound.participants.length > 0) {
                    if (currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        startRoundTimer(true);
                    } else if (!roundTimer && currentRound.endTime && new Date(currentRound.endTime) <= Date.now()) {
                        console.warn(`Active round ${currentRound.roundId} found with past endTime. Ending it.`);
                        await endRound(); // End stale active round
                    } else if (!roundTimer) {
                        console.warn(`Active round ${currentRound.roundId} found without valid/future endTime. Starting new timer.`);
                        startRoundTimer(false);
                    }
                }
                io.emit('roundData', formatRoundForClient(currentRound));
            } else {
                console.log("No suitable active/pending round in DB, creating initial round...");
                await createNewRound();
            }
        } catch (dbErr) {
            console.error("Error ensuring initial round:", dbErr);
            await createNewRound(); // Fallback
        }
    } else {
        console.log(`Initial round check: Current round ${currentRound.roundId} status ${currentRound.status} is suitable.`);
        const roundDataToSend = await Round.findById(currentRound._id)
           .populate('participants.user', 'steamId username avatar _id')
           .populate('items')
           .populate('winner', 'steamId username avatar _id')
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
}


function startRoundTimer(useRemainingTime = false) {
    if (roundTimer) clearInterval(roundTimer);
    if (!currentRound || currentRound.status !== 'active') {
        console.warn(`Cannot start timer: No active round or round status invalid (ID: ${currentRound?.roundId}, Status: ${currentRound?.status}).`);
        return;
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
        currentRound.endTime = calculatedEndTime.toISOString(); // Keep in-memory currentRound updated
        // The DB update for endTime is typically done when the round becomes active
        // or if it's explicitly set here for a fresh timer start.
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
            .then(() => console.log(`Timer started for round ${currentRound.roundId}. End time: ${calculatedEndTime.toISOString()} (DB updated).`))
            .catch(e => console.error(`Error saving round end time for round ${currentRound?._id}:`, e));
    }

    io.emit('timerUpdate', { timeLeft, roundId: currentRound.roundId });

    roundTimer = setInterval(async () => {
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) {
            clearInterval(roundTimer); roundTimer = null;
            console.warn("Timer stopped: Round state became invalid.");
            return;
        }
        let currenttimeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - Date.now()) / 1000));
        io.emit('timerUpdate', { timeLeft: currenttimeLeft, roundId: currentRound.roundId });

        if (currenttimeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null;
            console.log(`Round ${currentRound.roundId} timer reached zero.`);
            if (!isRolling && currentRound.status === 'active') {
                await endRound();
            }
        }
    }, 1000);
}

async function endRound() {
    if (!currentRound || currentRound.status !== 'active') {
        console.warn(`Attempted to end round ${currentRound?.roundId}, but status is ${currentRound?.status} or no current round.`);
        return;
    }
    // Ensure we don't try to end an already rolling round from multiple triggers (e.g. timer and manual call)
    if (isRolling && currentRound._id.toString() === (await Round.findById(currentRound._id).select('_id').lean())?._id.toString()) {
        console.warn(`endRound called for round ${currentRound.roundId} but it's already rolling.`);
        return;
    }

    isRolling = true; // Set isRolling early
    const roundToEndId = currentRound.roundId;
    const roundMongoId = currentRound._id;
    console.log(`--- Ending round ${roundToEndId}... ---`);

    try {
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } });
        currentRound.status = 'rolling';
        currentRound.endTime = new Date().toISOString();
        io.emit('roundRolling', { roundId: roundToEndId });

        const round = await Round.findById(roundMongoId)
            .populate('participants.user', 'steamId username avatar tradeUrl _id')
            .populate('items')
            .lean();

        if (!round || round.status !== 'rolling') { // Status check after DB fetch
            console.warn(`Round ${roundToEndId} data missing or status not 'rolling' in DB after update. Aborting endRound.`);
            isRolling = false;
            currentRound = await Round.findById(roundMongoId).lean(); // Re-sync global
            if (!currentRound || !['active', 'pending', 'rolling'].includes(currentRound.status)) {
                 setTimeout(createNewRound, ROUND_CREATION_DELAY_MS); // If state is broken, try to create new
            }
            return;
        }
        currentRound = { ...round }; // Update global in-memory round for processing

        if (round.participants.length === 0 || round.items.length === 0) {
            console.log(`Round ${round.roundId} ended with no participants or items. Pot Value: $${round.totalValue.toFixed(2)}`);
            const finalStatus = round.totalValue > 0 ? 'error' : 'completed';
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: finalStatus, completedTime: new Date(), winner: null, totalValue: 0, items: [] } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants or items." });
            isRolling = false; currentRound = null; setTimeout(createNewRound, ROUND_CREATION_DELAY_MS);
            return;
        }

        // ... (Tax calculation logic - remains unchanged)
        let allItemsInPotFromDB = [...round.items];
        let originalPotValue = round.participants.reduce((sum, p) => sum + (p?.itemsValue || 0), 0);
        let valueForWinnerCalculation = originalPotValue;
        let taxAmount = 0;
        let taxedItemsInfo = [];
        let itemsToGiveToWinner = [...allItemsInPotFromDB];

        if (originalPotValue >= MIN_POT_FOR_TAX && allItemsInPotFromDB.length > 0) {
            const targetTaxRate = Math.min(TAX_MAX_PERCENT, Math.max(TAX_MIN_PERCENT, TAX_MIN_PERCENT + (originalPotValue - MIN_POT_FOR_TAX) / 1000));
            const targetTaxValue = originalPotValue * (targetTaxRate / 100);
            const maxTaxValue = originalPotValue * (TAX_MAX_PERCENT / 100);
            const sortedItemsForTax = [...allItemsInPotFromDB].sort((a, b) => (a.price || 0) - (b.price || 0));
            let currentTaxValueAccumulated = 0;
            let tempTaxedItemsForOffer = [];

            for (const item of sortedItemsForTax) {
                if (tempTaxedItemsForOffer.length >= itemsToGiveToWinner.length) break;
                if (currentTaxValueAccumulated + item.price <= maxTaxValue) {
                    tempTaxedItemsForOffer.push(item);
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price });
                    currentTaxValueAccumulated += item.price;
                    if (currentTaxValueAccumulated >= targetTaxValue && tempTaxedItemsForOffer.length > 0) break;
                } else {
                    break;
                }
            }
            if (tempTaxedItemsForOffer.length > 0) {
                itemsToGiveToWinner = allItemsInPotFromDB.filter(item => !tempTaxedItemsForOffer.find(taxed => taxed._id.equals(item._id)));
                taxAmount = tempTaxedItemsForOffer.reduce((sum, item) => sum + item.price, 0);
                valueForWinnerCalculation = originalPotValue - taxAmount;
                console.log(`Tax Applied (Round ${round.roundId}): $${taxAmount.toFixed(2)} from ${tempTaxedItemsForOffer.length} items. Original: $${originalPotValue.toFixed(2)}. Winner Value: $${valueForWinnerCalculation.toFixed(2)}`);
            }
        }
        // ... (Winner selection logic - remains unchanged)
        const clientSeed = crypto.randomBytes(16).toString('hex');
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16);
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);

        if (totalTickets <= 0) {
            console.error(`Cannot determine winner: Total tickets is zero for round ${round.roundId}.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', completedTime: new Date(), clientSeed, provableHash, totalValue: 0, taxAmount: originalPotValue, taxedItems: round.items.map(i=> ({assetId: i.assetId, name: i.name, price: i.price})), items: [] } });
            io.emit('roundError', { roundId: round.roundId, error: 'No tickets in pot.' });
            io.emit('roundCompleted', { roundId: round.roundId, status: 'error' });
            isRolling = false; currentRound = null; setTimeout(createNewRound, ROUND_CREATION_DELAY_MS);
            return;
        }

        const winningTicket = decimalFromHash % totalTickets;
        let cumulativeTickets = 0;
        let winnerDBInfo = null;

        for (const participant of round.participants) {
            if (!participant?.tickets || !participant.user?._id) continue;
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winnerDBInfo = participant.user;
                break;
            }
        }

        if (!winnerDBInfo || !winnerDBInfo._id) {
             console.error(`Winner selection failed for round ${round.roundId}. WinningTicket: ${winningTicket}, TotalTickets: ${totalTickets}`);
             await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', completedTime: new Date(), clientSeed, provableHash } });
             io.emit('roundError', { roundId: round.roundId, error: 'Winner selection process failed.' });
             io.emit('roundCompleted', { roundId: round.roundId, status: 'error' });
             isRolling = false; currentRound = null; setTimeout(createNewRound, ROUND_CREATION_DELAY_MS);
             return;
        }
        await User.findByIdAndUpdate(winnerDBInfo._id, { $inc: { totalWinningsValue: valueForWinnerCalculation } });

        const finalUpdateData = {
            status: 'completed', completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winnerDBInfo._id,
            taxAmount: taxAmount, taxedItems: taxedItemsInfo,
            totalValue: valueForWinnerCalculation,
            items: itemsToGiveToWinner.map(i => i._id),
            payoutOfferStatus: 'Pending Send'
        };
        const completedRoundDoc = await Round.findOneAndUpdate({ _id: roundMongoId }, { $set: finalUpdateData }, { new: true })
            .populate('winner', 'steamId username avatar tradeUrl _id')
            .lean();

        if (!completedRoundDoc) throw new Error("Failed to save completed round data.");
        console.log(`Round ${round.roundId} completed. Winner: ${winnerDBInfo.username} (Ticket: ${winningTicket}/${totalTickets}, Value Won: $${valueForWinnerCalculation.toFixed(2)})`);

        io.emit('roundWinner', {
            roundId: round.roundId,
            winner: { id: winnerDBInfo._id.toString(), steamId: winnerDBInfo.steamId, username: winnerDBInfo.username, avatar: winnerDBInfo.avatar },
            winningTicket: winningTicket, totalValue: valueForWinnerCalculation, totalTickets: totalTickets,
            serverSeed: round.serverSeed, clientSeed: clientSeed, provableHash: provableHash, serverSeedHash: round.serverSeedHash
        });

        await sendWinningTradeOffer(completedRoundDoc, completedRoundDoc.winner, itemsToGiveToWinner);
        io.emit('roundCompleted', formatRoundForClient(completedRoundDoc));

    } catch (err) {
        console.error(`CRITICAL ERROR during endRound for round ${roundToEndId}:`, err.stack || err);
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', payoutOfferStatus: 'Failed' } })
            .catch(e => console.error("Error marking round as error post-failure:", e));
        io.emit('roundError', { roundId: roundToEndId, error: 'Internal server error during round finalization.' });
        io.emit('roundCompleted', { roundId: roundToEndId, status: 'error' });
    } finally {
        isRolling = false; // Crucial to reset this
        currentRound = null;
        console.log(`Scheduling next round creation after round ${roundToEndId} finalization.`);
        setTimeout(createNewRound, ROUND_CREATION_DELAY_MS); // Use defined constant
    }
}

// ... (sendWinningTradeOffer - remains unchanged)
async function sendWinningTradeOffer(roundDoc, winner, itemsToSend) {
    if (!isBotReady) {
        console.error(`PAYOUT_ERROR (Bot Offline): Round ${roundDoc.roundId}. Winner: ${winner.username}`);
        io.to(winner._id.toString()).emit('notification', { type: 'error', message: `Bot Error: Payout for round ${roundDoc.roundId} delayed. Contact support.` });
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed' } });
        return;
    }
    if (!winner.tradeUrl) {
        console.error(`PAYOUT_ERROR (No Trade URL): Winner ${winner.username} (ID: ${winner._id}). Round ${roundDoc.roundId}.`);
        io.to(winner._id.toString()).emit('notification', { type: 'error', message: 'Set your Steam Trade URL to receive winnings.' });
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed' } });
        return;
    }
    if (!itemsToSend || itemsToSend.length === 0) {
        console.log(`PAYOUT_INFO (No Items): Winner ${winner.username}, Round ${roundDoc.roundId}. Value Won: $${roundDoc.totalValue.toFixed(2)}.`);
        if (roundDoc.totalValue > 0) {
             io.to(winner._id.toString()).emit('notification', { type: 'warning', message: `Winnings for round ${roundDoc.roundId} ($${roundDoc.totalValue.toFixed(2)}) processed, but an issue occurred with item distribution. Contact support.` });
             await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed' } });
        } else {
            io.to(winner._id.toString()).emit('notification', { type: 'info', message: `All items from round ${roundDoc.roundId} were taxed. No items to send.` });
            await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'No Items Won' } });
        }
        return;
    }

    const offer = manager.createOffer(winner.tradeUrl);
    const itemsForOfferObject = itemsToSend.map(item => ({
        assetid: item.assetId, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID
    }));
    offer.addMyItems(itemsForOfferObject);
    offer.setMessage(`Winnings from Round #${roundDoc.roundId} on ${process.env.SITE_NAME}. Value: $${roundDoc.totalValue.toFixed(2)}.`);

    try {
        const sentOfferResult = await new Promise((resolve, reject) => {
            offer.send((err, status) => {
                if (err) return reject(err);
                resolve({ status: status, offerId: offer.id });
            });
        });

        const offerURL = `https://steamcommunity.com/tradeoffer/${sentOfferResult.offerId}/`;
        let offerStatusForDB = 'Sent';
        if (sentOfferResult.status === 'pending' || sentOfferResult.status === 'pendingConfirmation' || sentOfferResult.status === 'escrow' || sentOfferResult.status?.toLowerCase().includes('escrow')) {
            offerStatusForDB = 'Escrow';
        } else if (sentOfferResult.status === 'accepted') {
            offerStatusForDB = 'Accepted';
        }

        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferId: sentOfferResult.offerId, payoutOfferStatus: offerStatusForDB } });
        console.log(`[Trade Send DB Update] Round ${roundDoc.roundId}: PAYOUT_SUCCESS. Offer ${sentOfferResult.offerId} sent to ${winner.username}. Steam Status: ${sentOfferResult.status}, DB Status: ${offerStatusForDB}`);

        io.to(winner._id.toString()).emit('tradeOfferSent', {
            roundId: roundDoc.roundId, userId: winner._id.toString(), username: winner.username,
            offerId: sentOfferResult.offerId, offerURL: offerURL, status: offerStatusForDB, type: 'winning'
        });

        let notifMsg = `Winnings offer #${sentOfferResult.offerId} for round ${roundDoc.roundId} has been sent!`;
        let notifType = 'success';
        if (offerStatusForDB === 'Escrow') {
             notifMsg = `Winnings offer #${sentOfferResult.offerId} sent, but requires confirmation or is in Steam escrow.`;
             notifType = 'warning';
        }
        io.to(winner._id.toString()).emit('notification', { type: notifType, message: notifMsg });

    } catch (err) {
        let offerStatusUpdate = 'Failed';
        let userMessage = `Error sending winnings for round ${roundDoc.roundId}. Contact support.`;
        console.error(`[Trade Send Exception] Round ${roundDoc.roundId} for ${winner.username}. EResult: ${err.eresult}, Msg: ${err.message}`, err.stack || err);

        if (err.message?.includes('trade token') || err.eresult === 26) { userMessage = 'Your Steam Trade URL is invalid/revoked. Update in profile.'; offerStatusUpdate = 'Failed - Bad URL'; }
        else if (err.eresult === 15 || err.eresult === 16) { userMessage = 'Cannot send winnings. Ensure inventory is public, not full, and you are not trade banned.'; offerStatusUpdate = 'Failed - Inventory/Trade Issue';}
        else if (err.eresult === 11 || err.message?.toLowerCase().includes('escrow')) { userMessage = `Winnings offer for Round #${roundDoc.roundId} may be in Steam escrow.`; offerStatusUpdate = 'Escrow';}

        io.to(winner._id.toString()).emit('notification', { type: 'error', message: userMessage });
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: offerStatusUpdate } });
    }
}


// --- Authentication Routes --- (remains unchanged)
app.get('/auth/steam', authLimiter, passport.authenticate('steam', { failureRedirect: '/' }));
app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => { res.redirect('/'); }
);
app.post('/logout', (req, res, next) => {
    req.logout(err => {
        if (err) return next(err);
        req.session.destroy(err => {
            if (err) return res.status(500).json({ error: 'Logout failed.' });
            res.clearCookie('connect.sid');
            res.json({ success: true });
        });
    });
});

// --- Middleware & API Routes ---
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.status(401).json({ error: 'Not authenticated' });
}
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    next();
};

app.get('/api/user', ensureAuthenticated, (req, res) => {
    const { _id, steamId, username, avatar, tradeUrl, pendingDepositOfferId, totalDepositedValue, totalWinningsValue } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, pendingDepositOfferId, totalDepositedValue, totalWinningsValue });
});

app.post('/api/user/tradeurl', ensureAuthenticated,
    [
        body('tradeUrl').trim().custom((value) => {
            if (value === '') return true;
            const urlPattern = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/;
            if (!urlPattern.test(value)) throw new Error('Invalid Steam Trade URL format.');
            return true;
        })
    ],
    handleValidationErrors,
    async (req, res) => {
        try {
            const updatedUser = await User.findByIdAndUpdate(req.user._id, { tradeUrl: req.body.tradeUrl }, { new: true, runValidators: true });
            if (!updatedUser) return res.status(404).json({ error: 'User not found.' });
            res.json({ success: true, tradeUrl: updatedUser.tradeUrl });
        } catch (err) {
            console.error(`Error updating trade URL for ${req.user._id}:`, err);
            res.status(500).json({ error: err.message || 'Server error saving Trade URL.' });
        }
    }
);

app.get('/api/user/winning-history', ensureAuthenticated, async (req, res) => {
    try {
        const winnings = await Round.find({ winner: req.user._id, status: 'completed' })
            .sort({ completedTime: -1 })
            .select('roundId completedTime totalValue payoutOfferId payoutOfferStatus')
            .limit(50)
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
        console.error(`Error fetching winning history for ${req.user._id}:`, error);
        res.status(500).json({ error: 'Server error fetching winning history.' });
    }
});

app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    // ... (inventory logic - remains unchanged)
    if (!isBotReady) return res.status(503).json({ error: "Steam service temporarily unavailable." });
    try {
        const inventory = await new Promise((resolve, reject) => {
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                if (err) {
                    if (err.message?.includes('profile is private') || err.eresult === 15) return reject(new Error('Your Steam inventory is private. Please set it to public.'));
                    return reject(new Error(`Could not fetch inventory (${err.eresult || err.message})`));
                }
                resolve(inv || []);
            });
        });
        if (!inventory?.length) return res.json([]);
        const validItems = inventory.map(item => {
                const itemName = item.market_hash_name;
                if (!itemName || !item.assetid || !item.icon_url) return null;
                let price = getItemPrice(itemName);
                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`;
                return { assetId: item.assetid, name: itemName, image: imageUrl, price: price, tradable: item.tradable };
            })
            .filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE);
        res.json(validItems);
    } catch (err) {
        console.error(`Error in /api/inventory for ${req.user?.username}:`, err.message);
        res.status(500).json({ error: err.message || 'Server error fetching inventory.' });
    }
});

app.post('/api/deposit', depositLimiter, ensureAuthenticated,
    [
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`Deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.')
    ],
    handleValidationErrors,
    async (req, res) => {
        const user = req.user;
        const requestedAssetIds = req.body.assetIds;

        if (!isBotReady) return res.status(503).json({ error: "Deposit service unavailable (Bot offline)." });
        if (!user.tradeUrl) return res.status(400).json({ error: 'Set your Steam Trade URL in profile.' });

        if (user.pendingDepositOfferId) {
            try {
                const offer = await manager.getOffer(user.pendingDepositOfferId);
                if (offer && [TradeOfferManager.ETradeOfferState.Active, TradeOfferManager.ETradeOfferState.Sent, TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation].includes(offer.state)) {
                    const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                    return res.status(409).json({ error: 'Active deposit offer waiting. Accept/decline on Steam.', offerId: user.pendingDepositOfferId, offerURL: offerURL });
                }
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
            } catch (offerFetchError) {
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
            }
        }

        // MODIFIED: Allow deposits if round is 'pending' or 'active'
        if (!currentRound || !['pending', 'active'].includes(currentRound.status) || isRolling) {
            let message = 'Deposits currently closed.';
            if (isRolling) message = 'Round is currently rolling, deposits closed.';
            else if (!currentRound) message = 'No round available for deposit.';
            else if (currentRound.status === 'rolling') message = 'Round is rolling, cannot deposit.';
            else if (currentRound.status === 'completed' || currentRound.status === 'error') message = 'Round has ended, cannot deposit.';
            else if (currentRound.status === 'pending' && isRolling) message = 'Round is preparing, deposits will open shortly.'; // More specific if somehow pending and rolling
            else if (currentRound.status === 'active' && isRolling) message = 'Round is rolling, cannot deposit.';
            return res.status(400).json({ error: message });
        }

        const isNewParticipant = !currentRound.participants.some(p => p.user?.toString() === user._id.toString());
        if (isNewParticipant && currentRound.participants.length >= MAX_PARTICIPANTS) {
            return res.status(400).json({ error: `Participant limit (${MAX_PARTICIPANTS}) reached.` });
        }
        const currentItemCount = currentRound.items?.length || 0; // Handle case where items might be undefined initially for pending
        if (currentItemCount + requestedAssetIds.length > MAX_ITEMS_PER_POT) {
            const slotsLeft = MAX_ITEMS_PER_POT - currentItemCount;
            return res.status(400).json({ error: `Deposit would exceed pot limit (${MAX_ITEMS_PER_POT}). ${slotsLeft > 0 ? slotsLeft + ' slots left.' : 'No slots left.'}` });
        }

        let itemsToRequest = [];
        let depositTotalValue = 0;
        try {
            const userInventory = await new Promise((resolve, reject) => {
                manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                    if (err) return reject(new Error(err.message?.includes('private') ? 'Your Steam inventory is private.' : `Could not fetch inventory.`));
                    resolve(inv || []);
                });
            });
            const userInventoryMap = new Map(userInventory.map(item => [item.assetid, item]));
            for (const assetId of requestedAssetIds) {
                const invItem = userInventoryMap.get(assetId);
                if (!invItem) throw new Error(`Item ${assetId} not in inventory.`);
                if (!invItem.tradable) throw new Error(`Item '${invItem.market_hash_name}' not tradable.`);
                const price = getItemPrice(invItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) throw new Error(`'${invItem.market_hash_name}' ($${price.toFixed(2)}) is below min value ($${MIN_ITEM_VALUE}).`);
                itemsToRequest.push({
                    assetid: invItem.assetid, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID,
                    _price: price, _name: invItem.market_hash_name, _image: `https://community.akamai.steamstatic.com/economy/image/${invItem.icon_url}`
                });
                depositTotalValue += price;
            }
            if (itemsToRequest.length === 0) throw new Error("No valid items for deposit.");
        } catch (verificationError) {
            return res.status(400).json({ error: verificationError.message });
        }

        const depositId = uuidv4();
        const offer = manager.createOffer(user.tradeUrl);
        offer.addTheirItems(itemsToRequest.map(({ assetid, appid, contextid }) => ({ assetid, appid, contextid })));
        offer.setMessage(`RustyDegen Deposit ID: ${depositId} | Round: ${currentRound.roundId}`);

        pendingDeposits.set(depositId, {
            userId: user._id, roundId: currentRound._id, items: itemsToRequest,
            totalValue: depositTotalValue, steamId: user.steamId
        });
        const cleanupTimeout = setTimeout(() => {
            if(pendingDeposits.has(depositId)) {
                pendingDeposits.delete(depositId);
                User.updateOne({ steamId: user.steamId, pendingDepositOfferId: offer?.id || 'expired_deposit' }, { pendingDepositOfferId: null }).catch(e=>e);
            }
        }, manager.cancelTime || 10 * 60 * 1000);

        try {
            const status = await new Promise((resolve, reject) => {
                offer.send((err, sendStatus) => { if (err) return reject(err); resolve(sendStatus); });
            });
            await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: offer.id });
            console.log(`Deposit offer ${offer.id} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;
            res.json({ success: true, message: 'Deposit offer sent! Accept on Steam.', offerId: offer.id, offerURL: offerURL });
        } catch (error) {
            pendingDeposits.delete(depositId); clearTimeout(cleanupTimeout);
            await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }).catch(e=>e);
            let userMsg = 'Failed to create deposit offer.';
            if (error.message.includes('Trade URL') || error.eresult === 26) userMsg = 'Your Steam Trade URL might be invalid. Check profile.';
            else if (error.eresult) userMsg += ` (Code: ${error.eresult})`;
            res.status(500).json({ error: userMsg });
        }
    }
);

// --- Trade Offer Manager Event Handling ---
if (isBotConfigured && manager) {
    manager.on('newOffer', async (offer) => {
        if (!isBotReady || offer.isOurOffer || (offer.itemsToGive && offer.itemsToGive.length > 0)) return;
        offer.decline(err => { if(err) console.error(`Error declining unsolicited offer ${offer.id}:`, err); });
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        console.log(`Bot Offer #${offer.id} changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()})`);
        const depositIdMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
        const depositId = depositIdMatch ? depositIdMatch[1] : null;

        if (depositId && pendingDeposits.has(depositId)) {
            const depositData = pendingDeposits.get(depositId);
            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                pendingDeposits.delete(depositId);
                User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null }).catch(e=>e);

                let roundForDeposit;
                try {
                    roundForDeposit = await Round.findById(depositData.roundId).exec();
                    // MODIFIED: Check if round is 'pending' or 'active' and not rolling
                    if (!roundForDeposit || !['pending', 'active'].includes(roundForDeposit.status) || isRolling) {
                        io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Deposit Error (Offer ${offer.id}): Round invalid/ended. Items returned to Steam if possible. Contact support.` });
                        // TODO: Implement item return logic if necessary, or ensure they were never truly taken by bot if round state changed mid-offer
                        return;
                    }
                    const isNewP = !roundForDeposit.participants.some(p => p.user?.toString() === depositData.userId.toString());
                    if (isNewP && roundForDeposit.participants.length >= MAX_PARTICIPANTS) throw new Error("Participant limit hit post-acceptance.");
                     const currentItemCountInDb = roundForDeposit.items?.length || 0;
                    if (currentItemCountInDb + depositData.items.length > MAX_ITEMS_PER_POT) throw new Error("Pot item limit hit post-acceptance.");
                } catch (roundCheckError) {
                    io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `CRITICAL Deposit Error (Offer ${offer.id}). Contact support.` }); return;
                }

                let createdItemDocs = [];
                try {
                    const itemDocuments = depositData.items.map(itemData => new Item({
                        assetId: itemData.assetid, name: itemData._name, image: itemData._image,
                        price: itemData._price, owner: depositData.userId, roundId: depositData.roundId
                    }));
                    createdItemDocs = await Item.insertMany(itemDocuments, { ordered: false });
                    await User.findByIdAndUpdate(depositData.userId, { $inc: { totalDepositedValue: depositData.totalValue } });

                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));
                    let participantToUpdate = roundForDeposit.participants.find(p => p.user?.toString() === depositData.userId.toString());
                    if (participantToUpdate) {
                        participantToUpdate.itemsValue += depositData.totalValue;
                        participantToUpdate.tickets += depositTickets;
                    } else {
                        roundForDeposit.participants.push({ user: depositData.userId, itemsValue: depositData.totalValue, tickets: depositTickets });
                    }
                    roundForDeposit.totalValue += depositData.totalValue;
                    roundForDeposit.items.push(...createdItemDocs.map(doc => doc._id));

                    let roundJustActivated = false;
                    if (roundForDeposit.status === 'pending') { // First deposit makes round active
                        roundForDeposit.status = 'active';
                        roundForDeposit.startTime = new Date();
                        roundForDeposit.endTime = new Date(Date.now() + ROUND_DURATION * 1000);
                        roundJustActivated = true;
                    }
                    const savedRound = await roundForDeposit.save();

                    if (currentRound && currentRound._id.toString() === savedRound._id.toString()) {
                        currentRound = await Round.findById(savedRound._id).populate('participants.user', 'steamId username avatar _id').populate('items').lean();
                    } else {
                        console.warn("Deposit processed for a round different from in-memory currentRound or currentRound is null. Frontend might rely on next full sync.");
                    }

                    const populatedParticipant = currentRound?.participants.find(p => p.user?._id.toString() === depositData.userId.toString());
                    if (populatedParticipant && populatedParticipant.user) {
                        io.emit('participantUpdated', {
                            roundId: currentRound.roundId, userId: populatedParticipant.user._id.toString(),
                            username: populatedParticipant.user.username, avatar: populatedParticipant.user.avatar,
                            itemsValue: populatedParticipant.itemsValue, tickets: populatedParticipant.tickets,
                            totalValue: currentRound.totalValue,
                            depositedItems: depositData.items.map(i => ({ name: i._name, image: i._image, price: i._price }))
                        });
                    }

                    if (roundJustActivated && currentRound?.status === 'active' && currentRound.participants.length > 0 && !roundTimer) {
                        startRoundTimer(false); // Start timer, false because endTime was just set
                        io.emit('roundStatusUpdate', { roundId: currentRound.roundId, status: 'active', startTime: currentRound.startTime, endTime: currentRound.endTime });
                    }

                } catch (dbErr) {
                    // ... (error handling for DB remains the same)
                    console.error(`CRITICAL DB/UPDATE ERROR processing deposit ${offer.id} for round ${depositData.roundId}:`, dbErr);
                    io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `CRITICAL Deposit Error (Offer ${offer.id}). Contact support.` });
                    if (createdItemDocs.length > 0) await Item.deleteMany({ _id: { $in: createdItemDocs.map(d => d._id) } });
                    if (currentRound && currentRound._id.toString() === depositData.roundId.toString()) {
                        await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } });
                        io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error.' });
                        currentRound = null; setTimeout(createNewRound, 15000);
                    }
                }
            } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired, TradeOfferManager.ETradeOfferState.InvalidItems].includes(offer.state)) {
                if (depositData) {
                    pendingDeposits.delete(depositId);
                    User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null }).catch(e=>e);
                    io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Your deposit offer (#${offer.id}) was ${TradeOfferManager.ETradeOfferState[offer.state].toLowerCase()}.` });
                }
            }
        } else if (offer.itemsToGive && offer.itemsToGive.length > 0 && (!offer.itemsToReceive || offer.itemsToReceive.length === 0)) {
            // ... (payout offer logic - remains unchanged)
            let payoutStatusUpdate = TradeOfferManager.ETradeOfferState[offer.state] || 'Unknown';
            try {
                const updatedRound = await Round.findOneAndUpdate(
                    { payoutOfferId: offer.id }, { $set: { payoutOfferStatus: payoutStatusUpdate } }, { new: true }
                ).populate('winner', '_id');

                if (updatedRound && updatedRound.winner) {
                    const winnerUserId = updatedRound.winner._id.toString();
                    let notifType = 'info', notifMsg = `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) status: ${payoutStatusUpdate}.`;
                    if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) { notifType = 'success'; notifMsg = `Winnings from offer #${offer.id} (Round #${updatedRound.roundId}) accepted!`; }
                    else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired].includes(offer.state)) { notifType = 'error'; }
                    else if (offer.state === TradeOfferManager.ETradeOfferState.InEscrow) { notifType = 'warning'; notifMsg = `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) is in Steam escrow.`}
                    io.to(winnerUserId).emit('notification', { type: notifType, message: notifMsg });
                }
            } catch (dbError) {
                console.error(`Error updating payout status for offer #${offer.id}:`, dbError);
            }
        }
    });
}

// --- Round Info API & Formatting --- (remains unchanged)
function formatRoundForClient(round) {
    if (!round || !round._id) return null;
    let timeLeft = 0;
    if (round.status === 'active') {
        if (round.endTime && new Date(round.endTime) > Date.now()) {
            timeLeft = Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000));
        } else if (round.participants?.length > 0) {
            timeLeft = 0;
        } else {
            timeLeft = ROUND_DURATION; // Active but no participants, show full duration
        }
    } else if (round.status === 'pending') {
        timeLeft = ROUND_DURATION; // Show full duration for pending rounds, indicating readiness
    }

    const participantsFormatted = (round.participants || []).map(p => ({
        user: p.user ? { _id: p.user._id?.toString(), steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar } : null,
        itemsValue: p.itemsValue || 0, tickets: p.tickets || 0
    })).filter(p => p.user);

    const itemsFormatted = (round.items || []).map(i => ({
        ...i,
        owner: i.owner?._id?.toString() || i.owner?.toString()
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
        _id: round._id?.toString(), roundId: round.roundId, status: round.status,
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
// ... (API routes like /api/round/current, /api/rounds, /api/verify - mostly unchanged, ensure they reflect the new timer/status logic correctly for client if needed)
// For /api/round/current, ensure it correctly handles timer logic for pending/active rounds.
app.get('/api/round/current', async (req, res) => {
    let roundToFormat = null;
    try {
        if (currentRound && ['active', 'pending', 'rolling'].includes(currentRound.status)) {
            roundToFormat = await Round.findById(currentRound._id)
                .populate('participants.user', 'steamId username avatar _id')
                .populate('items').populate('winner', 'steamId username avatar _id').lean();
            if (!roundToFormat) currentRound = null; else currentRound = roundToFormat;
        }

        if (!currentRound || !['active', 'pending', 'rolling'].includes(currentRound.status)) {
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'pending', 'rolling'] } })
                .sort({ startTime: -1 })
                .populate('participants.user', 'steamId username avatar _id')
                .populate('items').populate('winner', 'steamId username avatar _id').lean();
            currentRound = roundToFormat;
        }

        if (currentRound) {
            if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !roundTimer) {
                if (currentRound.endTime && new Date(currentRound.endTime) > Date.now()) startRoundTimer(true);
                else startRoundTimer(false); // Or potentially end round if time is up
            } else if (currentRound.status === 'active' && currentRound.participants?.length === 0 && roundTimer) {
                clearInterval(roundTimer); roundTimer = null;
            } else if (currentRound.status === 'pending' && roundTimer) { // Stop timer if round is pending
                clearInterval(roundTimer); roundTimer = null;
            }
        }

        const formattedData = formatRoundForClient(currentRound);
        if (formattedData) res.json(formattedData);
        else {
            const newCreatedRound = await createNewRound();
            res.json(formatRoundForClient(newCreatedRound));
        }
    } catch (err) {
        console.error('Error fetching/formatting current round for API:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' });
    }
});

app.get('/api/rounds',
    [ body('page').optional().isInt({ min: 1 }).toInt(), body('limit').optional().isInt({ min: 1, max: 50 }).toInt() ],
    handleValidationErrors, async (req, res) => {
    // ... (remains unchanged)
    try {
        const page = req.query.page || 1; const limit = req.query.limit || 10; const skip = (page - 1) * limit; // Use req.query for GET
        const queryFilter = { status: { $in: ['completed', 'error'] } };
        const [rounds, totalCount] = await Promise.all([
            Round.find(queryFilter).sort('-roundId').skip(skip).limit(limit)
                .populate('winner', 'username avatar steamId')
                .select('roundId completedTime totalValue winner serverSeed clientSeed winningTicket provableHash status taxAmount payoutOfferId payoutOfferStatus')
                .lean(),
            Round.countDocuments(queryFilter)
        ]);
        res.json({ rounds, totalPages: Math.ceil(totalCount / limit), currentPage: page, totalRounds: totalCount });
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching round history.' });
    }
});
app.post('/api/verify',
    [ /* ... validations ... */ ], handleValidationErrors, async (req, res) => { /* ... remains unchanged ... */ });


// --- Socket.io Connection Handling ---
// ... (remains largely unchanged, ensure client gets updated round data reflecting new status/timer logic)
io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.initialize()(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.session()(socket.request, socket.request.res || {}, next); });

let connectedChatUsers = 0;
const userLastMessageTime = new Map();

io.on('connection', (socket) => {
    connectedChatUsers++;
    io.emit('updateUserCount', connectedChatUsers);
    const user = socket.request.user;
    if (user) socket.join(user._id.toString());
    console.log(`Client connected: ${socket.id}${user ? ` (User: ${user.username})` : ' (Anonymous)'}`);

    socket.on('requestRoundData', async () => {
        let roundToFormat = null;
        if (currentRound && ['active', 'pending', 'rolling'].includes(currentRound.status)) {
            roundToFormat = await Round.findById(currentRound._id)
                .populate('participants.user', 'steamId username avatar _id').populate('items')
                .populate('winner', 'steamId username avatar _id').lean();
            if (!roundToFormat) currentRound = null; else currentRound = roundToFormat;
        }
        if (!currentRound || !['active', 'pending', 'rolling'].includes(currentRound.status)) {
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'pending', 'rolling'] } })
                .sort({ startTime: -1 })
                .populate('participants.user', 'steamId username avatar _id').populate('items')
                .populate('winner', 'steamId username avatar _id').lean();
            currentRound = roundToFormat;
        }
        const formattedData = formatRoundForClient(currentRound);
        if (formattedData) {
            socket.emit('roundData', formattedData);
            if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !roundTimer) {
                if (currentRound.endTime && new Date(currentRound.endTime) > Date.now()) startRoundTimer(true);
                else startRoundTimer(false);
            } else if (currentRound.status === 'pending' && roundTimer) { // Ensure timer is cleared if a pending round is sent
                 clearInterval(roundTimer); roundTimer = null;
            }
        } else {
            const newCreatedRound = await createNewRound();
            socket.emit('roundData', formatRoundForClient(newCreatedRound));
        }
    });
    // ... (chatMessage and disconnect handlers remain unchanged)
    socket.on('chatMessage', (msg) => { /* ... */ });
    socket.on('disconnect', () => { /* ... */ });
});

// --- Server Startup ---
async function startApp() {
    await refreshPriceCache();
    setInterval(refreshPriceCache, PRICE_REFRESH_INTERVAL_MS);
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}. Site URL: ${process.env.SITE_URL}`);
        if (!isBotConfigured) console.log("INFO: Steam Bot NOT configured.");
        else if (!isBotReady) console.log("INFO: Steam Bot configured but login may have FAILED or is pending.");
        else console.log("INFO: Steam Bot is READY.");
        ensureInitialRound();
    });
}
startApp();
// ... (gracefulShutdown and final error handler remain unchanged)
function gracefulShutdown() { /* ... */ }
process.on('SIGTERM', gracefulShutdown); process.on('SIGINT', gracefulShutdown);
app.use((err, req, res, next) => { /* ... */ });
