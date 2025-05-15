// app.js (Corrected and Complete with Chat Logic)

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

// --- Enhanced: connect-mongo for persistent sessions ---
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
const MAX_CHAT_MESSAGE_LENGTH = 200; // For chat

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
            "script-src": ["'self'", "/socket.io/socket.io.js", "'unsafe-inline'"], // Allow socket.io.js
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
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Too many chat messages. Please wait a moment.', standardHeaders: true, legacyHeaders: false }); // Chat limiter

app.use('/api/', generalApiLimiter);
app.use(cors({ origin: process.env.SITE_URL || "*", credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
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
    taxedItems: [{ assetId: String, name: String, price: { type: Number, min: 0 } }]
});
roundSchema.index({ 'participants.user': 1 });

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
            participants: [],
            totalValue: 0
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
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items')
                    .lean();
                if (existingActive) {
                    console.log(`Found existing active round ${existingActive.roundId} on startup.`);
                    currentRound = existingActive;
                    if (currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        startRoundTimer(true);
                    } else if (currentRound.participants.length > 0 && !currentRound.endTime && !roundTimer) {
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
        currentRound.endTime = calculatedEndTime;
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
            .catch(e => console.error(`Error saving round end time for round ${currentRound?.roundId}:`, e));
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
// ... (endRound and sendWinningTradeOffer functions are substantial, ensure they are complete)
// app.js (Corrected and Complete with Chat Logic) - Part 2 of 2

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
            .populate('participants.user') // Populate user details for participants
            .populate('items')             // Populate item details for items in the pot
            .lean();                       // Use .lean() for plain JS objects
        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);
        if (round.status !== 'rolling') { // Safety check
             console.warn(`Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Aborting endRound.`);
             isRolling = false; return;
        }
        currentRound = round; // Update in-memory currentRound

        if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            console.log(`Round ${round.roundId} ended with no valid participants or value.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date() } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants." });
            isRolling = false;
            setTimeout(createNewRound, 5000);
            return;
        }

        let finalItems = [...round.items];
        let finalTotalValue = round.totalValue;
        let taxAmount = 0;
        let taxedItemsInfo = [];
        let itemsToTakeForTaxIds = [];

        if (finalTotalValue >= MIN_POT_FOR_TAX) {
            const targetTaxValue = finalTotalValue * (TAX_MIN_PERCENT / 100);
            const maxTaxValue = finalTotalValue * (TAX_MAX_PERCENT / 100);
            const sortedItems = [...finalItems].sort((a, b) => a.price - b.price);
            let currentTaxValue = 0;
            for (const item of sortedItems) {
                if (currentTaxValue + item.price <= maxTaxValue) {
                    itemsToTakeForTaxIds.push(item._id.toString());
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price });
                    currentTaxValue += item.price;
                    if (currentTaxValue >= targetTaxValue) break;
                } else break;
            }
            if (itemsToTakeForTaxIds.length > 0) {
                const taxedItemsIdsSet = new Set(itemsToTakeForTaxIds);
                finalItems = finalItems.filter(item => !taxedItemsIdsSet.has(item._id.toString()));
                taxAmount = currentTaxValue;
                finalTotalValue -= taxAmount;
                console.log(`Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${itemsToTakeForTaxIds.length} items). New Pot Value: $${finalTotalValue.toFixed(2)}`);
            }
        }

        const clientSeed = crypto.randomBytes(16).toString('hex');
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16);
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);
        if (totalTickets <= 0) throw new Error(`Cannot determine winner: Total tickets is zero or invalid for round ${round.roundId}.`);
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
        if (!winnerInfo || !winnerInfo._id) throw new Error(`Winner selection failed for round ${round.roundId}. Winning Ticket: ${winningTicket}, Total Tickets: ${totalTickets}`);

        try {
            const updatedWinnerUser = await User.findByIdAndUpdate(
                winnerInfo._id,
                { $inc: { totalWinningsValue: finalTotalValue } },
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
            status: 'completed', completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winnerInfo._id,
            taxAmount: taxAmount, taxedItems: taxedItemsInfo, totalValue: finalTotalValue,
            items: finalItems.map(i => i._id)
        };
        await Round.updateOne({ _id: roundMongoId }, { $set: finalUpdateData });
        console.log(`Round ${round.roundId} completed. Winner: ${winnerInfo.username} (Ticket: ${winningTicket}/${totalTickets}, Value: $${finalTotalValue.toFixed(2)})`);

        io.emit('roundWinner', {
            roundId: round.roundId,
            winner: { id: winnerInfo._id, steamId: winnerInfo.steamId, username: winnerInfo.username, avatar: winnerInfo.avatar },
            winningTicket: winningTicket, totalValue: finalTotalValue, totalTickets: totalTickets,
            serverSeed: round.serverSeed, clientSeed: clientSeed, provableHash: provableHash, serverSeedHash: round.serverSeedHash
        });
        await sendWinningTradeOffer(round, winnerInfo, finalItems);
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

async function sendWinningTradeOffer(round, winner, itemsToSend) {
    if (!isBotReady) {
        console.error(`PAYOUT_ERROR: Cannot send winnings for round ${round.roundId}: Steam Bot is not ready.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Bot Error: Payout for round ${round.roundId} requires manual processing. Contact support.` });
        return;
    }
    if (!winner.tradeUrl) {
        console.error(`PAYOUT_ERROR: Cannot send winnings for round ${round.roundId}: Winner ${winner.username} has no Trade URL set.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Please set your Trade URL in your profile to receive winnings.' });
        return;
    }
    if (!itemsToSend || itemsToSend.length === 0) {
        console.log(`PAYOUT_INFO: No items to send for round ${round.roundId} (possibly all taxed or error).`);
        if (round.taxAmount > 0 && round.totalValue <= 0) {
            io.emit('notification', { type: 'info', userId: winner._id.toString(), message: `Round ${round.roundId} winnings ($${round.taxAmount.toFixed(2)}) were processed as site tax.` });
        }
        return;
    }
    console.log(`Attempting to send ${itemsToSend.length} winning items for round ${round.roundId} to ${winner.username}...`);
    try {
        const offer = manager.createOffer(winner.tradeUrl);
        offer.addMyItems(itemsToSend.map(item => ({
            assetid: item.assetId, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID
        })));
        offer.setMessage(`Congratulations! Your winnings from Round #${round.roundId} on ${process.env.SITE_NAME || 'RustyDegen'}. Pot Value (after tax): $${round.totalValue.toFixed(2)}`);
        const identitySecret = process.env.STEAM_IDENTITY_SECRET;
        offer.send(!!identitySecret, (err, status) => {
            if (err) {
                if (err.message.includes('revoked') || err.message.includes('invalid') || err.eresult === 26) {
                    console.error(`PAYOUT_ERROR: Trade offer failed for round ${round.roundId}: Invalid Trade URL/Token for ${winner.username}. Offer ID: ${offer.id}`);
                    io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Your Trade URL is invalid or expired. Please update it to receive winnings.' });
                } else if (err.eresult === 15 || err.eresult === 16) {
                    console.error(`PAYOUT_ERROR: Trade offer failed for round ${round.roundId}: Winner's inventory might be full or private. Offer ID: ${offer.id}`);
                    io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Could not send winnings. Ensure your Steam inventory is public and not full.' });
                } else if (err.message?.includes('escrow') || err.eresult === 11) {
                   console.warn(`PAYOUT_WARN: Offer ${offer.id} sent but likely held in escrow. Winner: ${winner.username}`);
                   io.emit('notification', { type: 'warning', userId: winner._id.toString(), message: `Winnings sent (Offer #${offer.id}), but may be held in escrow by Steam. Ensure Steam Guard Mobile Authenticator has been active for 7 days.` });
                } else {
                    console.error(`PAYOUT_ERROR: Error sending trade offer ${offer.id} for round ${round.roundId}: EResult ${err.eresult} - ${err.message}`);
                     io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Error sending winnings for round ${round.roundId}. Please contact support.` });
                }
                return;
            }
            console.log(`PAYOUT_SUCCESS: Trade offer ${offer.id} sent to ${winner.username} for round ${round.roundId}. Status: ${status}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;
            io.emit('tradeOfferSent', {
                roundId: round.roundId, userId: winner._id.toString(), username: winner.username,
                offerId: offer.id, offerURL: offerURL, status: status
            });
             if (status === 'pending' || status === 'pendingConfirmation') {
                 console.log(`Offer #${offer.id} requires confirmation (Status: ${status}). Check mobile authenticator if auto-confirmation is not setup or failed.`);
                 if (!identitySecret) {
                     console.warn(`Offer #${offer.id} requires confirmation, but STEAM_IDENTITY_SECRET is not provided for auto-confirmation.`);
                     io.emit('notification', { type: 'info', userId: winner._id.toString(), message: `Winnings sent (Offer #${offer.id}), but require confirmation in Steam.` });
                 } else {
                     io.emit('notification', { type: 'warning', userId: winner._id.toString(), message: `Winnings sent (Offer #${offer.id}), but confirmation may be needed in Steam.` });
                 }
             }
        });
    } catch (err) {
        console.error(`PAYOUT_ERROR: Unexpected error creating/sending trade offer for round ${round.roundId}:`, err);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Error sending winnings for round ${round.roundId}. Please contact support.` });
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
        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }
        let latestRoundData;
        try {
            latestRoundData = await Round.findById(currentRound._id).select('participants items').lean().exec();
            if (!latestRoundData) throw new Error('Could not fetch current round data.');
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
        const offerMessage = `RustyDegen Deposit ID: ${depositId} | Round: ${currentRound.roundId}`;
        let cleanupTimeout = null;
        try {
            const offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsToRequest.map(({ assetid, appid, contextid }) => ({ assetid, appid, contextid })));
            offer.setMessage(offerMessage);
            pendingDeposits.set(depositId, {
                userId: user._id, roundId: currentRound._id, items: itemsToRequest,
                totalValue: depositTotalValue, steamId: user.steamId
            });
            console.log(`Stored pending deposit ${depositId} for user ${user.steamId}.`);
            cleanupTimeout = setTimeout(() => {
                 if(pendingDeposits.has(depositId)) {
                     console.log(`Deposit attempt ${depositId} expired.`);
                      pendingDeposits.delete(depositId);
                      User.updateOne({ steamId: user.steamId, pendingDepositOfferId: offer?.id || 'expired' }, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user pending flag on expiry:", e));
                 }
            }, manager.cancelTime || 10 * 60 * 1000);
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
    manager.on('newOffer', async (offer) => {
        if (!isBotReady || offer.isOurOffer) return;
        if (offer.itemsToReceive && offer.itemsToReceive.length > 0 && (!offer.itemsToGive || offer.itemsToGive.length === 0)) {
             if (offer.message && offer.message.includes('RustyDegen Deposit ID:')) {
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like a manual deposit. Declining.`);
                 return offer.decline((err) => { if (err) console.error(`Error declining manual deposit offer ${offer.id}:`, err); });
             } else {
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like an unsolicited item offer. Declining.`);
                  return offer.decline((err) => { if (err) console.error(`Error declining unsolicited offer ${offer.id}:`, err); });
             }
        }
        console.log(`Ignoring unexpected incoming offer #${offer.id} from ${offer.partner.getSteamID64()}.`);
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        if (offer.state !== oldState) {
            console.log(`Bot Offer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()}) Msg: "${offer.message}"`);
        }
        if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
            const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
            const depositId = messageMatch ? messageMatch[1] : null;
            let createdItemIds = []; // To store item IDs for potential rollback

            if (depositId && pendingDeposits.has(depositId)) {
                const depositData = pendingDeposits.get(depositId);
                pendingDeposits.delete(depositId);
                console.log(`Processing accepted deposit offer #${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId}`);
                User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                    .then(updateRes => {
                         if(updateRes.modifiedCount > 0) console.log(`Cleared pendingDepositOfferId flag for user ${depositData.steamId}`);
                         else console.warn(`Could not clear pending flag for user ${depositData.steamId} (Offer ID: ${offer.id})`);
                    })
                    .catch(e => console.error("Error clearing user pending flag on deposit accept:", e));
                let depositRound;
                try {
                     depositRound = await Round.findById(depositData.roundId).select('status participants items').exec();
                     if (!depositRound) throw new Error(`Round ${depositData.roundId} not found.`);
                     if (depositRound.status !== 'active' || isRolling) {
                          console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but round invalid. Status: ${depositRound?.status}, Rolling: ${isRolling}. Items NOT added.`);
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Round ended before deposit (Offer #${offer.id}). Contact support.` });
                          return;
                     }
                     const isNewParticipantCheck = !depositRound.participants.some(p => p.user?.toString() === depositData.userId.toString());
                     if (isNewParticipantCheck && depositRound.participants.length >= MAX_PARTICIPANTS) {
                         console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but participant limit reached. Items NOT added.`);
                         io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Participant limit reached before deposit (Offer #${offer.id}). Items NOT added. Contact support.` });
                         return;
                     }
                     if (depositRound.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                          console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but pot item limit reached. Items NOT added.`);
                           const slotsLeft = MAX_ITEMS_PER_POT - depositRound.items.length;
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Pot item limit (Offer #${offer.id}). ${slotsLeft} slots left. Items NOT added. Contact support.` });
                          return;
                     }
                 } catch (roundCheckError) {
                      console.error(`CRITICAL DB ERROR checking round status for accepted deposit ${depositId} (Offer ${offer.id}):`, roundCheckError);
                       io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Contact support.` });
                      return;
                 }
                try {
                    const itemDocuments = depositData.items.map(itemData => new Item({
                        assetId: itemData.assetid, name: itemData._name, image: itemData._image,
                        price: itemData._price, owner: depositData.userId, roundId: depositData.roundId
                    }));
                    const insertedItemsResult = await Item.insertMany(itemDocuments, { ordered: false });
                     if (insertedItemsResult.length !== itemDocuments.length) console.warn(`Deposit ${depositId}: Item insert count mismatch.`);
                    createdItemIds = insertedItemsResult.map(doc => doc._id); // Store for potential rollback
                    console.log(`Deposit ${depositId}: Inserted ${createdItemIds.length} items into DB.`);

                    const userToUpdateForDeposit = await User.findByIdAndUpdate(
                        depositData.userId,
                        { $inc: { totalDepositedValue: depositData.totalValue } },
                        { new: true }
                    );
                    if (userToUpdateForDeposit) {
                        console.log(`Updated deposit stats for ${userToUpdateForDeposit.username}: New total deposited $${userToUpdateForDeposit.totalDepositedValue.toFixed(2)}`);
                    } else {
                        console.warn(`Could not find user ${depositData.steamId} to update deposit stats.`);
                    }

                    const roundToUpdate = await Round.findById(depositData.roundId);
                    if (!roundToUpdate) throw new Error("Round disappeared before final update.");
                    if (roundToUpdate.status !== 'active') throw new Error("Round status changed before final update.");
                    let participantIndex = roundToUpdate.participants.findIndex(p => p.user?.toString() === depositData.userId.toString());
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));
                    if (participantIndex !== -1) {
                           roundToUpdate.participants[participantIndex].itemsValue += depositData.totalValue;
                           roundToUpdate.participants[participantIndex].tickets += depositTickets;
                    } else {
                           if (roundToUpdate.participants.length >= MAX_PARTICIPANTS) throw new Error(`Participant limit reached for ${depositData.steamId}.`);
                           roundToUpdate.participants.push({ user: depositData.userId, itemsValue: depositData.totalValue, tickets: depositTickets });
                    }
                    roundToUpdate.totalValue += depositData.totalValue;
                    if (roundToUpdate.items.length + createdItemIds.length > MAX_ITEMS_PER_POT) throw new Error(`Pot item limit reached for ${depositData.steamId}.`);
                    roundToUpdate.items.push(...createdItemIds);
                    const savedRound = await roundToUpdate.save();
                    const latestRoundData = await Round.findById(savedRound._id).populate('participants.user', 'steamId username avatar').lean();
                    if (!latestRoundData) throw new Error('Failed to fetch updated round data after deposit save.');
                    currentRound = latestRoundData;
                    const updatedParticipantData = latestRoundData.participants.find(p => p.user?._id.toString() === depositData.userId.toString());
                    const userInfo = updatedParticipantData?.user;
                    if (updatedParticipantData && userInfo) {
                          io.emit('participantUpdated', {
                               roundId: latestRoundData.roundId, userId: userInfo._id.toString(), username: userInfo.username,
                               avatar: userInfo.avatar, itemsValue: updatedParticipantData.itemsValue,
                               tickets: updatedParticipantData.tickets, totalValue: latestRoundData.totalValue,
                               depositedItems: depositData.items.map(i => ({ assetId: i.assetid, name: i._name, image: i._image, price: i._price }))
                          });
                    } else {
                          console.error(`Failed to find updated participant data for user ${depositData.steamId} in round ${latestRoundData.roundId}.`);
                    }
                      if (latestRoundData.participants.length === 1 && !roundTimer) {
                          console.log(`First participant (${userInfo?.username}) joined round ${latestRoundData.roundId}. Starting timer.`);
                          startRoundTimer();
                      }
                     console.log(`Deposit success processed for offer #${offer.id}. User: ${userInfo?.username}, Value: $${depositData.totalValue.toFixed(2)}`);
                 } catch (dbErr) {
                     console.error(`CRITICAL DATABASE/UPDATE ERROR processing accepted deposit ${offer.id} (DepositID: ${depositId}):`, dbErr);
                     io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Contact support.` });
                      if (createdItemIds.length > 0) { // Only if items were attempted to be inserted
                          console.warn(`Attempting to delete orphaned items for deposit ${depositId} due to error: ${dbErr.message}`);
                          await Item.deleteMany({ _id: { $in: createdItemIds } });
                      }
                      if (currentRound) {
                          await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } }).catch(e => console.error("Failed to set round status to error:", e));
                          io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error.' });
                      }
                 }
            } else if (offer.itemsToGive && offer.itemsToGive.length > 0 && (!offer.itemsToReceive || offer.itemsToReceive.length === 0)) {
                 console.log(`Payout offer #${offer.id} accepted by recipient ${offer.partner.getSteamID64()}.`);
                  User.findOne({ steamId: offer.partner.getSteamID64() }).lean().then(user => {
                      if (user) io.emit('notification', { type: 'success', userId: user._id.toString(), message: `Winnings from offer #${offer.id} received!` });
                  }).catch(e => console.error("Error finding user for payout accepted notification:", e));
            } else {
                   console.warn(`Offer #${offer.id} accepted, but not recognized as pending deposit or winnings. Message: "${offer.message}"`);
            }
        } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired, TradeOfferManager.ETradeOfferState.InvalidItems, TradeOfferManager.ETradeOfferState.Countered].includes(offer.state)) {
             console.warn(`Bot Offer #${offer.id} to ${offer.partner.getSteamID64()} ended unsuccessfully. State: ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
             const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
             const depositId = messageMatch ? messageMatch[1] : null;
             if (depositId && pendingDeposits.has(depositId)) {
                 const depositData = pendingDeposits.get(depositId);
                 console.warn(`Deposit offer ${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId} was ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                 pendingDeposits.delete(depositId);
                 User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                      .then(updateRes => {
                           if(updateRes.modifiedCount > 0) console.log(`Cleared pending flag for user ${depositData.steamId} due to offer failure.`);
                      })
                      .catch(e => console.error("Error clearing user flag on deposit failure:", e));
                  const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase();
                 io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Your deposit offer (#${offer.id}) was ${stateMessage}.` });
             } else if (offer.itemsToGive && offer.itemsToGive.length > 0) {
                  console.warn(`Payout offer #${offer.id} failed. State: ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                  User.findOne({ steamId: offer.partner.getSteamID64() }).lean().then(user => {
                      if (user) {
                           const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase();
                           io.emit('notification', { type: 'error', userId: user._id.toString(), message: `Failed to deliver winnings (Offer #${offer.id}). Offer ${stateMessage}. Contact support.` });
                      }
                  }).catch(e => console.error("Error finding user for payout fail notification:", e));
              }
        }
    });
}

// --- Round Info API Routes ---
function formatRoundForClient(round) {
    if (!round) return null;
    const timeLeft = (round.status === 'active' && round.endTime)
        ? Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000))
        : (round.status === 'pending' ? ROUND_DURATION : 0);
    const participantsFormatted = (round.participants || []).map(p => ({
        user: p.user ? { id: p.user._id, steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar } : null,
        itemsValue: p.itemsValue || 0, tickets: p.tickets || 0
    })).filter(p => p.user);
    const itemsFormatted = (round.items || []).map(i => ({
        assetId: i.assetId, name: i.name, image: i.image, price: i.price || 0, owner: i.owner
    }));
    let winnerDetails = null;
    if (round.winner && round.winner.steamId) { // Ensure winner object is populated
        winnerDetails = {
            id: round.winner._id,
            steamId: round.winner.steamId,
            username: round.winner.username,
            avatar: round.winner.avatar
        };
    } else if (round.winner) { // Fallback if winner is just an ID (should not happen with proper populate)
         console.warn("Winner field was not fully populated in formatRoundForClient for round:", round.roundId);
         winnerDetails = { id: round.winner.toString() }; // Send ID at least
    }
    return {
        roundId: round.roundId, status: round.status, startTime: round.startTime, endTime: round.endTime,
        timeLeft: timeLeft, totalValue: round.totalValue || 0, serverSeedHash: round.serverSeedHash,
        participants: participantsFormatted, items: itemsFormatted,
        winner: winnerDetails,
        winningTicket: round.status === 'completed' ? round.winningTicket : undefined,
        serverSeed: round.status === 'completed' ? round.serverSeed : undefined,
        clientSeed: round.status === 'completed' ? round.clientSeed : undefined,
        provableHash: round.status === 'completed' ? round.provableHash : undefined,
        taxAmount: round.taxAmount
    };
}

app.get('/api/round/current', async (req, res) => {
    let roundToFormat = null;
    try {
        if (currentRound?._id) {
            roundToFormat = await Round.findById(currentRound._id)
                 .populate('participants.user', 'steamId username avatar')
                 .populate('items').populate('winner', 'steamId username avatar').lean();
            if (!roundToFormat) currentRound = null; else currentRound = roundToFormat;
        }
        if (!roundToFormat) {
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                 .sort({ startTime: -1 })
                 .populate('participants.user', 'steamId username avatar')
                 .populate('items').populate('winner', 'steamId username avatar').lean();
            if (roundToFormat && !currentRound) {
                 currentRound = roundToFormat;
                 console.log(`Restored active/pending round ${currentRound.roundId} from DB via API.`);
                 if (currentRound.status === 'active' && currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) startRoundTimer(true);
                 else if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) startRoundTimer(false);
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
        const [rounds, totalCount] = await Promise.all([
            Round.find(queryFilter).sort('-roundId').skip(skip).limit(limit)
                 .populate('winner', 'username avatar steamId')
                 .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount taxedItems')
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
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 })
    ],
    handleValidationErrors, async (req, res) => {
    const { roundId, serverSeed, clientSeed } = req.body;
    try {
        const round = await Round.findOne({ roundId: roundId, status: 'completed' })
             .populate('participants.user', 'username').populate('winner', 'username').lean();
        if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found.` });
        const providedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
        if (providedHash !== round.serverSeedHash) return res.json({ verified: false, reason: 'Server Seed Hash mismatch.', expectedHash: round.serverSeedHash, providedSeed: serverSeed, calculatedHash: providedHash });
        if (round.serverSeed && round.clientSeed && (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed)) {
            return res.json({ verified: false, reason: 'Provided seeds do not match official round seeds.', expectedServerSeed: round.serverSeed, expectedClientSeed: round.clientSeed, providedServerSeed: serverSeed, providedClientSeed: clientSeed });
        }
        const combinedString = serverSeed + clientSeed;
        const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        if (round.provableHash && calculatedProvableHash !== round.provableHash) return res.json({ verified: false, reason: 'Calculated Provable Hash mismatch.', expectedProvableHash: round.provableHash, calculatedProvableHash, combinedString });
        const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
        const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;
        if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets.' });
        const calculatedWinningTicket = decimalFromHash % totalTickets;
        if (calculatedWinningTicket !== round.winningTicket) return res.json({ verified: false, reason: 'Calculated winning ticket mismatch.', calculatedTicket: calculatedWinningTicket, actualWinningTicket: round.winningTicket, provableHashUsed: calculatedProvableHash, totalTickets });
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

// --- Socket.io Connection Handling ---
io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.initialize()(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.session()(socket.request, socket.request.res || {}, next); });

let connectedChatUsers = 0; // For chat user count

io.on('connection', (socket) => {
    connectedChatUsers++;
    io.emit('updateUserCount', connectedChatUsers);
    if (socket.request.user && socket.request.user.username) {
        console.log(`User ${socket.request.user.username} (Socket ID: ${socket.id}) connected to chat.`);
    } else {
        console.log(`Anonymous client (Socket ID: ${socket.id}) connected to chat.`);
    }

    socket.on('requestRoundData', async () => {
        try {
            let roundToSend = null;
             if (currentRound?._id) {
                 roundToSend = await Round.findById(currentRound._id)
                       .populate('participants.user', 'steamId username avatar')
                       .populate('items').populate('winner', 'steamId username avatar').lean();
                 if (!roundToSend) currentRound = null; else currentRound = roundToSend;
             }
             if (!roundToSend) {
                 roundToSend = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                       .sort({ startTime: -1 })
                       .populate('participants.user', 'steamId username avatar')
                       .populate('items').populate('winner', 'steamId username avatar').lean();
                 if (roundToSend && !currentRound) {
                      currentRound = roundToSend;
                      console.log(`Restored active/pending round ${currentRound.roundId} from DB on client socket request.`);
                      if (currentRound.status === 'active' && currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) startRoundTimer(true);
                      else if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) startRoundTimer(false);
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

    socket.on('chatMessage', (msg) => {
        let userName = 'Anonymous';
        let userAvatar = '/img/default-avatar.png';
        let userId = socket.id;
        let userSteamId = null;

        if (socket.request.user && socket.request.user.username) {
            userName = socket.request.user.username;
            userAvatar = socket.request.user.avatar || '/img/default-avatar.png';
            userId = socket.request.user._id || socket.request.user.id;
            userSteamId = socket.request.user.steamId;
        } else {
            console.warn(`Chat message from unauthenticated socket ${socket.id}.`);
            socket.emit('notification', {type: 'error', message: 'You must be logged in to chat.'});
            return;
        }
        if (typeof msg !== 'string' || msg.trim().length === 0 || msg.trim().length > MAX_CHAT_MESSAGE_LENGTH) {
            socket.emit('notification', {type: 'error', message: 'Invalid message. Max 200 chars.'});
            return;
        }
        const messageData = {
            username: userName, avatar: userAvatar, message: msg.trim(),
            userId: userId, userSteamId: userSteamId, timestamp: new Date()
        };
        io.emit('chatMessage', messageData);
        console.log(`Chat (User: ${userName}, ID: ${userId}): ${msg.trim()}`);
    });

    socket.on('disconnect', (reason) => {
        connectedChatUsers--;
        io.emit('updateUserCount', connectedChatUsers);
         if (socket.request.user && socket.request.user.username) {
            console.log(`User ${socket.request.user.username} (Socket ID: ${socket.id}) disconnected from chat. Reason: ${reason}`);
        } else {
            console.log(`Anonymous client (Socket ID: ${socket.id}) disconnected from chat. Reason: ${reason}`);
        }
    });
});

// --- Server Startup ---
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
    io.close();
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
            console.error("Error during shutdown:", e);
            process.exit(1);
        }
    });
    setTimeout(() => {
        console.error('Could not close connections gracefully, forcing shutdown.');
        process.exit(1);
    }, 10000);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.');
    if (res.headersSent) return next(err);
    res.status(status).json({ error: message });
});

console.log("app.js updated with chat backend logic.");
