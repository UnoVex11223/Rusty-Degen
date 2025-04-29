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
const { v4: uuidv4 } = require('uuid'); // For unique deposit identifiers
require('dotenv').config();

// --- Configuration Constants ---
const requiredEnvVars = [
    'MONGODB_URI', 'SESSION_SECRET', 'STEAM_API_KEY', 'SITE_URL',
    // Conditionally required if bot is intended to function
    'STEAM_USERNAME', 'STEAM_PASSWORD', 'STEAM_SHARED_SECRET', 'BOT_TRADE_URL', 'SITE_NAME'
    // STEAM_IDENTITY_SECRET is optional but needed for auto-confirming trades
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
const MAX_ITEMS_PER_DEPOSIT = parseInt(process.env.MAX_ITEMS_PER_DEPOSIT) || 20; // Limit items per single deposit trade
const TAX_MIN_PERCENT = 5;
const TAX_MAX_PERCENT = 10;
const MIN_POT_FOR_TAX = parseFloat(process.env.MIN_POT_FOR_TAX) || 100;

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
            "script-src": ["'self'", "/socket.io/socket.io.js", "'unsafe-inline'"], // Added unsafe-inline temporarily if needed for inline event handlers from HTML file
            "script-src-attr": ["'self'", "'unsafe-inline'"], // Consider removing unsafe-inline later
            "style-src": ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "'unsafe-inline'"],
            "img-src": [
                "'self'", "data:", "*.steamstatic.com", "*.akamai.steamstatic.com"
            ],
            "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            "connect-src": (() => {
                const sources = ["'self'"];
                const siteUrl = process.env.SITE_URL;
                if (siteUrl) {
                    try {
                        const url = new URL(siteUrl);
                        sources.push(`ws://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(`wss://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(siteUrl); // Allow connections TO the site URL itself
                    } catch (e) {
                        console.error("Invalid SITE_URL for CSP connect-src:", siteUrl, e);
                    }
                }
                sources.push("https://rust.scmm.app"); // For pricing
                 // Allow connections back to self for API calls (redundant if SITE_URL is set correctly)
                 // sources.push(process.env.SITE_URL || "'self'");
                return sources;
            })(),
             // IMPORTANT: Allow framing to steamcommunity.com for trade offers
             "frame-src": ["'self'", "https://steamcommunity.com"],
             // IMPORTANT: Allow frame ancestors from steamcommunity.com if needed for embedded scenarios
             "frame-ancestors": ["'self'", "https://steamcommunity.com"],
            "object-src": ["'none'"],
            "upgrade-insecure-requests": [],
        },
    })
);
// Add other specific helmet features if needed, e.g., HSTS
// app.use(helmet.hsts({ maxAge: 15552000, includeSubDomains: true }));

// Rate Limiting Setup
const generalApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many login attempts from this IP, please try again after 10 minutes', standardHeaders: true, legacyHeaders: false });
const sensitiveActionLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, message: 'Too many requests for this action, please try again after 5 minutes', standardHeaders: true, legacyHeaders: false });
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 10, message: 'Too many deposit attempts, please wait a minute.', standardHeaders: true, legacyHeaders: false }); // Stricter limit for deposit requests

// Apply general limiter to API routes
app.use('/api/', generalApiLimiter);

// Configure middleware
app.use(cors({ origin: process.env.SITE_URL || "*", credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public')); // Serves index.html, main.js, styles.css etc.
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // TODO: Use MongoStore in production
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
                { $set: userData, $setOnInsert: { steamId: profile.id, tradeUrl: '', createdAt: new Date(), pendingDepositOfferId: null } }, // Add pendingDepositOfferId on insert
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
        // process.exit(1); // Exit if cannot connect to DB
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
    banned: { type: Boolean, default: false },
    // Field to track pending deposit offer ID
    pendingDepositOfferId: { type: String, default: null, index: true } // Added index
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
        tickets: { type: Number, required: true, default: 0, min: 0 }     // Tickets based on value
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
    pollInterval: 10000, // Poll slightly faster for quicker deposit confirmations // Check for new offers every 10 seconds
    cancelTime: 10 * 60 * 1000, // Cancel outgoing offers after 10 minutes (e.g., deposit requests)
});
let isBotReady = false; // Track bot readiness
// Store pending deposit data { depositId: { userId, items, roundId, steamId } }
// TODO: Consider using Redis or DB for persistence if app restarts often
const pendingDeposits = new Map();

// --- 2FA Code Generation ---
function generateAuthCode() {
    const secret = process.env.STEAM_SHARED_SECRET;
    if (!secret) { console.error("STEAM_SHARED_SECRET missing. Cannot generate 2FA code."); return null; }
    try { return SteamTotp.generateAuthCode(secret); }
    catch (e) { console.error("Error generating 2FA code:", e); return null; }
}

// --- Steam Bot Login ---
// Using enhanced login logic with detailed error reporting
if (isBotConfigured) {
    const loginCredentials = {
        accountName: process.env.STEAM_USERNAME,
        password: process.env.STEAM_PASSWORD,
        twoFactorCode: generateAuthCode()
    };

    if (loginCredentials.twoFactorCode) {
        console.log(`Attempting Steam login for bot: ${loginCredentials.accountName}...`);
        // Add 'steamguard' parameter to potentially capture more info
        community.login(loginCredentials, (err, sessionID, cookies, steamguard) => {
            // Log the error object immediately for details, regardless if it exists
            if (err) {
                console.error('STEAM LOGIN ERROR (Callback Err Object):', {
                    message: err.message,
                    eresult: err.eresult, // EResult provides specific Steam error codes
                    emaildomain: err.emaildomain, // May indicate if email auth is needed
                });
            } else {
                console.log('Steam community.login callback received (no immediate error object reported).');
            }

            // Check if EITHER an error occurred OR the SteamID wasn't retrieved
            if (err || !community.steamID) {
                console.error(`CRITICAL LOGIN FAILURE: Login callback failed or community.steamID is undefined. Error: ${err ? err.message : 'N/A'}, SteamID: ${community.steamID}, EResult: ${err?.eresult}`);
                isBotReady = false; // Ensure bot is marked as not ready
                // Add specific failure hints
                if (err?.eresult === 5) console.warn('Login Failure Hint: Invalid Password? Check .env');
                if (err?.eresult === 65) console.warn('Login Failure Hint: Incorrect 2FA Code (Check Shared Secret/Server Time) or Account Rate Limit?');
                if (err?.eresult === 63) console.warn('Login Failure Hint: Account Logon Denied - Check Email Auth/Steam Guard settings via Browser?');
                return; // *** DO NOT PROCEED to manager.setCookies if login failed ***
            }

            // Only proceed if login was truly successful
            console.log(`Steam bot ${loginCredentials.accountName} logged in successfully (SteamID: ${community.steamID}). Attempting to set cookies for TradeOfferManager...`);

            manager.setCookies(cookies, (setCookieErr) => {
                if (setCookieErr) {
                    console.error('TradeOfferManager Error setting cookies:', { error: setCookieErr.message, stack: setCookieErr.stack });
                    isBotReady = false;
                    return;
                }
                console.log('TradeOfferManager cookies set successfully.');
                // Cookies are valid enough for the manager, now set for community actions too
                community.setCookies(cookies);
                // Set persona/games played AFTER cookies are confirmed set
                // community.gamesPlayed(process.env.SITE_NAME || 'RustyDegen'); // Often cosmetic
                // community.setPersona(SteamCommunity.EPersonaState.Online); // Set online status
                isBotReady = true; // Mark bot as ready ONLY after cookies are set for BOTH manager and community
                console.log("Steam Bot is ready.");
                // Now that the bot is ready, attempt to create the first round if none exists
                ensureInitialRound();
            });

            // Auto-accept friend requests (can run once login is confirmed valid)
            community.on('friendRelationship', (steamID, relationship) => {
                if (relationship === SteamCommunity.EFriendRelationship.RequestRecipient) {
                    console.log(`Received friend request from ${steamID}. Accepting...`);
                    community.addFriend(steamID, (friendErr) => { // Use different variable name
                        if (friendErr) console.error(`Error accepting friend request from ${steamID}:`, friendErr);
                        else console.log(`Accepted friend request from ${steamID}.`);
                    });
                }
            });
        }); // End community.login callback
    } else {
        console.warn("Could not generate 2FA code. Steam Bot login skipped.");
        isBotReady = false;
    }
} // End if (isBotConfigured)

// --- Active Round Data ---
let currentRound = null;
let roundTimer = null; // Interval ID for the countdown
let isRolling = false; // Flag to prevent actions during winner selection/payout

// --- Deposit Security Token Store ---
// REMOVED: depositTokens object and verifyDepositToken function are no longer needed for the new flow

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
        io.emit('roundCreated', {
            roundId: newRound.roundId,
            serverSeedHash: newRound.serverSeedHash,
            timeLeft: ROUND_DURATION, // Initial time
            totalValue: 0,
            participants: [],
            items: []
        });

        console.log(`--- Round ${newRound.roundId} created and active ---`);
        return newRound.toObject(); // Return plain object representation

    } catch (err) {
        console.error('FATAL: Error creating new round:', err);
        setTimeout(createNewRound, 10000); // Retry after 10 seconds
        return null;
    }
}

// Ensure an initial round exists on startup *after* bot is ready
async function ensureInitialRound() {
    // Only run if bot is configured AND bot is ready
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
                    // Decide if timer needs starting
                    if (currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        startRoundTimer(true); // Start timer based on remaining time if not already running
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
        calculatedEndTime = new Date(currentRound.endTime);
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
            await endRound(); // Trigger round ending process
        }
    }, 1000);
}

/**
 * Handles the process of ending the current round, calculating the winner, applying tax, and initiating payout.
 */
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
            .populate('participants.user')
            .populate('items')
            .lean();

        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);
        if (round.status !== 'rolling') {
             console.warn(`Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Aborting endRound.`);
             isRolling = false; return;
            }
        currentRound = round; // Update in-memory state

        // --- Handle Empty Round ---
        if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            console.log(`Round ${round.roundId} ended with no valid participants or value.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date() } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants." });
            isRolling = false;
            setTimeout(createNewRound, 5000);
            return;
        }

        // --- Tax Calculation ---
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

        // --- Winner Calculation (Provably Fair) ---
        const clientSeed = crypto.randomBytes(16).toString('hex');
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16);
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);
        if (totalTickets <= 0) throw new Error(`Cannot determine winner: Total tickets is zero or invalid for round ${round.roundId}.`);
        const winningTicket = decimalFromHash % totalTickets;
        let cumulativeTickets = 0;
        let winner = null;
        for (const participant of round.participants) {
            if (!participant?.tickets || !participant.user) continue;
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winner = participant.user; break;
            }
        }
        if (!winner) throw new Error(`Winner selection failed for round ${round.roundId}. Winning Ticket: ${winningTicket}, Total Tickets: ${totalTickets}`);

        // --- Prepare Final Database Update ---
        const finalUpdateData = {
            status: 'completed', completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winner._id,
            taxAmount: taxAmount, taxedItems: taxedItemsInfo, totalValue: finalTotalValue,
            items: finalItems.map(i => i._id) // Store IDs of remaining items
        };
        await Round.updateOne({ _id: roundMongoId }, { $set: finalUpdateData });
        console.log(`Round ${round.roundId} completed. Winner: ${winner.username} (Ticket: ${winningTicket}/${totalTickets}, Value: $${finalTotalValue.toFixed(2)})`);

        // Emit winner information
        io.emit('roundWinner', {
            roundId: round.roundId,
            winner: { id: winner._id, steamId: winner.steamId, username: winner.username, avatar: winner.avatar },
            winningTicket: winningTicket, totalValue: finalTotalValue, totalTickets: totalTickets,
            serverSeed: round.serverSeed, clientSeed: clientSeed, provableHash: provableHash, serverSeedHash: round.serverSeedHash
        });

        // --- Initiate Payout ---
        await sendWinningTradeOffer(round, winner, finalItems); // Pass the filtered items

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
/**
 * Sends the winning trade offer to the winner.
 * MODIFIED: Includes offerURL in the socket emit.
 * @param {object} round - The completed Round lean object.
 * @param {object} winner - The populated User lean object for the winner.
 * @param {Array} itemsToSend - Array of lean Item objects to send (after tax).
 */
async function sendWinningTradeOffer(round, winner, itemsToSend) {
    // Critical Check: Ensure bot is ready before attempting to send
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
    // Check itemsToSend directly
    if (!itemsToSend || itemsToSend.length === 0) {
        console.log(`PAYOUT_INFO: No items to send for round ${round.roundId} (possibly all taxed or error).`);
        // Use final round value (post-tax) for check
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

        // Use identity secret for auto-confirmation if available
        const identitySecret = process.env.STEAM_IDENTITY_SECRET;
        offer.send(!!identitySecret, (err, status) => { // Pass true/false based on secret existence
            if (err) {
                // Handle specific errors like invalid trade URL token
                if (err.message.includes('revoked') || err.message.includes('invalid') || err.eresult === 26) { // EResult 26 is often invalid token
                    console.error(`PAYOUT_ERROR: Trade offer failed for round ${round.roundId}: Invalid Trade URL/Token for ${winner.username}. Offer ID: ${offer.id}`);
                    io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Your Trade URL is invalid or expired. Please update it to receive winnings.' });
                } else if (err.eresult === 15 || err.eresult === 16) { // EResult 15/16 often inventory full/private
                    console.error(`PAYOUT_ERROR: Trade offer failed for round ${round.roundId}: Winner's inventory might be full or private. Offer ID: ${offer.id}`);
                    io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Could not send winnings. Ensure your Steam inventory is public and not full.' });
                } else if (err.message?.includes('escrow') || err.eresult === 11) { // EResult 11 is often escrow
                   console.warn(`PAYOUT_WARN: Offer ${offer.id} sent but likely held in escrow. Winner: ${winner.username}`);
                   // Notify user about potential escrow
                   io.emit('notification', { type: 'warning', userId: winner._id.toString(), message: `Winnings sent (Offer #${offer.id}), but may be held in escrow by Steam. Ensure Steam Guard Mobile Authenticator has been active for 7 days.` });
                   // Still emit tradeOfferSent event below, as the offer *was* sent initially
                 } else {
                    console.error(`PAYOUT_ERROR: Error sending trade offer ${offer.id} for round ${round.roundId}: EResult ${err.eresult} - ${err.message}`);
                     // Send generic error to user
                      io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Error sending winnings for round ${round.roundId}. Please contact support.` });
                }
                // TODO: Implement retry logic or manual intervention queue for failed payouts
                return; // Stop if send fails initially
            }

            // Send was successful (or pending confirmation)
            console.log(`PAYOUT_SUCCESS: Trade offer ${offer.id} sent to ${winner.username} for round ${round.roundId}. Status: ${status}`);

             // Construct the offer URL regardless of status (it exists once sent)
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;

            // Notify client about the sent offer, including the URL
            io.emit('tradeOfferSent', {
                roundId: round.roundId,
                userId: winner._id.toString(),
                username: winner.username,
                offerId: offer.id,
                offerURL: offerURL, // <-- ADDED URL
                status: status // Include status if available/useful
            });

            // Handle confirmation pending status if needed (library handles auto-confirm)
             if (status === 'pending' || status === 'pendingConfirmation') { // Check both possible statuses
                 console.log(`Offer #${offer.id} requires confirmation (Status: ${status}). Check mobile authenticator if auto-confirmation is not setup or failed.`);
                 if (!identitySecret) {
                     // If no identitySecret, confirmation was never attempted automatically.
                     console.warn(`Offer #${offer.id} requires confirmation, but STEAM_IDENTITY_SECRET is not provided for auto-confirmation.`);
                     io.emit('notification', { type: 'info', userId: winner._id.toString(), message: `Winnings sent (Offer #${offer.id}), but require confirmation in Steam.` });
                 } else {
                     // The library likely tried and failed, or confirmation is genuinely needed.
                     io.emit('notification', { type: 'warning', userId: winner._id.toString(), message: `Winnings sent (Offer #${offer.id}), but confirmation may be needed in Steam.` });
                 }
             }
        }); // End offer.send callback

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

// Helper Middleware for validation results
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        // Log validation errors for debugging
        console.warn("Validation Errors:", errors.array());
        // Send only the first error message for simplicity, or customize as needed
        return res.status(400).json({ error: errors.array()[0].msg });
    }
    next();
};

// GET User Profile
app.get('/api/user', ensureAuthenticated, (req, res) => {
    // Return only necessary, non-sensitive user data
    // Add pendingDepositOfferId if you want frontend to know about it
    const { _id, steamId, username, avatar, tradeUrl, balance, createdAt, pendingDepositOfferId } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, balance, createdAt, pendingDepositOfferId });
});

// POST Update Trade URL
app.post('/api/user/tradeurl',
    sensitiveActionLimiter, // Apply stricter rate limit
    ensureAuthenticated,
    [ // Validation Rules
        body('tradeUrl')
            .trim()
            // Allow empty string to clear the trade URL
            .custom((value) => {
                if (value === '') return true; // Allow empty string
                // If not empty, validate URL format
                const urlPattern = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/;
                if (!urlPattern.test(value)) {
                    throw new Error('Invalid Steam Trade URL format. Must include partner and token, or be empty.');
                }
                return true;
            })
    ],
    handleValidationErrors, // Handle validation results
    async (req, res) => {
        // Validation passed if we reach here
        const { tradeUrl } = req.body; // tradeUrl will be trimmed and either valid or empty string

        try {
            const updatedUser = await User.findByIdAndUpdate(
                req.user._id,
                { tradeUrl: tradeUrl }, // Set the validated or empty trade URL
                { new: true, runValidators: true } // Return the updated document and run schema validators
            );
            if (!updatedUser) {
                return res.status(404).json({ error: 'User not found.' });
            }
            console.log(`Trade URL updated for user: ${updatedUser.username}`);
            res.json({ success: true, tradeUrl: updatedUser.tradeUrl });
        } catch (err) {
            // Check for Mongoose validation error (e.g., from schema match - unlikely with custom validator)
            if (err.name === 'ValidationError') {
                 console.error(`Trade URL Validation Error (Mongoose) for user ${req.user._id}:`, err.message);
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
        // Use manager.getUserInventoryContents
        const inventory = await new Promise((resolve, reject) => {
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                // >>> MODIFICATION START <<<
                if (err) {
                    // Check specific EResults first
                    if (err.eresult === 50) { // Account Locked/Banned
                        return reject({ // Reject with custom object
                            status: 403, // Forbidden
                            eresult: err.eresult,
                            message: 'Your Steam account has a trade restriction (Locked/Banned).',
                            logMessage: `Inventory Fetch Denied: User ${req.user.username} account is locked/banned (EResult 50).`
                        });
                    }
                    // Add other specific ban/lock EResult checks here if known (e.g., 9 for VAC banned on game?)

                    // Check for private profile / standard access denied
                    if (err.message?.includes('profile is private') || err.eresult === 15) { // EResult 15 is often Access Denied / Private
                        return reject({ // Reject with custom object
                            status: 403, // Forbidden
                            eresult: err.eresult,
                            message: 'Your Steam inventory is private. Please set it to public.',
                            logMessage: `Inventory Fetch Denied: User ${req.user.username} inventory is private (EResult ${err.eresult}).`
                        });
                    }

                    // Log other errors generically
                    console.error(`Inventory Fetch Error (Manager): User ${req.user.steamId}: EResult ${err.eresult} - ${err.message || err}`);
                    return reject({ // Reject with custom object
                        status: 503, // Service Unavailable (Steam issue)
                        eresult: err.eresult,
                        message: `Could not fetch inventory. Steam might be busy. (Code: ${err.eresult || 'N/A'})`,
                        logMessage: `Generic Inventory Fetch Error: EResult ${err.eresult}`
                    });
                }
                // >>> MODIFICATION END <<<
                resolve(inv || []); // Resolve with empty array if null/undefined
            });
        });

        console.log(`Raw inventory items count for ${req.user.username}: ${inventory?.length}`);

        if (!inventory?.length) return res.json([]);

        // Process items: get prices, format data
        const validItems = inventory
            .map(item => {
                const itemName = item.market_hash_name;
                let price = 0;
                if (itemName) price = getItemPrice(itemName);
                else console.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`);

                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

                if (!item.assetid || !item.icon_url || !itemName) { // Ensure name exists too
                    console.warn(`Inventory item missing required properties: assetId ${item?.assetid}, Name ${itemName}, Icon ${item?.icon_url}`);
                    return null;
                }
                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`;

                return {
                    assetId: item.assetid,
                    name: itemName, // Use market_hash_name
                    displayName: item.name,
                    image: imageUrl,
                    price: finalPrice,
                    tradable: item.tradable,
                    marketable: item.marketable
                };
            })
            .filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE); // Filter nulls, non-tradables, low value

        console.log(`Processed validItems count for ${req.user.username}: ${validItems.length}`);
        res.json(validItems);

    } catch (err) {
        // Catch errors rejected from the promise (our custom objects)
        if (err && err.logMessage) { // Check if it's our custom error object
            console.warn(err.logMessage); // Log the specific warning/error
            return res.status(err.status || 500).json({ error: err.message }); // Send the user-friendly message
        } else {
            // Catch other unexpected errors
            console.error(`Unexpected Error in /api/inventory for ${req.user?.username || req.user?.steamId}:`, err);
            res.status(500).json({ error: 'Server error fetching inventory.' });
        }
    }
});

// --- Deposit & Game Interaction Routes ---

// POST Initiate Deposit (New Flow - Creates and sends bot offer)
app.post('/api/deposit',
    depositLimiter, // Apply deposit-specific rate limit
    ensureAuthenticated,
    [ // Validation
        body('items')
            .isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT })
            .withMessage(`You must select between 1 and ${MAX_ITEMS_PER_DEPOSIT} items to deposit.`),
        body('items.*.assetId').isString().notEmpty().withMessage('Invalid item data (assetId).'),
        body('items.*.name').isString().notEmpty().withMessage('Invalid item data (name).'),
        body('items.*.price').isNumeric().withMessage('Invalid item data (price).') // Ensure price is numeric
    ],
    handleValidationErrors,
    async (req, res) => {
        const user = req.user;
        const depositItems = req.body.items;

        if (!isBotReady) return res.status(503).json({ error: "Deposit service temporarily unavailable (bot offline)." });
        if (isRolling) return res.status(400).json({ error: "Cannot deposit: Round is currently rolling." });
        if (!currentRound || currentRound.status !== 'active') return res.status(400).json({ error: "Cannot deposit: No active round." });
        if (!user.tradeUrl) return res.status(400).json({ error: "Please set your Steam Trade URL in your profile before depositing." });

        // Check if user already has a pending deposit offer
        if (user.pendingDepositOfferId) {
            console.warn(`User ${user.username} attempted deposit while another is pending (${user.pendingDepositOfferId}).`);
            // Maybe check offer status before rejecting outright? For now, reject.
            // Check offer status with steam: manager.getOffer(user.pendingDepositOfferId, ...)
            // If offer is still Active, return error. If Canceled/Invalid/Declined/Accepted, clear the DB field and allow new deposit.
            // For simplicity now: Assume it's still active if the field is set.
             return res.status(409).json({ error: `You already have a pending deposit offer (#${user.pendingDepositOfferId}). Please accept or decline it first.` });
        }

        // Check round limits
        const currentItemCountInPot = await Item.countDocuments({ roundId: currentRound._id });
        const currentParticipantCount = currentRound.participants.length; // Assumes participants array is accurate
        if (currentItemCountInPot + depositItems.length > MAX_ITEMS_PER_POT) {
            return res.status(400).json({ error: `Cannot deposit: Pot is full (Max ${MAX_ITEMS_PER_POT} items).` });
        }
        // Add participant limit check if necessary (using participant count)
        // Find if user is already a participant
        const isExistingParticipant = currentRound.participants.some(p => p.user?.toString() === user._id.toString());
        if (!isExistingParticipant && currentParticipantCount >= MAX_PARTICIPANTS) {
             return res.status(400).json({ error: `Cannot deposit: Round is full (Max ${MAX_PARTICIPANTS} participants).` });
        }

        // Recalculate total value based on *cached* prices on the server-side
        let totalDepositValue = 0;
        const itemsForOffer = depositItems.map(item => {
            const serverPrice = getItemPrice(item.name);
            if (serverPrice < MIN_ITEM_VALUE) {
                throw new Error(`Item "${item.name}" is below minimum value.`); // This will be caught below
            }
            totalDepositValue += serverPrice;
            return {
                assetid: item.assetId,
                appid: RUST_APP_ID,
                contextid: RUST_CONTEXT_ID,
                // Store price and name for later use if offer is accepted
                price: serverPrice,
                name: item.name
            };
        });

        if (totalDepositValue <= 0) {
            return res.status(400).json({ error: "Deposit value must be greater than zero." });
        }

        const uniqueDepositId = uuidv4(); // Generate unique ID for this deposit attempt

        try {
            const offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsForOffer.map(i => ({ assetid: i.assetid, appid: i.appid, contextid: i.contextid }))); // Map structure for addTheirItems
            offer.setMessage(`Deposit for Round #${currentRound.roundId} on ${process.env.SITE_NAME || 'RustyDegen'}. Deposit ID: ${uniqueDepositId}. Please accept to enter.`);

            // Send the offer (no auto-confirm needed for incoming)
            offer.send((err, status) => {
                if (err) {
                    // Handle specific errors related to trade offer creation/sending
                    if (err.message.includes('cannot send trade offers')) {
                        console.error(`Deposit Error (Offer Send): Bot cannot send offers. Check bot restrictions. User: ${user.username}`);
                        return res.status(503).json({ error: 'Deposit failed: Bot cannot send trade offers currently.' });
                    } else if (err.message.includes('items unavailable') || err.eresult === 10 || err.eresult === 26) { // Items unavailable or revoked/token issue
                        console.warn(`Deposit Error (Offer Send): Items unavailable or trade URL issue for ${user.username}. EResult: ${err.eresult}`);
                        return res.status(400).json({ error: 'Deposit failed: Some items are unavailable, or your Trade URL might be invalid. Refresh inventory and check URL.' });
                    } else if (err.eresult === 15 || err.eresult === 16) { // Target inventory full/private - should not happen for bot sending *to* user unless user has restrictions?
                         console.warn(`Deposit Error (Offer Send): User ${user.username} inventory issue? EResult: ${err.eresult}`);
                         return res.status(400).json({ error: 'Deposit failed: Check if your Steam inventory is public and not full.' });
                    } else if (err.eresult === 50) { // User account locked/banned
                         console.warn(`Deposit Error (Offer Send): User ${user.username} account locked/banned (EResult 50).`);
                         return res.status(403).json({ error: 'Deposit failed: Your Steam account is restricted (locked/banned).' });
                    } else {
                        console.error(`Deposit Error (Offer Send) for User ${user.username}, Offer ID (if created): ${offer.id}. EResult ${err.eresult} - Error:`, err);
                        return res.status(500).json({ error: 'Deposit failed: Could not send trade offer. Try again later.' });
                    }
                }

                console.log(`Deposit offer ${offer.id} sent to ${user.username} for round ${currentRound.roundId}. Status: ${status}. Deposit ID: ${uniqueDepositId}`);

                // --- Important: Store Offer ID and Deposit Data ---
                // 1. Store pending offer ID on User document
                 User.findByIdAndUpdate(user._id, { $set: { pendingDepositOfferId: offer.id } }, { new: true })
                    .then(updatedUser => {
                        if (!updatedUser) console.error(`Failed to store pending offer ID ${offer.id} for user ${user._id}`);
                        else console.log(`Stored pending offer ID ${offer.id} for user ${updatedUser.username}`);
                    })
                    .catch(dbErr => console.error(`DB Error storing pending offer ID ${offer.id} for user ${user._id}:`, dbErr));

                // 2. Store deposit details temporarily (e.g., in memory map) linked to the offer ID
                 pendingDeposits.set(offer.id, {
                     userId: user._id, // Store MongoDB ID
                     steamId: user.steamId, // Store SteamID for quick lookup in handler
                     items: itemsForOffer, // Items with server-side validated price
                     totalValue: totalDepositValue,
                     roundId: currentRound._id, // Store MongoDB ID of the round
                     uniqueDepositId: uniqueDepositId, // Store the unique ID
                     offerCreatedTime: Date.now()
                 });

                 // Construct offer URL
                 const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;

                // Respond to client with success and offer details
                res.status(200).json({
                    success: true,
                    message: 'Deposit offer sent! Please accept it on Steam.',
                    offerId: offer.id,
                    offerURL: offerURL // Send URL to frontend
                });
            }); // end offer.send

        } catch (err) {
            // Catch errors from price checks or offer creation setup
            console.error(`Error initiating deposit for ${user.username}:`, err.message);
            res.status(400).json({ error: err.message || 'Failed to initiate deposit.' });
        }
    });

// --- Trade Offer Manager Event Handlers ---

// When the bot receives a new trade offer (IGNORE - we only care about SENT offers being accepted)
manager.on('newOffer', offer => {
    console.log(`Received unwanted incoming trade offer #${offer.id} from ${offer.partner.getSteamID64()}. Declining.`);
    offer.decline(err => {
        if (err) console.error(`Error declining unwanted offer #${offer.id}:`, err);
    });
});

// When the state of a SENT offer changes (this is key for deposits)
manager.on('sentOfferChanged', async (offer, oldState) => {
    const offerId = offer.id;
    const partnerSteamId = offer.partner.getSteamID64(); // SteamID of the user
    const newState = offer.state; // Current state

    console.log(`Sent Offer Changed: ID ${offerId}, Partner: ${partnerSteamId}, Old State: ${TradeOfferManager.ETradeOfferState[oldState]}, New State: ${TradeOfferManager.ETradeOfferState[newState]}`);

    // Check if this offer ID corresponds to a known pending deposit
    const depositData = pendingDeposits.get(offerId);
    if (!depositData) {
        // This offer wasn't initiated by our deposit system, or data was lost. Ignore.
        // console.log(`Offer ${offerId} state changed, but no pending deposit data found. Ignoring.`);
        return;
    }

    // --- Offer Accepted: Process the Deposit ---
    if (newState === TradeOfferManager.ETradeOfferState.Accepted) {
        console.log(`Deposit offer ${offerId} ACCEPTED by ${partnerSteamId}. Processing items for round ${depositData.roundId}...`);

        // Critical: Prevent double processing if event fires multiple times
        if (pendingDeposits.has(offerId)) {
            pendingDeposits.delete(offerId); // Remove from pending map *immediately* to prevent race conditions
            await handleNewDeposit(offer, depositData); // Process the deposit
        } else {
             console.warn(`Offer ${offerId} accepted, but already processed or removed from pending map. Skipping.`);
        }

        // Clean up pending offer ID on user regardless
        await User.findOneAndUpdate({ steamId: partnerSteamId }, { $set: { pendingDepositOfferId: null } })
             .catch(err => console.error(`Error clearing pending offer ID ${offerId} for user ${partnerSteamId} after acceptance:`, err));


    } else if ([
        TradeOfferManager.ETradeOfferState.Declined,
        TradeOfferManager.ETradeOfferState.Canceled, // Could be canceled by bot timer or user
        TradeOfferManager.ETradeOfferState.InvalidItems, // Items became unavailable after offer sent
        TradeOfferManager.ETradeOfferState.Expired,
        TradeOfferManager.ETradeOfferState.Countered
    ].includes(newState)) {
        // --- Offer NOT Accepted ---
        console.log(`Deposit offer ${offerId} ended without acceptance (State: ${TradeOfferManager.ETradeOfferState[newState]}) for ${partnerSteamId}.`);
        // Remove from pending map
        pendingDeposits.delete(offerId);
        // Clean up pending offer ID on user document
        await User.findOneAndUpdate({ steamId: partnerSteamId }, { $set: { pendingDepositOfferId: null } })
            .then(() => console.log(`Cleared pending offer ID ${offerId} for user ${partnerSteamId} due to non-acceptance.`))
            .catch(err => console.error(`Error clearing pending offer ID ${offerId} for user ${partnerSteamId} after non-acceptance:`, err));
        // Notify user via socket if possible/needed
        io.to(partnerSteamId).emit('notification', { type: 'info', message: `Your deposit offer #${offerId} was ${TradeOfferManager.ETradeOfferState[newState]}.` });

    } else if (newState === TradeOfferManager.ETradeOfferState.Active) {
        // Offer is still active, user hasn't accepted/declined yet. No action needed here.
        // console.log(`Offer ${offerId} remains active.`);
    } else {
        // Handle other states if necessary (e.g., InEscrow might need notification)
        console.log(`Offer ${offerId} changed to unhandled state: ${TradeOfferManager.ETradeOfferState[newState]}.`);
         // If escrow state is relevant, handle it here
         if (newState === TradeOfferManager.ETradeOfferState.InEscrow) {
             console.warn(`Offer ${offerId} is in escrow. Deposit cannot complete.`);
             // Remove from pending, clear DB, notify user
             pendingDeposits.delete(offerId);
             await User.findOneAndUpdate({ steamId: partnerSteamId }, { $set: { pendingDepositOfferId: null } })
                .catch(err => console.error(`Error clearing pending offer ID ${offerId} for escrow state:`, err));
             io.to(partnerSteamId).emit('notification', { type: 'error', message: `Your deposit offer #${offerId} is held in escrow by Steam and cannot be processed.` });
         }
    }
});

// Handle confirmation needs for *outgoing* offers (payouts)
manager.on('pollData', pollData => {
    if (process.env.STEAM_IDENTITY_SECRET && pollData && pollData.confirmations && pollData.confirmations.length > 0) {
        console.log(`Received ${pollData.confirmations.length} confirmations to process.`);
        const authCode = generateAuthCode(); // Generate fresh code
        if (authCode) {
            manager.acceptAllConfirmations(Date.now(), process.env.STEAM_IDENTITY_SECRET, authCode, (err, results) => {
                 if (err) { console.error("Error accepting confirmations:", err); }
                 else if (results) {
                     console.log("Confirmation results:", results);
                      results.forEach(result => {
                          if (result.success) { console.log(`Confirmation ${result.id} accepted successfully.`); }
                          else { console.error(`Confirmation ${result.id} failed: ${result.message}`); }
                      });
                 }
            });
        } else { console.warn("Could not generate auth code for confirmations."); }
    }
});

/**
 * Processes an accepted deposit offer: saves items, updates round, emits socket events.
 * @param {object} offer - The accepted TradeOffer object from the manager.
 * @param {object} depositData - The data stored in pendingDeposits map.
 */
async function handleNewDeposit(offer, depositData) {
    // Double check crucial data exists
     if (!depositData || !depositData.userId || !depositData.roundId || !depositData.items || !depositData.totalValue) {
         console.error(`CRITICAL: Missing deposit data for accepted offer ${offer.id}. Cannot process deposit.`);
         // Attempt to notify user if possible
         if (depositData?.steamId) {
            io.to(depositData.steamId).emit('notification', { type: 'error', message: `Server error processing your accepted deposit (#${offer.id}). Please contact support.` });
         }
         return;
     }

    const { userId, steamId, items: depositItems, totalValue, roundId } = depositData;
    const offerId = offer.id;

    try {
        // --- Database Operations within a Transaction (Optional but recommended) ---
        // Start transaction if using replica sets: const session = await mongoose.startSession(); session.startTransaction();
        // Pass { session } to all Mongoose operations

        // 1. Find the Depositing User
        const user = await User.findById(userId); //.session(session); // Add .session(session) if using transactions
        if (!user) throw new Error(`User ${userId} not found during deposit processing for offer ${offerId}.`);

        // 2. Find the Current Active Round (Verify it's still the correct one)
        const round = await Round.findById(roundId).populate('participants.user'); //.session(session); // Add .session(session) if using transactions
        if (!round || round.status !== 'active') {
            // This *shouldn't* happen if checks were done before sending, but handle defensively.
            // Round might have ended *just* as the offer was accepted.
            console.warn(`Deposit offer ${offerId} accepted for round ${roundId}, but round is no longer active (Status: ${round?.status}). Refunding/handling needed.`);
            // TODO: Implement refund logic - create a new trade offer sending items back.
            io.to(steamId).emit('notification', { type: 'warning', message: `Your deposit (#${offerId}) was accepted after the round ended. Items will be returned.` });
            // Attempt to send items back
            // IMPORTANT: Ensure refund logic handles bot readiness and potential errors
            await sendRefundOffer(user, depositItems, offerId, "Round ended before deposit processed");
            // await session.abortTransaction(); session.endSession(); // Abort transaction if used
            return; // Stop processing this deposit
        }

        // --- Create Item Documents ---
        const itemsToSave = depositItems.map(itemData => ({
            assetId: itemData.assetid,
            name: itemData.name, // Use name from depositData
            price: itemData.price, // Use price from depositData (server-verified)
            image: `https://community.akamai.steamstatic.com/economy/image/${offer.itemsToReceive.find(i => i.assetid === itemData.assetid)?.icon_url || ''}`, // Get image URL from actual received items
            owner: user._id,
            roundId: round._id,
            depositedAt: new Date()
        }));

        const savedItems = await Item.insertMany(itemsToSave); // Add { session } if using transactions
        const savedItemIds = savedItems.map(item => item._id);

        // --- Update Round ---
        const ticketsEarned = Math.floor(totalValue / TICKET_VALUE_RATIO); // Calculate tickets based on server-verified value

        // Check if user is already a participant
        const participantIndex = round.participants.findIndex(p => p.user?._id.toString() === user._id.toString());

        let updatedParticipants;
        if (participantIndex > -1) {
            // Update existing participant
            round.participants[participantIndex].itemsValue += totalValue;
            round.participants[participantIndex].tickets += ticketsEarned;
            updatedParticipants = round.participants;
        } else {
            // Add new participant
            updatedParticipants = [
                ...round.participants,
                { user: user._id, itemsValue: totalValue, tickets: ticketsEarned }
            ];
             // If this is the FIRST participant, start the round timer
             if (updatedParticipants.length === 1 && !roundTimer) {
                 console.log(`First deposit in round ${round.roundId}. Starting timer.`);
                 startRoundTimer(false); // Start fresh timer
             }
        }

        // Update round totals and arrays atomically
        const updateResult = await Round.updateOne(
            { _id: round._id },
            {
                $inc: { totalValue: totalValue },
                $push: { items: { $each: savedItemIds } }, // Add new item IDs
                $set: { participants: updatedParticipants } // Overwrite participants array
            }
            // { session } // Add session if using transactions
        );

        if (updateResult.modifiedCount === 0 && updateResult.matchedCount === 1) {
             console.warn(`Round ${round.roundId} update did not modify document, though matched. Possible concurrency issue?`);
             // Consider if this needs intervention or if it's okay.
        } else if (updateResult.matchedCount === 0) {
             throw new Error(`Failed to update round ${round.roundId} during deposit processing - round not found.`);
        }


        // --- Commit Transaction (if using) ---
        // await session.commitTransaction();
        // session.endSession();

        // --- Emit Socket Updates ---
        const participantData = {
            user: { id: user._id, steamId: user.steamId, username: user.username, avatar: user.avatar },
            itemsValue: totalValue, // Value of *this* deposit
            tickets: ticketsEarned // Tickets from *this* deposit
        };
        const depositedItemsData = savedItems.map(item => ({
            id: item._id, assetId: item.assetId, name: item.name, image: item.image, price: item.price,
            owner: { username: user.username, avatar: user.avatar, steamId: user.steamId }
        }));

        io.emit('newDeposit', {
            roundId: round.roundId,
            participant: participantData, // Data about the user and this deposit's value/tickets
            items: depositedItemsData,    // Details of the deposited items
            updatedTotalValue: round.totalValue + totalValue, // Reflect new total (fetch updated round if needed for accuracy)
             updatedParticipants: updatedParticipants.map(p => ({ // Send updated list snapshot
                 user: { id: p.user?._id, steamId: p.user?.steamId, username: p.user?.username, avatar: p.user?.avatar },
                 itemsValue: p.itemsValue,
                 tickets: p.tickets
             }))
        });

        // Send success notification to the specific user
        io.to(steamId).emit('notification', { type: 'success', message: `Deposit (#${offerId}) successful! $${totalValue.toFixed(2)} added to the pot.` });

        console.log(`Successfully processed deposit ${offerId} for ${user.username}. Value: $${totalValue.toFixed(2)}, Tickets: ${ticketsEarned}.`);

    } catch (error) {
        console.error(`CRITICAL ERROR processing accepted deposit ${offerId} (User: ${steamId}):`, error);
        // --- Rollback Transaction (if using) ---
        // await session.abortTransaction();
        // session.endSession();

        // --- Attempt to Refund Items ---
        // TODO: Implement robust refund logic. This is complex because the items *are* now in the bot's inventory.
        io.to(steamId).emit('notification', { type: 'error', message: `Server error processing your accepted deposit (#${offerId}). Items may need manual return. Contact support.` });
        // Attempt refund (pass original depositItems structure if possible)
        if (depositData?.items) {
            const userForRefund = await User.findOne({ steamId: steamId }).lean(); // Need user object for trade URL
            if (userForRefund) {
                await sendRefundOffer(userForRefund, depositData.items, offerId, "Server error during deposit processing");
            } else {
                 console.error(`Cannot refund offer ${offerId} - User ${steamId} not found.`);
            }
        }

        // Remove potentially partially saved items? Or leave them for manual reconciliation? Difficult decision.
        // If items were saved but round update failed, the state is inconsistent.
    }
}

/**
 * Attempts to send a refund trade offer back to the user.
 * @param {object} user - User object (lean or Mongoose) with steamId and tradeUrl.
 * @param {Array} itemsToRefund - Array of item data ({ assetid, appid, contextid }).
 * @param {string} originalOfferId - The ID of the deposit offer being refunded.
 * @param {string} reason - Reason for the refund.
 */
async function sendRefundOffer(user, itemsToRefund, originalOfferId, reason) {
    if (!isBotReady) {
        console.error(`REFUND_ERROR: Cannot refund offer ${originalOfferId} for ${user.username}: Bot is not ready.`);
        // Notify admin?
        return;
    }
    if (!user.tradeUrl) {
        console.error(`REFUND_ERROR: Cannot refund offer ${originalOfferId}: User ${user.username} has no Trade URL.`);
        return;
    }
    if (!itemsToRefund || itemsToRefund.length === 0) {
        console.error(`REFUND_ERROR: No items provided for refund related to offer ${originalOfferId}.`);
        return;
    }

    console.log(`Attempting to refund ${itemsToRefund.length} items for deposit ${originalOfferId} to ${user.username} (Reason: ${reason}).`);

    try {
        const offer = manager.createOffer(user.tradeUrl);
        // Ensure correct structure for addMyItems
        offer.addMyItems(itemsToRefund.map(item => ({
            assetid: item.assetid || item.assetId, // Handle both potential property names
            appid: item.appid || RUST_APP_ID,
            contextid: item.contextid || RUST_CONTEXT_ID
        })));
        offer.setMessage(`Refund for Deposit Offer #${originalOfferId}. Reason: ${reason}. Please accept.`);

        offer.send((err, status) => {
            if (err) {
                 console.error(`REFUND_ERROR: Failed to send refund offer for deposit ${originalOfferId} to ${user.username}. EResult ${err.eresult} - Error:`, err);
                 // TODO: Queue for manual refund? Notify admin?
                 io.to(user.steamId).emit('notification', { type: 'error', message: `Automated refund failed for deposit #${originalOfferId}. Please contact support.` });
            } else {
                 console.log(`Refund offer ${offer.id} sent successfully to ${user.username} for original deposit ${originalOfferId}. Status: ${status}.`);
                 io.to(user.steamId).emit('notification', { type: 'info', message: `Your items from deposit #${originalOfferId} are being returned due to an issue (${reason}). Please accept refund offer #${offer.id}.` });
            }
        });
    } catch (setupErr) {
        console.error(`REFUND_ERROR: Error setting up refund offer for deposit ${originalOfferId}:`, setupErr);
         io.to(user.steamId).emit('notification', { type: 'error', message: `Automated refund failed for deposit #${originalOfferId}. Please contact support.` });
    }
}


// GET Current Round State
app.get('/api/round', async (req, res) => {
    try {
        // Fetch the latest active or rolling round if currentRound isn't up-to-date
        let roundData = currentRound;
        if (!roundData || !['active', 'rolling'].includes(roundData.status)) {
            roundData = await Round.findOne({ status: { $in: ['active', 'rolling'] } })
                .populate('participants.user', 'steamId username avatar')
                .populate({
                    path: 'items',
                    populate: { path: 'owner', select: 'steamId username avatar' }
                })
                .sort('-startTime') // Get the most recent if multiple somehow exist
                .lean(); // Use lean for performance
            currentRound = roundData; // Update in-memory cache
        } else {
            // If currentRound exists and is active/rolling, ensure it's populated
            // This might be slightly less efficient than lean() above but ensures consistency if currentRound was manipulated
             const populatedRound = await Round.findById(currentRound._id)
                 .populate('participants.user', 'steamId username avatar')
                 .populate({
                     path: 'items',
                     populate: { path: 'owner', select: 'steamId username avatar' }
                 });
              if (populatedRound) currentRound = populatedRound.toObject(); // Update cache with populated version
              roundData = currentRound;
        }


        if (!roundData) {
            // If still no active round, maybe create one? Or return empty state?
            // For now, return indicating no active round
             return res.status(404).json({ error: 'No active round found.' });
            // Alternatively: Trigger round creation
            // if (isBotReady && !isRolling) {
            //     console.log("No active round found via API, attempting creation.");
            //     roundData = await createNewRound(); // Await creation
            //     if (!roundData) return res.status(500).json({ error: 'Failed to start new round.' });
            // } else {
            //     return res.status(503).json({ error: 'Game service temporarily unavailable.' });
            // }
        }

        // Calculate timeLeft if round is active
        let timeLeft = 0;
        if (roundData.status === 'active' && roundData.endTime) {
            timeLeft = Math.max(0, Math.floor((new Date(roundData.endTime).getTime() - Date.now()) / 1000));
        } else if (roundData.status === 'active' && !roundData.endTime && roundData.participants?.length > 0) {
            // Timer should have started but endTime wasn't set/persisted? Start it now.
             console.warn(`API fetch found active round ${roundData.roundId} with participants but no endTime. Starting timer.`);
             startRoundTimer(false);
             timeLeft = ROUND_DURATION; // Assume full duration initially
        } else if (roundData.status === 'active' && roundData.participants?.length === 0) {
             timeLeft = ROUND_DURATION; // Show full duration if no one joined yet
        }

        res.json({
            roundId: roundData.roundId,
            status: roundData.status,
            startTime: roundData.startTime,
            endTime: roundData.endTime,
            totalValue: roundData.totalValue,
            participants: roundData.participants?.map(p => ({ // Ensure participants exist
                 user: {
                     // id: p.user?._id, // Expose Mongo ID if needed, maybe not
                     steamId: p.user?.steamId || 'N/A', // Handle potential population issues
                     username: p.user?.username || 'Loading...',
                     avatar: p.user?.avatar || ''
                 },
                 itemsValue: p.itemsValue || 0,
                 tickets: p.tickets || 0
            })) || [],
            items: roundData.items?.map(item => ({ // Ensure items exist
                id: item._id, // Internal ID for potential client-side keying
                assetId: item.assetId,
                name: item.name,
                image: item.image,
                price: item.price,
                owner: { // Include basic owner info
                    steamId: item.owner?.steamId || 'N/A',
                    username: item.owner?.username || 'Loading...',
                    avatar: item.owner?.avatar || ''
                }
            })) || [],
            timeLeft: timeLeft,
            serverSeedHash: roundData.serverSeedHash
        });
    } catch (err) {
        console.error("Error fetching current round state:", err);
        res.status(500).json({ error: "Server error fetching round data." });
    }
});


// --- WebSocket Events ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Identify user if authenticated via session (requires middleware)
    // This part is tricky without express-socket.io-session or similar
    // For now, we might need client to send identify event after connection

    socket.on('identify', (steamId) => {
        // Use steamId to join a user-specific room
        if (steamId) {
             console.log(`Socket ${socket.id} identified as SteamID ${steamId}. Joining room.`);
             socket.join(steamId); // Join room named after the user's SteamID
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});


// --- Server Initialization ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on ${process.env.SITE_URL || `http://localhost:${PORT}`}`);
    // Initial price cache population and schedule periodic refresh
    refreshPriceCache().then(() => {
        console.log("Initial price cache populated.");
        setInterval(refreshPriceCache, PRICE_REFRESH_INTERVAL_MS);
        console.log(`Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);
        // Attempt to create the initial round *after* initial pricing is done and bot login attempted
        ensureInitialRound(); // Ensure this runs after bot login logic has executed
    }).catch(err => {
         console.error("CRITICAL: Failed initial price cache population. Check SCMM API status.", err);
         // Decide if server should exit or run with fallbacks
         // process.exit(1);
         ensureInitialRound(); // Still try to start round logic, might use fallbacks
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.info('SIGTERM signal received: Closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        mongoose.connection.close(false, () => { // Updated signature for newer Mongoose
             console.log('MongoDB connection closed');
             // Log out bot if possible/needed?
             // manager.logOff(); // Or community.logOff(); - Check library docs
            process.exit(0);
        });
    });
});

// TODO:
// - Robust error handling for all async operations
// - Transactional DB updates for deposits
// - Admin dashboard/controls
// - Consider Redis for session store and pending deposits map for persistence
// - Implement refund logic for edge cases (round ending during deposit)
// - More specific EResult handling in trade offer callbacks
// - Input validation/sanitization for all API endpoints (using express-validator)
// - Security headers (Helmet)
// - Rate limiting (express-rate-limit)
// - Logging improvements (use a dedicated logger like Winston)
// - Client-side error display and notifications
// - Favicon handling
// - Test trade URL validation thoroughly
// - Test various Steam API error conditions (private inventory, trade bans, bot issues)
