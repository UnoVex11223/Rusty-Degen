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
        tickets: { type: Number, required: true, default: 0, min: 0 }      // Tickets based on value
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
                if (err) {
                    if (err.message?.includes('profile is private') || err.eresult === 15) {
                        return reject(new Error('Your Steam inventory is private. Please set it to public.'));
                    }
                    console.error(`Inventory Fetch Error (Manager): User ${req.user.steamId}: EResult ${err.eresult} - ${err.message || err}`);
                    return reject(new Error(`Could not fetch inventory. Steam might be busy or inventory private.`));
                }
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
        console.error(`Error in /api/inventory for ${req.user?.username || req.user?.steamId}:`, err.message);
        res.status(500).json({ error: err.message || 'Server error fetching inventory.' });
    }
});


// POST Initiate Deposit Request (NEW LOGIC - Creates offer FROM bot TO user)
app.post('/api/deposit', // Kept endpoint name as /api/deposit for simplicity with frontend example
    depositLimiter, // Apply deposit rate limit
    ensureAuthenticated,
    [ // Basic validation for asset IDs
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`You can deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items at a time.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.') // Basic format check
    ],
    handleValidationErrors,
    async (req, res) => {
        const user = req.user; // User object attached by ensureAuthenticated/passport
        const requestedAssetIds = req.body.assetIds;

        // --- Pre-Checks ---
        if (!isBotReady) {
            return res.status(503).json({ error: "Deposit service temporarily unavailable (Bot offline)." });
        }
        if (!user.tradeUrl) {
             // Should ideally be caught by frontend, but double-check
            return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile before depositing.' });
        }
         // Check if user already has a pending deposit offer
        if (user.pendingDepositOfferId) {
             try {
                 // Attempt to fetch the existing offer to check its status
                 const offer = await manager.getOffer(user.pendingDepositOfferId);
                 if (offer && [
                     TradeOfferManager.ETradeOfferState.Active, // Offer is valid and awaiting response
                     TradeOfferManager.ETradeOfferState.Sent, // Offer sent but not yet active (less common here)
                     TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation // Bot needs to confirm (shouldn't happen for requests)
                   ].includes(offer.state))
                {
                     console.log(`User ${user.username} already has pending deposit offer ${user.pendingDepositOfferId}. State: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
                     const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                     // Return 409 Conflict status
                     return res.status(409).json({
                         error: 'You already have an active deposit offer waiting. Please accept or decline it on Steam before creating a new one.',
                         offerId: user.pendingDepositOfferId,
                         offerURL: offerURL // Send URL so frontend can link to it
                     });
                 } else {
                      // Offer exists but is not active (e.g., accepted, declined, expired) - clear the flag
                      console.log(`Clearing stale pending offer ${user.pendingDepositOfferId} for user ${user.username} (State: ${TradeOfferManager.ETradeOfferState[offer?.state]}).`);
                      await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
                 }
             } catch (offerFetchError) {
                 // Offer likely doesn't exist in manager's cache or error fetching - clear the flag
                 console.warn(`Could not fetch pending offer ${user.pendingDepositOfferId}, clearing flag:`, offerFetchError.message);
                 await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
             }
        }

        // Check Round Status
        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }

        // Fetch latest round data for limits check (atomic check is difficult, but check before creating offer)
        let latestRoundData;
        try {
            // Use exec() to ensure a promise is returned from the Mongoose query
            latestRoundData = await Round.findById(currentRound._id).select('participants items').lean().exec();
            if (!latestRoundData) throw new Error('Could not fetch current round data.');

            // Check participant limit (consider if user is already a participant)
             const isNewParticipant = !latestRoundData.participants.some(p => p.user?.toString() === user._id.toString());
             if (isNewParticipant && latestRoundData.participants.length >= MAX_PARTICIPANTS) {
                 return res.status(400).json({ error: `Participant limit (${MAX_PARTICIPANTS}) reached.` });
             }
            // Check item limit
            if (latestRoundData.items.length + requestedAssetIds.length > MAX_ITEMS_PER_POT) {
                 const slotsLeft = MAX_ITEMS_PER_POT - latestRoundData.items.length;
                 return res.status(400).json({ error: `Depositing ${requestedAssetIds.length} items would exceed the pot limit (${MAX_ITEMS_PER_POT}). Only ${slotsLeft} slots left.` });
            }
        } catch (dbErr) {
            console.error(`Error fetching round data during deposit for ${user.username}:`, dbErr);
            return res.status(500).json({ error: 'Internal server error checking round limits. Please try again.' });
        }

        // --- Verify Items and Calculate Value ---
        let itemsToRequest = []; // Array to hold items formatted for the trade offer
        let depositTotalValue = 0;
        try {
            // Fetch user's inventory from Steam to verify ownership and tradability
            console.log(`Workspaceing inventory for ${user.username} (SteamID: ${user.steamId}) to verify deposit items...`);
            const userInventory = await new Promise((resolve, reject) => {
                manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                    if (err) {
                        if (err.message?.includes('profile is private') || err.eresult === 15) {
                             return reject(new Error('Your Steam inventory is private. Please set it to public.'));
                        }
                         console.error(`Inventory Fetch Error (Deposit): User ${user.steamId}: EResult ${err.eresult}`, err);
                         return reject(new Error(`Could not fetch your inventory. Ensure it's public and try again.`));
                    }
                    resolve(inv || []);
                });
            });
            console.log(`Inventory fetched for ${user.username}. Found ${userInventory.length} items. Verifying selection...`);

            const userInventoryMap = new Map(userInventory.map(item => [item.assetid, item]));

            for (const assetId of requestedAssetIds) {
                const inventoryItem = userInventoryMap.get(assetId);
                if (!inventoryItem) {
                    // SECURITY: If item isn't found after fetching fresh inventory, reject deposit.
                    throw new Error(`Item with Asset ID ${assetId} not found in your current Steam inventory.`);
                }
                if (!inventoryItem.tradable) {
                     // SECURITY: Check tradability again based on fresh inventory data.
                    throw new Error(`Item '${inventoryItem.market_hash_name}' (ID: ${assetId}) is currently not tradable.`);
                }

                const price = getItemPrice(inventoryItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) {
                    // Filter based on current price cache / fallback
                    throw new Error(`Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below the minimum deposit value ($${MIN_ITEM_VALUE}).`);
                }

                // Add item details needed for the trade offer AND for processing upon acceptance
                itemsToRequest.push({
                    assetid: inventoryItem.assetid,
                    appid: RUST_APP_ID,
                    contextid: RUST_CONTEXT_ID,
                    // Store price and name/image derived *during this verification* for processing on acceptance
                    _price: price, // Use the price determined now
                    _name: inventoryItem.market_hash_name,
                     _image: `https://community.akamai.steamstatic.com/economy/image/${inventoryItem.icon_url}`
                });
                depositTotalValue += price;
            }

             // Final check if verification yielded any items
             if (itemsToRequest.length === 0) {
                 // This should only happen if all requested items failed verification
                 throw new Error("None of the selected items could be verified for deposit.");
             }
             console.log(`Verified ${itemsToRequest.length} items for deposit for ${user.username}. Total Value: $${depositTotalValue.toFixed(2)}`);

        } catch (verificationError) {
            console.warn(`Deposit item verification failed for ${user.username}:`, verificationError.message);
            // Send specific error message back to user
            return res.status(400).json({ error: verificationError.message });
        }

        // --- Create and Send Trade Offer ---
        const depositId = uuidv4(); // Unique ID for this deposit attempt
        const offerMessage = `RustyDegen Deposit ID: ${depositId} | Round: ${currentRound.roundId}`; // Include round ID for context
        let cleanupTimeout = null; // Define timeout variable

        try {
            const offer = manager.createOffer(user.tradeUrl); // Use the user's trade URL
            // Use addTheirItems to request items FROM the user
            offer.addTheirItems(itemsToRequest.map(({ assetid, appid, contextid }) => ({ assetid, appid, contextid })));
            offer.setMessage(offerMessage); // Add the unique identifier

            // Store pending deposit details *before* sending offer
            pendingDeposits.set(depositId, {
                userId: user._id, // User's MongoDB ID
                roundId: currentRound._id, // Round's MongoDB ID
                items: itemsToRequest, // Includes verified _price, _name, _image
                totalValue: depositTotalValue,
                steamId: user.steamId // Store user's SteamID for logging/lookup
            });
            console.log(`Stored pending deposit ${depositId} for user ${user.steamId}.`);

            // Set timeout to clean up pending deposit if not accepted within manager's cancelTime
            cleanupTimeout = setTimeout(() => {
                 if(pendingDeposits.has(depositId)) {
                     console.log(`Deposit attempt ${depositId} expired.`);
                      pendingDeposits.delete(depositId);
                      // Also clear the user flag if this was the offer they were associated with
                      User.updateOne({ steamId: user.steamId, pendingDepositOfferId: offer?.id || 'expired' }, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user pending flag on expiry:", e));
                 }
            }, manager.cancelTime || 10 * 60 * 1000); // Use manager's cancelTime or default to 10 mins

            // Send the offer (no auto-confirmation needed for requests)
            console.log(`Sending deposit offer to ${user.username} (Trade URL: ${user.tradeUrl})...`);
            const status = await new Promise((resolve, reject) => {
                offer.send((err, status) => {
                    if (err) return reject(err); // Handle errors below
                    resolve(status);
                });
            });

            // Offer sent successfully (or pending) - Update user's pending offer ID in DB
            try {
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: offer.id });
                console.log(`Set pendingDepositOfferId=${offer.id} for user ${user.username}.`);
            } catch (dbUpdateError) {
                 console.error(`CRITICAL: Failed to set pendingDepositOfferId for user ${user.username} after sending offer ${offer.id}.`, dbUpdateError);
                 // Offer was sent, but DB state might be inconsistent. Need monitoring/manual fix.
                  // Clean up pending data as the DB link failed
                  pendingDeposits.delete(depositId);
                  clearTimeout(cleanupTimeout); // Clear the expiry timeout
                  // Attempt to cancel the sent offer? Risky if user already saw it.
                  // offer.cancel().catch(cancelErr => console.error(`Failed to cancel offer ${offer.id} after DB update error:`, cancelErr));
                  return res.status(500).json({ error: 'Failed to finalize deposit request state. Please contact support.' });
            }

            console.log(`Deposit offer ${offer.id} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;

            // Respond to frontend with offer details
            res.json({
                success: true,
                message: 'Deposit offer created! Please accept it on Steam to complete your deposit.',
                offerId: offer.id,
                offerURL: offerURL // Send URL for direct redirection
            });

        // Inside the catch block for offer.send
        } catch (error) {
            console.error(`Error sending deposit offer for ${user.username} (DepositID: ${depositId}): EResult ${error.eresult}`, error.message); // Log both
            // Clean up pending data
            pendingDeposits.delete(depositId);
            if (cleanupTimeout) clearTimeout(cleanupTimeout); // Clear expiry timeout if it was set
            await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user flag on offer fail:", e));

            let userMessage = 'Failed to create deposit trade offer. Please try again later.';
            // Check based on message content if eresult is undefined
            if (error.message.includes('unable to trade') && error.message.includes('reset your Steam account')) {
                 userMessage = `Steam Error: Your account has a temporary trade restriction due to a recent password reset. Please wait for the restriction to lift. (${error.message})`;
            } else if (error.message.includes('Trade URL') || error.message.includes('token') || error.eresult === 26) {
                userMessage = 'Your Steam Trade URL might be invalid or expired. Please check it in your profile.';
            } // ... other specific error checks based on eresult OR message ...
            else if (error.eresult) { // Add fallback for other eresults
                 userMessage += ` (Code: ${error.eresult})`;
            }

            res.status(500).json({ error: userMessage });
        }
    });


// --- Trade Offer Manager Event Handling ---
if (isBotConfigured && manager) {

    // Listener for INCOMING offers (Offers sent TO the bot)
    manager.on('newOffer', async (offer) => {
        if (!isBotReady) return; // Ignore offers if bot isn't ready
        if (offer.isOurOffer) return; // Ignore offers sent *by* the bot

        // --- Auto-decline unsolicited deposit attempts ---
        // Check if it looks like a deposit (user sending items, bot giving nothing)
        if (offer.itemsToReceive && offer.itemsToReceive.length > 0 && (!offer.itemsToGive || offer.itemsToGive.length === 0)) {
            // Check if it contains a deposit ID message - if so, it's likely a user manually sending after a failed attempt. Decline gently.
             if (offer.message && offer.message.includes('RustyDegen Deposit ID:')) {
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like a manual deposit attempt. Declining.`);
                 return offer.decline((err) => {
                      if (err) console.error(`Error declining manual deposit offer ${offer.id}:`, err);
                 });
             } else {
                 // Truly unsolicited item donation/deposit
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like an unsolicited item offer. Declining.`);
                  return offer.decline((err) => {
                       if (err) console.error(`Error declining unsolicited offer ${offer.id}:`, err);
                  });
             }
        }

        // Handle other incoming offers if needed (e.g., admin actions, specific item requests - unlikely for this app)
        console.log(`Ignoring unexpected incoming offer #${offer.id} from ${offer.partner.getSteamID64()}. Items to receive: ${offer.itemsToReceive?.length}, Items to give: ${offer.itemsToGive?.length}`);
        // Optionally decline other unexpected offers too
        // offer.decline().catch(e => console.error(`Error declining unexpected offer ${offer.id}:`, e));
    });

    // Listener for offers SENT BY THE BOT changing state
    manager.on('sentOfferChanged', async (offer, oldState) => {
        // Log state changes for offers sent by the bot
        if (offer.state !== oldState) {
            console.log(`Bot Offer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()}) Message: "${offer.message}"`);
        }

        // --- Handle ACCEPTED DEPOSIT Offers (Sent by Bot, Accepted by User) ---
        if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
            // Attempt to extract deposit ID from the message
            const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
            const depositId = messageMatch ? messageMatch[1] : null;

            // Check if this is a known pending deposit
            if (depositId && pendingDeposits.has(depositId)) {
                const depositData = pendingDeposits.get(depositId);
                pendingDeposits.delete(depositId); // Remove from pending map *immediately* to prevent reprocessing

                console.log(`Processing accepted deposit offer #${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId}`);

                // Clear the user's pending offer flag in DB
                User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                    .then(updateRes => {
                         if(updateRes.modifiedCount > 0) console.log(`Cleared pendingDepositOfferId flag for user ${depositData.steamId}`);
                         else console.warn(`Could not clear pendingDepositOfferId flag for user ${depositData.steamId} (Offer ID: ${offer.id}) - maybe already cleared?`);
                    })
                    .catch(e => console.error("Error clearing user pending flag on deposit accept:", e));


                // --- Double check round status before adding items ---
                let depositRound;
                try {
                     depositRound = await Round.findById(depositData.roundId).select('status participants items').exec(); // Use exec() for promise
                     if (!depositRound) throw new Error(`Round ${depositData.roundId} not found.`);
                     if (depositRound.status !== 'active' || isRolling) { // Check isRolling flag too
                          console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but round ${depositData.roundId} is no longer active/valid. Status: ${depositRound?.status}, Rolling: ${isRolling}. Items NOT added.`);
                          // TODO: Decide how to handle items received when round is invalid (return items? credit balance?)
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Round ended before your deposit (Offer #${offer.id}) could be processed. Items not added. Contact support.` });
                          // Attempt to return items (this is complex, might need separate queue)
                          // sendReturnOffer(depositData.steamId, offer.itemsToReceive, `Deposit for Round ${depositData.roundId} failed.`);
                          return; // Stop processing this deposit
                     }
                     // Check limits again right before insertion (race condition mitigation)
                     const isNewParticipantCheck = !depositRound.participants.some(p => p.user?.toString() === depositData.userId.toString());
                     if (isNewParticipantCheck && depositRound.participants.length >= MAX_PARTICIPANTS) {
                         console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but participant limit reached just before insertion. Items NOT added.`);
                         io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Participant limit reached before your deposit (Offer #${offer.id}) could be processed. Items not added. Contact support.` });
                          // TODO: Handle returning items
                         return;
                     }
                     if (depositRound.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                          console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but pot item limit reached just before insertion. Items NOT added.`);
                           const slotsLeft = MAX_ITEMS_PER_POT - depositRound.items.length;
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Pot item limit reached before your deposit (Offer #${offer.id}) could be processed. Only ${slotsLeft} slots left. Items not added. Contact support.` });
                          // TODO: Handle returning items
                          return;
                     }
                 } catch (roundCheckError) {
                      console.error(`CRITICAL DB ERROR checking round status for accepted deposit ${depositId} (Offer ${offer.id}):`, roundCheckError);
                      // TODO: Handle items - CRITICAL error state. Flag for admin. Return items?
                       io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error: Could not verify round for deposit (Offer #${offer.id}). Contact support immediately.` });
                       // Maybe try to return items here if possible
                      return;
                 }


                // --- Update Database (Items and Round) ---
                try {
                    // Create Item documents using data stored in pendingDeposits
                    const itemDocuments = depositData.items.map(itemData => new Item({
                        assetId: itemData.assetid,
                        name: itemData._name, // Use verified name
                        image: itemData._image, // Use verified image
                        price: itemData._price, // Use verified price
                        owner: depositData.userId, // Link to user's MongoDB ID
                        roundId: depositData.roundId // Link to round's MongoDB ID
                    }));

                    // Insert items into DB
                    const insertedItemsResult = await Item.insertMany(itemDocuments, { ordered: false });
                     if (insertedItemsResult.length !== itemDocuments.length) {
                          console.warn(`Deposit ${depositId}: Item insert count mismatch. Expected ${itemDocuments.length}, got ${insertedItemsResult.length}.`);
                          // Some items might not have been inserted, potential issue. Continue cautiously.
                     }
                    const createdItemIds = insertedItemsResult.map(doc => doc._id);
                    console.log(`Deposit ${depositId}: Inserted ${createdItemIds.length} items into DB.`);

                    // --- Atomic Round Update using findOneAndUpdate ---
                     // This approach finds the round, updates it in memory, and saves it.
                     // Alternative is using updateOne with positional operators, which can be complex.
                     const roundToUpdate = await Round.findById(depositData.roundId);
                     if (!roundToUpdate) throw new Error("Round disappeared before final update.");
                     if (roundToUpdate.status !== 'active') throw new Error("Round status changed before final update."); // Final status check

                     // Find participant or add new
                     let participantIndex = roundToUpdate.participants.findIndex(p => p.user?.toString() === depositData.userId.toString());
                     const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));

                     if (participantIndex !== -1) {
                          // Update existing participant
                           roundToUpdate.participants[participantIndex].itemsValue += depositData.totalValue;
                           roundToUpdate.participants[participantIndex].tickets += depositTickets;
                     } else {
                          // Add new participant
                           // Final check for participant limit before adding
                           if (roundToUpdate.participants.length >= MAX_PARTICIPANTS) {
                                throw new Error(`Participant limit reached just before adding participant ${depositData.steamId}.`);
                           }
                           roundToUpdate.participants.push({
                                user: depositData.userId,
                                itemsValue: depositData.totalValue,
                                tickets: depositTickets
                           });
                     }

                     // Update total value and items list
                     roundToUpdate.totalValue += depositData.totalValue;
                      // Final check for item limit before adding
                     if (roundToUpdate.items.length + createdItemIds.length > MAX_ITEMS_PER_POT) {
                          throw new Error(`Pot item limit reached just before adding items for participant ${depositData.steamId}.`);
                     }
                     roundToUpdate.items.push(...createdItemIds);

                     // Save the updated round document
                     const savedRound = await roundToUpdate.save();

                     // Populate the necessary fields for the event emission
                     const latestRoundData = await Round.findById(savedRound._id)
                          .populate('participants.user', 'steamId username avatar')
                          // No need to populate items fully for this event
                          .lean();
                     // --- End Atomic Round Update ---

                     if (!latestRoundData) throw new Error('Failed to fetch updated round data after deposit save.');

                     currentRound = latestRoundData; // Update global state

                     // --- Emit update to clients ---
                     const updatedParticipantData = latestRoundData.participants.find(p => p.user?._id.toString() === depositData.userId.toString());
                     const userInfo = updatedParticipantData?.user; // Get the populated user info

                     if (updatedParticipantData && userInfo) {
                          io.emit('participantUpdated', {
                               roundId: latestRoundData.roundId,
                               userId: userInfo._id.toString(), // Send MongoDB ID
                               username: userInfo.username,
                               avatar: userInfo.avatar,
                               itemsValue: updatedParticipantData.itemsValue, // Send cumulative value
                               tickets: updatedParticipantData.tickets, // Send cumulative tickets
                               totalValue: latestRoundData.totalValue, // Send new round total
                               depositedItems: depositData.items.map(i => ({ // Send items from *this* specific deposit
                                   assetId: i.assetid, name: i._name, image: i._image, price: i._price
                               }))
                          });
                     } else {
                          // This case should ideally not happen if DB update succeeded
                          console.error(`Failed to find updated participant data for user ${depositData.steamId} in round ${latestRoundData.roundId} after DB save.`);
                     }

                      // Start timer visually if this was the first participant joining
                      if (latestRoundData.participants.length === 1 && !roundTimer) {
                          console.log(`First participant (${userInfo?.username}) joined round ${latestRoundData.roundId} via deposit ${depositId}. Starting timer.`);
                          startRoundTimer(); // Start the timer with default duration
                      }

                     console.log(`Deposit success processed for offer #${offer.id}. User: ${userInfo?.username}, Value: $${depositData.totalValue.toFixed(2)}`);

                 } catch (dbErr) {
                     console.error(`CRITICAL DATABASE/UPDATE ERROR processing accepted deposit offer ${offer.id} (DepositID: ${depositId}):`, dbErr);
                     // TODO: System to handle items stuck in bot inventory. Flag for admin review. Return items?
                     io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error: Database issue after accepting deposit offer #${offer.id}. Please contact support IMMEDIATELY.` });
                     // If items were created but round update failed, try to delete them?
                      if (dbErr.message.includes("limit reached") && createdItemIds && createdItemIds.length > 0) {
                          console.warn(`Attempting to delete orphaned items due to limit error for deposit ${depositId}`);
                          await Item.deleteMany({ _id: { $in: createdItemIds } });
                          // TODO: Attempt to return items to user
                      }
                     // Potentially mark round as error?
                      if (currentRound) {
                          await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } })
                               .catch(e => console.error("Failed to set round status to error:", e));
                          io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error.' });
                      }
                 }
            } // End if (depositId && pendingDeposits.has(depositId))

             // --- Handle ACCEPTED WINNING Offers (Sent by Bot, Accepted by User) ---
             else if (offer.itemsToGive && offer.itemsToGive.length > 0 && (!offer.itemsToReceive || offer.itemsToReceive.length === 0)) {
                 // This block handles when a user accepts a WINNINGS offer sent by the bot
                 console.log(`Payout offer #${offer.id} accepted by recipient ${offer.partner.getSteamID64()}.`);
                 // Optional: Add further logic here if needed, like marking payout complete in DB.
                 // Find user by steamId to potentially emit notification confirming receipt
                  User.findOne({ steamId: offer.partner.getSteamID64() }).lean().then(user => {
                      if (user) {
                           io.emit('notification', { type: 'success', userId: user._id.toString(), message: `Winnings from offer #${offer.id} successfully received!` });
                      }
                  }).catch(e => console.error("Error finding user for payout accepted notification:", e));
              }
              // Else: Offer accepted, but not a recognized deposit or payout (shouldn't happen with current logic)
              else {
                   console.warn(`Offer #${offer.id} was accepted, but it wasn't recognized as a pending deposit or a winnings payout. Message: "${offer.message}"`);
              }
        } // End if (offer.state === Accepted)

        // --- Handle other state changes for offers SENT BY BOT (Declined, Expired, etc.) ---
        else if (
            offer.state === TradeOfferManager.ETradeOfferState.Declined ||
            offer.state === TradeOfferManager.ETradeOfferState.Canceled || // Bot might cancel expired offers
            offer.state === TradeOfferManager.ETradeOfferState.Expired ||
            offer.state === TradeOfferManager.ETradeOfferState.InvalidItems ||
            offer.state === TradeOfferManager.ETradeOfferState.Countered
        ) {
             console.warn(`Bot Offer #${offer.id} to ${offer.partner.getSteamID64()} ended unsuccessfully. State: ${TradeOfferManager.ETradeOfferState[offer.state]}.`);

             // Check if it was a pending deposit offer that failed
             const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
             const depositId = messageMatch ? messageMatch[1] : null;

             if (depositId && pendingDeposits.has(depositId)) {
                 // This was a deposit request that the user declined, or it expired/failed
                 const depositData = pendingDeposits.get(depositId);
                 console.warn(`Deposit offer ${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId} was ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                 pendingDeposits.delete(depositId); // Clean up pending data

                 // Clear the user's pending offer flag in DB
                 User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                      .then(updateRes => {
                           if(updateRes.modifiedCount > 0) console.log(`Cleared pendingDepositOfferId flag for user ${depositData.steamId} due to offer failure/expiry.`);
                      })
                      .catch(e => console.error("Error clearing user flag on deposit failure/expiry:", e));

                 // Notify user
                  const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase();
                 io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Your deposit offer (#${offer.id}) was ${stateMessage} and was cancelled.` });
             }
              // Check if it was a winnings payout offer that failed
              else if (offer.itemsToGive && offer.itemsToGive.length > 0) {
                  // This was a payout offer that the user declined, or it expired/failed
                  console.warn(`Payout offer #${offer.id} failed. State: ${TradeOfferManager.ETradeOfferState[offer.state]}. Items returned to bot inventory.`);
                  // Find user by steamId to emit notification
                  User.findOne({ steamId: offer.partner.getSteamID64() }).lean().then(user => {
                      if (user) {
                           const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase();
                           io.emit('notification', { type: 'error', userId: user._id.toString(), message: `Failed to deliver winnings (Offer #${offer.id}). The offer was ${stateMessage}. Contact support if this persists.` });
                      }
                  }).catch(e => console.error("Error finding user for payout fail notification:", e));
                  // TODO: Add logic to flag this failed payout for admin review/manual retry?
              }
        } // End if (Declined, Canceled, Expired, etc.)
    }); // End manager.on('sentOfferChanged')

} // End if (isBotConfigured && manager)


// --- Round Info API Routes ---
// Helper function to format round data for client
function formatRoundForClient(round) { // Expects a lean object
    if (!round) return null;

    const timeLeft = (round.status === 'active' && round.endTime)
        ? Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000))
        : (round.status === 'pending' ? ROUND_DURATION : 0);

    const participantsFormatted = (round.participants || []).map(p => ({
        user: p.user ? { id: p.user._id, steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar } : null,
        itemsValue: p.itemsValue || 0,
        tickets: p.tickets || 0
    })).filter(p => p.user);

    // Only include items if needed by client (can be large) - currently needed for display
    const itemsFormatted = (round.items || []).map(i => ({
        assetId: i.assetId,
        name: i.name,
        image: i.image,
        price: i.price || 0,
        owner: i.owner // Keep owner's Mongo ID
    }));

    let winnerDetails = null;
    if (round.winner) {
        winnerDetails = {
            id: round.winner._id || round.winner,
            steamId: round.winner.steamId || 'N/A',
            username: round.winner.username || 'N/A',
            avatar: round.winner.avatar || 'N/A'
        };
    }

    return {
        roundId: round.roundId,
        status: round.status,
        startTime: round.startTime,
        endTime: round.endTime,
        timeLeft: timeLeft,
        totalValue: round.totalValue || 0,
        serverSeedHash: round.serverSeedHash,
        participants: participantsFormatted,
        items: itemsFormatted, // Include formatted items
        // Conditionally include completed round data
        winner: winnerDetails,
        winningTicket: round.status === 'completed' ? round.winningTicket : undefined,
        serverSeed: round.status === 'completed' ? round.serverSeed : undefined,
        clientSeed: round.status === 'completed' ? round.clientSeed : undefined,
        provableHash: round.status === 'completed' ? round.provableHash : undefined,
        taxAmount: round.taxAmount
    };
}

// GET Current Round Data
app.get('/api/round/current', async (req, res) => {
    let roundToFormat = null;
    try {
        // Prioritize the in-memory currentRound if it exists and seems valid
        if (currentRound?._id) {
            roundToFormat = await Round.findById(currentRound._id)
                 .populate('participants.user', 'steamId username avatar')
                 .populate('items') // Populate full item details
                 .populate('winner', 'steamId username avatar')
                 .lean();
            if (!roundToFormat) { currentRound = null; } // Clear if not found
            else { currentRound = roundToFormat; } // Update memory
        }

        // Fallback: If no round in memory or fetch failed, check DB for *any* active round
        if (!roundToFormat) {
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                 .sort({ startTime: -1 })
                 .populate('participants.user', 'steamId username avatar')
                 .populate('items')
                 .populate('winner', 'steamId username avatar')
                 .lean();
            if (roundToFormat && !currentRound) { // Restore to memory if found and memory is empty
                 currentRound = roundToFormat;
                 console.log(`Restored active/pending round ${currentRound.roundId} from DB via API.`);
                 // Ensure timer is running if needed
                 if (currentRound.status === 'active' && currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                     startRoundTimer(true);
                 } else if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) {
                     startRoundTimer(false);
                 }
            }
        }

        const formattedData = formatRoundForClient(roundToFormat);

        if (formattedData) {
            res.json(formattedData);
        } else {
            res.status(404).json({ error: 'No active or pending round found.' });
        }
    } catch (err) {
        console.error('Error fetching/formatting current round data:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' });
    }
});

// GET Past Rounds (History)
app.get('/api/rounds',
    [ // Validation Rules
        query('page').optional().isInt({ min: 1 }).toInt().withMessage('Page must be a positive integer.'),
        query('limit').optional().isInt({ min: 1, max: 50 }).toInt().withMessage('Limit must be between 1 and 50.')
    ],
    handleValidationErrors,
    async (req, res) => {
        try {
            const page = req.query.page || 1;
            const limit = req.query.limit || 10;
            const skip = (page - 1) * limit;
            const queryFilter = { status: { $in: ['completed', 'error'] } };

            const [rounds, totalCount] = await Promise.all([
                Round.find(queryFilter)
                     .sort('-roundId')
                     .skip(skip)
                     .limit(limit)
                     .populate('winner', 'username avatar steamId')
                     .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount taxedItems') // Select fields
                     .lean(),
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

// POST Verify Provably Fair
app.post('/api/verify',
    sensitiveActionLimiter,
    [ // Validation Rules
        body('roundId').notEmpty().isInt({ min: 1 }).toInt(),
        body('serverSeed').trim().notEmpty().isHexadecimal().isLength({ min: 64, max: 64 }),
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 })
    ],
    handleValidationErrors,
    async (req, res) => {
        const { roundId, serverSeed, clientSeed } = req.body;
        try {
            const round = await Round.findOne({ roundId: roundId, status: 'completed' })
                 .populate('participants.user', 'username')
                 .populate('winner', 'username')
                 .lean();
            if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found.` });

            // 1. Verify Server Seed Hash
            const providedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
            if (providedHash !== round.serverSeedHash) {
                return res.json({ verified: false, reason: 'Server Seed Hash mismatch.', expectedHash: round.serverSeedHash, providedSeed: serverSeed, calculatedHash: providedHash });
            }
            // 2. Verify Seeds Match Record (if available)
            if (round.serverSeed && round.clientSeed) {
                if (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed) {
                    return res.json({ verified: false, reason: 'Provided seeds do not match the official round seeds.', expectedServerSeed: round.serverSeed, expectedClientSeed: round.clientSeed, providedServerSeed: serverSeed, providedClientSeed: clientSeed });
                }
            }
            // 3. Recalculate Winning Ticket
            const combinedString = serverSeed + clientSeed;
            const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
            // Verify calculated provable hash matches stored provable hash (if available)
            if (round.provableHash && calculatedProvableHash !== round.provableHash) {
                 return res.json({ verified: false, reason: 'Calculated Provable Hash does not match recorded hash.', expectedProvableHash: round.provableHash, calculatedProvableHash: calculatedProvableHash, combinedString: combinedString });
            }
            const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
            const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;
            if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets.' });
            const calculatedWinningTicket = decimalFromHash % totalTickets;
            // 4. Compare Calculated vs Actual Ticket
            if (calculatedWinningTicket !== round.winningTicket) {
                 return res.json({ verified: false, reason: 'Calculated winning ticket does not match the recorded winning ticket.', calculatedTicket: calculatedWinningTicket, actualWinningTicket: round.winningTicket, provableHashUsed: calculatedProvableHash, totalTickets: totalTickets });
            }
            // If all checks pass
            res.json({
                verified: true, roundId: round.roundId, serverSeed: serverSeed, serverSeedHash: round.serverSeedHash, clientSeed: clientSeed,
                combinedString: combinedString, finalHash: calculatedProvableHash, winningTicket: calculatedWinningTicket,
                totalTickets: totalTickets, totalValue: round.totalValue, winnerUsername: round.winner?.username || 'N/A'
            });
        } catch (err) {
            console.error(`Error verifying round ${roundId}:`, err);
            res.status(500).json({ error: 'Server error during verification.' });
        }
    });


// --- Socket.io Connection Handling ---
io.on('connection', (socket) => {
    // console.log(`Client connected: ${socket.id}`);

    // Send current round data on connection request
    socket.on('requestRoundData', async () => {
        try {
            // Re-use the logic from the API endpoint to get consistent data
            let roundToSend = null;
             if (currentRound?._id) {
                 roundToSend = await Round.findById(currentRound._id)
                       .populate('participants.user', 'steamId username avatar')
                       .populate('items') // Send items for initial load
                       .populate('winner', 'steamId username avatar')
                       .lean();
                 if (!roundToSend) { currentRound = null; }
                 else { currentRound = roundToSend; }
             }
             if (!roundToSend) {
                 roundToSend = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                       .sort({ startTime: -1 })
                       .populate('participants.user', 'steamId username avatar')
                       .populate('items') // Send items for initial load
                       .populate('winner', 'steamId username avatar')
                       .lean();
                 if (roundToSend && !currentRound) {
                      currentRound = roundToSend;
                      console.log(`Restored active/pending round ${currentRound.roundId} from DB on client socket request.`);
                      // Check and potentially start timer
                      if (currentRound.status === 'active' && currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                          startRoundTimer(true);
                      } else if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) {
                          startRoundTimer(false);
                      }
                 }
             }

            const formattedData = formatRoundForClient(roundToSend); // formatRoundForClient now includes items

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
        // console.log(`Client disconnected: ${socket.id}. Reason: ${reason}`);
    });
});

// --- Server Startup ---
async function startApp() {
    console.log("Performing initial price cache refresh from rust.scmm.app...");
    await refreshPriceCache(); // Wait for the first refresh attempt

    // Schedule periodic cache refresh
    setInterval(async () => {
        try { await refreshPriceCache(); }
        catch (refreshErr) { console.error("Error during scheduled price cache refresh:", refreshErr); }
    }, PRICE_REFRESH_INTERVAL_MS);
    console.log(`Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);

    // Start HTTP server
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log(`Site URL configured as: ${process.env.SITE_URL}`);

        // Bot status check
        if (!isBotConfigured) { console.log("INFO: Steam Bot not configured. Trade features disabled."); }
        else if (!isBotReady) { console.log("INFO: Steam Bot login attempt may have failed or is pending. Check logs."); }
        else { console.log("INFO: Steam Bot is ready."); } // Bot logged in and cookies set

        // Call ensureInitialRound AFTER server listens and bot status is known
        ensureInitialRound();
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
            await mongoose.connection.close();
            console.log('MongoDB connection closed.');
             // Stop polling if manager exists
             if (manager) {
                 console.log('Stopping TradeOfferManager polling...');
                 // You might need to access the internal poller to stop it cleanly
                 // Or rely on process exit stopping it. Check library docs if needed.
             }
            process.exit(0); // Exit cleanly
        } catch (e) {
            console.error("Error during shutdown:", e);
            process.exit(1);
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

// --- Basic Error Handling Middleware (Place LAST) ---
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.');
    // Avoid sending sensitive error details in production
    // Check if headers already sent
    if (res.headersSent) {
        return next(err); // Delegate to default Express handler
    }
    res.status(status).json({ error: message });
});
