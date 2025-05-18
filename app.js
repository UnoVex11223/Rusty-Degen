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
// Removed sensitiveActionLimiter as specific routes have their own or generalApiLimiter is sufficient
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 5, message: 'Too many deposit attempts, please wait a minute.', standardHeaders: true, legacyHeaders: false }); // Reduced max deposit attempts
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
    banned: { type: Boolean, default: false }, // Kept for future use
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
    endTime: { type: Date }, // Set when timer starts
    completedTime: { type: Date },
    totalValue: { type: Number, default: 0, min: 0 }, // Pre-tax value during active, after-tax for winner in completed
    items: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }], // Items for the winner
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
    pollInterval: 10000, // 10 seconds
    cancelTime: 10 * 60 * 1000, // 10 minutes for sent offers
});
let isBotReady = false;
const pendingDeposits = new Map(); // { depositId: { userId, roundId, items, totalValue, steamId } }

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
                isBotReady = false;
                return;
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
let currentRound = null; // In-memory representation of the current round object (from DB)
let roundTimer = null; // Stores the setInterval ID for the round countdown
let isRolling = false; // Flag to prevent concurrent endRound operations or deposits during rolling

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
                    const priceInDollars = item.price / 100.0; // Assuming price is in cents
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
    return (cachedPrice !== undefined) ? cachedPrice : MIN_ITEM_VALUE; // Fallback to MIN_ITEM_VALUE if not found
}

// --- Core Game Logic ---
async function createNewRound() {
    if (isRolling) {
        console.log("Cannot create new round: Current round is rolling. Will retry soon.");
        return null;
    }
    if (currentRound && ['active', 'pending'].includes(currentRound.status)) {
        console.log(`Cannot create new round: Round ${currentRound.roundId} is already ${currentRound.status}.`);
        return currentRound;
    }

    currentRound = null; isRolling = false;
    if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }

    try {
        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');

        const lastRound = await Round.findOne().sort('-roundId');
        const nextRoundId = lastRound ? lastRound.roundId + 1 : 1;

        const newRoundDoc = new Round({
            roundId: nextRoundId,
            status: 'pending',
            serverSeed: serverSeed,
            serverSeedHash: serverSeedHash,
        });
        await newRoundDoc.save();
        currentRound = newRoundDoc.toObject(); // Use plain object for in-memory currentRound

        console.log(`--- Round ${currentRound.roundId} created (Pending) --- ServerSeedHash: ${currentRound.serverSeedHash}`);
        io.emit('roundCreated', formatRoundForClient(currentRound)); // Send pending round to client

        // The round becomes 'active' and timer starts only when the first participant deposits.
        // No automatic timer start here.

        return currentRound;
    } catch (err) {
        console.error('FATAL: Error creating new round:', err);
        setTimeout(createNewRound, 10000); // Retry
        return null;
    }
}

async function ensureInitialRound() {
    if (!isBotConfigured || !isBotReady) {
        console.log("Bot not ready or not configured, skipping initial round check.");
        return;
    }

    if (!currentRound || !['active', 'pending', 'rolling'].includes(currentRound.status)) {
        try {
            const existingRound = await Round.findOne({ status: { $in: ['active', 'pending'] } })
                .populate('participants.user', 'steamId username avatar _id') // Ensure _id for client mapping
                .populate('items')
                .lean();

            if (existingRound) {
                console.log(`Found existing ${existingRound.status} round ${existingRound.roundId} on startup.`);
                currentRound = existingRound; // Assign to global in-memory currentRound

                if (currentRound.status === 'active' && currentRound.participants.length > 0) {
                    if (currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        startRoundTimer(true); // Resume timer with remaining time
                    } else if (!roundTimer) {
                        console.warn(`Active round ${currentRound.roundId} found without valid/future endTime. Starting new timer.`);
                        startRoundTimer(false); // Start a new timer cycle
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
        // Ensure client is updated if currentRound is already set (e.g. from a previous createNewRound call)
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
        currentRound.endTime = calculatedEndTime.toISOString();
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
        // Recalculate timeLeft based on the authoritative currentRound.endTime
        let currenttimeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - Date.now()) / 1000));
        io.emit('timerUpdate', { timeLeft: currenttimeLeft, roundId: currentRound.roundId });

        if (currenttimeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null;
            console.log(`Round ${currentRound.roundId} timer reached zero.`);
            if (!isRolling && currentRound.status === 'active') { // Double check status before ending
                await endRound();
            }
        }
    }, 1000);
}

// app.js (Backend Logic - Refined)
// Part 2 of 2

async function endRound() {
    if (!currentRound || currentRound.status !== 'active') {
        console.warn(`Attempted to end round ${currentRound?.roundId}, but status is ${currentRound?.status} or no current round.`);
        return;
    }
    if (isRolling && currentRound._id.toString() === (await Round.findById(currentRound._id).select('_id').lean())?._id.toString()) {
        console.warn(`endRound called for round ${currentRound.roundId} but it's already rolling.`);
        return;
    }

    isRolling = true;
    const roundToEndId = currentRound.roundId;
    const roundMongoId = currentRound._id;
    console.log(`--- Ending round ${roundToEndId}... ---`);

    try {
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } });
        currentRound.status = 'rolling'; // Update in-memory
        currentRound.endTime = new Date().toISOString();
        io.emit('roundRolling', { roundId: roundToEndId });

        const round = await Round.findById(roundMongoId)
            .populate('participants.user', 'steamId username avatar tradeUrl _id') // Ensure _id is populated
            .populate('items')
            .lean();

        if (!round || round.status !== 'rolling') {
            console.warn(`Round ${roundToEndId} data missing or status not 'rolling' in DB after update. Aborting endRound.`);
            isRolling = false;
            currentRound = await Round.findById(roundMongoId).lean(); // Re-sync
            // Potentially create new if state is broken or re-activate if appropriate
            if (!currentRound || !['active', 'pending', 'rolling'].includes(currentRound.status)) {
                setTimeout(createNewRound, 5000);
            }
            return;
        }
        currentRound = { ...round }; // Update global in-memory round with full data for processing

        if (round.participants.length === 0 || round.items.length === 0) {
            console.log(`Round ${round.roundId} ended with no participants or items. Pot Value: $${round.totalValue.toFixed(2)}`);
            const finalStatus = round.totalValue > 0 ? 'error' : 'completed'; // If value > 0 but no one to win, it's an error
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: finalStatus, completedTime: new Date(), winner: null, totalValue: 0, items: [] } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants or items." });
            isRolling = false; currentRound = null; setTimeout(createNewRound, 7000);
            return;
        }

        let allItemsInPotFromDB = [...round.items]; // All items initially in the pot
        let originalPotValue = round.participants.reduce((sum, p) => sum + (p?.itemsValue || 0), 0);
        let valueForWinnerCalculation = originalPotValue;
        let taxAmount = 0;
        let taxedItemsInfo = []; // For DB: { assetId, name, price }
        let itemsToGiveToWinner = [...allItemsInPotFromDB]; // Start with all items

        if (originalPotValue >= MIN_POT_FOR_TAX && allItemsInPotFromDB.length > 0) {
            const targetTaxRate = Math.min(TAX_MAX_PERCENT, Math.max(TAX_MIN_PERCENT, TAX_MIN_PERCENT + (originalPotValue - MIN_POT_FOR_TAX) / 1000)); // Example progressive tax
            const targetTaxValue = originalPotValue * (targetTaxRate / 100);
            const maxTaxValue = originalPotValue * (TAX_MAX_PERCENT / 100);

            // Sort items by price (cheapest first) to take for tax
            const sortedItemsForTax = [...allItemsInPotFromDB].sort((a, b) => (a.price || 0) - (b.price || 0));
            let currentTaxValueAccumulated = 0;
            let tempTaxedItemsForOffer = []; // Items the bot will keep

            for (const item of sortedItemsForTax) {
                if (tempTaxedItemsForOffer.length >= itemsToGiveToWinner.length) break; // Cannot tax more items than available for winner

                if (currentTaxValueAccumulated + item.price <= maxTaxValue) {
                    tempTaxedItemsForOffer.push(item);
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price });
                    currentTaxValueAccumulated += item.price;
                    if (currentTaxValueAccumulated >= targetTaxValue && tempTaxedItemsForOffer.length > 0) break; // Met target
                } else {
                    // If adding this item exceeds max, try to find a single item closer to remaining target, or just stop.
                    // For simplicity, we stop if the next cheapest exceeds max.
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

        const clientSeed = crypto.randomBytes(16).toString('hex'); // Fresh client seed for each round end
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16); // Use first 8 hex chars for ticket
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);

        if (totalTickets <= 0) {
            console.error(`Cannot determine winner: Total tickets is zero for round ${round.roundId}.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', completedTime: new Date(), clientSeed, provableHash, totalValue: 0, taxAmount: originalPotValue, taxedItems: round.items.map(i=> ({assetId: i.assetId, name: i.name, price: i.price})), items: [] } });
            io.emit('roundError', { roundId: round.roundId, error: 'No tickets in pot.' });
            io.emit('roundCompleted', { roundId: round.roundId, status: 'error' });
            isRolling = false; currentRound = null; setTimeout(createNewRound, 10000);
            return;
        }

        const winningTicket = decimalFromHash % totalTickets;
        let cumulativeTickets = 0;
        let winnerDBInfo = null; // Populated User object from round.participants

        for (const participant of round.participants) {
            if (!participant?.tickets || !participant.user?._id) continue;
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winnerDBInfo = participant.user; // This is already the populated user object
                break;
            }
        }

        if (!winnerDBInfo || !winnerDBInfo._id) {
             console.error(`Winner selection failed for round ${round.roundId}. WinningTicket: ${winningTicket}, TotalTickets: ${totalTickets}`);
             await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', completedTime: new Date(), clientSeed, provableHash } });
             io.emit('roundError', { roundId: round.roundId, error: 'Winner selection process failed.' });
             io.emit('roundCompleted', { roundId: round.roundId, status: 'error' });
             isRolling = false; currentRound = null; setTimeout(createNewRound, 10000);
             return;
        }

        await User.findByIdAndUpdate(winnerDBInfo._id, { $inc: { totalWinningsValue: valueForWinnerCalculation } });

        const finalUpdateData = {
            status: 'completed', completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winnerDBInfo._id,
            taxAmount: taxAmount, taxedItems: taxedItemsInfo,
            totalValue: valueForWinnerCalculation, // This is what the winner is considered to have won
            items: itemsToGiveToWinner.map(i => i._id), // Store IDs of items won
            payoutOfferStatus: 'Pending Send'
        };

        const completedRoundDoc = await Round.findOneAndUpdate({ _id: roundMongoId }, { $set: finalUpdateData }, { new: true })
            .populate('winner', 'steamId username avatar tradeUrl _id') // _id stringified by formatRoundForClient
            .lean();

        if (!completedRoundDoc) throw new Error("Failed to save completed round data.");

        console.log(`Round ${round.roundId} completed. Winner: ${winnerDBInfo.username} (Ticket: ${winningTicket}/${totalTickets}, Value Won: $${valueForWinnerCalculation.toFixed(2)})`);

        io.emit('roundWinner', { // For animation, uses populated winnerDBInfo from earlier
            roundId: round.roundId,
            winner: { // Ensure IDs are strings for client
                id: winnerDBInfo._id.toString(),
                steamId: winnerDBInfo.steamId,
                username: winnerDBInfo.username,
                avatar: winnerDBInfo.avatar
            },
            winningTicket: winningTicket,
            totalValue: valueForWinnerCalculation, // After tax value
            totalTickets: totalTickets,
            serverSeed: round.serverSeed, // Revealed server seed
            clientSeed: clientSeed,       // Revealed client seed
            provableHash: provableHash,   // Revealed final hash
            serverSeedHash: round.serverSeedHash // Initial hash
        });

        await sendWinningTradeOffer(completedRoundDoc, completedRoundDoc.winner, itemsToGiveToWinner);

        // Emit final completed event after trade offer attempt
        io.emit('roundCompleted', formatRoundForClient(completedRoundDoc));


    } catch (err) {
        console.error(`CRITICAL ERROR during endRound for round ${roundToEndId}:`, err.stack || err);
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', payoutOfferStatus: 'Failed' } })
            .catch(e => console.error("Error marking round as error post-failure:", e));
        io.emit('roundError', { roundId: roundToEndId, error: 'Internal server error during round finalization.' });
        io.emit('roundCompleted', { roundId: roundToEndId, status: 'error' }); // Also emit generic completed
    } finally {
        isRolling = false;
        currentRound = null; // Clear current round, new one will be made
        console.log(`Scheduling next round creation after round ${roundToEndId} finalization.`);
        setTimeout(createNewRound, 10000); // Create new round after a delay
    }
}

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
            // The `!!identitySecret` was for manager.sendWithToken, standard send doesn't use it directly.
            // If 2FA is on bot, confirmations are handled by manager/community events if needed.
            offer.send((err, status) => {
                if (err) return reject(err);
                resolve({ status: status, offerId: offer.id }); // offer.id should be available after send attempt
            });
        });

        const offerURL = `https://steamcommunity.com/tradeoffer/${sentOfferResult.offerId}/`;
        let offerStatusForDB = 'Sent'; // Default
        if (sentOfferResult.status === 'pending' || sentOfferResult.status === 'pendingConfirmation' || sentOfferResult.status === 'escrow' || sentOfferResult.status?.toLowerCase().includes('escrow')) {
            offerStatusForDB = 'Escrow';
        } else if (sentOfferResult.status === 'accepted') {
            offerStatusForDB = 'Accepted';
        }

        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferId: sentOfferResult.offerId, payoutOfferStatus: offerStatusForDB } });
        console.log(`[Trade Send DB Update] Round ${roundDoc.roundId}: PAYOUT_SUCCESS. Offer ${sentOfferResult.offerId} sent to ${winner.username}. Steam Status: ${sentOfferResult.status}, DB Status: ${offerStatusForDB}`);

        io.to(winner._id.toString()).emit('tradeOfferSent', { // Emit specifically to the winner's socket if possible
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


// --- Authentication Routes ---
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

app.get('/api/user', ensureAuthenticated, (req, res) => { // Send only necessary user fields
    const { _id, steamId, username, avatar, tradeUrl, pendingDepositOfferId, totalDepositedValue, totalWinningsValue } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, pendingDepositOfferId, totalDepositedValue, totalWinningsValue });
});

app.post('/api/user/tradeurl', ensureAuthenticated, // Removed extra rate limiter, general one applies
    [
        body('tradeUrl').trim().custom((value) => {
            if (value === '') return true; // Allow empty
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
            amountWon: win.totalValue, // Already after-tax value
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
             try { // Check existing offer state
                 const offer = await manager.getOffer(user.pendingDepositOfferId);
                 if (offer && [TradeOfferManager.ETradeOfferState.Active, TradeOfferManager.ETradeOfferState.Sent, TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation].includes(offer.state)) {
                     const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                     return res.status(409).json({ error: 'Active deposit offer waiting. Accept/decline on Steam.', offerId: user.pendingDepositOfferId, offerURL: offerURL });
                 } // Else, old offer is no longer active, proceed.
                 await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }); // Clear stale ID
             } catch (offerFetchError) {
                 await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }); // Clear on error too
             }
        }

        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits currently closed for this round.' });
        }
        // Use in-memory currentRound for these checks for speed, assuming it's kept up-to-date by socket events
        const isNewParticipant = !currentRound.participants.some(p => p.user?.toString() === user._id.toString());
        if (isNewParticipant && currentRound.participants.length >= MAX_PARTICIPANTS) {
             return res.status(400).json({ error: `Participant limit (${MAX_PARTICIPANTS}) reached.` });
        }
        if (currentRound.items.length + requestedAssetIds.length > MAX_ITEMS_PER_POT) {
             const slotsLeft = MAX_ITEMS_PER_POT - currentRound.items.length;
             return res.status(400).json({ error: `Deposit would exceed pot limit (${MAX_ITEMS_PER_POT}). ${slotsLeft} slots left.` });
        }

        let itemsToRequest = [];
        let depositTotalValue = 0;
        try { // Verify items from user's inventory
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

        const depositId = uuidv4(); // For tracking this specific deposit attempt
        const offer = manager.createOffer(user.tradeUrl);
        offer.addTheirItems(itemsToRequest.map(({ assetid, appid, contextid }) => ({ assetid, appid, contextid })));
        offer.setMessage(`RustyDegen Deposit ID: ${depositId} | Round: ${currentRound.roundId}`);

        pendingDeposits.set(depositId, { // Store deposit details temporarily
            userId: user._id, roundId: currentRound._id, items: itemsToRequest,
            totalValue: depositTotalValue, steamId: user.steamId
        });
        const cleanupTimeout = setTimeout(() => { // Auto-cleanup if offer not acted upon
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
            await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }).catch(e=>e); // Clear flag on fail
            let userMsg = 'Failed to create deposit offer.';
            if (error.message.includes('Trade URL') || error.eresult === 26) userMsg = 'Your Steam Trade URL might be invalid. Check profile.';
            else if (error.eresult) userMsg += ` (Code: ${error.eresult})`;
            res.status(500).json({ error: userMsg });
        }
    }
);

// --- Trade Offer Manager Event Handling ---
if (isBotConfigured && manager) {
    manager.on('newOffer', async (offer) => { // Decline unsolicited offers
        if (!isBotReady || offer.isOurOffer || (offer.itemsToGive && offer.itemsToGive.length > 0)) return;
        offer.decline(err => { if(err) console.error(`Error declining unsolicited offer ${offer.id}:`, err); });
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        console.log(`Bot Offer #${offer.id} changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()})`);

        const depositIdMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
        const depositId = depositIdMatch ? depositIdMatch[1] : null;

        if (depositId && pendingDeposits.has(depositId)) { // This is a deposit offer we sent
            const depositData = pendingDeposits.get(depositId);
            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                pendingDeposits.delete(depositId);
                User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null }).catch(e=>e);

                let roundForDeposit;
                try {
                    roundForDeposit = await Round.findById(depositData.roundId).exec(); // Get full Mongoose doc
                    if (!roundForDeposit || roundForDeposit.status !== 'active' || isRolling) { // Re-check round state
                        io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Deposit Error (Offer ${offer.id}): Round invalid/ended. Contact support.` });
                        return; // TODO: Consider how to handle items if round is no longer valid (e.g. refund)
                    }
                    const isNewP = !roundForDeposit.participants.some(p => p.user?.toString() === depositData.userId.toString());
                    if (isNewP && roundForDeposit.participants.length >= MAX_PARTICIPANTS) throw new Error("Participant limit hit post-acceptance.");
                    if (roundForDeposit.items.length + depositData.items.length > MAX_ITEMS_PER_POT) throw new Error("Pot item limit hit post-acceptance.");
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

                    if (roundForDeposit.status === 'pending') { // First deposit makes round active
                        roundForDeposit.status = 'active';
                        roundForDeposit.startTime = new Date();
                         // Set endTime and start timer ONLY if it's now active with participants
                        roundForDeposit.endTime = new Date(Date.now() + ROUND_DURATION * 1000);
                    }
                    const savedRound = await roundForDeposit.save();
                    // Update global currentRound if it matches
                    if (currentRound && currentRound._id.toString() === savedRound._id.toString()) {
                        currentRound = await Round.findById(savedRound._id).populate('participants.user', 'steamId username avatar _id').populate('items').lean(); // Re-populate and make lean for consistency
                    } else if (!currentRound || currentRound._id.toString() !== savedRound._id.toString()){
                        // If global currentRound is different or null, ensure it's updated if this deposit belongs to it.
                        // This can happen if currentRound was cleared or a new one was made just before this completed.
                        // For safety, we might just rely on the next fetch/socket update.
                        console.warn("Deposit processed for a round different from in-memory currentRound or currentRound is null. Frontend might rely on next full sync.");
                    }


                    const populatedParticipant = currentRound?.participants.find(p => p.user?._id.toString() === depositData.userId.toString());
                    if (populatedParticipant && populatedParticipant.user) {
                         io.emit('participantUpdated', { // Broadcast to all clients
                              roundId: currentRound.roundId,
                              userId: populatedParticipant.user._id.toString(), // User's MongoDB _id
                              username: populatedParticipant.user.username,
                              avatar: populatedParticipant.user.avatar,
                              itemsValue: populatedParticipant.itemsValue, // New total value for this participant in this round
                              tickets: populatedParticipant.tickets,
                              totalValue: currentRound.totalValue, // New overall pot total value
                              depositedItems: depositData.items.map(i => ({ name: i._name, image: i._image, price: i._price }))
                         });
                    }

                    // Start timer if this was the first deposit to an active round
                    if (currentRound?.status === 'active' && currentRound.participants.length === 1 && !roundTimer) {
                        startRoundTimer(false); // false because endTime was just set
                        // Also emit status update if it just became active
                        io.emit('roundStatusUpdate', { roundId: currentRound.roundId, status: 'active', startTime: currentRound.startTime, endTime: currentRound.endTime });
                    }

                } catch (dbErr) {
                     console.error(`CRITICAL DB/UPDATE ERROR processing deposit ${offer.id} for round ${depositData.roundId}:`, dbErr);
                     io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `CRITICAL Deposit Error (Offer ${offer.id}). Contact support.` });
                     if (createdItemDocs.length > 0) await Item.deleteMany({ _id: { $in: createdItemDocs.map(d => d._id) } }); // Rollback items
                     if (currentRound && currentRound._id.toString() === depositData.roundId.toString()) {
                         await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } });
                         io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error.' });
                         currentRound = null; setTimeout(createNewRound, 15000);
                     }
                }
            } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired, TradeOfferManager.ETradeOfferState.InvalidItems].includes(offer.state)) {
                if (depositData) { // Check if data exists before trying to use it
                    pendingDeposits.delete(depositId);
                    User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null }).catch(e=>e);
                    io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Your deposit offer (#${offer.id}) was ${TradeOfferManager.ETradeOfferState[offer.state].toLowerCase()}.` });
                }
            }
        } else if (offer.itemsToGive && offer.itemsToGive.length > 0 && (!offer.itemsToReceive || offer.itemsToReceive.length === 0)) {
            // This is a payout (winnings) offer we sent
            let payoutStatusUpdate = TradeOfferManager.ETradeOfferState[offer.state] || 'Unknown';
            try {
                const updatedRound = await Round.findOneAndUpdate(
                    { payoutOfferId: offer.id },
                    { $set: { payoutOfferStatus: payoutStatusUpdate } },
                    { new: true }
                ).populate('winner', '_id'); // Only need winner's _id for notification

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

// --- Round Info API & Formatting ---
function formatRoundForClient(round) { // Ensures consistent data structure for client
    if (!round || !round._id) return null; // Basic check

    let timeLeft = 0;
    if (round.status === 'active') {
        if (round.endTime && new Date(round.endTime) > Date.now()) {
            timeLeft = Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000));
        } else if (round.participants?.length > 0) { // Active with participants but no valid future end time (e.g., timer about to end or just ended)
            timeLeft = 0;
        } else { // Active, no participants, or no valid end time
            timeLeft = ROUND_DURATION;
        }
    } else if (round.status === 'pending') {
        timeLeft = ROUND_DURATION; // Show full duration for pending rounds
    }

    const participantsFormatted = (round.participants || []).map(p => ({
        user: p.user ? { _id: p.user._id?.toString(), steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar } : null,
        itemsValue: p.itemsValue || 0, tickets: p.tickets || 0
    })).filter(p => p.user); // Filter out any potentially null users if population failed

    // For items, ensure owner ID is stringified if populated
    const itemsFormatted = (round.items || []).map(i => ({
        ...i, // Spread existing item properties (like assetId, name, image, price from lean() query)
        owner: i.owner?._id?.toString() || i.owner?.toString() // Handle populated or just ID
    }));


    let winnerDetails = null;
    if (round.winner && typeof round.winner === 'object' && round.winner.steamId) { // Populated winner object
        winnerDetails = {
            id: round.winner._id?.toString(), steamId: round.winner.steamId,
            username: round.winner.username, avatar: round.winner.avatar
        };
    } else if (round.winner) { // Just an ID (should not happen if populated correctly)
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
        items: itemsFormatted, // All items in pot for active, winner's items for completed
        winner: winnerDetails,
        // Provably fair details only if round is completed
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
        if (currentRound && ['active', 'pending', 'rolling'].includes(currentRound.status)) {
            // If in-memory currentRound seems valid, re-populate it to ensure all fields are fresh for client
            roundToFormat = await Round.findById(currentRound._id)
                 .populate('participants.user', 'steamId username avatar _id')
                 .populate('items') // For active round, these are all items in pot
                 .populate('winner', 'steamId username avatar _id') // Mostly for 'rolling' status
                 .lean();
            if (!roundToFormat) { // If it was deleted or changed status in DB
                currentRound = null; // Invalidate in-memory
            } else {
                currentRound = roundToFormat; // Update in-memory with fresh lean object
            }
        }

        if (!currentRound || !['active', 'pending', 'rolling'].includes(currentRound.status)) {
            // If no valid in-memory round, try to find one from DB
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'pending', 'rolling'] } })
                 .sort({ startTime: -1 }) // Get the latest if multiple (shouldn't happen for active/pending)
                 .populate('participants.user', 'steamId username avatar _id')
                 .populate('items')
                 .populate('winner', 'steamId username avatar _id')
                 .lean();
            currentRound = roundToFormat; // Update in-memory
        }

        // Ensure timer is correctly managed based on the fetched/current round state
        if (currentRound) {
            if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !roundTimer) {
                if (currentRound.endTime && new Date(currentRound.endTime) > Date.now()) startRoundTimer(true); else startRoundTimer(false);
            } else if (currentRound.status === 'active' && currentRound.participants?.length === 0 && roundTimer) {
                clearInterval(roundTimer); roundTimer = null; // Stop timer if no participants
            }
        }

        const formattedData = formatRoundForClient(currentRound);
        if (formattedData) {
            res.json(formattedData);
        } else {
            // No active/pending/rolling round found, explicitly create one if this API is hit
            const newCreatedRound = await createNewRound();
            res.json(formatRoundForClient(newCreatedRound)); // Send the newly created pending round
        }
    } catch (err) {
        console.error('Error fetching/formatting current round for API:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' });
    }
});


app.get('/api/rounds', // Past rounds history
    [ body('page').optional().isInt({ min: 1 }).toInt(), body('limit').optional().isInt({ min: 1, max: 50 }).toInt() ], // Changed to body for consistency, though query is more common for GET
    handleValidationErrors, async (req, res) => {
    try {
        const page = req.body.page || 1; const limit = req.body.limit || 10; const skip = (page - 1) * limit;
        const queryFilter = { status: { $in: ['completed', 'error'] } }; // Only completed/error rounds
        const [rounds, totalCount] = await Promise.all([
            Round.find(queryFilter).sort('-roundId').skip(skip).limit(limit)
                 .populate('winner', 'username avatar steamId') // Populate winner info
                 .select('roundId completedTime totalValue winner serverSeed clientSeed winningTicket provableHash status taxAmount payoutOfferId payoutOfferStatus') // Select relevant fields
                 .lean(),
            Round.countDocuments(queryFilter)
        ]);
        res.json({ rounds, totalPages: Math.ceil(totalCount / limit), currentPage: page, totalRounds: totalCount });
    } catch (err) {
        res.status(500).json({ error: 'Server error fetching round history.' });
    }
});

app.post('/api/verify', // Provably fair verification
    [
        body('roundId').notEmpty().isInt({ min: 1 }).toInt(),
        body('serverSeed').trim().isHexadecimal().isLength({ min: 64, max: 64 }),
        body('clientSeed').trim().isString().isLength({ min: 1, max: 128 })
    ],
    handleValidationErrors, async (req, res) => {
    const { roundId, serverSeed, clientSeed } = req.body;
    try {
        const round = await Round.findOne({ roundId: roundId, status: 'completed' })
             .populate('participants.user', 'username').populate('winner', 'username').lean();
        if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found.` });

        // Verify serverSeed against serverSeedHash stored at round start (not user provided)
        const calculatedServerSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
        if (calculatedServerSeedHash !== round.serverSeedHash) {
            return res.json({ verified: false, reason: 'Provided Server Seed does not match the original Server Seed Hash for this round.' });
        }
        // Now verify against the revealed seeds if they match what's stored
        if (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed) {
            return res.json({ verified: false, reason: 'Provided seeds do not match the official revealed seeds for this round.'});
        }

        const combinedString = round.serverSeed + round.clientSeed; // Use stored seeds for official verification
        const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        if (calculatedProvableHash !== round.provableHash) return res.json({ verified: false, reason: 'Calculated Provable Hash mismatch.' });

        const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
        const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;
        if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets.' });
        const calculatedWinningTicket = decimalFromHash % totalTickets;

        if (calculatedWinningTicket !== round.winningTicket) return res.json({ verified: false, reason: 'Calculated winning ticket mismatch.' });
        res.json({
            verified: true, roundId: round.roundId, serverSeed: round.serverSeed, serverSeedHash: round.serverSeedHash, clientSeed: round.clientSeed,
            finalHash: round.provableHash, winningTicket: round.winningTicket, totalTickets,
            winnerUsername: round.winner?.username || 'N/A'
        });
    } catch (err) {
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
    io.emit('updateUserCount', connectedChatUsers); // Broadcast new count
    const user = socket.request.user; // From passport session
    if (user) socket.join(user._id.toString()); // Join a room for user-specific notifications

    console.log(`Client connected: ${socket.id}${user ? ` (User: ${user.username})` : ' (Anonymous)'}`);

    socket.on('requestRoundData', async () => { // Send current round data on request
        let roundToFormat = null;
        // Prioritize in-memory currentRound if it's valid and active/pending/rolling
        if (currentRound && ['active', 'pending', 'rolling'].includes(currentRound.status)) {
            roundToFormat = await Round.findById(currentRound._id) // Re-fetch to ensure latest data for this specific client
                 .populate('participants.user', 'steamId username avatar _id')
                 .populate('items')
                 .populate('winner', 'steamId username avatar _id')
                 .lean();
            if (!roundToFormat) currentRound = null; // Invalidate if not found in DB
            else currentRound = roundToFormat;
        }
        // If no valid in-memory, fetch from DB
        if (!currentRound || !['active', 'pending', 'rolling'].includes(currentRound.status)) {
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'pending', 'rolling'] } })
                 .sort({ startTime: -1 })
                 .populate('participants.user', 'steamId username avatar _id')
                 .populate('items')
                 .populate('winner', 'steamId username avatar _id')
                 .lean();
            currentRound = roundToFormat;
        }

        const formattedData = formatRoundForClient(currentRound);
        if (formattedData) {
            socket.emit('roundData', formattedData);
            // Ensure timer is correctly managed if sending an active round
            if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !roundTimer) {
                if (currentRound.endTime && new Date(currentRound.endTime) > Date.now()) startRoundTimer(true);
                else startRoundTimer(false);
            }
        } else {
            // If absolutely no round found, create one and send it
            const newCreatedRound = await createNewRound(); // This sets global currentRound
            socket.emit('roundData', formatRoundForClient(newCreatedRound));
        }
    });

    socket.on('chatMessage', (msg) => {
        if (!user || !user._id) return socket.emit('notification', {type: 'error', message: 'Must be logged in to chat.'});

        const userId = user._id.toString();
        const now = Date.now();
        const lastMsgTime = userLastMessageTime.get(userId) || 0;
        if (now - lastMsgTime < CHAT_COOLDOWN_SECONDS * 1000) {
            const timeLeft = Math.ceil((CHAT_COOLDOWN_SECONDS * 1000 - (now - lastMsgTime)) / 1000);
            return socket.emit('notification', {type: 'warning', message: `Wait ${timeLeft}s to chat.`});
        }
        const trimmedMsg = msg.trim();
        if (trimmedMsg.length === 0 || trimmedMsg.length > MAX_CHAT_MESSAGE_LENGTH) {
            return socket.emit('notification', {type: 'error', message: `Message 1-${MAX_CHAT_MESSAGE_LENGTH} chars.`});
        }
        userLastMessageTime.set(userId, now);
        io.emit('chatMessage', { // Broadcast to all
            username: user.username, avatar: user.avatar || '/img/default-avatar.png',
            message: trimmedMsg, userId: userId, userSteamId: user.steamId, timestamp: new Date()
        });
    });

    socket.on('disconnect', () => {
        connectedChatUsers = Math.max(0, connectedChatUsers - 1);
        io.emit('updateUserCount', connectedChatUsers);
        console.log(`Client disconnected: ${socket.id}${user ? ` (User: ${user.username})` : ''}`);
    });
});

// --- Server Startup ---
async function startApp() {
    await refreshPriceCache(); // Initial price fetch
    setInterval(refreshPriceCache, PRICE_REFRESH_INTERVAL_MS);

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}. Site URL: ${process.env.SITE_URL}`);
        if (!isBotConfigured) console.log("INFO: Steam Bot NOT configured.");
        else if (!isBotReady) console.log("INFO: Steam Bot configured but login may have FAILED or is pending.");
        else console.log("INFO: Steam Bot is READY.");
        ensureInitialRound(); // Ensure a round exists or is created on startup
    });
}

startApp();

function gracefulShutdown() {
    console.log('Shutdown signal received. Closing server...');
    io.close(() => console.log('Socket.IO connections closed.'));
    server.close(async () => {
        console.log('HTTP server closed.');
        await mongoose.connection.close();
        console.log('MongoDB connection closed.');
        if (manager && typeof manager.shutdown === 'function') manager.shutdown();
        process.exit(0);
    });
    setTimeout(() => { console.error('Forcing shutdown.'); process.exit(1); }, 10000); // Force exit
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Final error handler
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: process.env.NODE_ENV === 'production' ? 'Server error.' : (err.message || 'Unknown error.') });
});
