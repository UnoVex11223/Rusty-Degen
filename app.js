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
const helmet = require('helmet'); // <-- Added helmet import
const rateLimit = require('express-rate-limit');
const { body, query, param, validationResult } = require('express-validator');
require('dotenv').config();

// --- Configuration Constants ---
// Ensure critical environment variables are present
const requiredEnvVars = [
    'MONGODB_URI', 'SESSION_SECRET', 'STEAM_API_KEY', 'SITE_URL',
    // Conditionally required if bot is intended to function
    'STEAM_USERNAME', 'STEAM_PASSWORD', 'STEAM_SHARED_SECRET', 'BOT_TRADE_URL', 'SITE_NAME'
];
const isBotConfigured = process.env.STEAM_USERNAME && process.env.STEAM_PASSWORD && process.env.STEAM_SHARED_SECRET && process.env.BOT_TRADE_URL;
let missingVars = requiredEnvVars.filter(v => !process.env[v] && !(v.startsWith('STEAM_') || v === 'BOT_TRADE_URL' || v === 'SITE_NAME') && isBotConfigured); // Check core vars always, bot vars only if configured
if (!isBotConfigured) {
    console.warn("WARN: Steam Bot credentials/config incomplete in .env file. Trading features will be disabled.");
} else {
    // If bot is configured, check for bot-specific vars
    missingVars = missingVars.concat(requiredEnvVars.filter(v => (v.startsWith('STEAM_') || v === 'BOT_TRADE_URL' || v === 'SITE_NAME') && !process.env[v]));
}

if (missingVars.length > 0) {
    console.error(`FATAL: Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1);
}


const RUST_APP_ID = 252490;
const RUST_CONTEXT_ID = 2;
const ROUND_DURATION = parseInt(process.env.ROUND_DURATION_SECONDS) || 99; // Matches client
const TICKET_VALUE_RATIO = parseFloat(process.env.TICKET_VALUE) || 0.01; // $1 = 100 tickets
const DEPOSIT_TOKEN_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const PRICE_CACHE_TTL_SECONDS = parseInt(process.env.PRICE_CACHE_TTL_SECONDS) || 15 * 60; // 15 minutes default cache validity
const PRICE_REFRESH_INTERVAL_MS = (parseInt(process.env.PRICE_REFRESH_MINUTES) || 10) * 60 * 1000; // Default 10 mins refresh interval
const MIN_ITEM_VALUE = parseFloat(process.env.MIN_ITEM_VALUE) || 0.10; // Minimum value for an item to be depositable
const PRICE_FETCH_TIMEOUT_MS = 30000; // 30 seconds timeout for SCMM API

// Game Rules Constants (Matching Client)
const MAX_PARTICIPANTS = 20;
const MAX_ITEMS_PER_POT = 200;
const TAX_MIN_PERCENT = 5;
const TAX_MAX_PERCENT = 10;
const MIN_POT_FOR_TAX = parseFloat(process.env.MIN_POT_FOR_TAX) || 100; // Pot must be at least $100 for tax (Added default)

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: process.env.SITE_URL || "*", methods: ["GET", "POST"] } });

// --- Security Middleware ---

// Trust proxy if behind one (like Heroku, Nginx) - important for rate limiting IPs correctly
app.set('trust proxy', 1); // Adjust the number based on your proxy depth

app.use(helmet()); // <-- Sets secure HTTP headers

// Rate Limiting Setup (Using your existing definitions)
const generalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again after 15 minutes',
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 10, // Limit each IP to 10 login attempts per windowMs
    message: 'Too many login attempts from this IP, please try again after 10 minutes',
    standardHeaders: true,
    legacyHeaders: false,
});

const sensitiveActionLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 20, // Limit each IP to 20 sensitive actions per windowMs
    message: 'Too many requests for this action, please try again after 5 minutes',
    standardHeaders: true,
    legacyHeaders: false,
});

// Apply general limiter to API routes (Already present in your code)
app.use('/api/', generalApiLimiter);

// Configure middleware
app.use(cors({ origin: process.env.SITE_URL || "*", credentials: true }));
app.use(bodyParser.json()); // Consider limiting request body size: app.use(bodyParser.json({ limit: '10kb' }));
app.use(bodyParser.urlencoded({ extended: true })); // Consider limiting request body size: app.use(bodyParser.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.static('public')); // Serve static files like main.js, CSS
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // TODO: Consider using a persistent session store (like connect-mongo) for production
    // const MongoStore = require('connect-mongo');
    // store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
    cookie: {
        maxAge: 3600000, // 1 hour session cookie
        secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
        httpOnly: true, // Helps prevent XSS accessing the cookie
        sameSite: 'lax' // Helps prevent CSRF
    }
}));
app.use(passport.initialize());
app.use(passport.session());

// --- Steam Strategy ---
passport.use(new SteamStrategy({
    returnURL: `${process.env.SITE_URL}/auth/steam/return`,
    realm: process.env.SITE_URL,
    apiKey: process.env.STEAM_API_KEY,
    providerURL: 'https://steamcommunity.com/openid' // Correct OpenID endpoint
},
    async (identifier, profile, done) => {
        try {
            // Use findOneAndUpdate with upsert for cleaner create/update logic
            const userData = {
                username: profile.displayName,
                avatar: profile._json.avatarfull || '',
                // Don't overwrite tradeUrl on login
            };
            const user = await User.findOneAndUpdate(
                { steamId: profile.id },
                { $set: userData, $setOnInsert: { steamId: profile.id, tradeUrl: '', createdAt: new Date() } },
                { new: true, upsert: true, runValidators: true } // upsert=true creates if not found
            );
            // console.log(`User login/update successful: ${user.username} (ID: ${user.steamId})`); // Less verbose logging
            return done(null, user); // Pass user object to serializeUser
        } catch (err) {
            console.error('Steam Strategy Error:', err);
            return done(err);
        }
    }
));
passport.serializeUser((user, done) => done(null, user.id)); // Use internal MongoDB ID
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user); // Attach user object to req.user
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
    avatar: { type: String },
    tradeUrl: {
        type: String,
        default: '',
        // Basic regex validation at schema level (more thorough validation in route)
        match: [/^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/, 'Invalid Steam Trade URL format']
     },
    balance: { type: Number, default: 0 }, // Example field, might not be used in jackpot
    createdAt: { type: Date, default: Date.now },
    banned: { type: Boolean, default: false }
});
const itemSchema = new mongoose.Schema({
    assetId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    image: { type: String, required: true },
    price: { type: Number, required: true, min: 0 }, // Ensure price is non-negative
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // Added index
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
        itemsValue: { type: Number, required: true, default: 0, min: 0 }, // Total value deposited by user in this round
        tickets: { type: Number, required: true, default: 0, min: 0 }    // Tickets based on value
    }],
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // Added index
    winningTicket: { type: Number, min: 0 },
    serverSeed: { type: String, required: true, match: /^[a-f0-9]{64}$/ }, // Ensure hex format
    serverSeedHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ }, // Ensure hex format
    clientSeed: { type: String, match: /^[a-f0-9]+$/ }, // Allow any hex length, could be refined
    provableHash: { type: String, match: /^[a-f0-9]{64}$/ }, // Ensure hex format
    taxAmount: { type: Number, default: 0, min: 0 }, // Store the calculated tax value
    taxedItems: [{ // Store basic info of items taken as tax
        assetId: String,
        name: String,
        price: { type: Number, min: 0 }
    }]
});
// Add index to participants.user for faster lookups
roundSchema.index({ 'participants.user': 1 });

const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);

// --- Steam Bot Setup ---
const community = new SteamCommunity();
const manager = new TradeOfferManager({
    steam: community,
    domain: process.env.SITE_URL ? process.env.SITE_URL.replace(/^https?:\/\//, '') : 'localhost', // Domain for trade link validation
    language: 'en', // Language for trade offers
    pollInterval: 15000, // Check for new offers every 15 seconds
    cancelTime: 10 * 60 * 1000, // Cancel outgoing offers after 10 minutes
    // Consider adding cancelOfferCount for automatic cancellation of old offers
});
let isBotReady = false; // Track bot readiness

// --- 2FA Code Generation ---
function generateAuthCode() {
    const secret = process.env.STEAM_SHARED_SECRET;
    if (!secret) { console.error("STEAM_SHARED_SECRET missing. Cannot generate 2FA code."); return null; }
    try { return SteamTotp.generateAuthCode(secret); }
    catch (e) { console.error("Error generating 2FA code:", e); return null; }
}

// --- Steam Bot Login ---
if (isBotConfigured) {
    const loginCredentials = {
        accountName: process.env.STEAM_USERNAME,
        password: process.env.STEAM_PASSWORD,
        twoFactorCode: generateAuthCode()
    };
    if (loginCredentials.twoFactorCode) {
        console.log(`Attempting Steam login for bot: ${loginCredentials.accountName}...`);
        community.login(loginCredentials, (err, sessionID, cookies) => {
            if (err) {
                console.error('FATAL STEAM LOGIN ERROR:', err);
                isBotReady = false;
                // Optionally, implement retry logic or alert admin
            } else {
                console.log(`Steam bot ${loginCredentials.accountName} logged in successfully (SteamID: ${community.steamID}).`);
                manager.setCookies(cookies, (err) => {
                    if (err) {
                        console.error('TradeOfferManager Error setting cookies:', err);
                        isBotReady = false;
                        return;
                    }
                    console.log('TradeOfferManager cookies set.');
                    community.setCookies(cookies); // Also set cookies for general community actions
                    // community.gamesPlayed(process.env.SITE_NAME || 'RustyDegen'); // Commented out: Often cosmetic
                    // community.setPersona(1); // Set online status (1 = Online) // Set online status
                    isBotReady = true;
                    console.log("Steam Bot is ready.");
                    // Now that the bot is ready, attempt to create the first round if none exists
                    ensureInitialRound();
                });

                // Auto-accept friend requests
                community.on('friendRelationship', (steamID, relationship) => {
                    if (relationship === SteamCommunity.EFriendRelationship.RequestRecipient) {
                        console.log(`Received friend request from ${steamID}. Accepting...`);
                        community.addFriend(steamID, (err) => {
                            if (err) console.error(`Error accepting friend request from ${steamID}:`, err);
                            else console.log(`Accepted friend request from ${steamID}.`);
                        });
                    }
                });
            }
        });
    } else {
        console.warn("Could not generate 2FA code. Steam Bot login skipped.");
        isBotReady = false;
    }
} // No else needed, warning logged at start if not configured

// --- Active Round Data ---
let currentRound = null;
let roundTimer = null; // Interval ID for the countdown
let isRolling = false; // Flag to prevent actions during winner selection/payout

// --- Deposit Security Token Store ---
// TODO: For production robustness, replace this in-memory store with a persistent one
//        like Redis or a MongoDB collection with a TTL index.
const depositTokens = {}; // Simple in-memory store { token: { userId, expiry } }

function generateDepositToken(userId) {
    const token = crypto.randomBytes(16).toString('hex');
    const expiry = Date.now() + DEPOSIT_TOKEN_EXPIRY_MS;
    depositTokens[token] = { userId: userId.toString(), expiry: expiry };
    // console.log(`Generated deposit token ${token} for user ${userId}`); // Less verbose log
    // Clean up expired token after expiry + buffer
    setTimeout(() => {
        if (depositTokens[token] && depositTokens[token].expiry <= Date.now()) {
            delete depositTokens[token];
            // console.log(`Expired and deleted deposit token ${token}`); // Less verbose log
        }
    }, DEPOSIT_TOKEN_EXPIRY_MS + 5000);
    return token;
}
async function verifyDepositToken(token, partnerSteamId) {
    // Basic validation on the token format itself
    if (!token || typeof token !== 'string' || !/^[a-f0-9]{32}$/i.test(token)) {
         console.warn(`Invalid token format received: ${token}`);
         return null;
    }

    const tokenData = depositTokens[token];
    if (!tokenData || tokenData.expiry <= Date.now()) {
        if (tokenData) delete depositTokens[token]; // Clean up if expired
        // console.log(`Deposit token ${token} is invalid or expired.`); // Less verbose log
        return null;
    }
    try {
        // Find user by partner's SteamID and check if it matches the token owner
        // Ensure partnerSteamId looks like a SteamID before querying
        if (!partnerSteamId || typeof partnerSteamId !== 'string' || !/^\d{17}$/.test(partnerSteamId)) {
             console.warn(`Invalid partner SteamID format received: ${partnerSteamId}`);
             return null;
        }
        const user = await User.findOne({ steamId: partnerSteamId }).lean(); // Use lean for performance
        if (!user || user._id.toString() !== tokenData.userId) {
            console.warn(`Token ${token} verification failed: User mismatch (Offer from ${partnerSteamId}, Token for ${tokenData.userId})`);
            return null;
        }
        // Important: Invalidate token immediately after successful verification
        delete depositTokens[token];
        console.log(`Verified deposit token ${token} for user ${user.username}`);
        return user; // Return the full user object (lean)
    } catch (err) {
        console.error(`Error during token verification for token ${token}:`, err);
        return null;
    }
}


// --- Pricing Cache and Functions ---
const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false }); // useClones: false for performance

// Fallback function
function getFallbackPrice(marketHashName) {
    // console.warn(`PRICE_INFO: Using fallback (min value $${MIN_ITEM_VALUE.toFixed(2)}) for: ${marketHashName}`); // Less verbose
    return MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0;
}

/**
 * Fetches ALL item prices from rust.scmm.app and updates the local cache.
 */
async function refreshPriceCache() {
    console.log("PRICE_INFO: Attempting to refresh price cache from rust.scmm.app...");
    const apiUrl = `https://rust.scmm.app/api/item/prices?currency=USD`;

    try {
        const response = await axios.get(apiUrl, { timeout: PRICE_FETCH_TIMEOUT_MS });

        if (response.data && Array.isArray(response.data)) {
            const items = response.data;
            let updatedCount = 0;
            let newItems = []; // Array for bulk cache update

            items.forEach(item => {
                // Check for valid name and non-negative number price
                if (item?.name && typeof item.price === 'number' && item.price >= 0) {
                    const key = item.name;
                    // Assuming SCMM API returns price in the smallest currency unit (e.g., cents)
                    const priceInDollars = item.price / 100.0;

                    newItems.push({ key: key, val: priceInDollars }); // TTL is managed by NodeCache default
                    updatedCount++;
                } else if (item?.name) {
                    // console.warn(`PRICE_WARN: Invalid or missing price field for item '${item.name}' in SCMM response. Raw price: ${item.price}`); // Less verbose
                }
            });

            if (newItems.length > 0) {
                const success = priceCache.mset(newItems); // Bulk set items in cache
                if (success) { console.log(`PRICE_SUCCESS: Refreshed price cache with ${updatedCount} items from rust.scmm.app.`); }
                else { console.error("PRICE_ERROR: Failed to bulk set price cache (node-cache mset returned false)."); }
            } else {
                console.warn("PRICE_WARN: No valid items found in the response from rust.scmm.app price refresh.");
            }
        } else {
            console.error("PRICE_ERROR: Invalid or empty array response received from rust.scmm.app price refresh. Response Status:", response.status);
        }
    } catch (error) {
        console.error(`PRICE_ERROR: Failed to fetch prices from ${apiUrl}.`);
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
             console.error(` -> Error: Request timed out after ${PRICE_FETCH_TIMEOUT_MS}ms. SCMM API might be slow/unreachable.`);
        } else if (error.response) {
            console.error(` -> Status: ${error.response.status}, Response:`, error.response.data || error.message);
        } else if (error.request) {
            console.error(` -> Error: No response received (Network issue?).`, error.message);
        } else {
            console.error(' -> Error setting up request:', error.message);
        }
        // Do not crash the server, continue using potentially stale cache or fallbacks
    }
}

/**
 * Gets item price from local cache, falling back if not found.
 * @param {string} marketHashName
 * @returns {number} Price in USD
 */
function getItemPrice(marketHashName) {
    // Basic validation on input
    if (typeof marketHashName !== 'string' || marketHashName.length === 0) {
        console.warn("getItemPrice called with invalid marketHashName:", marketHashName);
        return 0;
    }
    const cachedPrice = priceCache.get(marketHashName);
    if (cachedPrice !== undefined) { // Check cache first (0 is a valid cached price)
        return cachedPrice;
    } else {
        return getFallbackPrice(marketHashName); // Use fallback if not in cache
    }
}

// --- Sanitizer Function ---
// Function to sanitize data before passing to vulnerable packages
function sanitizeObjectProperties(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    // Create a new object to avoid modifying the original
    const sanitized = Array.isArray(obj) ? [] : {};

    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const value = obj[key];

            // Recursively sanitize nested objects
            if (value && typeof value === 'object') {
                sanitized[key] = sanitizeObjectProperties(value);
            }
            // Sanitize strings to prevent prototype pollution
            else if (typeof value === 'string') {
                // Avoid "__proto__", "constructor", etc.
                if (key === '__proto__' || key === 'constructor' ||
                    key === 'prototype' || key === 'hasOwnProperty') {
                    continue;
                }
                sanitized[key] = value;
            }
            // Keep other primitives as-is
            else {
                sanitized[key] = value;
            }
        }
    }

    return sanitized;
}
// Use this sanitizer before passing data to steamcommunity or steam-tradeoffer-manager
// Example:
// const sanitizedData = sanitizeObjectProperties(inputData);
// steamCommunityInstance.someMethod(sanitizedData);


// --- Core Game Logic ---

/**
 * Creates a new round if one isn't already active or rolling.
 */
async function createNewRound() {
    if (isRolling) {
        console.log("Cannot create new round: Current round is rolling.");
        return null;
    }
    // Check if there's already an active round in memory
    if (currentRound && currentRound.status === 'active') {
        console.log(`Cannot create new round: Round ${currentRound.roundId} is already active.`);
        return currentRound;
    }

    try {
        isRolling = false; // Ensure rolling flag is reset

        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');

        // Get the last round ID to increment
        const lastRound = await Round.findOne().sort('-roundId');
        const nextRoundId = lastRound ? lastRound.roundId + 1 : 1;

        const newRound = new Round({
            roundId: nextRoundId,
            status: 'active', // Start as active immediately
            startTime: new Date(),
            serverSeed: serverSeed,
            serverSeedHash: serverSeedHash,
            items: [],
            participants: [],
            totalValue: 0
        });

        await newRound.save();
        currentRound = newRound.toObject(); // Update global current round state (use toObject for plain object)

        // Timer starts when the first participant joins (handled in handleNewDeposit)
        // We just emit the creation event here. Client handles timer display.
        io.emit('roundCreated', {
            roundId: newRound.roundId,
            serverSeedHash: newRound.serverSeedHash,
            timeLeft: ROUND_DURATION, // Initial time
            totalValue: 0,
            participants: [],
            items: []
        });

        console.log(`--- Round ${newRound.roundId} created and active ---`);
        // Return plain object representation
        return newRound.toObject();

    } catch (err) {
        console.error('FATAL: Error creating new round:', err);
        // Retry after a delay if round creation fails
        setTimeout(createNewRound, 10000); // Retry after 10 seconds
        return null;
    }
}

// Ensure an initial round exists on startup *after* bot is ready
async function ensureInitialRound() {
    // Only run if bot is configured OR if no bot is needed (allow site to run without bot)
    if (!isBotConfigured || isBotReady) {
        if (!currentRound) {
            try {
                const existingActive = await Round.findOne({ status: 'active' }).populate('participants.user', 'steamId username avatar').populate('items').lean();
                if (existingActive) {
                    console.log(`Found existing active round ${existingActive.roundId} on startup.`);
                    currentRound = existingActive; // Use lean object directly
                    // Decide if timer needs starting (e.g., based on participants and endTime)
                    if (currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now()) {
                        startRoundTimer(true); // Start timer based on remaining time
                    } else if (currentRound.participants.length > 0 && !currentRound.endTime) {
                         // If round was active but timer somehow wasn't set, start it now
                         console.warn(`Active round ${currentRound.roundId} found without endTime. Starting timer now.`);
                         startRoundTimer(false);
                    }
                } else {
                    console.log("No active round found, creating initial round...");
                    await createNewRound();
                }
            } catch (dbErr) {
                console.error("Error ensuring initial round:", dbErr);
                // Consider retrying or exiting if initial round setup fails critically
            }
        }
    } else {
        console.log("Skipping initial round check as bot is not ready/configured.");
        // Optionally schedule a check for later if bot becomes ready
    }
}


/**
 * Starts or restarts the countdown timer for the current round.
 * @param {boolean} useRemainingTime - If true, calculate based on endTime, else use ROUND_DURATION.
 */
function startRoundTimer(useRemainingTime = false) {
    if (roundTimer) clearInterval(roundTimer); // Clear existing timer
    if (!currentRound || currentRound.status !== 'active') {
        console.warn("Cannot start timer: No active round or round status invalid.");
        return;
    }

    let timeLeft;
    let calculatedEndTime;

    if (useRemainingTime && currentRound.endTime) {
        calculatedEndTime = new Date(currentRound.endTime); // Use existing end time
        timeLeft = Math.max(0, Math.floor((calculatedEndTime.getTime() - Date.now()) / 1000));
        console.log(`Resuming timer for round ${currentRound.roundId} with ${timeLeft}s remaining.`);
    } else {
        timeLeft = ROUND_DURATION;
        calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
        currentRound.endTime = calculatedEndTime; // Set end time on the object
        // Save end time asynchronously
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
            .catch(e => console.error(`Error saving round end time for round ${currentRound?.roundId}:`, e));
        console.log(`Starting timer for round ${currentRound.roundId} (${ROUND_DURATION}s). End time: ${calculatedEndTime.toISOString()}`);
    }

    io.emit('timerUpdate', { timeLeft }); // Initial emit

    roundTimer = setInterval(async () => {
        // Check validity on each tick
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) {
            clearInterval(roundTimer);
            roundTimer = null;
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
            await endRound(); // Trigger round ending process
        }
    }, 1000); // Update every second
}


/**
 * Handles the process of ending the current round, calculating the winner, applying tax, and initiating payout.
 */
async function endRound() {
    if (!currentRound || isRolling || currentRound.status !== 'active') {
        console.warn(`Attempted to end round ${currentRound?.roundId}, but state is invalid (Status: ${currentRound?.status}, Rolling: ${isRolling})`);
        return; // Prevent ending if not active or already rolling
    }

    isRolling = true; // Set flag to prevent concurrent actions
    const roundIdToEnd = currentRound.roundId; // Store ID in case currentRound changes unexpectedly
    const roundMongoId = currentRound._id; // Store Mongo ID for reliable fetching
    console.log(`--- Ending round ${roundIdToEnd}... ---`);

    try {
        // Update round status immediately in DB
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } });
        io.emit('roundRolling', { roundId: roundIdToEnd }); // Notify clients

        // Fetch the full round data for processing, ensuring it's the one we intended to end
        // Use lean() for performance as we modify/calculate based on this data
        const round = await Round.findById(roundMongoId)
            .populate('participants.user') // Populate user data
            .populate('items')             // Populate item data
            .lean();                       // <-- Use lean

        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);
        if (round.status !== 'rolling') { // Double check status after fetch
             console.warn(`Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Aborting endRound.`);
             isRolling = false;
             return;
        }
        // Update in-memory currentRound to match fetched lean data
        currentRound = round;

        // --- Handle Empty Round ---
        if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            console.log(`Round ${round.roundId} ended with no valid participants or value.`);
            // Update status directly in DB
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date() }});
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants." });
            isRolling = false; // Reset flag
            setTimeout(createNewRound, 5000); // Start next round sooner
            return; // Exit early
        }

        // --- Tax Calculation ---
        let finalItems = [...round.items]; // Copy items to modify (these are lean objects)
        let finalTotalValue = round.totalValue;
        let taxAmount = 0;
        let taxedItemsInfo = [];
        let itemsToTakeForTaxIds = []; // Store IDs of items to take

        // Check eligibility using MIN_POT_FOR_TAX
        if (finalTotalValue >= MIN_POT_FOR_TAX) {
            const targetTaxValue = finalTotalValue * (TAX_MIN_PERCENT / 100);
            const maxTaxValue = finalTotalValue * (TAX_MAX_PERCENT / 100);

            const sortedItems = [...finalItems].sort((a, b) => a.price - b.price);
            let currentTaxValue = 0;

            for (const item of sortedItems) {
                if (currentTaxValue + item.price <= maxTaxValue) {
                    itemsToTakeForTaxIds.push(item._id.toString()); // Store ID
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price }); // Store basic info
                    currentTaxValue += item.price;
                    if (currentTaxValue >= targetTaxValue) {
                        break;
                    }
                } else {
                    break;
                }
            }

            if (itemsToTakeForTaxIds.length > 0) {
                const taxedAssetIdsSet = new Set(itemsToTakeForTaxIds);
                // Filter items *to be sent to winner*
                const itemsToSendToWinner = finalItems.filter(item => !taxedAssetIdsSet.has(item._id.toString()));
                taxAmount = currentTaxValue;
                finalTotalValue -= taxAmount; // Reduce pot value

                console.log(`Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${itemsToTakeForTaxIds.length} items). New Pot Value: $${finalTotalValue.toFixed(2)}`);

                // Prepare update for the database
                // Note: We'll update winner, seeds, etc., in one go later
            }
            // else: Tax skipped, no need to modify items/value yet
        }
        // else: Tax skipped due to low pot value

        // --- Winner Calculation (Provably Fair) ---
        const clientSeed = crypto.randomBytes(16).toString('hex'); // Generate client seed now
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');

        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16);
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);

        if (totalTickets <= 0) throw new Error(`Cannot determine winner: Total tickets is zero or invalid for round ${round.roundId}.`);

        const winningTicket = decimalFromHash % totalTickets;

        let cumulativeTickets = 0;
        let winner = null; // This will store the participant's user object
        for (const participant of round.participants) {
            if (!participant?.tickets || !participant.user) continue; // Skip invalid participants
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winner = participant.user; // The user object is populated from the .lean() query
                break;
            }
        }

        if (!winner) throw new Error(`Winner selection failed for round ${round.roundId}. Winning Ticket: ${winningTicket}, Total Tickets: ${totalTickets}`);

        // --- Prepare Final Database Update ---
        const finalUpdateData = {
            status: 'completed',
            completedTime: new Date(),
            clientSeed: clientSeed,
            provableHash: provableHash,
            winningTicket: winningTicket,
            winner: winner._id, // Store winner's MongoDB ID
            taxAmount: taxAmount,
            taxedItems: taxedItemsInfo,
            totalValue: finalTotalValue, // Store final (post-tax) value
            // Only update items if tax was applied
            ...(itemsToTakeForTaxIds.length > 0 && { items: finalItems.filter(item => !itemsToTakeForTaxIds.includes(item._id.toString())).map(i => i._id) })
        };

        await Round.updateOne({ _id: roundMongoId }, { $set: finalUpdateData });

        console.log(`Round ${round.roundId} completed. Winner: ${winner.username} (Ticket: ${winningTicket}/${totalTickets}, Value: $${finalTotalValue.toFixed(2)})`);

        // Emit winner information (including post-tax value)
        io.emit('roundWinner', {
            roundId: round.roundId,
            winner: { // Send relevant winner details
                id: winner._id,
                steamId: winner.steamId,
                username: winner.username,
                avatar: winner.avatar
            },
            winningTicket: winningTicket,
            totalValue: finalTotalValue, // Send post-tax value
            totalTickets: totalTickets,
            serverSeed: round.serverSeed, // Reveal server seed
            clientSeed: clientSeed,
            provableHash: provableHash,
            serverSeedHash: round.serverSeedHash // Keep sending hash too
        });

        // --- Initiate Payout ---
        // Fetch the items to actually send (excluding taxed items)
        const itemsToSend = finalItems.filter(item => !itemsToTakeForTaxIds.includes(item._id.toString()));
        // Pass the winner user object and the filtered finalItems array (lean objects)
        await sendWinningTradeOffer(round, winner, itemsToSend);

    } catch (err) {
        console.error(`CRITICAL ERROR during endRound for round ${roundIdToEnd}:`, err);
        try {
             // Attempt to mark the round as 'error' in DB
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error' } });
            io.emit('roundError', { roundId: roundIdToEnd, error: 'Internal server error during round finalization.' });
        } catch (saveErr) {
             console.error(`Failed to mark round ${roundIdToEnd} as error after initial error:`, saveErr);
        }
    } finally {
        isRolling = false; // Reset rolling flag
        console.log(`Scheduling next round creation after round ${roundIdToEnd} finalization.`);
        setTimeout(createNewRound, 10000); // Schedule next round (e.g., 10s after completion/error)
    }
}

/**
 * Sends the winning trade offer to the winner.
 * @param {object} round - The completed Round lean object.
 * @param {object} winner - The populated User lean object for the winner.
 * @param {Array} itemsToSend - Array of lean Item objects to send (after tax).
 */
async function sendWinningTradeOffer(round, winner, itemsToSend) {
    // Critical Check: Ensure bot is ready before attempting to send
    if (!isBotReady) {
        console.error(`PAYOUT_ERROR: Cannot send winnings for round ${round.roundId}: Steam Bot is not ready.`);
        // Notify admin/support system here
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Bot Error: Payout for round ${round.roundId} requires manual processing. Please contact support.` });
        return;
    }
    if (!winner.tradeUrl) {
        console.error(`PAYOUT_ERROR: Cannot send winnings for round ${round.roundId}: Winner ${winner.username} has no Trade URL set.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Please set your Trade URL in your profile to receive winnings.' });
        return;
    }
    if (!itemsToSend || itemsToSend.length === 0) {
        console.log(`PAYOUT_INFO: No items to send for round ${round.roundId} (possibly all taxed or error).`);
        if (round.taxAmount > 0 && round.totalValue <= 0) { // If tax took everything
            io.emit('notification', { type: 'info', userId: winner._id.toString(), message: `Round ${round.roundId} winnings ($${round.taxAmount.toFixed(2)}) were processed as site tax.` });
        }
        return;
    }

    console.log(`Attempting to send ${itemsToSend.length} winning items for round ${round.roundId} to ${winner.username}...`);

    try {
        const offer = manager.createOffer(winner.tradeUrl);
        offer.addMyItems(itemsToSend.map(item => ({ // Map lean item objects
            assetid: item.assetId,
            appid: RUST_APP_ID,
            contextid: RUST_CONTEXT_ID
        })));
        offer.setMessage(`Congratulations! Your winnings from Round #${round.roundId} on ${process.env.SITE_NAME || 'RustyDegen'}. Pot Value (after tax): $${round.totalValue.toFixed(2)}`);

        const status = await new Promise((resolve, reject) => {
            offer.send((err, status) => {
                if (err) {
                    // Handle specific errors like invalid trade URL token
                    if (err.message.includes('revoked') || err.message.includes('invalid') || err.eresult === 26) { // EResult 26 is often invalid token
                        console.error(`PAYOUT_ERROR: Trade offer failed for round ${round.roundId}: Invalid Trade URL/Token for ${winner.username}. Offer ID: ${offer.id}`);
                        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Your Trade URL is invalid or expired. Please update it to receive winnings.' });
                    } else if (err.eresult === 15 || err.eresult === 16) { // EResult 15/16 often inventory full/private
                         console.error(`PAYOUT_ERROR: Trade offer failed for round ${round.roundId}: Winner's inventory might be full or private. Offer ID: ${offer.id}`);
                         io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Could not send winnings. Ensure your Steam inventory is public and not full.' });
                    } else {
                         console.error(`PAYOUT_ERROR: Error sending trade offer ${offer.id} for round ${round.roundId}: EResult ${err.eresult} - ${err.message}`);
                    }
                    // TODO: Implement retry logic or manual intervention queue for failed payouts
                    return reject(err); // Reject the promise on error
                }
                resolve(status); // Resolve with the status on success
            });
        });

        console.log(`PAYOUT_SUCCESS: Trade offer ${offer.id} sent to ${winner.username} for round ${round.roundId}. Status: ${status}`);
        // Notify client about the sent offer
        io.emit('tradeOfferSent', {
            roundId: round.roundId,
            userId: winner._id.toString(),
            username: winner.username,
            offerId: offer.id,
            status: status // Include status if available/useful
        });

    } catch (err) {
        // Error already logged in the offer.send callback for specific cases
        // General catch for other potential errors during offer creation/sending
        console.error(`PAYOUT_ERROR: Unexpected error creating/sending trade offer for round ${round.roundId}:`, err);
        // TODO: Notify admin/support
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Error sending winnings for round ${round.roundId}. Please contact support.` });
    }
}


// --- Authentication Routes ---
// Apply auth rate limiter to the login initiation route
app.get('/auth/steam', authLimiter, passport.authenticate('steam', { failureRedirect: '/' }));

app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => {
        // Successful authentication, redirect home.
        res.redirect('/');
    });

// Logout Route
app.post('/logout', (req, res, next) => {
    req.logout(err => {
        if (err) { return next(err); }
        req.session.destroy(err => {
            if (err) {
                console.error("Error destroying session during logout:", err);
                return res.status(500).json({ error: 'Logout failed.' });
            }
            res.clearCookie('connect.sid'); // Use the default session cookie name
            res.json({ success: true });
        });
    });
});


// --- Middleware & API Routes ---
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) { return next(); }
    res.status(401).json({ error: 'Not authenticated' });
}

// Helper Middleware for validation results (Already present in your code)
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    next();
};

// GET User Profile
app.get('/api/user', ensureAuthenticated, (req, res) => {
    // Return only necessary, non-sensitive user data
    const { _id, steamId, username, avatar, tradeUrl, balance, createdAt } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, balance, createdAt });
});

// POST Update Trade URL (Updated with validation)
app.post('/api/user/tradeurl',
    sensitiveActionLimiter, // Apply stricter rate limit
    ensureAuthenticated,
    [ // Validation Rules from provided snippet
        body('tradeUrl')
            .trim()
            .notEmpty().withMessage('Trade URL cannot be empty.')
            .isURL({ require_protocol: true, protocols: ['https'] }).withMessage('Trade URL must be a valid HTTPS URL.') // Modified from snippet for better validation
            .matches(/^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/)
            .withMessage('Invalid Steam Trade URL format. Must include partner and token.')
    ],
    handleValidationErrors, // Handle validation results
    async (req, res) => { // This is the original handler logic
        // Validation passed if we reach here
        const { tradeUrl } = req.body;

        try {
            const updatedUser = await User.findByIdAndUpdate(
                req.user._id,
                { tradeUrl: tradeUrl },
                { new: true, runValidators: true } // Return the updated document and run schema validators
            );
            if (!updatedUser) {
                return res.status(404).json({ error: 'User not found.' });
            }
            console.log(`Trade URL updated for user: ${updatedUser.username}`);
            res.json({ success: true, tradeUrl: updatedUser.tradeUrl });
        } catch (err) {
             // Check for Mongoose validation error (e.g., from schema match)
            if (err.name === 'ValidationError') {
                return res.status(400).json({ error: err.message });
            }
            console.error(`Error updating trade URL for user ${req.user._id}:`, err);
            res.status(500).json({ error: 'Server error saving Trade URL.' });
        }
});

// GET User Inventory
app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    // Check bot readiness before attempting inventory fetch
    if (!isBotReady) {
        console.warn(`Inventory fetch failed for ${req.user.username}: Bot service is unavailable.`);
        return res.status(503).json({ error: "Steam service temporarily unavailable. Please try again later." });
    }

    try {
        // Use manager.getUserInventoryContents for potentially better reliability
        const inventory = await new Promise((resolve, reject) => {
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                if (err) {
                    // Handle common errors more gracefully
                    if (err.message?.includes('profile is private') || err.eresult === 15) {
                        return reject(new Error('Your Steam inventory is private. Please set it to public.'));
                    }
                    console.error(`Inventory Fetch Error (Manager): User ${req.user.steamId}: EResult ${err.eresult} - ${err.message || err}`);
                    return reject(new Error(`Could not fetch inventory. Steam might be busy or inventory private.`));
                }
                resolve(inv || []); // Resolve with empty array if null/undefined
            });
        });

        if (!inventory?.length) return res.json([]); // Return empty array if inventory is empty

        // Process items: get prices (sync using cache), format data
        const validItems = inventory // Renamed for clarity
            .map(item => {
                const itemName = item.market_hash_name;
                let price = 0;
                if (itemName) {
                    price = getItemPrice(itemName); // Reads cache/fallback synchronously
                } else {
                    // console.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`); // Less verbose
                }
                // Ensure price is a number, default to 0 if not
                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

                // Check for required properties (assetid, icon_url) before returning
                if (!item.assetid || !item.icon_url) {
                     console.warn(`Inventory item missing assetid or icon_url: Name ${itemName}`);
                     return null; // Skip this item
                }

                return {
                    assetId: item.assetid, // Ensure assetId is included
                    name: itemName || 'Unknown Item', // Use market_hash_name preferentially
                    displayName: item.name, // Original name from Steam
                    image: `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`, // Use Steam CDN URL
                    price: finalPrice,
                    tradable: item.tradable, // Include tradable status
                    marketable: item.marketable // Include marketable status
                };
            })
            .filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE); // Filter nulls, non-tradables, and low value items

        res.json(validItems);

    } catch (err) {
        console.error(`Error in /api/inventory for ${req.user?.username || req.user?.steamId}:`, err.message);
        // Send back the specific error message if available and reasonable
        res.status(500).json({ error: err.message || 'Server error fetching inventory.' });
    }
});


// POST Initiate Deposit Request (Client gets token and bot URL)
app.post('/api/deposit/initiate',
    sensitiveActionLimiter, // Apply stricter rate limit
    ensureAuthenticated,
    async (req, res) => { // Mark async for potential future DB checks if needed
        if (!isBotReady || !process.env.BOT_TRADE_URL) {
            console.warn(`Deposit initiation failed for ${req.user.username}: Bot service is unavailable.`);
            return res.status(503).json({ error: "Deposit service is temporarily unavailable. Please try again later." });
        }
        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            // console.warn(`Deposit initiation rejected for ${req.user.username}: Round not active (Status: ${currentRound?.status}, Rolling: ${isRolling})`); // Less verbose
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }

        // Fetch latest round data for accurate limit checks just before token generation
        try {
            const latestRoundData = await Round.findById(currentRound._id).select('participants items').lean();
            if (!latestRoundData) {
                console.error(`Deposit initiation failed for ${req.user.username}: Could not fetch current round data.`);
                return res.status(500).json({ error: 'Internal server error. Please try again.' });
            }

            // Double check limits server-side before issuing token
            if (latestRoundData.participants.length >= MAX_PARTICIPANTS) {
                return res.status(400).json({ error: `Participant limit (${MAX_PARTICIPANTS}) reached.` });
            }
            if (latestRoundData.items.length >= MAX_ITEMS_PER_POT) {
                return res.status(400).json({ error: `Pot item limit (${MAX_ITEMS_PER_POT}) reached.` });
            }

            // Generate a unique, short-lived token for the trade offer message
            const token = generateDepositToken(req.user._id);
            res.json({
                success: true,
                depositToken: token,
                botTradeUrl: process.env.BOT_TRADE_URL // Send the bot's trade URL to the client
            });
        } catch (dbErr) {
            console.error(`Error fetching round data during deposit initiation for ${req.user.username}:`, dbErr);
            return res.status(500).json({ error: 'Internal server error. Please try again.' });
        }
});


// --- Trade Offer Manager Event Handling ---
if (isBotConfigured && manager) { // Ensure manager is initialized
    manager.on('newOffer', async (offer) => {
        if (!isBotReady) return; // Ignore offers if bot isn't fully ready

        // Basic sanity checks on the offer object
        if (!offer || !offer.partner || typeof offer.partner.getSteamID64 !== 'function') {
            console.warn('Received an invalid or incomplete offer object.');
            return;
        }

        // Ignore offers sent *by* the bot, or empty offers, or offers without a message (token)
        if (offer.isOurOffer || !offer.itemsToReceive || offer.itemsToReceive.length === 0 || !offer.message) {
            // console.log(`Ignoring offer #${offer.id}: isOurOffer=${offer.isOurOffer}, itemsToReceive=${offer.itemsToReceive?.length}, hasMessage=${!!offer.message}`); // Debug log
            return;
        }

        const partnerSteamId = offer.partner.getSteamID64();
        console.log(`Received new trade offer #${offer.id} from ${partnerSteamId}. Message: "${offer.message}"`);

        // 1. Check Round Status & Limits *before* verifying token
        if (!currentRound || !currentRound._id || currentRound.status !== 'active' || isRolling) {
            console.log(`Offer #${offer.id}: Declining - Deposits closed (Status: ${currentRound?.status}, Rolling: ${isRolling})`);
            return offer.decline().catch(e => console.error(`Error declining offer ${offer.id} (round closed):`, e));
        }
        // Fetch latest participant count directly from DB for better accuracy in checks
        let latestRoundDataForCheck;
        try {
             latestRoundDataForCheck = await Round.findById(currentRound._id).select('participants items').lean();
        } catch(dbErr) {
             console.error(`Offer #${offer.id}: DB error fetching round data for limits check:`, dbErr);
             // Decline if we can't check limits
             return offer.decline().catch(e => console.error(`Error declining offer ${offer.id} (DB check failed):`, e));
        }

        if (!latestRoundDataForCheck) {
             console.error(`Offer #${offer.id}: Cannot check limits, current round data missing from DB.`);
             return offer.decline().catch(e => console.error(`Error declining offer ${offer.id} (DB check failed):`, e));
        }

        if (latestRoundDataForCheck.participants.length >= MAX_PARTICIPANTS) {
             console.log(`Offer #${offer.id}: Declining - Participant limit reached (${latestRoundDataForCheck.participants.length}/${MAX_PARTICIPANTS}).`);
             return offer.decline().catch(e => console.error(`Error declining offer ${offer.id} (participants full):`, e));
        }
        if (latestRoundDataForCheck.items.length >= MAX_ITEMS_PER_POT) {
             console.log(`Offer #${offer.id}: Declining - Pot item limit reached (${latestRoundDataForCheck.items.length}/${MAX_ITEMS_PER_POT}).`);
             return offer.decline().catch(e => console.error(`Error declining offer ${offer.id} (items full):`, e));
        }


        // 2. Verify Deposit Token
        const token = offer.message.trim();
        let user; // Will store the user object if token is valid
        try {
            user = await verifyDepositToken(token, partnerSteamId); // verifyDepositToken now includes basic validation
            if (!user) {
                console.log(`Offer #${offer.id}: Declining - Invalid or expired deposit token.`);
                return offer.decline().catch(e => console.error(`Error declining offer ${offer.id} (invalid token):`, e));
            }
        } catch (vErr) { // Catch errors during DB lookup in verifyDepositToken
            console.error(`Offer #${offer.id}: Error verifying deposit token:`, vErr);
            return offer.decline().catch(e => console.error(`Error declining offer ${offer.id} (token verify error):`, e));
        }

        // Re-check participant limit specifically for NEW participants joining (using latest fetched data)
        const isNewParticipant = !latestRoundDataForCheck.participants.some(p => p.user?.toString() === user._id.toString());
        if (isNewParticipant && latestRoundDataForCheck.participants.length >= MAX_PARTICIPANTS) {
             console.log(`Offer #${offer.id}: Declining - Participant limit reached just before processing new participant ${user.username}.`);
             return offer.decline().catch(e => console.error(`Error declining offer ${offer.id} (participants full - race condition):`, e));
        }


        // 3. Process Items and Calculate Value
        try {
            const itemsToProcess = offer.itemsToReceive
                .map(item => {
                    // Basic check for necessary properties from Steam
                    if (!item || !item.market_hash_name || !item.assetid || !item.icon_url || !item.appid || !item.contextid) {
                        console.warn(`Offer #${offer.id}: Item asset ${item?.assetid || 'UNKNOWN'} missing required properties. Skipping.`);
                        return null;
                    }
                    // Ensure item is for the correct game (Rust)
                    if (item.appid != RUST_APP_ID || item.contextid != RUST_CONTEXT_ID) {
                        console.warn(`Offer #${offer.id}: Item asset ${item.assetid} ('${item.market_hash_name}') is not a Rust item (AppID: ${item.appid}, ContextID: ${item.contextid}). Skipping.`);
                        return null;
                    }

                    const price = getItemPrice(item.market_hash_name); // Get price from cache/fallback
                    // Check if item meets minimum value threshold
                    if (price < MIN_ITEM_VALUE) {
                        // console.log(`Offer #${offer.id}: Item '${item.market_hash_name}' ($${price.toFixed(2)}) value below minimum ($${MIN_ITEM_VALUE}). Skipping.`); // Less verbose
                        return null;
                    }
                    return {
                        assetId: item.assetid,
                        name: item.market_hash_name,
                        image: `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`,
                        price: price,
                        owner: user._id, // Store user's MongoDB ID
                        roundId: currentRound._id // Link item to the current round
                    };
                })
                .filter(i => i !== null); // Remove skipped items

            const depositTotalValue = itemsToProcess.reduce((sum, item) => sum + item.price, 0);

            if (itemsToProcess.length === 0) {
                console.log(`Offer #${offer.id}: Declining - No valid items met the requirements (Correct game, min value).`);
                return offer.decline().catch(e => console.error(`Error declining offer ${offer.id} (no valid items):`, e));
            }

            // Final check: Ensure adding these items doesn't exceed pot limit (using latest fetched data)
            if (latestRoundDataForCheck.items.length + itemsToProcess.length > MAX_ITEMS_PER_POT) {
                console.log(`Offer #${offer.id}: Declining - Deposit would exceed pot item limit (${latestRoundDataForCheck.items.length} + ${itemsToProcess.length} > ${MAX_ITEMS_PER_POT}).`);
                return offer.decline().catch(e => console.error(`Error declining offer ${offer.id} (items full - race condition):`, e));
            }

            // 4. Accept the Offer
            offer.accept(async (err, status) => {
                if (err) {
                    console.error(`Offer #${offer.id}: Error accepting trade: EResult ${err.eresult} - ${err.message || err}`);
                    // Handle specific errors like escrow
                    if (err.message?.includes('escrow') || err.eresult === 11) { // EResult 11 is often escrow
                        console.warn(`Offer #${offer.id} may be held in escrow. Deposit likely failed.`);
                        // Notify user about escrow issue
                         io.emit('notification', { type: 'warning', userId: user._id.toString(), message: `Your deposit (Offer #${offer.id}) might be held in escrow by Steam. Please ensure Steam Guard Mobile Authenticator has been active for 7 days.` });
                    }
                    return; // Stop processing if accept fails
                }

                 // Check status for confirmation needed (rare for bot->bot but good practice)
                 if (status === 'pending') {
                      console.log(`Offer #${offer.id} accepted but requires confirmation (pending). Accepting confirmation...`);
                      try {
                          await new Promise((resolve, reject) => {
                               community.acceptConfirmationForObject(process.env.STEAM_IDENTITY_SECRET, offer.id, (confErr) => {
                                   if (confErr) {
                                       console.error(`Offer #${offer.id}: Error accepting confirmation:`, confErr);
                                       // TODO: Handle this state - items might be stuck until manually confirmed/canceled. Notify admin.
                                       reject(confErr);
                                   } else {
                                       console.log(`Offer #${offer.id}: Confirmation accepted.`);
                                       resolve();
                                   }
                               });
                          });
                          // If confirmation is successful, proceed to update DB
                      } catch (confAcceptErr) {
                           io.emit('notification', { type: 'error', userId: user._id.toString(), message: `Deposit Error: Could not automatically confirm offer #${offer.id}. Please contact support.` });
                           // Do not proceed with DB update if confirmation failed
                           return;
                      }
                 } else {
                    console.log(`Offer #${offer.id} accepted successfully. Status: ${status}. Updating database...`);
                 }


                // --- 5. Update Database (CRITICAL SECTION) ---
                // Use findOneAndUpdate for atomic update to mitigate race conditions
                try {
                    // Prepare update operations
                    // Use lean() for performance and create Item documents directly
                    const itemDocuments = itemsToProcess.map(item => new Item(item));
                    await Item.insertMany(itemDocuments, { ordered: false }); // Save items first, allow continuing if some duplicates fail (shouldn't happen with assetId)
                    const createdItemIds = itemDocuments.map(doc => doc._id);

                    // Find the participant index or prepare new participant data
                    const participantUpdate = {
                         $inc: { // Use $inc for atomic increments
                              totalValue: depositTotalValue,
                              'participants.$.itemsValue': depositTotalValue,
                              'participants.$.tickets': Math.max(1, Math.floor(depositTotalValue / TICKET_VALUE_RATIO))
                         },
                         $push: { items: { $each: createdItemIds } } // Push new item IDs
                    };
                    const participantFilter = { _id: currentRound._id, status: 'active', 'participants.user': user._id }; // Match round, status, and existing participant

                    // Attempt to update existing participant
                    const updateResult = await Round.updateOne(participantFilter, participantUpdate);

                    let latestRound;
                    if (updateResult.matchedCount === 0) { // Use matchedCount for better check if filter worked but no change needed (or participant wasn't found)
                         // Participant not found or round status changed, try adding as new participant
                         const newParticipantData = {
                             user: user._id,
                             itemsValue: depositTotalValue,
                             tickets: Math.max(1, Math.floor(depositTotalValue / TICKET_VALUE_RATIO))
                         };
                         const addParticipantUpdate = {
                              $inc: { totalValue: depositTotalValue },
                              $push: {
                                  items: { $each: createdItemIds },
                                  participants: newParticipantData
                              }
                         };
                         // Add condition to ensure round is still active and participant doesn't exist yet
                         const addFilter = {
                             _id: currentRound._id,
                             status: 'active',
                             'participants.user': { $ne: user._id } // Ensure user is not already in the array
                         };
                         const addResult = await Round.updateOne(addFilter, addParticipantUpdate);

                         if (addResult.modifiedCount === 0) {
                              // Check if the participant was added *just now* by another process (race condition)
                              const checkAgain = await Round.findOne({ _id: currentRound._id, 'participants.user': user._id }).lean();
                              if (!checkAgain) {
                                  // CRITICAL: Round status changed or participant add failed unexpectedly.
                                  // This could happen if the participant limit was hit between the initial check and now.
                                  throw new Error(`Round status/limits changed after accepting offer ${offer.id}. DB update failed.`);
                              }
                              // If checkAgain finds the user, it means another process added them, fetch latest data
                              latestRound = await Round.findById(currentRound._id).populate('participants.user', 'steamId username avatar').lean();

                         } else {
                              // Fetch the round again after adding participant
                              latestRound = await Round.findById(currentRound._id).populate('participants.user', 'steamId username avatar').lean();
                         }

                    } else {
                         // Fetch the round again after updating existing participant
                         latestRound = await Round.findById(currentRound._id).populate('participants.user', 'steamId username avatar').lean();
                    }


                    if (!latestRound) {
                         // Should not happen if update succeeded, but handle defensively
                         throw new Error(`Failed to fetch updated round data after deposit for offer ${offer.id}.`);
                    }
                    currentRound = latestRound; // Update the global state


                    // 6. Emit update to clients
                    const updatedParticipantData = latestRound.participants.find(p => p.user?._id.toString() === user._id.toString());
                    io.emit('participantUpdated', {
                        roundId: latestRound.roundId,
                        userId: user._id.toString(), // Send MongoDB ID
                        username: user.username,
                        avatar: user.avatar,
                        itemsValue: updatedParticipantData?.itemsValue || 0, // Send cumulative value
                        tickets: updatedParticipantData?.tickets || 0,       // Send cumulative tickets
                        totalValue: latestRound.totalValue,                 // Send new round total value
                        depositedItems: itemsToProcess.map(i => ({ // Send details of *this* deposit
                            assetId: i.assetId, name: i.name, image: i.image, price: i.price
                        }))
                    });


                    // Start timer if this was the first participant (check latestRound)
                    if (latestRound.participants.length === 1 && !roundTimer) { // Check roundTimer flag too
                        console.log(`First participant (${user.username}) joined round ${latestRound.roundId}. Starting timer.`);
                        // timerActive flag is not reliable server-side, rely on roundTimer interval ID
                        startRoundTimer();
                    }

                    console.log(`Deposit success for offer #${offer.id}. User: ${user.username}, Value: $${depositTotalValue.toFixed(2)}, Items: ${itemsToProcess.length}`);

                } catch (dbErr) {
                    // CRITICAL: Error saving to DB after accepting trade. Items are in bot inventory.
                    console.error(`CRITICAL DATABASE ERROR after accepting offer ${offer.id}:`, dbErr);
                    // Attempt to mark round as error? Or just log for manual fix.
                    if (currentRound) { // Try to mark round as errored
                        await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } })
                            .catch(e => console.error("Failed to set round status to error:", e));
                        io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error.' });
                    }
                    // TODO: System to handle items stuck in bot inventory (e.g., flag for admin).
                    io.emit('notification', { type: 'error', userId: user._id.toString(), message: `Deposit Error: Database issue after accepting offer #${offer.id}. Please contact support.` });
                    // IMPORTANT: Consider attempting to return items to the user here if DB update fails.
                    // This is complex due to potential trade holds/errors. Manual intervention is often safer.
                }
            }); // End offer.accept callback

        } catch (procErr) {
            console.error(`Offer #${offer.id}: Error processing items/value:`, procErr);
            offer.decline().catch(e => console.error(`Error declining offer ${offer.id} (item processing error):`, e));
        }
    }); // End manager.on('newOffer')

    manager.on('sentOfferChanged', (offer, oldState) => {
        // Only log significant changes
        if (offer.state !== oldState) {
             console.log(`Payout Offer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]}`);
        }
        // TODO: Add logic here if needed (e.g., logging successful payouts, handling declines/failures)
        if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
             console.log(`Payout offer #${offer.id} accepted by recipient.`);
             // Optional: Mark round payout as fully complete if needed
        } else if (
             offer.state === TradeOfferManager.ETradeOfferState.Declined ||
             offer.state === TradeOfferManager.ETradeOfferState.Canceled ||
             offer.state === TradeOfferManager.ETradeOfferState.Expired ||
             offer.state === TradeOfferManager.ETradeOfferState.InvalidItems ||
             offer.state === TradeOfferManager.ETradeOfferState.Countered // Added Countered
             ) {
             console.warn(`Payout offer #${offer.id} failed or was not accepted. State: ${TradeOfferManager.ETradeOfferState[offer.state]}. Items likely returned to bot inventory.`);
             // TODO: Notify user/admin, potentially retry or credit balance. Flag for manual intervention.
             // Find the winner associated with this offer if possible (might need to store offer details with round)
             // io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Payout Error: Failed to deliver winnings for offer #${offer.id}. Please contact support.` });
        }
    });

} // End if (isBotConfigured && manager)


// --- Round Info API Routes ---
// Helper function to format round data for client
function formatRoundForClient(round) { // Expects a lean object
    if (!round) return null;

    const timeLeft = (round.status === 'active' && round.endTime)
        ? Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000))
        : 0;

    // Participants should already be populated lean objects
    const participantsFormatted = (round.participants || []).map(p => ({
        user: p.user ? { id: p.user._id, steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar } : null,
        itemsValue: p.itemsValue || 0,
        tickets: p.tickets || 0
    })).filter(p => p.user); // Filter out any potential null users

    // Items should already be populated lean objects
    const itemsFormatted = (round.items || []).map(i => ({
        // id: i._id, // Usually not needed on client for display
        assetId: i.assetId, // More useful for linking/images
        name: i.name,
        image: i.image,
        price: i.price || 0,
        owner: i.owner // Keep owner's Mongo ID
    }));

    // Winner should already be populated if status is completed
    let winnerDetails = null;
    if (round.status === 'completed' && round.winner) {
         winnerDetails = {
             id: round.winner._id,
             steamId: round.winner.steamId,
             username: round.winner.username,
             avatar: round.winner.avatar
         };
    }


    return {
        roundId: round.roundId,
        status: round.status,
        startTime: round.startTime,
        endTime: round.endTime,
        timeLeft: timeLeft,
        totalValue: round.totalValue || 0, // Use final post-tax value
        serverSeedHash: round.serverSeedHash,
        participants: participantsFormatted,
        items: itemsFormatted,
        // Conditionally include completed round data
        winner: winnerDetails,
        winningTicket: round.status === 'completed' ? round.winningTicket : undefined, // Use undefined for cleaner JSON
        serverSeed: round.status === 'completed' ? round.serverSeed : undefined,
        clientSeed: round.status === 'completed' ? round.clientSeed : undefined,
        provableHash: round.status === 'completed' ? round.provableHash : undefined,
        taxAmount: round.taxAmount
    };
}


app.get('/api/round/current', async (req, res) => {
    let roundToFormat = null;
    try {
        // Prioritize the in-memory currentRound if it exists and seems valid
        if (currentRound?._id) {
            // Fetch fresh data to ensure consistency, especially participant/item lists
            roundToFormat = await Round.findById(currentRound._id)
                .populate('participants.user', 'steamId username avatar')
                .populate('items') // Populate full item details
                .populate('winner', 'steamId username avatar') // Populate winner details
                .lean();
             // If fetch fails for the in-memory ID, clear it and try finding another active one
             if (!roundToFormat) {
                  console.warn(`Current round (_id: ${currentRound._id}, roundId: ${currentRound.roundId}) in memory was not found in DB. Clearing memory reference.`);
                  currentRound = null;
             } else {
                 // Update in-memory version with fresh data
                 currentRound = roundToFormat;
             }
        }

        // Fallback: If no round in memory or fetch failed, check DB for *any* active round
        if (!roundToFormat) {
            roundToFormat = await Round.findOne({ status: 'active' })
                .sort({ startTime: -1 }) // Get the latest active round if multiple somehow exist
                .populate('participants.user', 'steamId username avatar')
                .populate('items')
                .populate('winner', 'steamId username avatar')
                .lean();
            if (roundToFormat && !currentRound) { // Restore to memory if found and memory is empty
                currentRound = roundToFormat;
                console.log(`Restored active round ${currentRound.roundId} from DB via API.`);
                // Ensure timer is running if needed (check conditions again)
                if (currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                    startRoundTimer(true); // Resume timer if needed and not already running
                } else if (currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) {
                     console.warn(`Restored active round ${currentRound.roundId} from DB found without endTime. Starting timer now.`);
                     startRoundTimer(false);
                }
            }
        }

        const formattedData = formatRoundForClient(roundToFormat);

        if (formattedData) {
            res.json(formattedData);
        } else {
            // No active round found in memory or DB
            res.status(404).json({ error: 'No active round found.' });
        }
    } catch (err) {
        console.error('Error fetching/formatting current round data:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' });
    }
});

app.get('/api/rounds',
    [ // Validation Rules
        query('page').optional().isInt({ min: 1 }).toInt().withMessage('Page must be a positive integer.'),
        query('limit').optional().isInt({ min: 1, max: 50 }).toInt().withMessage('Limit must be between 1 and 50.') // Added max limit
    ],
    handleValidationErrors, // Handle validation results
    async (req, res) => {
        try {
            // Use validated and sanitized values or defaults
            const page = req.query.page || 1;
            const limit = req.query.limit || 10;
            const skip = (page - 1) * limit;

            const queryFilter = { status: { $in: ['completed', 'error'] } }; // Find completed or errored rounds

            // Execute queries in parallel
            const [rounds, totalCount] = await Promise.all([
                Round.find(queryFilter)
                    .sort('-roundId') // Sort by roundId descending (newest first)
                    .skip(skip)
                    .limit(limit)
                    .populate('winner', 'username avatar steamId') // Populate winner info
                    // Select only necessary fields for the history view
                    .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount')
                    .lean(), // Use lean for performance
                Round.countDocuments(queryFilter)
            ]);

            res.json({
                rounds: rounds,
                totalPages: Math.ceil(totalCount / limit),
                currentPage: page,
                totalRounds: totalCount
            });
        } catch (err) {
            console.error('Error fetching past rounds:', err);
            res.status(500).json({ error: 'Server error fetching round history.' });
        }
});

app.post('/api/verify',
    sensitiveActionLimiter, // Apply stricter rate limit
    [ // Validation Rules
        body('roundId')
            .notEmpty().withMessage('Round ID is required.')
            .isInt({ min: 1 }).toInt().withMessage('Round ID must be a positive integer.'),
        body('serverSeed')
            .trim()
            .notEmpty().withMessage('Server Seed is required.')
            .isHexadecimal().withMessage('Server Seed must be a hexadecimal string.')
            .isLength({ min: 64, max: 64 }).withMessage('Server Seed must be 64 characters long.'),
        body('clientSeed')
             .trim()
             .notEmpty().withMessage('Client Seed is required.')
             // Allow reasonable length hex or alphanumeric for client seed flexibility, adjust if needed
             .isString()
             .isLength({ min: 1, max: 128 }).withMessage('Client Seed length invalid.')
             // Optionally restrict characters: .matches(/^[a-f0-9]+$/i).withMessage('Client Seed must be hexadecimal.')
    ],
    handleValidationErrors, // Handle validation results
    async (req, res) => {
        // Use validated data
        const { roundId, serverSeed, clientSeed } = req.body;

        try {
            const round = await Round.findOne({ roundId: roundId, status: 'completed' })
                .populate('participants.user', 'username') // Need participants for ticket calculation
                .populate('winner', 'username')
                .lean(); // Use lean

            if (!round) {
                return res.status(404).json({ error: `Completed round #${roundId} not found.` });
            }

            // 1. Verify Server Seed Hash
            const providedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
            if (providedHash !== round.serverSeedHash) {
                return res.json({
                    verified: false,
                    reason: 'Server Seed Hash mismatch.',
                    expectedHash: round.serverSeedHash,
                    providedSeed: serverSeed,
                    calculatedHash: providedHash
                });
            }

            // 2. Verify Seeds Match Record (if round data contains them - sometimes verification happens before reveal)
             if (round.serverSeed && round.clientSeed) {
                 if (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed) {
                     return res.json({
                         verified: false,
                         reason: 'Provided seeds do not match the official round seeds.',
                         expectedServerSeed: round.serverSeed,
                         expectedClientSeed: round.clientSeed,
                         providedServerSeed: serverSeed,
                         providedClientSeed: clientSeed
                     });
                 }
             } else {
                 // Cannot fully verify against stored seeds yet, maybe round just finished
                 console.warn(`Verification attempt for round ${roundId} before seeds fully recorded?`);
             }


            // 3. Recalculate Winning Ticket using the *provided* seeds
            const combinedString = serverSeed + clientSeed;
            const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');

            // Verify calculated provable hash matches stored provable hash (if available)
            if (round.provableHash && calculatedProvableHash !== round.provableHash) {
                 return res.json({
                     verified: false,
                     reason: 'Calculated Provable Hash does not match recorded hash.',
                     expectedProvableHash: round.provableHash,
                     calculatedProvableHash: calculatedProvableHash,
                     combinedString: combinedString
                 });
            }

            const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
            const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;

            if (totalTickets <= 0) {
                return res.json({ verified: false, reason: 'Round had zero total tickets.' });
            }

            const calculatedWinningTicket = decimalFromHash % totalTickets;

            // 4. Compare Calculated vs Actual Ticket
            if (calculatedWinningTicket !== round.winningTicket) {
                return res.json({
                    verified: false,
                    reason: 'Calculated winning ticket does not match the recorded winning ticket.',
                    calculatedTicket: calculatedWinningTicket,
                    actualWinningTicket: round.winningTicket,
                    provableHashUsed: calculatedProvableHash, // Show hash used for calculation
                    totalTickets: totalTickets
                });
            }

            // If all checks pass
            res.json({
                verified: true,
                roundId: round.roundId,
                serverSeed: serverSeed, // Echo back provided seed
                serverSeedHash: round.serverSeedHash,
                clientSeed: clientSeed, // Echo back provided seed
                combinedString: combinedString, // Show combined string
                finalHash: calculatedProvableHash, // Show calculated hash
                winningTicket: calculatedWinningTicket,
                totalTickets: totalTickets,
                totalValue: round.totalValue, // Post-tax value
                winnerUsername: round.winner?.username || 'N/A'
            });

        } catch (err) {
            console.error(`Error verifying round ${roundId}:`, err);
            res.status(500).json({ error: 'Server error during verification.' });
        }
});


// --- Socket.io Connection Handling ---
io.on('connection', (socket) => {
    // console.log(`Client connected: ${socket.id}`); // Less verbose

    // Send current round data on connection request
    socket.on('requestRoundData', async () => { // Listen for explicit request
        try {
            // Re-use the logic from the API endpoint to get consistent data
            let roundToSend = null;
            if (currentRound?._id) {
                roundToSend = await Round.findById(currentRound._id)
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items')
                    .populate('winner', 'steamId username avatar')
                    .lean();
                 if (!roundToSend) { currentRound = null; } // Clear if not found
                 else { currentRound = roundToSend; } // Update memory
            }
            if (!roundToSend) {
                roundToSend = await Round.findOne({ status: 'active' })
                    .sort({ startTime: -1 })
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items')
                    .populate('winner', 'steamId username avatar')
                    .lean();
                if (roundToSend && !currentRound) {
                    currentRound = roundToSend;
                    console.log(`Restored active round ${currentRound.roundId} from DB on client socket request.`);
                    // Check and potentially start timer
                     if (currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                           startRoundTimer(true);
                     } else if (currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) {
                           startRoundTimer(false);
                     }
                }
            }

            const formattedData = formatRoundForClient(roundToSend);

            if (formattedData) {
                socket.emit('roundData', formattedData);
            } else {
                socket.emit('noActiveRound'); // Tell client no round is active
            }
        } catch (err) {
            console.error(`Error fetching round data for socket ${socket.id}:`, err);
            socket.emit('roundError', { error: 'Failed to load round data.' });
        }
    }); // End 'requestRoundData' listener


    socket.on('disconnect', (reason) => {
        // console.log(`Client disconnected: ${socket.id}. Reason: ${reason}`); // Less verbose
    });
});

// --- Server Startup ---
async function startApp() {
    console.log("Performing initial price cache refresh from rust.scmm.app...");
    await refreshPriceCache(); // Wait for the first refresh attempt

    // Schedule periodic cache refresh AFTER the first one is done
    // Wrap in try...catch to prevent interval crashing the app
    setInterval(async () => {
         try {
               await refreshPriceCache();
         } catch (refreshErr) {
               console.error("Error during scheduled price cache refresh:", refreshErr);
               // Continue running, rely on existing cache/fallbacks
         }
    }, PRICE_REFRESH_INTERVAL_MS);
    console.log(`Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);

    // Start HTTP server AFTER initial cache attempt
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log(`Site URL configured as: ${process.env.SITE_URL}`);

        // Bot status check (Initial round creation moved to login callback/ensureInitialRound)
        if (!isBotConfigured) { console.log("INFO: Steam Bot not configured. Trade features disabled."); }
        else if (!isBotReady) { console.log("INFO: Waiting for Steam Bot login attempt..."); }
        else { console.log("INFO: Steam Bot is ready."); } // If already ready at listen time
    });
}

startApp(); // Call the async startup function

// --- Graceful Shutdown ---
function gracefulShutdown() {
    console.log('Received shutdown signal. Closing server...');
    io.close(); // Close socket connections
    server.close(async () => { // Make callback async
        console.log('HTTP server closed.');
        try {
            await mongoose.connection.close(); // Use await for cleaner closing
            console.log('MongoDB connection closed.');
            process.exit(0); // Exit cleanly
        } catch (e) {
            console.error("Error closing MongoDB connection:", e);
            process.exit(1); // Exit with error on DB close failure
        }
    });

    // Force shutdown after a timeout
    setTimeout(() => {
        console.error('Could not close connections gracefully, forcing shutdown.');
        process.exit(1);
    }, 10000); // 10 seconds timeout
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown); // Handle Ctrl+C

// Basic Error Handling Middleware (Place LAST)
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    // Avoid sending stack trace in production
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.');
    // Avoid sending sensitive error details in production
    res.status(status).json({ error: message });
});
