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
const { v4: uuidv4 } = require('uuid'); // <-- ADDED: For unique deposit identifiers
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
        tickets: { type: Number, required: true, default: 0, min: 0 }      // Tickets based on value
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

// --- Sanitizer Function ---
// REMOVED: sanitizeObjectProperties function (less critical with current libs, but can be re-added if specific vulnerabilities are found)

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

// START HERE FOR PART 2

/**
 * Sends the winning trade offer to the winner.
 * @param {object} round - The completed round object.
 * @param {object} winner - The winning user object.
 * @param {Array} itemsToSend - Array of item objects to send.
 */
async function sendWinningTradeOffer(round, winner, itemsToSend) {
    if (!isBotReady) { console.error(`Cannot send winnings for round ${round.roundId}: Bot is not ready.`); return; }
    if (!winner || !winner.tradeUrl) { console.error(`Cannot send winnings for round ${round.roundId}: Winner object invalid or missing trade URL.`); return; }
    if (!itemsToSend || itemsToSend.length === 0) { console.log(`No items to send for round ${round.roundId} (Pot value was $${round.totalValue.toFixed(2)} after tax). Skipping trade offer.`); return; }

    const offer = manager.createOffer(winner.tradeUrl);
    const offerItems = itemsToSend.map(item => ({
        assetid: item.assetId,
        appid: RUST_APP_ID,
        contextid: RUST_CONTEXT_ID
    }));

    offer.addMyItems(offerItems);
    offer.setMessage(`Congratulations! You won round ${round.roundId} on ${process.env.SITE_NAME || 'our site'}. Enjoy your winnings!`);

    console.log(`Attempting to send winnings trade offer for round ${round.roundId} to ${winner.username} (Trade URL: ${winner.tradeUrl.substring(0, 50)}...). Items: ${itemsToSend.length}`);

    offer.send(async (err, status) => {
        if (err) {
            console.error(`Error sending winning trade offer for round ${round.roundId} to ${winner.username}:`, {
                message: err.message,
                eresult: err.eresult,
                // You might get more info from `err.cause` depending on the version
                cause: err.cause ? { message: err.cause.message, ...err.cause } : undefined
            });
            io.to(winner.steamId).emit('notification', { type: 'error', message: `Error sending winnings for round ${round.roundId}. Please contact support.` });

            // TODO: Implement retry logic or alert admin
            try {
                await Round.updateOne({ _id: round._id }, { $set: { status: 'payout_error' } }); // Mark payout error status
            } catch (updateError) {
                console.error(`Failed to update round ${round.roundId} status to payout_error after send error:`, updateError);
            }
            return;
        }

        // Offer sent, need confirmation or timed out
        console.log(`Winnings trade offer ${offer.id} sent successfully for round ${round.roundId} to ${winner.username}. Status: ${status}. Offer ID: ${offer.id}`);
        io.to(winner.steamId).emit('notification', { type: 'info', message: `Winnings trade offer sent for round ${round.roundId}. Please accept it.` });

        // Save offer ID to round (optional, for tracking)
        try {
            await Round.updateOne({ _id: round._id }, { $set: { payoutOfferId: offer.id, status: 'payout_sent' } });
        } catch (updateError) {
            console.error(`Failed to save payoutOfferId ${offer.id} for round ${round.roundId}:`, updateError);
        }


        // Handle auto-confirmation if identity_secret is provided
        if (process.env.STEAM_IDENTITY_SECRET && (status === 'sent' || status === 'pendingConfirmation')) {
            console.log(`Attempting mobile confirmation for winnings offer ${offer.id}...`);
            community.acceptConfirmationForObject(process.env.STEAM_IDENTITY_SECRET, offer.id, (confErr) => {
                if (confErr) {
                    console.error(`Failed to confirm winnings offer ${offer.id}:`, confErr.message || confErr);
                    io.to(winner.steamId).emit('notification', { type: 'warning', message: `Winnings offer sent, but failed to auto-confirm. Please check your mobile confirmations.` });
                } else {
                    console.log(`Winnings offer ${offer.id} confirmed successfully via mobile.`);
                    // Note: Trade offer manager might emit 'sentOfferConfirmed' too, duplication possible.
                    try {
                        Round.updateOne({ _id: round._id }, { $set: { status: 'payout_confirmed_mobile' } }).catch(e => console.error("DB update error:",e));
                    } catch(dbErr){ console.error("Error updating round status after mobile confirm:", dbErr); }
                }
            });
        } else if (status === 'sent' || status === 'pendingConfirmation') {
            console.log(`Winnings offer ${offer.id} requires manual confirmation by the bot owner.`);
            // Consider alerting the bot owner here if needed
        }
    });
}

/**
 * Helper to get user inventory with specific error handling for restrictions.
 * Returns a Promise that resolves with the inventory or rejects with a structured error.
 * @param {string} steamId - The user's SteamID64.
 * @returns {Promise<Array<object>>} - Resolves with inventory items, rejects with {type, message}.
 */
function getUserInventory(steamId) {
    return new Promise((resolve, reject) => {
        if (!manager || !isBotReady) {
            return reject({ type: 'BOT_UNAVAILABLE', message: 'Trade manager is not ready.' });
        }
        manager.getUserInventoryContents(steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
            if (err) {
                console.warn(`Inventory Fetch Error for ${steamId}:`, { message: err.message, eresult: err.eresult }); // Log for debugging

                // --- START: Trade Restriction/Privacy Check ---
                if (err.eresult === 15) { // EResult 15: Access Denied (Often Private or Restricted)
                    // Try to distinguish based on message, though unreliable
                    if (err.message && err.message.toLowerCase().includes('private')) {
                        return reject({ type: 'INVENTORY_PRIVATE', message: 'Your Steam inventory is private. Please set it to public to deposit.' });
                    } else {
                        // Assume it's a restriction if not clearly private
                        return reject({ type: 'TRADE_RESTRICTED', message: 'Your Steam account has a trade restriction (hold, ban, or cooldown) preventing inventory access.' });
                    }
                } else if (err.eresult === 50) { // EResult 50: Account Locked Down
                    return reject({ type: 'TRADE_RESTRICTED', message: 'Your Steam account appears to be locked, preventing inventory access.' });
                }
                // Add other EResults if needed (e.g., 16=Timeout, 26=Limit Exceeded, but less likely for inventory view)

                // --- END: Trade Restriction/Privacy Check ---

                // Generic fetch error if not caught above
                return reject({ type: 'FETCH_ERROR', message: 'Failed to fetch inventory. Please try again later.' });
            }
            if (!inv) {
                return reject({ type: 'FETCH_ERROR', message: 'Inventory data received was empty.' });
            }
            resolve(inv); // Success
        });
    });
}

// --- Routes ---

// Authentication routes
app.get('/auth/steam', authLimiter, passport.authenticate('steam', { failureRedirect: '/' }));
app.get('/auth/steam/return', authLimiter, passport.authenticate('steam', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/'); // Redirect to homepage after successful login
});
app.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        req.session.destroy((destroyErr) => {
            if (destroyErr) {
                console.error("Error destroying session:", destroyErr);
                // Still redirect even if session destroy fails silently
            }
            res.clearCookie('connect.sid'); // Ensure session cookie is cleared
            res.redirect('/');
        });
    });
});

// Middleware to check authentication
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) { return next(); }
    res.status(401).json({ error: 'Authentication required.' });
}

// API route to get current user data
app.get('/api/user', (req, res) => {
    if (req.isAuthenticated() && req.user) {
        // Send only necessary, non-sensitive user data
        res.json({
            steamId: req.user.steamId,
            username: req.user.username,
            avatar: req.user.avatar,
            tradeUrl: req.user.tradeUrl || '' // Send empty string if not set
        });
    } else {
        res.status(401).json(null); // Send null or specific error if not authenticated
    }
});


// API route to get user's Rust inventory
// GET /api/inventory
// Requires authentication
// --- MODIFIED ROUTE ---
app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    const userSteamId = req.user.steamId;
    try {
        const inventory = await getUserInventory(userSteamId); // Use the helper function

        if (!inventory || inventory.length === 0) {
            return res.json([]); // Return empty array if inventory is empty
        }

        const pricedInventory = inventory.map(item => {
            const price = getItemPrice(item.market_hash_name);
            const imageUrl = item.getImageURL ? item.getImageURL() : (item.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${item.icon_url}` : '');
            return {
                assetId: item.assetid || item.id, // Prefer assetid, fallback to id
                name: item.market_hash_name || item.name, // Prefer market_hash_name
                image: imageUrl,
                price: price,
                tradable: item.tradable,
                marketable: item.marketable,
                // Add any other relevant properties if needed
            };
        }).filter(item => item.tradable); // Only return tradable items

        res.json(pricedInventory);

    } catch (error) {
        // Check the type of error rejected by getUserInventory
        if (error.type === 'TRADE_RESTRICTED') {
            console.warn(`Inventory access denied for ${userSteamId}: Trade Restricted.`);
            return res.status(403).json({ error: 'Trade Restricted', reason: error.message });
        } else if (error.type === 'INVENTORY_PRIVATE') {
            console.warn(`Inventory access denied for ${userSteamId}: Inventory Private.`);
            return res.status(403).json({ error: 'Inventory Private', reason: error.message });
        } else if (error.type === 'BOT_UNAVAILABLE') {
            console.error(`Inventory fetch failed for ${userSteamId}: Bot Unavailable.`);
            return res.status(503).json({ error: 'Bot Unavailable', reason: error.message });
        } else { // Handle generic FETCH_ERROR or other unexpected errors
            console.error(`Failed to get inventory for ${userSteamId}:`, error.message || error);
            return res.status(500).json({ error: 'Inventory Error', reason: error.message || 'Failed to fetch inventory. Please try again later.' });
        }
    }
});
// --- END MODIFIED ROUTE ---

// API route to get current round state
app.get('/api/round', async (req, res) => {
    try {
        if (!currentRound) {
            // Maybe try fetching from DB if memory state is empty
            const latestRound = await Round.findOne({ status: { $in: ['active', 'rolling'] } })
                .sort('-startTime')
                .populate('participants.user', 'steamId username avatar')
                .populate('items')
                .lean();
            if (!latestRound) {
                return res.status(404).json({ error: 'No active round found.' });
            }
            currentRound = latestRound; // Update in-memory state
        }

        // Calculate timeLeft based on current state if applicable
        let timeLeft = 0;
        if (currentRound.status === 'active' && currentRound.endTime) {
            timeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - Date.now()) / 1000));
        } else if (currentRound.status === 'active' && !currentRound.endTime && currentRound.participants?.length === 0) {
            timeLeft = ROUND_DURATION; // Show full duration if timer hasn't started
        }

        // Prepare participant data, ensuring sensitivity - only send what's needed
        const participantsData = currentRound.participants?.map(p => ({
            user: {
                steamId: p.user?.steamId,
                username: p.user?.username,
                avatar: p.user?.avatar
            },
            itemsValue: p.itemsValue,
            tickets: p.tickets
        })) || [];

        // Prepare item data
        const itemsData = currentRound.items?.map(item => ({
            _id: item._id, // May be needed for client-side rendering keys
            assetId: item.assetId,
            name: item.name,
            image: item.image,
            price: item.price,
            owner: { // Include minimal owner info if necessary
                steamId: participantsData.find(p => p.user?.steamId === item.ownerSteamId)?.user?.steamId, // Find matching participant to get steamId if populated
                username: participantsData.find(p => p.user?.steamId === item.ownerSteamId)?.user?.username,
                avatar: participantsData.find(p => p.user?.steamId === item.ownerSteamId)?.user?.avatar
            }
        })) || [];


        res.json({
            roundId: currentRound.roundId,
            status: currentRound.status,
            timeLeft: timeLeft,
            totalValue: currentRound.totalValue || 0,
            serverSeedHash: currentRound.serverSeedHash,
            participants: participantsData,
            items: itemsData,
            maxParticipants: MAX_PARTICIPANTS,
            maxItemsPerPot: MAX_ITEMS_PER_POT
            // Include winner info if round is completed
            // winner: currentRound.status === 'completed' ? currentRound.winner : null,
            // winningTicket: currentRound.status === 'completed' ? currentRound.winningTicket : null,
            // serverSeed: currentRound.status === 'completed' ? currentRound.serverSeed : null,
            // clientSeed: currentRound.status === 'completed' ? currentRound.clientSeed : null,
            // provableHash: currentRound.status === 'completed' ? currentRound.provableHash : null,
        });
    } catch (err) {
        console.error('Error fetching current round state:', err);
        res.status(500).json({ error: 'Internal server error fetching round state.' });
    }
});

// API route to update user trade URL
// POST /api/tradeurl
// Requires authentication
// Body: { tradeUrl: '...' }
app.post('/api/tradeurl', ensureAuthenticated, sensitiveActionLimiter, [
    body('tradeUrl').trim().isURL({ protocols: ['http', 'https'], require_protocol: true }).withMessage('Invalid URL format.')
        .matches(/^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/)
        .withMessage('Invalid Steam Trade URL format.')
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array().map(e => e.msg) });
    }

    const { tradeUrl } = req.body;

    try {
        // Validate the trade URL using the manager's check (optional but recommended)
        manager.getOfferTokenFromTradeURL(tradeUrl, (err, partner, token) => {
            if (err) {
                console.warn(`Trade URL validation failed for user ${req.user.steamId}: ${err.message}`);
                return res.status(400).json({ errors: ['Failed to validate trade URL with Steam. Ensure it is correct and your inventory is public.'] });
            }

            // If validation passes, update the user document
            User.findByIdAndUpdate(req.user.id, { $set: { tradeUrl: tradeUrl } }, { new: true, runValidators: true })
                .then(updatedUser => {
                    if (!updatedUser) {
                        return res.status(404).json({ errors: ['User not found.'] });
                    }
                    console.log(`Trade URL updated for user ${updatedUser.steamId}`);
                    // Return only the updated tradeUrl, not the whole user object
                    res.json({ success: true, tradeUrl: updatedUser.tradeUrl });
                })
                .catch(updateErr => {
                    console.error(`Error updating trade URL in DB for user ${req.user.steamId}:`, updateErr);
                    // Handle potential validation errors from schema
                    if (updateErr.name === 'ValidationError') {
                        return res.status(400).json({ errors: Object.values(updateErr.errors).map(e => e.message) });
                    }
                    res.status(500).json({ errors: ['Internal server error saving trade URL.'] });
                });
        }); // End manager.getOfferTokenFromTradeURL

    } catch (err) {
        // Catch unexpected errors (though most should be handled by promises/callbacks)
        console.error('Unexpected error in /api/tradeurl route:', err);
        res.status(500).json({ errors: ['An unexpected server error occurred.'] });
    }
});

// API route to initiate a deposit
// POST /api/deposit
// Requires authentication
// Body: { itemAssetIds: ['assetId1', 'assetId2', ...] }
// --- NEW DEPOSIT FLOW ---
app.post('/api/deposit', ensureAuthenticated, depositLimiter, [
    body('itemAssetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT })
        .withMessage(`You must select between 1 and ${MAX_ITEMS_PER_DEPOSIT} items.`)
        .custom((value) => value.every(id => typeof id === 'string' && /^\d+$/.test(id))) // Basic check for string numbers
        .withMessage('Invalid item asset ID format found.'),
], async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) { return res.status(400).json({ error: errors.array().map(e => e.msg).join(', ') }); }
    if (!isBotConfigured || !isBotReady) { return res.status(503).json({ error: 'Deposits are temporarily disabled (Bot offline).' }); }
    if (!req.user.tradeUrl) { return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile before depositing.' }); }
    if (isRolling) { return res.status(409).json({ error: 'Cannot deposit while the round is rolling.' }); }
    if (!currentRound || currentRound.status !== 'active') { return res.status(409).json({ error: 'Cannot deposit, the current round is not active.' }); }
    // Check if user already has a pending deposit
    if (req.user.pendingDepositOfferId) { return res.status(409).json({ error: 'You already have a pending deposit offer. Please accept or decline it first.' }); }

    const { itemAssetIds } = req.body;
    const userMongoId = req.user._id;
    const userSteamId = req.user.steamId;
    const roundMongoId = currentRound._id;

    // Server-side validation of items
    try {
        // 1. Refetch user's inventory to ensure they still own the items
        const userInventory = await getUserInventory(userSteamId);
        if (!userInventory) throw new Error('Could not fetch user inventory for validation.');

        const itemsToDeposit = [];
        let depositValue = 0;
        for (const assetId of itemAssetIds) {
            const ownedItem = userInventory.find(invItem => invItem.assetid === assetId);
            if (!ownedItem) {
                return res.status(400).json({ error: `You no longer own item with ID ${assetId}. Please refresh your inventory.` });
            }
            if (!ownedItem.tradable) {
                return res.status(400).json({ error: `Item '${ownedItem.market_hash_name}' is not tradable.` });
            }
            const price = getItemPrice(ownedItem.market_hash_name);
            if (price < MIN_ITEM_VALUE) {
                return res.status(400).json({ error: `Item '${ownedItem.market_hash_name}' ($${price.toFixed(2)}) is below the minimum value of $${MIN_ITEM_VALUE.toFixed(2)}.` });
            }
            itemsToDeposit.push({
                assetid: ownedItem.assetid,
                appid: RUST_APP_ID,
                contextid: RUST_CONTEXT_ID,
                // Store name/price for potential use in handleNewOffer
                name: ownedItem.market_hash_name,
                price: price,
                image: ownedItem.getImageURL ? ownedItem.getImageURL() : (ownedItem.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${ownedItem.icon_url}` : '')
            });
            depositValue += price;
        }

        if (itemsToDeposit.length === 0) { return res.status(400).json({ error: 'No valid items selected for deposit.' }); }

        // 2. Check pot limits (participants and total items)
        const currentParticipantSteamIds = new Set(currentRound.participants.map(p => p.user?.steamId));
        const isNewParticipant = !currentParticipantSteamIds.has(userSteamId);
        const currentTotalItems = currentRound.items.length;

        if (isNewParticipant && currentParticipantSteamIds.size >= MAX_PARTICIPANTS) {
            return res.status(409).json({ error: `Round is full (${MAX_PARTICIPANTS} participants). Please wait for the next round.` });
        }
        if (currentTotalItems + itemsToDeposit.length > MAX_ITEMS_PER_POT) {
            return res.status(409).json({ error: `Depositing these items would exceed the maximum pot item limit (${MAX_ITEMS_PER_POT}).` });
        }


        // 3. Create and send the trade offer *requesting* items from the user
        const depositOffer = manager.createOffer(req.user.tradeUrl);
        depositOffer.addTheirItems(itemsToDeposit); // Bot is receiving items
        const uniqueDepositId = uuidv4(); // Generate a unique ID for this deposit attempt
        depositOffer.setMessage(`Deposit for Round ${currentRound.roundId} on ${process.env.SITE_NAME || 'our site'}. Total value: $${depositValue.toFixed(2)}. Deposit ID: ${uniqueDepositId}`);

        console.log(`Sending deposit request offer to ${req.user.username} for ${itemsToDeposit.length} items (Value: $${depositValue.toFixed(2)}, Deposit ID: ${uniqueDepositId}).`);

        depositOffer.send(async (err, status) => {
            if (err) {
                console.error(`Error sending deposit request offer to ${req.user.username}:`, { message: err.message, eresult: err.eresult });
                let friendlyError = 'Failed to send deposit trade offer. Please ensure your trade URL is correct and your inventory is public.';
                if (err.eresult === 15) friendlyError = 'Failed to send deposit offer: Access Denied. Check Trade URL/Inventory Privacy.';
                if (err.eresult === 16) friendlyError = 'Failed to send deposit offer: Timed out. Please try again.';
                if (err.eresult === 26) friendlyError = 'Failed to send deposit offer: Limit exceeded. Try again later.';
                // Add more specific eresult messages if needed
                return res.status(500).json({ error: friendlyError });
            }

            // Offer sent successfully
            const offerId = depositOffer.id;
            console.log(`Deposit request offer ${offerId} sent to ${req.user.username} (Status: ${status}). Deposit ID: ${uniqueDepositId}`);

            // Store pending deposit info (Offer ID, User, Items, Round, Deposit ID)
            // Use the unique deposit ID from the message to link the offer when received
            pendingDeposits.set(uniqueDepositId, {
                offerId: offerId,
                userId: userMongoId,
                steamId: userSteamId, // Store steamId for quicker lookup in handleNewOffer
                items: itemsToDeposit, // Store details of items expected in the deposit
                roundId: roundMongoId,
                depositValue: depositValue,
                timestamp: Date.now()
            });

            // Mark the user as having a pending offer in DB to prevent concurrent deposits
            try {
                await User.updateOne({ _id: userMongoId }, { $set: { pendingDepositOfferId: offerId } });
                req.user.pendingDepositOfferId = offerId; // Update session user object too
            } catch (dbError) {
                console.error(`Failed to update pendingDepositOfferId for user ${userSteamId}:`, dbError);
                // Offer was sent, but DB update failed. User might get stuck.
                // Attempt to cancel the offer? Or just log and hope the user handles it.
                // For now, log and inform user of potential issue
                return res.status(500).json({ error: 'Deposit offer sent, but failed to update user status. Please contact support if issues persist.', offerId: offerId });
            }

            // Respond to client that offer was sent
            res.json({
                success: true,
                message: 'Deposit trade offer sent! Please accept it on Steam.',
                offerId: offerId, // Send offer ID so client can potentially link to Steam
                requiresConfirmation: status === 'sent' // Indicate if bot owner needs to confirm
            });
        }); // End depositOffer.send

    } catch (validationError) {
        // Handle errors from getUserInventory (trade restricted, private, etc.)
        if (validationError.type === 'TRADE_RESTRICTED') {
            return res.status(403).json({ error: validationError.message });
        } else if (validationError.type === 'INVENTORY_PRIVATE') {
            return res.status(403).json({ error: validationError.message });
        }
        // Handle other validation errors
        console.error('Error during deposit item validation:', validationError);
        res.status(500).json({ error: validationError.message || 'Failed to validate deposit items.' });
    }
});
// --- END NEW DEPOSIT FLOW ---

// --- Trade Offer Manager Event Handlers ---
if (isBotConfigured) {

    /**
     * Extracts the Deposit ID from the trade offer message.
     * @param {string} message - The trade offer message.
     * @returns {string|null} The deposit ID or null if not found.
     */
    function getDepositIdFromMessage(message) {
        if (!message) return null;
        const match = message.match(/Deposit ID: ([a-fA-F0-9-]+)$/); // Match UUID at the end
        return match ? match[1] : null;
    }

    manager.on('newOffer', async (offer) => {
        console.log(`Received new trade offer #${offer.id} from ${offer.partner.getSteamID64()}. State: ${offer.state} (${TradeOfferManager.ETradeOfferState[offer.state]})`);

        // Ignore offers from the bot itself or offers where the bot gives items (only accept deposits)
        if (offer.partner.getSteamID64() === community.steamID.getSteamID64()) {
            console.log(`Offer ${offer.id} is from self, ignoring.`);
            return;
        }
        if (offer.itemsToGive.length > 0 || offer.itemsToReceive.length === 0) {
            console.log(`Offer ${offer.id} is not a valid deposit (Bot giving items or receiving none). Declining.`);
            offer.decline(err => { if (err) console.error(`Error declining invalid deposit offer ${offer.id}:`, err); });
            return;
        }

        // Check if it's an active deposit offer we requested
        const depositId = getDepositIdFromMessage(offer.message);
        const pendingDepositData = depositId ? pendingDeposits.get(depositId) : null;

        if (pendingDepositData && pendingDepositData.offerId === offer.id && offer.partner.getSteamID64() === pendingDepositData.steamId) {
            console.log(`Offer ${offer.id} matches pending deposit ${depositId} from ${pendingDepositData.steamId}. Verifying items...`);

            // Verify items received match exactly what was expected (asset IDs)
            const expectedAssetIds = new Set(pendingDepositData.items.map(item => item.assetid));
            const receivedAssetIds = new Set(offer.itemsToReceive.map(item => item.assetid));

            if (expectedAssetIds.size !== receivedAssetIds.size || ![...expectedAssetIds].every(id => receivedAssetIds.has(id))) {
                console.warn(`Offer ${offer.id} (Deposit ${depositId}) item mismatch. Expected: ${[...expectedAssetIds].join(',')}, Received: ${[...receivedAssetIds].join(',')}. Declining.`);
                offer.decline(err => { if (err) console.error(`Error declining mismatched deposit offer ${offer.id}:`, err); });
                // Clean up pending state? Maybe leave it for user to retry/cancel?
                io.to(pendingDepositData.steamId).emit('notification', { type: 'error', message: 'Deposit item mismatch detected. Offer declined. Please try again.' });
                pendingDeposits.delete(depositId); // Remove from pending as it's invalid
                User.updateOne({ _id: pendingDepositData.userId }, { $set: { pendingDepositOfferId: null } }).catch(console.error); // Clear user pending status
                return;
            }

            // Items match, accept the offer
            console.log(`Accepting deposit offer ${offer.id} (Deposit ${depositId})...`);
            offer.accept(async (err, status) => {
                if (err) {
                    console.error(`Error accepting deposit offer ${offer.id} (Deposit ${depositId}):`, { message: err.message, eresult: err.eresult });
                    io.to(pendingDepositData.steamId).emit('notification', { type: 'error', message: `Error accepting your deposit offer ${offer.id}. Please try again or contact support.` });
                    // Offer might be in escrow, invalid state, etc.
                    // Clean up pending state? Maybe retry?
                    pendingDeposits.delete(depositId);
                    User.updateOne({ _id: pendingDepositData.userId }, { $set: { pendingDepositOfferId: null } }).catch(console.error);
                    return;
                }

                console.log(`Deposit offer ${offer.id} (Deposit ${depositId}) accepted. Status: ${status}.`);
                io.to(pendingDepositData.steamId).emit('notification', { type: 'success', message: `Deposit offer ${offer.id} accepted!` });

                // If accepted and completed (not in escrow), process the deposit
                if (status === 'accepted') {
                    await handleCompletedDeposit(offer, pendingDepositData, depositId);
                } else if (status === 'pending') {
                    // Offer likely requires mobile confirmation by the bot owner
                    console.warn(`Deposit offer ${offer.id} accepted but requires confirmation (Bot owner action needed?). Status: ${status}`);
                    // Need to wait for 'receivedOfferConfirmed' event or manual confirmation
                } else {
                    console.warn(`Deposit offer ${offer.id} accepted with unexpected status: ${status}. Manual check might be needed.`);
                    // Handle other statuses like escrow etc. if necessary
                }

                // Regardless of accept status, clean up pending user state
                User.updateOne({ _id: pendingDepositData.userId }, { $set: { pendingDepositOfferId: null } })
                    .catch(e => console.error(`Error clearing pendingDepositOfferId after accepting offer ${offer.id}:`, e));

            }); // End offer.accept callback

        } else {
            // Offer is not a recognized pending deposit (maybe donation, wrong items, old offer?)
            console.log(`Offer ${offer.id} from ${offer.partner.getSteamID64()} is not a recognized pending deposit or message invalid/missing. Declining.`);
            offer.decline(err => { if (err) console.error(`Error declining unrecognized offer ${offer.id}:`, err); });
        }
    }); // End manager.on('newOffer')


    // --- Handle Completed Deposits ---
    /**
     * Processes a deposit after the trade offer is successfully completed (state=Accepted).
     * @param {object} offer - The completed trade offer object.
     * @param {object} depositData - The associated data from `pendingDeposits`.
     * @param {string} depositId - The unique ID for this deposit.
     */
    async function handleCompletedDeposit(offer, depositData, depositId) {
        console.log(`Processing completed deposit ${depositId} from offer ${offer.id}...`);
        const { userId, roundId, items: expectedItems, depositValue, steamId } = depositData;

        try {
            // Double check current round hasn't changed/ended unexpectedly
            if (!currentRound || currentRound._id.toString() !== roundId.toString() || currentRound.status !== 'active') {
                console.error(`Deposit ${depositId} (Offer ${offer.id}) failed: Round ${roundId} is no longer active or valid.`);
                io.to(steamId).emit('notification', { type: 'error', message: `Deposit failed: The round ended before your deposit was confirmed.` });
                // TODO: Handle refund/return of items? This is complex. Log for now.
                // For now, just remove from pendingDeposits
                pendingDeposits.delete(depositId);
                return;
            }

            // Create Item documents
            const itemsToSave = expectedItems.map(item => ({
                assetId: item.assetid,
                name: item.name,
                image: item.image,
                price: item.price,
                owner: userId,
                roundId: roundId
            }));
            const savedItems = await Item.insertMany(itemsToSave);
            const savedItemIds = savedItems.map(item => item._id);

            // Update Round: Add items, add/update participant, update total value
            const ticketsEarned = Math.floor(depositValue / TICKET_VALUE_RATIO);
            const userExists = currentRound.participants.some(p => p.user?.toString() === userId.toString());

            let updateOperation;
            if (userExists) {
                // Update existing participant's value and tickets
                updateOperation = {
                    $push: { items: { $each: savedItemIds } },
                    $inc: {
                        totalValue: depositValue,
                        'participants.$[elem].itemsValue': depositValue,
                        'participants.$[elem].tickets': ticketsEarned
                    }
                };
            } else {
                // Add new participant
                updateOperation = {
                    $push: {
                        items: { $each: savedItemIds },
                        participants: {
                            user: userId,
                            itemsValue: depositValue,
                            tickets: ticketsEarned
                        }
                    },
                    $inc: { totalValue: depositValue }
                };
            }

            const arrayFilters = userExists ? [{ 'elem.user': userId }] : undefined;
            const updatedRound = await Round.findOneAndUpdate(
                { _id: roundId, status: 'active' }, // Ensure round is still active when updating
                updateOperation,
                { new: true, arrayFilters: arrayFilters, runValidators: true }
            )
            .populate('participants.user', 'steamId username avatar')
            .populate('items') // Repopulate items after adding new ones
            .lean(); // Use lean for performance

            if (!updatedRound) {
                // This could happen if the round status changed between the check and the update
                console.error(`Deposit ${depositId} (Offer ${offer.id}) failed: Could not update round ${roundId} (maybe status changed?).`);
                io.to(steamId).emit('notification', { type: 'error', message: `Deposit failed: Round status changed during confirmation.` });
                // TODO: Refund items?
                pendingDeposits.delete(depositId);
                return;
            }

            console.log(`Round ${roundId} updated successfully after deposit ${depositId}. New value: $${updatedRound.totalValue.toFixed(2)}`);
            currentRound = updatedRound; // Update in-memory state

            // Emit updated round state to clients
            io.emit('roundUpdate', {
                roundId: currentRound.roundId,
                totalValue: currentRound.totalValue,
                participants: currentRound.participants.map(p => ({ // Send updated participants list
                    user: { steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar },
                    itemsValue: p.itemsValue,
                    tickets: p.tickets
                })),
                items: savedItems.map(item => ({ // Send only the newly added items for animation
                    _id: item._id,
                    assetId: item.assetId,
                    name: item.name,
                    image: item.image,
                    price: item.price,
                    owner: { steamId: steamId, username: updatedRound.participants.find(p=>p.user.steamId === steamId)?.user.username, avatar: updatedRound.participants.find(p=>p.user.steamId === steamId)?.user.avatar }
                }))
            });

            // Start timer if this is the first participant
            if (currentRound.participants.length === 1 && !roundTimer) {
                startRoundTimer(false);
            }

            // Clean up the pending deposit entry
            pendingDeposits.delete(depositId);
            console.log(`Deposit ${depositId} processed and removed from pending map.`);

        } catch (error) {
            console.error(`CRITICAL ERROR processing completed deposit ${depositId} (Offer ${offer.id}):`, error);
            io.to(steamId).emit('notification', { type: 'error', message: `Critical error processing your deposit ${depositId}. Please contact support.` });
            // Ensure pending state is cleaned up if possible
            pendingDeposits.delete(depositId);
            // User pendingDepositOfferId should have been cleared when offer was accepted/declined
        }
    } // End handleCompletedDeposit

    // Listen for state changes on offers WE SENT (e.g., deposit requests, winnings)
    manager.on('sentOfferChanged', async (offer, oldState) => {
        console.log(`Sent offer ${offer.id} changed state from ${TradeOfferManager.ETradeOfferState[oldState]} to ${TradeOfferManager.ETradeOfferState[offer.state]}.`);

        // --- Handle changes to DEPOSIT REQUEST offers we sent ---
        const depositId = getDepositIdFromMessage(offer.message);
        const pendingDepositData = depositId ? pendingDeposits.get(depositId) : null;

        if (pendingDepositData && pendingDepositData.offerId === offer.id) {
            if (offer.state === TradeOfferManager.ETradeOfferState.Declined ||
                offer.state === TradeOfferManager.ETradeOfferState.Canceled ||
                offer.state === TradeOfferManager.ETradeOfferState.Expired ||
                offer.state === TradeOfferManager.ETradeOfferState.InvalidItems) {
                console.log(`Deposit request offer ${offer.id} (Deposit ${depositId}) was not completed (State: ${offer.state}). Cleaning up.`);
                pendingDeposits.delete(depositId);
                // Clear pending status on user
                User.updateOne({ _id: pendingDepositData.userId, pendingDepositOfferId: offer.id }, { $set: { pendingDepositOfferId: null } })
                    .then(() => console.log(`Cleared pending status for user ${pendingDepositData.steamId} after offer ${offer.id} ended.`))
                    .catch(e => console.error(`Error clearing pending status for user ${pendingDepositData.steamId}:`, e));
                io.to(pendingDepositData.steamId).emit('notification', { type: 'info', message: `Your deposit offer ${offer.id} was ${TradeOfferManager.ETradeOfferState[offer.state]}.` });
            } else if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                // This usually shouldn't happen for deposit requests (bot receives items),
                // unless the user somehow accepted the request TO them? Ignore for now.
                console.warn(`Deposit request offer ${offer.id} (Deposit ${depositId}) changed to Accepted state unexpectedly.`);
            }
        }

        // --- Handle changes to WINNINGS offers we sent ---
        // Check if the offer ID matches a payout offer ID in a completed round
        // This requires querying the DB or keeping track of sent winning offers in memory
        else {
            const round = await Round.findOne({ payoutOfferId: offer.id }).lean();
            if (round && round.winner) {
                const winnerSteamId = (await User.findById(round.winner).lean())?.steamId;
                if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                    console.log(`Winnings offer ${offer.id} for round ${round.roundId} ACCEPTED by winner.`);
                    Round.updateOne({ _id: round._id }, { $set: { status: 'payout_accepted' } }).catch(e => console.error(e));
                    if (winnerSteamId) io.to(winnerSteamId).emit('notification', { type: 'success', message: `Winnings for round ${round.roundId} successfully accepted!` });
                } else if (offer.state === TradeOfferManager.ETradeOfferState.Declined ||
                           offer.state === TradeOfferManager.ETradeOfferState.Canceled ||
                           offer.state === TradeOfferManager.ETradeOfferState.Expired ||
                           offer.state === TradeOfferManager.ETradeOfferState.InvalidItems) {
                    console.warn(`Winnings offer ${offer.id} for round ${round.roundId} was not completed (State: ${offer.state}).`);
                    Round.updateOne({ _id: round._id }, { $set: { status: 'payout_failed' } }).catch(e => console.error(e));
                    if (winnerSteamId) io.to(winnerSteamId).emit('notification', { type: 'warning', message: `Winnings offer ${offer.id} for round ${round.roundId} was not completed (${TradeOfferManager.ETradeOfferState[offer.state]}). Please contact support.` });
                    // TODO: Handle failed payout (retry? alert admin?)
                }
            }
        }
    }); // End manager.on('sentOfferChanged')


    // Listen for confirmations of offers WE RECEIVED (i.e., Deposits needing confirmation)
    manager.on('receivedOfferConfirmed', async (offer, oldState) => {
        console.log(`Received offer ${offer.id} confirmed (was ${TradeOfferManager.ETradeOfferState[oldState]}, now ${TradeOfferManager.ETradeOfferState[offer.state]})`);
        if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
            const depositId = getDepositIdFromMessage(offer.message);
            const pendingDepositData = depositId ? pendingDeposits.get(depositId) : null;
            if (pendingDepositData && pendingDepositData.offerId === offer.id) {
                console.log(`Deposit offer ${offer.id} (Deposit ${depositId}) was confirmed after acceptance.`);
                await handleCompletedDeposit(offer, pendingDepositData, depositId);
            } else {
                console.warn(`Offer ${offer.id} confirmed, but couldn't find matching pending deposit data.`);
            }
        } else {
            console.warn(`Received offer ${offer.id} confirmed but ended in state ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
        }
    });

    // Optional: Handle confirmations for offers WE SENT (Winnings needing confirmation)
    manager.on('sentOfferConfirmed', (offer, oldState) => {
        console.log(`Sent offer ${offer.id} confirmed (was ${TradeOfferManager.ETradeOfferState[oldState]}, now ${TradeOfferManager.ETradeOfferState[offer.state]})`);
        // If it was a winnings offer, update round status maybe?
        Round.updateOne({ payoutOfferId: offer.id }, { $set: { status: 'payout_confirmed_manager' } }).catch(e=>console.error(e));
    });

} // End if (isBotConfigured)

// --- Socket.IO Connections ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Try to associate socket with authenticated user if available
    const session = socket.request.session; // Access session data
    if (session && session.passport && session.passport.user) {
        User.findById(session.passport.user).then(user => {
            if (user) {
                socket.join(user.steamId); // Join a room based on steamId
                console.log(`Socket ${socket.id} associated with user ${user.username} (${user.steamId})`);
            }
        }).catch(err => console.error("Error finding user for socket association:", err));
    }


    // Send current round state on connection
    // Use the same logic as /api/round to prepare data
    (async () => {
        try {
            let roundToSend = currentRound;
            if (!roundToSend) {
                const latestRound = await Round.findOne({ status: { $in: ['active', 'rolling'] } })
                    .sort('-startTime')
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items')
                    .lean();
                roundToSend = latestRound;
            }
            if (roundToSend) {
                let timeLeft = 0;
                if (roundToSend.status === 'active' && roundToSend.endTime) {
                    timeLeft = Math.max(0, Math.floor((new Date(roundToSend.endTime).getTime() - Date.now()) / 1000));
                } else if (roundToSend.status === 'active' && !roundToSend.endTime && roundToSend.participants?.length === 0) {
                    timeLeft = ROUND_DURATION;
                }
                const participantsData = roundToSend.participants?.map(p => ({
                    user: p.user ? { steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar } : null,
                    itemsValue: p.itemsValue, tickets: p.tickets
                })) || [];
                const itemsData = roundToSend.items?.map(item => ({
                    _id: item._id, assetId: item.assetId, name: item.name, image: item.image, price: item.price,
                    owner: participantsData.find(p => p.user?.steamId === (item.ownerSteamId || roundToSend.participants.find(part=>part.user._id.toString() === item.owner?.toString())?.user.steamId))?.user || null // Complex owner lookup if not prepopulated correctly
                })) || [];

                socket.emit('initialRoundState', {
                    roundId: roundToSend.roundId, status: roundToSend.status, timeLeft: timeLeft,
                    totalValue: roundToSend.totalValue || 0, serverSeedHash: roundToSend.serverSeedHash,
                    participants: participantsData, items: itemsData,
                    maxParticipants: MAX_PARTICIPANTS, maxItemsPerPot: MAX_ITEMS_PER_POT
                });
            } else {
                socket.emit('initialRoundState', null); // Send null if no round found
            }
        } catch(err) {
            console.error("Error sending initial round state via socket:", err);
            socket.emit('initialRoundState', { error: 'Failed to load round state.' });
        }
    })();


    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });

    // Add other socket event handlers if needed
});

// Attach session middleware to Socket.IO requests
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000, secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax' }
    // store: // Use same store as Express if using one
});
io.engine.use(sessionMiddleware);
io.engine.use(passport.initialize());
io.engine.use(passport.session());


// --- Price Cache Refresh Interval ---
refreshPriceCache(); // Initial fetch
setInterval(refreshPriceCache, PRICE_REFRESH_INTERVAL_MS);

// --- Start Server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on ${process.env.SITE_URL || `http://localhost:${PORT}`}`);
    // Ensure initial round creation is attempted *after* server starts listening and bot might be ready
    setTimeout(ensureInitialRound, 2000); // Delay slightly to allow bot login potentially
});

// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
    console.log('\nSIGINT received. Shutting down gracefully...');
    server.close(() => {
        console.log('HTTP server closed.');
    });
    io.close(() => {
        console.log('Socket.IO closed.');
    });
    if (roundTimer) clearInterval(roundTimer);
    await mongoose.connection.close(false); // false = don't force close immediately
    console.log('MongoDB connection closed.');
    // Log off bot? Optional, depends if state needs saving
    if (isBotConfigured && community && community.steamID) {
        community.setPersona(0); // Offline
    }
    console.log('Shutdown complete.');
    process.exit(0);
});
