// app.js - Segment 1 of 3

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
const MongoStore = require('connect-mongo'); // Ensure 'npm install connect-mongo'

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
const MAX_CHAT_MESSAGE_LENGTH = 200; // ADDED: For chat

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
                        // Ensure ws and wss protocols for socket.io are allowed for the correct hostname and port
                        sources.push(`ws://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(`wss://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(siteUrl); // Allow HTTP/HTTPS connections to the site URL itself
                    } catch (e) {
                        console.error("Invalid SITE_URL for CSP connect-src:", siteUrl, e);
                    }
                }
                sources.push("https://rust.scmm.app"); // For price fetching
                return sources;
            })(),
             "frame-src": ["'self'", "https://steamcommunity.com"],
             "frame-ancestors": ["'self'", "https://steamcommunity.com"], // If you embed Steam content
            "object-src": ["'none'"],
            "upgrade-insecure-requests": [],
        },
    })
);


const generalApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many login attempts from this IP, please try again after 10 minutes', standardHeaders: true, legacyHeaders: false });
const sensitiveActionLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, message: 'Too many requests for this action, please try again after 5 minutes', standardHeaders: true, legacyHeaders: false });
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 10, message: 'Too many deposit attempts, please wait a minute.', standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: 'Too many chat messages. Please wait a moment.', standardHeaders: true, legacyHeaders: false }); // ADDED: Chat limiter

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
        autoRemove: 'native' // Default
    }),
    cookie: {
        maxAge: 3600000 * 24, // 24 hours session cookie
        secure: process.env.NODE_ENV === 'production', // True if HTTPS
        httpOnly: true,
        sameSite: 'lax' // Or 'strict' or 'none' (if cross-site with secure:true)
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
    providerURL: 'https://steamcommunity.com/openid' // Explicitly set OpenID provider URL
},
    async (identifier, profile, done) => {
        try {
            // Extract necessary fields, ensuring robust handling for potentially missing ones
            const userData = {
                username: profile.displayName || `User${profile.id.substring(profile.id.length - 5)}`, // Fallback username
                avatar: profile._json.avatarfull || profile._json.avatar || '/img/default-avatar.png', // Fallback avatar
            };

            const user = await User.findOneAndUpdate(
                { steamId: profile.id },
                {
                    $set: userData,
                    $setOnInsert: { // These fields are only set if a new user is created
                        steamId: profile.id,
                        tradeUrl: '', // Initialize tradeUrl as empty
                        createdAt: new Date(),
                        pendingDepositOfferId: null,
                        totalDepositedValue: 0, // Initialize new stats fields
                        totalWinningsValue: 0
                    }
                },
                { new: true, upsert: true, runValidators: true } // Options: return modified doc, create if not exists, run schema validators
            );
            return done(null, user);
        } catch (err) {
            console.error('Steam Strategy Error:', err);
            return done(err);
        }
    }
));

passport.serializeUser((user, done) => {
    done(null, user.id); // Using MongoDB's default _id for session storage
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user); // User object will be attached to req.user
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
        process.exit(1); // Exit if cannot connect to DB
    });

// --- MongoDB Schemas ---
const userSchema = new mongoose.Schema({
    steamId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    avatar: { type: String }, // URL to Steam avatar
    tradeUrl: {
        type: String,
        default: '',
        // Basic regex, consider more robust validation if needed
        match: [/^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/, 'Invalid Steam Trade URL format']
    },
    createdAt: { type: Date, default: Date.now },
    banned: { type: Boolean, default: false },
    pendingDepositOfferId: { type: String, default: null, index: true }, // Store active deposit offer ID
    totalDepositedValue: { type: Number, default: 0, min: 0 }, // New field
    totalWinningsValue: { type: Number, default: 0, min: 0 }  // New field
});

const itemSchema = new mongoose.Schema({
    assetId: { type: String, required: true, index: true }, // Steam asset ID
    name: { type: String, required: true }, // Skin name, used for pricing etc.
    image: { type: String, required: true }, // URL to item image
    price: { type: Number, required: true, min: 0 },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true, index: true },
    depositedAt: { type: Date, default: Date.now }
});

const roundSchema = new mongoose.Schema({
    roundId: { type: Number, required: true, unique: true, index: true }, // Sequential round number
    status: { type: String, enum: ['pending', 'active', 'rolling', 'completed', 'error'], default: 'pending', index: true },
    startTime: { type: Date },
    endTime: { type: Date }, // When the timer actually ends or rolling starts
    completedTime: { type: Date }, // When winner is fully processed
    totalValue: { type: Number, default: 0, min: 0 },
    items: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }],
    participants: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        itemsValue: { type: Number, required: true, default: 0, min: 0 },
        tickets: { type: Number, required: true, default: 0, min: 0 } // Number of tickets based on value
    }],
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    winningTicket: { type: Number, min: 0 },
    serverSeed: { type: String, required: true, match: /^[a-f0-9]{64}$/ }, // SHA256
    serverSeedHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ }, // SHA256 hash of serverSeed
    clientSeed: { type: String, match: /^[a-f0-9]+$/ }, // Can be user-provided or generated
    provableHash: { type: String, match: /^[a-f0-9]{64}$/ }, // SHA256 of (serverSeed + clientSeed)
    taxAmount: { type: Number, default: 0, min: 0 },
    taxedItems: [{ assetId: String, name: String, price: { type: Number, min: 0 } }] // Store details of taxed items
});
roundSchema.index({ 'participants.user': 1 }); // Index for faster participant queries

const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);


// --- Steam Bot Setup ---
const community = new SteamCommunity();
const manager = new TradeOfferManager({
    steam: community, // Use the community instance
    domain: process.env.SITE_URL ? process.env.SITE_URL.replace(/^https?:\/\//, '') : 'localhost', // Your site's domain name
    language: 'en', // Language for trade offers
    pollInterval: 10000, // Poll for new offers every 10 seconds
    cancelTime: 10 * 60 * 1000, // Automatically cancel offers not accepted in 10 minutes
});
let isBotReady = false;
const pendingDeposits = new Map(); // Tracks deposit offers initiated by the site

// Function to generate 2FA code for bot login
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
                // More detailed error logging
                console.error('STEAM LOGIN ERROR (Callback Err Object):', { message: err.message, eresult: err.eresult, emaildomain: err.emaildomain });
            } else {
                console.log('Steam community.login callback received (no immediate error object reported).');
            }

            // Check if login was truly successful (community.steamID will be set)
            if (err || !community.steamID) {
                console.error(`CRITICAL LOGIN FAILURE: Login callback failed or community.steamID is undefined. Error: ${err ? err.message : 'N/A'}, SteamID: ${community.steamID}, EResult: ${err?.eresult}`);
                isBotReady = false;
                // Provide hints based on EResult
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
                community.setCookies(cookies); // Also set cookies for the community instance
                isBotReady = true;
                console.log("Steam Bot is ready and operational.");
                ensureInitialRound(); // Ensure a round exists after bot is ready
            });

            // Auto-accept friend requests
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
let isRolling = false; // Flag to prevent actions during winner selection

// Price caching
const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false });

// Fallback price function (can be more sophisticated)
function getFallbackPrice(marketHashName) {
    // For now, just return a minimal value or 0 if MIN_ITEM_VALUE is not set positively
    return MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0;
}


// Function to refresh the price cache from external API
async function refreshPriceCache() {
    console.log("PRICE_INFO: Attempting to refresh price cache from rust.scmm.app...");
    const apiUrl = `https://rust.scmm.app/api/item/prices?currency=USD`; // Assuming USD prices
    try {
        const response = await axios.get(apiUrl, { timeout: PRICE_FETCH_TIMEOUT_MS });
        if (response.data && Array.isArray(response.data)) {
            const items = response.data;
            let updatedCount = 0;
            let newItems = []; // For bulk update

            items.forEach(item => {
                // Validate item structure and price
                if (item?.name && typeof item.price === 'number' && item.price >= 0) {
                    const priceInDollars = item.price / 100.0; // Convert cents to dollars
                    newItems.push({ key: item.name, val: priceInDollars });
                    updatedCount++;
                }
            });

            if (newItems.length > 0) {
                const success = priceCache.mset(newItems); // Bulk set items
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
            // Log status and data if available from error response
            console.error(` -> Status: ${error.response.status}, Response:`, error.response.data || error.message);
        } else if (error.request) {
            // Request was made but no response received
            console.error(` -> Error: No response received (Network issue?).`, error.message);
        } else {
            // Something happened in setting up the request that triggered an Error
            console.error(' -> Error setting up request:', error.message);
        }
    }
}


// Function to get item price, falling back if not cached
function getItemPrice(marketHashName) {
    if (typeof marketHashName !== 'string' || marketHashName.length === 0) {
        console.warn("getItemPrice called with invalid marketHashName:", marketHashName);
        return 0; // Return 0 for invalid names
    }
    const cachedPrice = priceCache.get(marketHashName);
    return (cachedPrice !== undefined) ? cachedPrice : getFallbackPrice(marketHashName);
}

// app.js - Segment 2 of 3

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
        isRolling = false; // Ensure rolling is false when starting a new round
        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');

        const lastRound = await Round.findOne().sort('-roundId');
        const nextRoundId = lastRound ? lastRound.roundId + 1 : 1;

        const newRound = new Round({
            roundId: nextRoundId,
            status: 'active', // Start as active
            startTime: new Date(),
            serverSeed: serverSeed,
            serverSeedHash: serverSeedHash,
            items: [],
            participants: [],
            totalValue: 0
            // endTime will be set when the first player joins or timer starts
        });
        await newRound.save();
        currentRound = newRound.toObject(); // Use plain object for currentRound in memory

        // Emit roundCreated event to all clients
        io.emit('roundCreated', {
            roundId: newRound.roundId,
            serverSeedHash: newRound.serverSeedHash,
            timeLeft: ROUND_DURATION, // Initial time, will be updated
            totalValue: 0,
            participants: [],
            items: []
        });
        console.log(`--- Round ${newRound.roundId} created and active ---`);
        return newRound.toObject();
    } catch (err) {
        console.error('FATAL: Error creating new round:', err);
        // Consider a more robust retry or notification mechanism
        setTimeout(createNewRound, 10000); // Retry after 10 seconds
        return null;
    }
}

async function ensureInitialRound() {
    if (isBotConfigured && isBotReady) { // Only if bot is configured and ready
        if (!currentRound) {
            try {
                // Look for an existing active or pending round
                const existingActive = await Round.findOne({ status: 'active' })
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items') // Populate items for the round
                    .lean(); // Use lean for performance if only reading

                if (existingActive) {
                    console.log(`Found existing active round ${existingActive.roundId} on startup.`);
                    currentRound = existingActive;
                    // If round has participants and an end time in the future, resume timer
                    if (currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        startRoundTimer(true); // Pass true to use remaining time
                    } else if (currentRound.participants.length > 0 && !currentRound.endTime && !roundTimer) {
                        // If active round has participants but no end time (e.g., server restart after first deposit but before timer start)
                        console.warn(`Active round ${currentRound.roundId} found without endTime. Starting timer now.`);
                        startRoundTimer(false); // Start a new timer
                    }
                    // If round is active but no participants, it will wait for the first deposit
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
        // Resuming timer: calculate remaining time from existing endTime
        calculatedEndTime = new Date(currentRound.endTime);
        timeLeft = Math.max(0, Math.floor((calculatedEndTime.getTime() - Date.now()) / 1000));
        console.log(`Resuming timer for round ${currentRound.roundId} with ${timeLeft}s remaining.`);
    } else {
        // Starting new timer: set endTime based on ROUND_DURATION
        timeLeft = ROUND_DURATION;
        calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
        currentRound.endTime = calculatedEndTime; // Update in-memory round
        // Update endTime in DB
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
            .catch(e => console.error(`Error saving round end time for round ${currentRound?.roundId}:`, e));
        console.log(`Starting timer for round ${currentRound.roundId} (${ROUND_DURATION}s). End time: ${calculatedEndTime.toISOString()}`);
    }

    io.emit('timerUpdate', { timeLeft }); // Initial emit

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
            clearInterval(roundTimer);
            roundTimer = null;
            console.log(`Round ${currentRound.roundId} timer reached zero.`);
            await endRound(); // Proceed to end the round
        }
    }, 1000);
}


async function endRound() {
    if (!currentRound || isRolling || currentRound.status !== 'active') {
        console.warn(`Attempted to end round ${currentRound?.roundId}, but state is invalid (Status: ${currentRound?.status}, Rolling: ${isRolling})`);
        return;
    }

    isRolling = true;
    const roundIdToEnd = currentRound.roundId; // Capture before potential async changes
    const roundMongoId = currentRound._id; // Capture MongoDB _id

    console.log(`--- Ending round ${roundIdToEnd}... ---`);

    try {
        // Update round status to 'rolling'
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } });
        io.emit('roundRolling', { roundId: roundIdToEnd });

        // Fetch the most up-to-date round data, populating necessary fields
        const round = await Round.findById(roundMongoId)
            .populate('participants.user') // Populate user details for participants
            .populate('items')             // Populate item details for items in the pot
            .lean();                       // Use .lean() for plain JS objects

        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);

        // Safety check: if status somehow changed from 'rolling' by another process
        if (round.status !== 'rolling') {
             console.warn(`Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Aborting endRound.`);
             isRolling = false; return;
        }

        currentRound = round; // Update in-memory currentRound

        // Handle case with no participants or no value
        if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            console.log(`Round ${round.roundId} ended with no valid participants or value.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date() } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants." });
            isRolling = false;
            setTimeout(createNewRound, 5000); // Schedule next round
            return;
        }

        // --- Tax Calculation ---
        let finalItems = [...round.items]; // Items to be potentially won
        let finalTotalValue = round.totalValue; // Pot value to be potentially won
        let taxAmount = 0;
        let taxedItemsInfo = []; // Store {assetId, name, price} of taxed items
        let itemsToTakeForTaxIds = []; // Store MongoDB _ids of items taken for tax

        if (finalTotalValue >= MIN_POT_FOR_TAX) {
            const targetTaxValue = finalTotalValue * (TAX_MIN_PERCENT / 100);
            const maxTaxValue = finalTotalValue * (TAX_MAX_PERCENT / 100);
            // Sort items by price (ascending) to pick smallest suitable items for tax
            const sortedItems = [...finalItems].sort((a, b) => a.price - b.price);
            let currentTaxValue = 0;

            for (const item of sortedItems) {
                if (currentTaxValue + item.price <= maxTaxValue) { // Don't exceed max tax
                    itemsToTakeForTaxIds.push(item._id.toString()); // Store MongoDB ID
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price });
                    currentTaxValue += item.price;
                    if (currentTaxValue >= targetTaxValue) break; // Stop if target tax is met or exceeded
                } else break; // Next item would exceed max tax
            }

            if (itemsToTakeForTaxIds.length > 0) {
                const taxedItemsIdsSet = new Set(itemsToTakeForTaxIds);
                // Filter out taxed items from the final list of items to be won
                finalItems = finalItems.filter(item => !taxedItemsIdsSet.has(item._id.toString()));
                taxAmount = currentTaxValue;
                finalTotalValue -= taxAmount; // Adjust final pot value
                console.log(`Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${itemsToTakeForTaxIds.length} items). New Pot Value: $${finalTotalValue.toFixed(2)}`);
            }
        }
        // --- End Tax Calculation ---

        // Provably Fair Calculation
        const clientSeed = crypto.randomBytes(16).toString('hex'); // Generate client seed
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');

        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16); // Use first 8 hex chars
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);

        if (totalTickets <= 0) throw new Error(`Cannot determine winner: Total tickets is zero or invalid for round ${round.roundId}.`);

        const winningTicket = decimalFromHash % totalTickets;

        let cumulativeTickets = 0;
        let winnerInfo = null; // Will store the populated user object of the winner

        for (const participant of round.participants) {
            if (!participant?.tickets || !participant.user) continue; // Skip if no tickets or user data
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winnerInfo = participant.user; // This is the populated user object
                break;
            }
        }

        if (!winnerInfo || !winnerInfo._id) throw new Error(`Winner selection failed for round ${round.roundId}. Winning Ticket: ${winningTicket}, Total Tickets: ${totalTickets}`);

        // --- Update Winner's Stats ---
        try {
            const updatedWinnerUser = await User.findByIdAndUpdate(
                winnerInfo._id,
                { $inc: { totalWinningsValue: finalTotalValue } }, // Increment totalWinningsValue
                { new: true } // Option to return the updated document
            );
            if (updatedWinnerUser) {
                console.log(`Updated winnings stats for ${updatedWinnerUser.username}: New total winnings $${updatedWinnerUser.totalWinningsValue.toFixed(2)}`);
            } else {
                console.warn(`Could not find user ${winnerInfo.username} to update winnings stats.`);
            }
        } catch (statError) {
            console.error(`Error updating winnings stats for user ${winnerInfo.username}:`, statError);
            // Non-fatal, continue with round completion
        }
        // --- End Update Winner's Stats ---

        const finalUpdateData = {
            status: 'completed', completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winnerInfo._id, // Store winner's MongoDB ID
            taxAmount: taxAmount, taxedItems: taxedItemsInfo, totalValue: finalTotalValue, // Updated total value after tax
            items: finalItems.map(i => i._id) // Store IDs of items actually won (after tax)
        };

        await Round.updateOne({ _id: roundMongoId }, { $set: finalUpdateData });
        console.log(`Round ${round.roundId} completed. Winner: ${winnerInfo.username} (Ticket: ${winningTicket}/${totalTickets}, Value: $${finalTotalValue.toFixed(2)})`);

        // Emit winner information to clients
        io.emit('roundWinner', {
            roundId: round.roundId,
            winner: { id: winnerInfo._id, steamId: winnerInfo.steamId, username: winnerInfo.username, avatar: winnerInfo.avatar },
            winningTicket: winningTicket, totalValue: finalTotalValue, totalTickets: totalTickets,
            serverSeed: round.serverSeed, clientSeed: clientSeed, provableHash: provableHash, serverSeedHash: round.serverSeedHash
        });

        // Send winning items if bot is ready and configured
        await sendWinningTradeOffer(round, winnerInfo, finalItems); // Pass the populated winner user object and final items

    } catch (err) {
        console.error(`CRITICAL ERROR during endRound for round ${roundIdToEnd}:`, err);
        try {
            // Mark round as 'error' in DB if something went wrong
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error' } });
            io.emit('roundError', { roundId: roundIdToEnd, error: 'Internal server error during round finalization.' });
        } catch (saveErr) {
            console.error(`Failed to mark round ${roundIdToEnd} as error after initial error:`, saveErr);
        }
    } finally {
        isRolling = false; // Reset rolling flag
        console.log(`Scheduling next round creation after round ${roundIdToEnd} finalization.`);
        setTimeout(createNewRound, 10000); // Schedule next round creation
    }
}

async function sendWinningTradeOffer(round, winner, itemsToSend) {
    if (!isBotReady) {
        console.error(`PAYOUT_ERROR: Cannot send winnings for round ${round.roundId}: Steam Bot is not ready.`);
        // Notify user about manual processing
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
        // If only tax was applied and no items left for winner
        if (round.taxAmount > 0 && round.totalValue <= 0) { // totalValue here is after-tax value
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
        offer.setMessage(`Congratulations! Your winnings from Round #${round.roundId} on ${process.env.SITE_NAME || 'RustyDegen'}. Pot Value (after tax): $${round.totalValue.toFixed(2)}`); // Use after-tax value

        const identitySecret = process.env.STEAM_IDENTITY_SECRET; // For auto-confirming trades, if set

        // Send offer. If identitySecret is provided, it attempts to auto-confirm.
        offer.send(!!identitySecret, (err, status) => {
            if (err) {
                // Handle various trade offer errors
                if (err.message.includes('revoked') || err.message.includes('invalid') || err.eresult === 26) {
                    console.error(`PAYOUT_ERROR: Trade offer failed for round ${round.roundId}: Invalid Trade URL/Token for ${winner.username}. Offer ID: ${offer.id}`);
                    io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Your Trade URL is invalid or expired. Please update it to receive winnings.' });
                } else if (err.eresult === 15 || err.eresult === 16) { // Access denied or inventory full/private
                    console.error(`PAYOUT_ERROR: Trade offer failed for round ${round.roundId}: Winner's inventory might be full or private. Offer ID: ${offer.id}`);
                    io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Could not send winnings. Ensure your Steam inventory is public and not full.' });
                } else if (err.message?.includes('escrow') || err.eresult === 11) { // EResult 11 often indicates items are not tradable soon (escrow)
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
            io.emit('tradeOfferSent', { // Inform client about the offer
                roundId: round.roundId, userId: winner._id.toString(), username: winner.username,
                offerId: offer.id, offerURL: offerURL, status: status
            });

             if (status === 'pending' || status === 'pendingConfirmation') { // Older manager versions might use 'pending' for needs confirmation
                 console.log(`Offer #${offer.id} requires confirmation (Status: ${status}). Check mobile authenticator if auto-confirmation is not setup or failed.`);
                 if (!identitySecret) {
                     console.warn(`Offer #${offer.id} requires confirmation, but STEAM_IDENTITY_SECRET is not provided for auto-confirmation.`);
                     io.emit('notification', { type: 'info', userId: winner._id.toString(), message: `Winnings sent (Offer #${offer.id}), but require confirmation in Steam.` });
                 } else {
                     // If identity secret was provided but confirmation still needed, it might have failed
                     io.emit('notification', { type: 'warning', userId: winner._id.toString(), message: `Winnings sent (Offer #${offer.id}), but confirmation may be needed in Steam.` });
                 }
             }
        });
    } catch (err) { // Catch errors from createOffer itself
        console.error(`PAYOUT_ERROR: Unexpected error creating/sending trade offer for round ${round.roundId}:`, err);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Error sending winnings for round ${round.roundId}. Please contact support.` });
    }
}

// --- Authentication Routes ---
app.get('/auth/steam', authLimiter, passport.authenticate('steam', { failureRedirect: '/' }));

app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }), // Handle failure redirect
    (req, res) => {
        // Successful authentication, redirect home.
        res.redirect('/');
    }
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
// 

// app.js - Segment 3 of 3

// --- Middleware & API Routes ---
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) { // isAuthenticated() is provided by Passport
        return next();
    }
    res.status(401).json({ error: 'Not authenticated' });
}

// Middleware for handling validation results
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        // Log validation errors for debugging
        console.warn("Validation Errors:", errors.array());
        // Return the first error message to the client
        return res.status(400).json({ error: errors.array()[0].msg });
    }
    next();
};


// Get current user details
app.get('/api/user', ensureAuthenticated, (req, res) => {
    // Send relevant user data, excluding sensitive info like password hashes (if any)
    const { _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue });
});

// Update user's trade URL
app.post('/api/user/tradeurl',
    sensitiveActionLimiter, // Apply rate limiting
    ensureAuthenticated,
    [ // Validation middleware
        body('tradeUrl').trim().custom((value) => {
            // Allow empty string to clear the trade URL
            if (value === '') return true;
            // Validate format if not empty
            const urlPattern = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/;
            if (!urlPattern.test(value)) {
                throw new Error('Invalid Steam Trade URL format. Must include partner and token, or be empty.');
            }
            return true;
        })
    ],
    handleValidationErrors, // Process validation results
    async (req, res) => {
        const { tradeUrl } = req.body;
        try {
            const updatedUser = await User.findByIdAndUpdate(req.user._id, { tradeUrl: tradeUrl }, { new: true, runValidators: true });
            if (!updatedUser) return res.status(404).json({ error: 'User not found.' });

            console.log(`Trade URL updated for user: ${updatedUser.username}`);
            res.json({ success: true, tradeUrl: updatedUser.tradeUrl });
        } catch (err) {
            // Handle Mongoose validation errors specifically
            if (err.name === 'ValidationError') {
                 console.error(`Trade URL Validation Error (Mongoose) for user ${req.user._id}:`, err.message);
                 return res.status(400).json({ error: err.message }); // Send Mongoose validation error message
            }
            console.error(`Error updating trade URL for user ${req.user._id}:`, err);
            res.status(500).json({ error: 'Server error saving Trade URL.' });
        }
    }
);


// Get user's Rust inventory from Steam
app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    if (!isBotReady) { // Check if bot is operational
        console.warn(`Inventory fetch failed for ${req.user.username}: Bot service is unavailable.`);
        return res.status(503).json({ error: "Steam service temporarily unavailable. Please try again later." });
    }
    try {
        const inventory = await new Promise((resolve, reject) => {
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                if (err) {
                    if (err.message?.includes('profile is private') || err.eresult === 15) { // EResult 15 for private inventory
                        return reject(new Error('Your Steam inventory is private. Please set it to public.'));
                    }
                    // Log other Steam errors
                    console.error(`Inventory Fetch Error (Manager): User ${req.user.steamId}: EResult ${err.eresult} - ${err.message || err}`);
                    return reject(new Error(`Could not fetch inventory. Steam might be busy or inventory private.`));
                }
                resolve(inv || []); // Resolve with empty array if inv is null/undefined
            });
        });

        if (!inventory?.length) return res.json([]); // Return empty if no items

        // Map inventory items to desired format and get prices
        const validItems = inventory.map(item => {
                const itemName = item.market_hash_name; // Name is kept for price fetching
                let price = 0;
                if (itemName) price = getItemPrice(itemName);
                else console.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`);

                // Ensure price is a valid number, default to 0 if not
                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

                if (!item.assetid || !item.icon_url || !itemName) {
                    // Log items with missing critical properties but don't stop processing others
                    console.warn(`Inventory item missing required properties: assetId ${item?.assetid}, Name ${itemName}, Icon ${item?.icon_url}`);
                    return null; // Will be filtered out
                }
                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`;
                return { assetId: item.assetid, name: itemName, image: imageUrl, price: finalPrice, tradable: item.tradable };
            })
            .filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE); // Filter out nulls, non-tradables, and low-value items

        res.json(validItems);
    } catch (err) {
        console.error(`Error in /api/inventory for ${req.user?.username || req.user?.steamId}:`, err.message);
        res.status(500).json({ error: err.message || 'Server error fetching inventory.' });
    }
});


// POST Initiate Deposit Request
app.post('/api/deposit', depositLimiter, ensureAuthenticated,
    [ // Input validation
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`You can deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items at a time.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.') // Basic check, can be more specific
    ],
    handleValidationErrors,
    async (req, res) => {
        const user = req.user;
        const requestedAssetIds = req.body.assetIds;

        if (!isBotReady) return res.status(503).json({ error: "Deposit service temporarily unavailable (Bot offline)." });
        if (!user.tradeUrl) return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile before depositing.' });

        // Check if user already has a pending deposit offer
        if (user.pendingDepositOfferId) {
             try {
                 const offer = await manager.getOffer(user.pendingDepositOfferId);
                 // Check if the offer is still active/pending on Steam's side
                 if (offer && [TradeOfferManager.ETradeOfferState.Active, TradeOfferManager.ETradeOfferState.Sent, TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation].includes(offer.state)) {
                     console.log(`User ${user.username} already has pending deposit offer ${user.pendingDepositOfferId}. State: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
                     const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                     return res.status(409).json({ error: 'You already have an active deposit offer waiting. Please accept or decline it on Steam.', offerId: user.pendingDepositOfferId, offerURL: offerURL });
                 } else {
                      // Offer is no longer active (e.g., declined, expired, accepted) - clear the flag
                      console.log(`Clearing stale pending offer ${user.pendingDepositOfferId} for user ${user.username} (State: ${TradeOfferManager.ETradeOfferState[offer?.state]}).`);
                      await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
                 }
             } catch (offerFetchError) {
                 // If getOffer fails (e.g., offer doesn't exist), it's safe to clear the flag
                 console.warn(`Could not fetch pending offer ${user.pendingDepositOfferId}, clearing flag:`, offerFetchError.message);
                 await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
             }
        }

        // Check round status and limits
        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }

        let latestRoundData; // To check participant and item limits
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


        // Verify items and calculate total value
        let itemsToRequest = [];
        let depositTotalValue = 0;
        try {
            console.log(`Verifying inventory for ${user.username} (SteamID: ${user.steamId}) to confirm deposit items...`);
            const userInventory = await new Promise((resolve, reject) => { // Fetch fresh inventory
                manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                    if (err) {
                        if (err.message?.includes('profile is private') || err.eresult === 15) return reject(new Error('Your Steam inventory is private.'));
                        console.error(`Inventory Fetch Error (Deposit): User ${user.steamId}: EResult ${err.eresult}`, err);
                        return reject(new Error(`Could not fetch inventory. Ensure it's public.`));
                    }
                    resolve(inv || []);
                });
            });

            const userInventoryMap = new Map(userInventory.map(item => [item.assetid, item])); // Map for quick lookup

            for (const assetId of requestedAssetIds) {
                const inventoryItem = userInventoryMap.get(assetId);
                if (!inventoryItem) throw new Error(`Item Asset ID ${assetId} not in inventory.`);
                if (!inventoryItem.tradable) throw new Error(`Item '${inventoryItem.market_hash_name}' not tradable.`);

                const price = getItemPrice(inventoryItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) throw new Error(`Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below min value ($${MIN_ITEM_VALUE}).`);

                itemsToRequest.push({
                    assetid: inventoryItem.assetid, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID,
                    _price: price, _name: inventoryItem.market_hash_name, // Store price, name, image for later use
                     _image: `https://community.akamai.steamstatic.com/economy/image/${inventoryItem.icon_url}`
                });
                depositTotalValue += price;
            }
             if (itemsToRequest.length === 0) throw new Error("No items could be verified for deposit."); // Should not happen if assetIds were validated
             console.log(`Verified ${itemsToRequest.length} items for deposit for ${user.username}. Total Value: $${depositTotalValue.toFixed(2)}`);
        } catch (verificationError) {
            console.warn(`Deposit item verification failed for ${user.username}:`, verificationError.message);
            return res.status(400).json({ error: verificationError.message });
        }

        // Create and send trade offer
        const depositId = uuidv4(); // Unique ID for this deposit attempt
        const offerMessage = `RustyDegen Deposit ID: ${depositId} | Round: ${currentRound.roundId}`;
        let cleanupTimeout = null;

        try {
            const offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsToRequest.map(({ assetid, appid, contextid }) => ({ assetid, appid, contextid }))); // Items bot will receive
            offer.setMessage(offerMessage);

            // Store pending deposit details temporarily
            pendingDeposits.set(depositId, {
                userId: user._id, roundId: currentRound._id, items: itemsToRequest, // Includes _price, _name, _image
                totalValue: depositTotalValue, steamId: user.steamId
            });
            console.log(`Stored pending deposit ${depositId} for user ${user.steamId}.`);

            // Timeout to clean up pending deposit if not acted upon
            cleanupTimeout = setTimeout(() => {
                 if(pendingDeposits.has(depositId)) {
                     console.log(`Deposit attempt ${depositId} expired.`);
                      pendingDeposits.delete(depositId);
                      // Also clear the user's pendingDepositOfferId if it matches this expired offer
                      User.updateOne({ steamId: user.steamId, pendingDepositOfferId: offer?.id || 'expired' }, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user pending flag on expiry:", e));
                 }
            }, manager.cancelTime || 10 * 60 * 1000); // Use manager's cancelTime or default

            console.log(`Sending deposit offer to ${user.username} (Trade URL: ${user.tradeUrl})...`);
            const status = await new Promise((resolve, reject) => { // Promisify offer.send
                offer.send((err, status) => { if (err) return reject(err); resolve(status); });
            });

            // Update user's pendingDepositOfferId *after* successfully sending
            try {
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: offer.id });
                console.log(`Set pendingDepositOfferId=${offer.id} for user ${user.username}.`);
            } catch (dbUpdateError) {
                 // This is critical - offer sent but DB not updated. Log and attempt to recover or notify.
                 console.error(`CRITICAL: Failed to set pendingDepositOfferId for user ${user.username} after sending offer ${offer.id}.`, dbUpdateError);
                  pendingDeposits.delete(depositId); // Clean up pending deposit
                  if (cleanupTimeout) clearTimeout(cleanupTimeout);
                  // Potentially try to cancel the offer on Steam side if possible, or notify admin
                  return res.status(500).json({ error: 'Failed to finalize deposit request state. Contact support.' });
            }

            console.log(`Deposit offer ${offer.id} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;
            res.json({ success: true, message: 'Deposit offer created! Accept on Steam.', offerId: offer.id, offerURL: offerURL });

        } catch (error) { // Catch errors from createOffer or offer.send
            console.error(`Error sending deposit offer for ${user.username} (DepositID: ${depositId}): EResult ${error.eresult}`, error.message);
            pendingDeposits.delete(depositId); // Clean up
            if (cleanupTimeout) clearTimeout(cleanupTimeout);
            // Ensure user's pending flag is cleared if it was set prematurely or in a failed attempt
            await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user flag on offer fail:", e));

            let userMessage = 'Failed to create deposit trade offer. Try again later.';
            if (error.message.includes('unable to trade') && error.message.includes('reset your Steam account')) userMessage = `Steam Error: Account has temporary trade restriction. (${error.message})`;
            else if (error.message.includes('Trade URL') || error.message.includes('token') || error.eresult === 26) userMessage = 'Your Steam Trade URL might be invalid/expired. Check profile.';
            else if (error.eresult) userMessage += ` (Code: ${error.eresult})`; // Append EResult if available
            res.status(500).json({ error: userMessage });
        }
    }
);


// --- Trade Offer Manager Event Handling ---
if (isBotConfigured && manager) { // Ensure manager is initialized
    manager.on('newOffer', async (offer) => { // Incoming offers TO bot
        // Ignore if bot is not ready or if it's an offer the bot itself sent
        if (!isBotReady || offer.isOurOffer) return;

        // Automatically decline unsolicited offers (donations, wrong items, etc.)
        // This simple check declines any offer where bot receives items and gives nothing,
        // unless it's identified as a site-initiated deposit (which shouldn't happen via 'newOffer')
        if (offer.itemsToReceive && offer.itemsToReceive.length > 0 && (!offer.itemsToGive || offer.itemsToGive.length === 0)) {
             // Check if it's a manual deposit attempt (should be rare if users use the site UI)
             if (offer.message && offer.message.includes('RustyDegen Deposit ID:')) {
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like a manual deposit. Declining.`);
                 return offer.decline((err) => { if (err) console.error(`Error declining manual deposit offer ${offer.id}:`, err); });
             } else {
                 // Standard unsolicited offer
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like an unsolicited item offer. Declining.`);
                  return offer.decline((err) => { if (err) console.error(`Error declining unsolicited offer ${offer.id}:`, err); });
             }
        }
        // For other types of incoming offers (e.g., if bot was supposed to give items), log and decline.
        console.log(`Ignoring unexpected incoming offer #${offer.id} from ${offer.partner.getSteamID64()}.`);
        // offer.decline().catch(e => console.error("Error declining unexpected offer:", e)); // Decline other unexpected offers too
    });

    manager.on('sentOfferChanged', async (offer, oldState) => { // Offers SENT BY BOT
        if (offer.state !== oldState) { // Log state changes
            console.log(`Bot Offer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()}) Msg: "${offer.message}"`);
        }

        if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
            // Try to match Deposit ID from offer message
            const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
            const depositId = messageMatch ? messageMatch[1] : null;

            if (depositId && pendingDeposits.has(depositId)) { // It's a deposit offer
                const depositData = pendingDeposits.get(depositId);
                pendingDeposits.delete(depositId); // Remove from pending
                console.log(`Processing accepted deposit offer #${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId}`);

                // Clear user's pending flag
                User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                    .then(updateRes => {
                         if(updateRes.modifiedCount > 0) console.log(`Cleared pendingDepositOfferId flag for user ${depositData.steamId}`);
                         else console.warn(`Could not clear pending flag for user ${depositData.steamId} (Offer ID: ${offer.id})`); // May have already been cleared
                    })
                    .catch(e => console.error("Error clearing user pending flag on deposit accept:", e));


                // Critical section: Add items to round, update DB
                // Ensure round is still active and valid before adding items
                let depositRound;
                try {
                     // Fetch the round fresh from DB to ensure atomicity and up-to-date status
                     depositRound = await Round.findById(depositData.roundId).select('status participants items').exec(); // Select only needed fields
                     if (!depositRound) throw new Error(`Round ${depositData.roundId} not found.`);

                     // Check if round status changed or limits exceeded *after* offer was accepted by user but *before* server processes it
                     if (depositRound.status !== 'active' || isRolling) { // isRolling check from server state
                          console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but round invalid. Status: ${depositRound?.status}, Rolling: ${isRolling}. Items NOT added.`);
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Round ended before deposit (Offer #${offer.id}). Contact support.` });
                          // TODO: Potentially handle returning items to user if this happens, or mark for admin review
                          return;
                     }

                     const isNewParticipantCheck = !depositRound.participants.some(p => p.user?.toString() === depositData.userId.toString());
                     if (isNewParticipantCheck && depositRound.participants.length >= MAX_PARTICIPANTS) {
                         console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but participant limit reached. Items NOT added.`);
                         io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Participant limit reached before deposit (Offer #${offer.id}). Items NOT added. Contact support.` });
                         return; // TODO: Item return/review
                     }
                     if (depositRound.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                          console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but pot item limit reached. Items NOT added.`);
                           const slotsLeft = MAX_ITEMS_PER_POT - depositRound.items.length;
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Pot item limit (Offer #${offer.id}). ${slotsLeft} slots left. Items NOT added. Contact support.` });
                          return; // TODO: Item return/review
                     }
                 } catch (roundCheckError) {
                      console.error(`CRITICAL DB ERROR checking round status for accepted deposit ${depositId} (Offer ${offer.id}):`, roundCheckError);
                       io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Contact support.` });
                      // This is a severe issue, might require manual intervention for the user's items
                      return;
                 }

                // Create Item documents and save them
                try {
                    const itemDocuments = depositData.items.map(itemData => new Item({
                        assetId: itemData.assetid, name: itemData._name, image: itemData._image,
                        price: itemData._price, owner: depositData.userId, roundId: depositData.roundId
                    }));

                    const insertedItemsResult = await Item.insertMany(itemDocuments, { ordered: false }); // ordered:false allows valid items to insert if some fail
                     if (insertedItemsResult.length !== itemDocuments.length) console.warn(`Deposit ${depositId}: Item insert count mismatch. Some items might have failed to insert.`);

                    const createdItemIds = insertedItemsResult.map(doc => doc._id);
                    console.log(`Deposit ${depositId}: Inserted ${createdItemIds.length} items into DB.`);


                    // --- Update User's totalDepositedValue ---
                    const userToUpdateForDeposit = await User.findByIdAndUpdate(
                        depositData.userId,
                        { $inc: { totalDepositedValue: depositData.totalValue } },
                        { new: true } // To get the updated document, though not strictly needed here
                    );
                    if (userToUpdateForDeposit) {
                        console.log(`Updated deposit stats for ${userToUpdateForDeposit.username}: New total deposited $${userToUpdateForDeposit.totalDepositedValue.toFixed(2)}`);
                    } else {
                        console.warn(`Could not find user ${depositData.steamId} to update deposit stats.`);
                    }
                    // --- End Update User's Deposit Stats ---


                    // Update round with new participant/items
                    // Fetch round again for update to ensure atomicity with Mongoose's findByIdAndUpdate or save()
                    const roundToUpdate = await Round.findById(depositData.roundId);
                    if (!roundToUpdate) throw new Error("Round disappeared before final update.");
                    if (roundToUpdate.status !== 'active') throw new Error("Round status changed before final update."); // Double check

                    let participantIndex = roundToUpdate.participants.findIndex(p => p.user?.toString() === depositData.userId.toString());
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));

                    if (participantIndex !== -1) { // Existing participant
                           roundToUpdate.participants[participantIndex].itemsValue += depositData.totalValue;
                           roundToUpdate.participants[participantIndex].tickets += depositTickets;
                    } else { // New participant
                           if (roundToUpdate.participants.length >= MAX_PARTICIPANTS) throw new Error(`Participant limit reached for ${depositData.steamId}.`); // Final check before push
                           roundToUpdate.participants.push({ user: depositData.userId, itemsValue: depositData.totalValue, tickets: depositTickets });
                    }

                    roundToUpdate.totalValue += depositData.totalValue;
                    if (roundToUpdate.items.length + createdItemIds.length > MAX_ITEMS_PER_POT) throw new Error(`Pot item limit reached for ${depositData.steamId}.`); // Final check
                    roundToUpdate.items.push(...createdItemIds);

                    const savedRound = await roundToUpdate.save();

                    // Fetch fully populated round data for broadcasting
                    const latestRoundData = await Round.findById(savedRound._id).populate('participants.user', 'steamId username avatar').lean();
                    if (!latestRoundData) throw new Error('Failed to fetch updated round data after deposit save.');

                    currentRound = latestRoundData; // Update in-memory currentRound

                    // Find the updated participant's data for emitting
                    const updatedParticipantData = latestRoundData.participants.find(p => p.user?._id.toString() === depositData.userId.toString());
                    const userInfo = updatedParticipantData?.user;

                    if (updatedParticipantData && userInfo) {
                          io.emit('participantUpdated', { // Send data to client
                               roundId: latestRoundData.roundId, userId: userInfo._id.toString(), username: userInfo.username,
                               avatar: userInfo.avatar, itemsValue: updatedParticipantData.itemsValue,
                               tickets: updatedParticipantData.tickets, totalValue: latestRoundData.totalValue,
                               depositedItems: depositData.items.map(i => ({ assetId: i.assetid, name: i._name, image: i._image, price: i._price })) // Send deposited items info
                          });
                    } else {
                          console.error(`Failed to find updated participant data for user ${depositData.steamId} in round ${latestRoundData.roundId}.`);
                    }

                      // Start timer if this is the first participant
                      if (latestRoundData.participants.length === 1 && !roundTimer) { // Check if timer is already running server-side
                          console.log(`First participant (${userInfo?.username}) joined round ${latestRoundData.roundId}. Starting timer.`);
                          startRoundTimer();
                      }
                     console.log(`Deposit success processed for offer #${offer.id}. User: ${userInfo?.username}, Value: $${depositData.totalValue.toFixed(2)}`);

                 } catch (dbErr) {
                     console.error(`CRITICAL DATABASE/UPDATE ERROR processing accepted deposit ${offer.id} (DepositID: ${depositId}):`, dbErr);
                     io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Contact support.` });
                      // If items were inserted but round update failed, they are orphaned.
                      if (dbErr.message.includes("limit reached") && createdItemIds && createdItemIds.length > 0) {
                          // Attempt to delete orphaned items if a limit was the cause of failure AFTER item insertion
                          console.warn(`Attempting to delete orphaned items for deposit ${depositId}`);
                          await Item.deleteMany({ _id: { $in: createdItemIds } });
                      }
                      // Mark round as error if this critical update fails
                      if (currentRound) { // Ensure currentRound is defined
                          await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } }).catch(e => console.error("Failed to set round status to error:", e));
                          io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error.' });
                      }
                 }
            } else if (offer.itemsToGive && offer.itemsToGive.length > 0 && (!offer.itemsToReceive || offer.itemsToReceive.length === 0)) {
                 // This is a payout (winnings) offer that was accepted
                 console.log(`Payout offer #${offer.id} accepted by recipient ${offer.partner.getSteamID64()}.`);
                  // Notify the winner (optional, but good UX)
                  User.findOne({ steamId: offer.partner.getSteamID64() }).lean().then(user => {
                      if (user) io.emit('notification', { type: 'success', userId: user._id.toString(), message: `Winnings from offer #${offer.id} received!` });
                  }).catch(e => console.error("Error finding user for payout accepted notification:", e));
            } else {
                   // Offer accepted, but not recognized as a deposit or standard payout
                   console.warn(`Offer #${offer.id} accepted, but not recognized as pending deposit or winnings. Message: "${offer.message}"`);
            }
        } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired, TradeOfferManager.ETradeOfferState.InvalidItems, TradeOfferManager.ETradeOfferState.Countered].includes(offer.state)) {
             // Offer ended unsuccessfully
             console.warn(`Bot Offer #${offer.id} to ${offer.partner.getSteamID64()} ended unsuccessfully. State: ${TradeOfferManager.ETradeOfferState[offer.state]}.`);

             // Check if it was a deposit offer
             const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
             const depositId = messageMatch ? messageMatch[1] : null;

             if (depositId && pendingDeposits.has(depositId)) {
                 const depositData = pendingDeposits.get(depositId);
                 console.warn(`Deposit offer ${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId} was ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                 pendingDeposits.delete(depositId); // Remove from pending
                 // Clear user's pending flag
                 User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                      .then(updateRes => {
                           if(updateRes.modifiedCount > 0) console.log(`Cleared pending flag for user ${depositData.steamId} due to offer failure.`);
                      })
                      .catch(e => console.error("Error clearing user flag on deposit failure:", e));
                  const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase(); // e.g., "declined", "expired"
                 io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Your deposit offer (#${offer.id}) was ${stateMessage}.` });
             } else if (offer.itemsToGive && offer.itemsToGive.length > 0) { // Was a payout offer
                  console.warn(`Payout offer #${offer.id} failed. State: ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                  // Notify the user whose payout failed
                  User.findOne({ steamId: offer.partner.getSteamID64() }).lean().then(user => {
                      if (user) {
                           const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase();
                           io.emit('notification', { type: 'error', userId: user._id.toString(), message: `Failed to deliver winnings (Offer #${offer.id}). Offer ${stateMessage}. Contact support.` });
                      }
                  }).catch(e => console.error("Error finding user for payout fail notification:", e));
              }
        }
        // Other states like Active, CreatedNeedsConfirmation usually don't need server-side action here
        // unless you implement offer monitoring or re-sending logic.
    });
}
// --- End of Segment 3 ---
