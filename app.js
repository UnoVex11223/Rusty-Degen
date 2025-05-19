// app.js (Corrected and Complete with Chat Logic & Winning History Backend)

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
const bodyParser = require('body-parser'); // Still commonly used for simple JSON/URL-encoded parsing
const SteamTotp = require('steam-totp');
const axios = require('axios'); // Modern HTTP client, already in use
const NodeCache = require('node-cache');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, query, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid'); // Using v4 from uuid, ensure package is updated via npm/yarn
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
const TAX_MIN_PERCENT = parseFloat(process.env.SITE_FEE_PERCENT_MIN) || 5; // Use SITE_FEE_PERCENT from .env if available
const TAX_MAX_PERCENT = parseFloat(process.env.SITE_FEE_PERCENT_MAX) || 10; // Use SITE_FEE_PERCENT from .env if available
const MIN_POT_FOR_TAX = parseFloat(process.env.MIN_POT_FOR_TAX) || 100;
const MAX_CHAT_MESSAGE_LENGTH = 200;
const CHAT_COOLDOWN_SECONDS = parseInt(process.env.CHAT_COOLDOWN_SECONDS) || 5; // ADDED: Chat cooldown
const WINNER_PAYOUT_DELAY_MS = 7000; // Delay before sending trade offer to allow animation to complete on client

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: process.env.SITE_URL || "*", methods: ["GET", "POST"] } });

// --- Security Middleware ---
app.set('trust proxy', 1); // Necessary for rate limiters if behind a proxy
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "default-src": ["'self'"],
            "script-src": ["'self'", "/socket.io/socket.io.js", "'unsafe-inline'"], // Allow socket.io.js and inline scripts if necessary (consider nonce for inline)
            "script-src-attr": ["'self'", "'unsafe-inline'"], // For inline event handlers if any (try to avoid)
            "style-src": ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "'unsafe-inline'"], // Allow inline styles (consider moving to CSS files)
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
             "frame-src": ["'self'", "https://steamcommunity.com"], // Allow framing from self and steamcommunity (e.g. for trade offers)
             "frame-ancestors": ["'self'", "https://steamcommunity.com"], // Who can frame your site
            "object-src": ["'none'"], // Disallow <object>, <embed>, <applet>
            "upgrade-insecure-requests": [], // Upgrade HTTP to HTTPS
        },
    })
);


const generalApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many login attempts from this IP, please try again after 10 minutes', standardHeaders: true, legacyHeaders: false });
const sensitiveActionLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, message: 'Too many requests for this action, please try again after 5 minutes', standardHeaders: true, legacyHeaders: false });
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 10, message: 'Too many deposit attempts, please wait a minute.', standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, // Max 20 messages per minute per IP
    message: 'Too many chat messages from this IP. Please wait a moment.',
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', generalApiLimiter);
app.use(cors({ origin: process.env.SITE_URL || "*", credentials: true }));
app.use(express.json()); // Replaces bodyParser.json()
app.use(express.urlencoded({ extended: true })); // Replaces bodyParser.urlencoded()
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
        maxAge: 3600000 * 24, // 24 hours
        secure: process.env.NODE_ENV === 'production', // Set to true if using HTTPS
        httpOnly: true,
        sameSite: 'lax' // Recommended for CSRF protection if not using csurf
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
    providerURL: 'https://steamcommunity.com/openid' // Standard OpenID endpoint
},
    async (identifier, profile, done) => {
        try {
            const userData = {
                username: profile.displayName || `User${profile.id.substring(profile.id.length - 5)}`,
                avatar: profile._json.avatarfull || profile._json.avatar || '/img/default-avatar.png', // Use a default if none provided
            };
            const user = await User.findOneAndUpdate(
                { steamId: profile.id },
                {
                    $set: userData,
                    $setOnInsert: { // Fields to set only on document creation
                        steamId: profile.id,
                        tradeUrl: '', // Initialize as empty
                        createdAt: new Date(),
                        pendingDepositOfferId: null,
                        totalDepositedValue: 0,
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
passport.serializeUser((user, done) => done(null, user.id)); // Store user ID in session
passport.deserializeUser(async (id, done) => { // Retrieve user from ID
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
        process.exit(1); // Exit if DB connection fails
    });

// --- MongoDB Schemas ---
const userSchema = new mongoose.Schema({
    steamId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    avatar: { type: String },
    tradeUrl: {
        type: String,
        default: '',
        // Basic regex for Steam trade URL format
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
    name: { type: String, required: true }, // Market hash name
    image: { type: String, required: true }, // Image URL
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
    totalValue: { type: Number, default: 0, min: 0 }, // For winner, this is after-tax value. Original pre-tax pot value is sum of participant itemsValues.
    items: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }], // References to Item documents (items given to winner)
    participants: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        itemsValue: { type: Number, required: true, default: 0, min: 0 }, // Total value deposited by this user in this round
        tickets: { type: Number, required: true, default: 0, min: 0 } // Number of tickets based on value
    }],
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    winningTicket: { type: Number, min: 0 },
    serverSeed: { type: String, required: true, match: /^[a-f0-9]{64}$/ }, // 64 char hex
    serverSeedHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    clientSeed: { type: String, match: /^[a-f0-9]+$/ }, // Can vary in length
    provableHash: { type: String, match: /^[a-f0-9]{64}$/ }, // Hash of ServerSeed + ClientSeed
    taxAmount: { type: Number, default: 0, min: 0 },
    taxedItems: [{ assetId: String, name: String, price: { type: Number, min: 0 } }], // Info about items taken as tax
    payoutOfferId: { type: String, index: true }, // ID of the trade offer sent for winnings
    payoutOfferStatus: { type: String, enum: ['Pending Send', 'Sent', 'Accepted', 'Declined', 'Canceled', 'Expired', 'InvalidItems', 'Escrow', 'Failed', 'Unknown', 'No Items Won'], default: 'Unknown' } // Status of the payout trade offer
});
roundSchema.index({ 'participants.user': 1 }); // Index for querying participants
roundSchema.index({ winner: 1, status: 1, completedTime: -1 }); // For winning history query

const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);


// --- Steam Bot Setup ---
const community = new SteamCommunity();
const manager = new TradeOfferManager({
    steam: community, // Use the logged-in community instance
    domain: process.env.SITE_URL ? process.env.SITE_URL.replace(/^https?:\/\//, '') : 'localhost', // Your site's domain
    language: 'en', // Language for trade offers
    pollInterval: 10000, // Poll for new offers every 10 seconds
    cancelTime: 10 * 60 * 1000, // Cancel offers that haven't been accepted in 10 minutes
    // cancelOfferCount: 50, // OPTIONAL: Number of offers to check for cancellation each poll
    // cancelOfferCountMinAge: 1 * 60 * 60 * 1000 // OPTIONAL: Minimum age of offers to consider for cancellation (1 hour)
});
let isBotReady = false;
const pendingDeposits = new Map(); // Stores { depositId: { userId, roundId, items, totalValue, steamId } }

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
                community.setCookies(cookies); // Also set cookies for the community instance
                isBotReady = true;
                console.log("Steam Bot is ready and operational.");
                ensureInitialRound(); // Now that bot is ready, ensure a round exists
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
let isRolling = false; // Flag to indicate if a round is currently being rolled/processed

const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false });

// Fallback pricing (consider a more robust strategy if scmm.app is down)
function getFallbackPrice(marketHashName) {
    // For now, just return minimum, but you might want logging or alternative sources
    return MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0;
}

async function refreshPriceCache() {
    console.log("PRICE_INFO: Attempting to refresh price cache from rust.scmm.app...");
    const apiUrl = `https://rust.scmm.app/api/item/prices?currency=USD`; // Ensure this is the correct endpoint
    try {
        const response = await axios.get(apiUrl, { timeout: PRICE_FETCH_TIMEOUT_MS }); // Using axios
        if (response.data && Array.isArray(response.data)) {
            const items = response.data;
            let updatedCount = 0;
            let newItems = []; // For bulk update
            items.forEach(item => {
                // Ensure item has necessary properties and price is valid
                if (item?.name && typeof item.price === 'number' && item.price >= 0) {
                    const priceInDollars = item.price / 100.0; // Assuming price is in cents
                    newItems.push({ key: item.name, val: priceInDollars });
                    updatedCount++;
                }
            });
            if (newItems.length > 0) {
                const success = priceCache.mset(newItems); // Bulk set
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
        } else if (error.response) { // Axios error structure
            console.error(` -> Status: ${error.response.status}, Response:`, error.response.data || error.message);
        } else if (error.request) { // Request made but no response
            console.error(` -> Error: No response received (Network issue?).`, error.message);
        } else { // Other errors
            console.error(' -> Error setting up request:', error.message);
        }
    }
}

function getItemPrice(marketHashName) {
    if (typeof marketHashName !== 'string' || marketHashName.length === 0) {
        console.warn("getItemPrice called with invalid marketHashName:", marketHashName);
        return 0; // Or throw an error, depending on desired strictness
    }
    const cachedPrice = priceCache.get(marketHashName);
    return (cachedPrice !== undefined) ? cachedPrice : getFallbackPrice(marketHashName);
}

// --- Core Game Logic ---
async function createNewRound() {
    if (isRolling) {
        console.log("Cannot create new round: Current round is rolling or finalizing.");
        return null;
    }
    if (currentRound && (currentRound.status === 'active' || currentRound.status === 'rolling')) {
        console.log(`Cannot create new round: Round ${currentRound.roundId} is already ${currentRound.status}.`);
        return currentRound; // Return existing active/rolling round
    }

    try {
        isRolling = false; // Ensure rolling flag is reset
        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');

        const lastRound = await Round.findOne().sort('-roundId'); // Get the latest roundId
        const nextRoundId = lastRound ? lastRound.roundId + 1 : 1;

        const newRound = new Round({
            roundId: nextRoundId,
            status: 'active', // Start as active
            startTime: new Date(),
            serverSeed: serverSeed,
            serverSeedHash: serverSeedHash,
            items: [],
            participants: [],
            totalValue: 0, // This will be pre-tax pot value during the round
            payoutOfferStatus: 'Unknown' // Initialize for winning history
        });
        await newRound.save();
        currentRound = newRound.toObject(); // Update in-memory currentRound (as plain object)

        // Emit roundCreated BEFORE clearing items (so clients see the fresh round state)
        io.emit('roundCreated', {
            roundId: newRound.roundId,
            serverSeedHash: newRound.serverSeedHash,
            timeLeft: ROUND_DURATION, // Initial time for new round
            totalValue: 0,
            participants: [],
            items: [] // Send empty items for a new round
        });
        console.log(`--- Round ${newRound.roundId} created and active ---`);
        // Timer will start when the first participant joins
        return newRound.toObject();
    } catch (err) {
        console.error('FATAL: Error creating new round:', err);
        // Consider a more robust retry or error handling strategy if DB errors persist
        setTimeout(createNewRound, 10000); // Retry after delay
        return null;
    }
}

async function ensureInitialRound() {
    if (isBotConfigured && isBotReady) { // Only if bot is configured and ready
        if (!currentRound) {
            try {
                // Prioritize an 'active' or 'rolling' round to potentially resume
                let existingRound = await Round.findOne({ status: { $in: ['active', 'rolling'] } })
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items') // Populate items that are IN THE POT (not necessarily for winner yet)
                    .lean();

                if (existingRound) {
                    console.log(`Found existing ${existingRound.status} round ${existingRound.roundId} on startup.`);
                    currentRound = existingRound;

                    if (currentRound.status === 'active') {
                        if (currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                            startRoundTimer(true); // Resume with remaining time
                        } else if (currentRound.participants.length > 0 && !currentRound.endTime && !roundTimer) {
                            console.warn(`Active round ${currentRound.roundId} found without endTime. Starting timer now.`);
                            startRoundTimer(false);
                        }
                        // Client will request full data and render items
                    } else if (currentRound.status === 'rolling') {
                        console.log(`Round ${currentRound.roundId} was rolling. Attempting to finalize.`);
                        isRolling = false; // Reset flag as we are taking over
                        await endRound(); // Try to complete the rolling process
                    }
                } else {
                    console.log("No active or rolling round found, creating initial round...");
                    await createNewRound();
                }
            } catch (dbErr) {
                console.error("Error ensuring initial round:", dbErr);
                // Fallback: If error occurs (e.g., during endRound), try creating a fresh round after a delay
                setTimeout(createNewRound, 5000);
            }
        }
    } else if (isBotConfigured && !isBotReady) {
        console.log("Bot configured but not ready, skipping initial round check until bot is ready.");
    } else {
        console.log("Bot not configured, skipping initial round check.");
    }
}

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
        currentRound.endTime = calculatedEndTime.toISOString(); // Store ISO string for consistency
        // Update endTime in DB
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
            .catch(e => console.error(`Error saving round end time for round ${currentRound?.roundId}:`, e));
        console.log(`Starting timer for round ${currentRound.roundId} (${ROUND_DURATION}s). End time: ${calculatedEndTime.toISOString()}`);
    }

    io.emit('timerUpdate', { timeLeft }); // Initial timer update

    roundTimer = setInterval(async () => {
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) {
            clearInterval(roundTimer); roundTimer = null;
            console.warn("Timer stopped: Round state became invalid during countdown.");
            return;
        }

        const now = Date.now();
        // Ensure currentRound.endTime is treated as a Date object for comparison
        let currenttimeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - now) / 1000));

        io.emit('timerUpdate', { timeLeft: currenttimeLeft });

        if (currenttimeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null;
            console.log(`Round ${currentRound.roundId} timer reached zero.`);
            await endRound();
        }
    }, 1000);
}

// app.js (Corrected and Complete with Chat Logic & Winning History Backend) - Part 2 of 2

async function endRound() {
    if (!currentRound || isRolling || currentRound.status !== 'active') {
        console.warn(`Attempted to end round ${currentRound?.roundId}, but state is invalid (Status: ${currentRound?.status}, Rolling: ${isRolling})`);
        if (isRolling && currentRound && currentRound.status === 'rolling') {
             console.log(`Round ${currentRound.roundId} is already rolling. Allowing current process to complete.`);
        }
        return;
    }
    isRolling = true; // Set rolling flag immediately
    const roundIdToEnd = currentRound.roundId;
    const roundMongoId = currentRound._id; // Ensure we are using the MongoDB ObjectId
    console.log(`--- Ending round ${roundIdToEnd}... ---`);

    try {
        // Update status to 'rolling' in DB and emit to clients
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } });
        io.emit('roundRolling', { roundId: roundIdToEnd }); // Client uses this to switch to roulette view directly

        // Fetch the most up-to-date round data, ensuring all participants and items are populated
        const round = await Round.findById(roundMongoId)
            .populate('participants.user', 'steamId username avatar tradeUrl') // Ensure tradeUrl is populated for winner
            .populate('items') // Populate all items currently in the pot
            .lean(); // Use .lean() for performance if not modifying the mongoose doc directly

        if (!round) {
            throw new Error(`Round ${roundIdToEnd} data missing after status update to rolling.`);
        }
        // Double-check status in case of race conditions, though less likely with lean()
        if (round.status !== 'rolling') {
             console.warn(`Round ${roundIdToEnd} status changed unexpectedly (${round.status}) after marking as rolling. Aborting endRound.`);
             isRolling = false; // Reset rolling flag
             // If status is completed/error, new round creation will be handled by that flow
             return;
        }
        currentRound = round; // Update in-memory currentRound with the lean object

        if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            console.log(`Round ${round.roundId} ended with no valid participants or value.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date() } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants or value in pot." });
            isRolling = false;
            setTimeout(createNewRound, 5000); // Create new round after a short delay
            return;
        }

        let itemsInPotBeforeTax = [...round.items]; // All items that were in the pot
        let originalPotValue = round.participants.reduce((sum, p) => sum + (p?.itemsValue || 0), 0);
        let valueForWinner = originalPotValue;
        let taxAmount = 0;
        let taxedItemsInfo = []; // To store info about items taken for tax
        let itemsToGiveToWinner = [...itemsInPotBeforeTax]; // Start with all items

        // Calculate and apply tax
        if (originalPotValue >= MIN_POT_FOR_TAX) {
            const targetTaxRate = TAX_MIN_PERCENT / 100;
            const maxTaxRate = TAX_MAX_PERCENT / 100;
            let targetTaxValue = originalPotValue * targetTaxRate;
            const maxTaxValueAllowed = originalPotValue * maxTaxRate;

            // Sort items by price (ascending) to pick smallest for tax
            const sortedItemsForTaxConsideration = [...itemsInPotBeforeTax].sort((a, b) => (a.price || 0) - (b.price || 0));
            let currentTaxValueAccumulated = 0;
            let itemsTakenForTaxObjects = [];

            for (const item of sortedItemsForTaxConsideration) {
                // If adding this item doesn't exceed max tax and helps reach target
                if (currentTaxValueAccumulated < targetTaxValue || (currentTaxValueAccumulated + (item.price || 0) <= maxTaxValueAllowed)) {
                    itemsTakenForTaxObjects.push(item);
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price || 0 });
                    currentTaxValueAccumulated += (item.price || 0);
                    // Stop if we've hit the target tax or taking more would exceed the max percentage
                    if (currentTaxValueAccumulated >= targetTaxValue && currentTaxValueAccumulated <= maxTaxValueAllowed) break;
                    if (currentTaxValueAccumulated > maxTaxValueAllowed) { // Oops, went over, remove last item
                        const lastItem = itemsTakenForTaxObjects.pop();
                        taxedItemsInfo.pop();
                        currentTaxValueAccumulated -= (lastItem.price || 0);
                        break;
                    }
                } else if (itemsTakenForTaxObjects.length === 0 && (item.price || 0) <= maxTaxValueAllowed) {
                    // If no items taken yet, and this single item is within max tax, take it (even if above target)
                    itemsTakenForTaxObjects.push(item);
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price || 0 });
                    currentTaxValueAccumulated += (item.price || 0);
                    break;
                }
            }


            if (itemsTakenForTaxObjects.length > 0) {
                const taxItemIds = new Set(itemsTakenForTaxObjects.map(i => i._id.toString()));
                itemsToGiveToWinner = itemsInPotBeforeTax.filter(item => !taxItemIds.has(item._id.toString()));
                taxAmount = currentTaxValueAccumulated;
                valueForWinner = originalPotValue - taxAmount;
                console.log(`Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${itemsTakenForTaxObjects.length} items). Original Value: $${originalPotValue.toFixed(2)}. Pot Value for Winner: $${valueForWinner.toFixed(2)}`);
            }
        }

        // Determine winner
        const clientSeed = crypto.randomBytes(16).toString('hex'); // Generate client seed at the end
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16); // Use first 8 hex chars for wider range
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);

        if (totalTickets <= 0) {
             console.warn(`Round ${round.roundId} has zero total tickets despite having participants/value. This should not happen.`);
             // This case needs careful handling, maybe mark round as error or refund
             await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', completedTime: new Date(), clientSeed, provableHash, taxAmount, taxedItems: taxedItemsInfo } });
             io.emit('roundError', { roundId: round.roundId, error: 'Internal error: Zero tickets in round.' });
             isRolling = false;
             setTimeout(createNewRound, 7000);
             return;
        }
        const winningTicket = decimalFromHash % totalTickets;
        let cumulativeTickets = 0;
        let winnerInfo = null; // This will be the populated user object

        for (const participant of round.participants) {
            if (!participant?.tickets || !participant.user) continue;
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winnerInfo = participant.user; // Winner user object is already populated with tradeUrl
                break;
            }
        }

        if (!winnerInfo || !winnerInfo._id) {
            throw new Error(`Winner selection failed for round ${round.roundId}. No winner found for ticket ${winningTicket}.`);
        }

        // Update winner's stats
        await User.findByIdAndUpdate(winnerInfo._id, { $inc: { totalWinningsValue: valueForWinner } });
        console.log(`Updated winnings stats for ${winnerInfo.username}: Added $${valueForWinner.toFixed(2)}`);

        const finalUpdateData = {
            status: 'completed',
            completedTime: new Date(),
            clientSeed: clientSeed,
            provableHash: provableHash,
            winningTicket: winningTicket,
            winner: winnerInfo._id, // Store winner's ObjectId
            taxAmount: taxAmount,
            taxedItems: taxedItemsInfo, // Store info about items taken as tax
            totalValue: valueForWinner, // This is the after-tax value the winner receives
            items: itemsToGiveToWinner.map(i => i._id), // Store ObjectIds of items won by the winner
            payoutOfferStatus: 'Pending Send'
        };

        const completedRoundDoc = await Round.findOneAndUpdate({ _id: roundMongoId }, { $set: finalUpdateData }, { new: true })
            .populate('winner', 'steamId username avatar tradeUrl'); // Re-populate winner to ensure all fields are fresh for payout

        if (!completedRoundDoc) {
            throw new Error("Failed to save completed round data after winner selection.");
        }

        console.log(`Round ${round.roundId} completed. Winner: ${winnerInfo.username} (Ticket: ${winningTicket}/${totalTickets}, Value Won: $${valueForWinner.toFixed(2)})`);

        // Emit winner details for client-side animation
        io.emit('roundWinner', {
            roundId: round.roundId,
            winner: { // Send necessary winner details
                id: winnerInfo._id, // MongoDB _id
                steamId: winnerInfo.steamId,
                username: winnerInfo.username,
                avatar: winnerInfo.avatar
            },
            winningTicket: winningTicket,
            totalValue: valueForWinner, // After-tax value
            totalTickets: totalTickets,
            serverSeed: round.serverSeed, // Revealed server seed
            clientSeed: clientSeed,       // Client seed used
            provableHash: provableHash,   // Final provable hash
            serverSeedHash: round.serverSeedHash // Initial hash for verification
        });

        // Delay sending the trade offer to allow animation to complete on client
        setTimeout(async () => {
            // Fetch the winner again directly before sending trade to get latest tradeUrl if it changed
            const finalWinnerData = await User.findById(winnerInfo._id).select('tradeUrl username steamId').lean();
            if (!finalWinnerData) {
                console.error(`CRITICAL: Could not fetch winner ${winnerInfo.username} for payout after delay.`);
                await Round.updateOne({ _id: completedRoundDoc._id }, { $set: { payoutOfferStatus: 'Failed' } });
                return;
            }
            // Pass the lean User object and the actual Item objects to send
            await sendWinningTradeOffer(completedRoundDoc.toObject(), finalWinnerData, itemsToGiveToWinner);
        }, WINNER_PAYOUT_DELAY_MS);


    } catch (err) {
        console.error(`CRITICAL ERROR during endRound for round ${roundIdToEnd}:`, err);
        // Attempt to mark the round as 'error' in the database
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', payoutOfferStatus: 'Failed' } })
            .catch(e => console.error("Error marking round as error after endRound failure:", e));
        io.emit('roundError', { roundId: roundIdToEnd, error: 'Internal server error during round finalization.' });
    } finally {
        isRolling = false; // Reset rolling flag
        console.log(`Scheduling next round creation after round ${roundIdToEnd} finalization attempt.`);
        // Always schedule a new round, even if the previous one had an error, to keep the game going
        setTimeout(createNewRound, 10000); // Delay before creating the next round
    }
}

async function sendWinningTradeOffer(roundDoc, winner, itemsToSend) { // winner is a lean User object, itemsToSend are full Item objects
    if (!isBotReady) {
        console.error(`PAYOUT_ERROR (Bot Not Ready): Cannot send winnings for round ${roundDoc.roundId} to ${winner.username}.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Steam Bot Error: Payout for round ${roundDoc.roundId} is currently unavailable. Please contact support.` });
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed' } });
        return;
    }
    if (!winner.tradeUrl) {
        console.error(`PAYOUT_ERROR (No Trade URL): Winner ${winner.username} (SteamID: ${winner.steamId}) has no Trade URL set for round ${roundDoc.roundId}.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'CRITICAL: Your Trade URL is not set. Please update it in your profile to receive your winnings for round ' + roundDoc.roundId +'. Contact support if items are not received after updating.' });
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed' } });
        return;
    }
    if (!itemsToSend || itemsToSend.length === 0) {
        console.log(`PAYOUT_INFO: No items to send for winner ${winner.username} in round ${roundDoc.roundId}. Pot value might have been entirely taxed or $0.`);
        if (roundDoc.taxAmount > 0 && roundDoc.totalValue <= 0) { // totalValue is after-tax value for winner
            io.emit('notification', { type: 'info', userId: winner._id.toString(), message: `Round ${roundDoc.roundId}: Your winnings ($${roundDoc.taxAmount.toFixed(2)}) were collected as site tax. No items to send.` });
        } else if (roundDoc.totalValue <= 0) {
             io.emit('notification', { type: 'info', userId: winner._id.toString(), message: `Round ${roundDoc.roundId}: No items won (pot value was $0 or completely taxed).` });
        }
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'No Items Won' } });
        return;
    }

    console.log(`Attempting to send ${itemsToSend.length} item(s) for round ${roundDoc.roundId} to ${winner.username} (Trade URL: ${winner.tradeUrl}). Total value: $${roundDoc.totalValue.toFixed(2)}`);
    try {
        const offer = manager.createOffer(winner.tradeUrl);
        // itemsToSend should be an array of full Item objects (not just IDs)
        const itemsForOffer = itemsToSend.map(item => ({
            assetid: item.assetId, // Make sure this is the correct assetId from the Item schema
            appid: RUST_APP_ID,    // Ensure RUST_APP_ID is defined
            contextid: RUST_CONTEXT_ID // Ensure RUST_CONTEXT_ID is defined
        }));

        offer.addMyItems(itemsForOffer);
        offer.setMessage(`Congratulations! Your winnings from Round #${roundDoc.roundId} on ${process.env.SITE_NAME}. Total value: $${roundDoc.totalValue.toFixed(2)}`);

        // Asynchronously send the offer
        const sentOfferDetails = await new Promise((resolve, reject) => {
            offer.send((err, status) => {
                if (err) {
                    // EResult 2 indicates a general failure, often related to trade tokens or privacy settings
                    if (err.eresult === 2 || err.message.toLowerCase().includes('trade token') || err.message.toLowerCase().includes('privacy settings')) {
                       err.customMessage = 'Failed to send trade offer. Please check your Steam Trade URL, inventory privacy (must be public), and ensure you can receive trades. (EResult: ' + err.eresult + ')';
                    } else if (err.eresult === 15 || err.eresult === 16) { // Inventory full or private
                         err.customMessage = 'Could not send winnings: Your Steam inventory might be full or private. Please check and try again or contact support. (EResult: ' + err.eresult + ')';
                    } else if (err.eresult === 26) { // Trade URL invalid token
                         err.customMessage = 'Your Steam Trade URL is invalid or has an expired token. Please update it in your profile. (EResult: 26)';
                    }
                    return reject(err);
                }
                resolve({ status, offerId: offer.id });
            });
        });

        const offerURL = `https://steamcommunity.com/tradeoffer/${sentOfferDetails.offerId}/`;
        let payoutStatus = 'Sent';
        if (sentOfferDetails.status === 'pending' || sentOfferDetails.status === 'pendingConfirmation' || sentOfferDetails.status === 'escrow' || offer.state === TradeOfferManager.ETradeOfferState.InEscrow) {
            payoutStatus = 'Escrow'; // Or a more specific status like 'PendingConfirmation'
            console.log(`Offer #${sentOfferDetails.offerId} requires confirmation or is in escrow (Status: ${sentOfferDetails.status}, Offer State: ${TradeOfferManager.ETradeOfferState[offer.state]}).`);
            io.emit('notification', {
                type: 'warning', userId: winner._id.toString(),
                message: `Winnings sent (Offer <a href="${offerURL}" target="_blank" rel="noopener noreferrer" class="notification-link">#${sentOfferDetails.offerId}</a>), but it may be held in escrow or require confirmation in Steam.`
            });
        }

        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferId: sentOfferDetails.offerId, payoutOfferStatus: payoutStatus } });
        console.log(`PAYOUT_SUCCESS: Offer ${sentOfferDetails.offerId} sent to ${winner.username} for round ${roundDoc.roundId}. Status: ${sentOfferDetails.status}`);

        // Emit event for client to show "Accept Trade" popup
        io.emit('tradeOfferSent', {
            type: 'winning', // Differentiate from deposit offers if needed on client
            roundId: roundDoc.roundId,
            userId: winner._id.toString(), // Winner's MongoDB ID
            username: winner.username,
            offerId: sentOfferDetails.offerId,
            offerURL: offerURL,
            status: sentOfferDetails.status, // e.g., "sent", "pending", "escrow"
            message: `Your winnings from Round #${roundDoc.roundId} are ready! Click to accept.`
        });

    } catch (err) {
        let offerStatusUpdate = 'Failed';
        let userMessage = `Error sending winnings for round ${roundDoc.roundId}. Please contact support.`;

        if (err.customMessage) { // Use custom message if set
            userMessage = err.customMessage;
        } else if (err.message?.includes('revoked') || err.message?.includes('invalid') || err.eresult === 26) {
            userMessage = 'Your Trade URL is invalid or expired. Please update it in your profile to receive winnings for this round. (EResult: 26)'; offerStatusUpdate = 'Failed - Bad URL';
        } else if (err.eresult === 15 || err.eresult === 16) {
            userMessage = 'Could not send winnings. Ensure your Steam inventory is public and not full. (EResult: ' + err.eresult + ')'; offerStatusUpdate = 'Failed - Inventory Issue';
        } else if (err.message?.includes('escrow') || err.eresult === 11) { // EResult 11 can also indicate escrow
            userMessage = `Winnings sent for round ${roundDoc.roundId}, but may be held in escrow by Steam.`; offerStatusUpdate = 'Escrow';
        }

        console.error(`PAYOUT_ERROR: Sending offer for round ${roundDoc.roundId} to ${winner.username} failed. EResult: ${err.eresult || 'N/A'} - Message: ${err.message}`, err.stack || err);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: userMessage });
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

// --- Middleware & API Routes ---
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

app.get('/api/user', ensureAuthenticated, (req, res) => {
    const { _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue });
});

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
            if (err.name === 'ValidationError') { // Mongoose validation error
                 console.error(`Trade URL Validation Error (Mongoose) for user ${req.user._id}:`, err.message);
                 return res.status(400).json({ error: err.message });
            }
            console.error(`Error updating trade URL for user ${req.user._id}:`, err);
            res.status(500).json({ error: 'Server error saving Trade URL.' });
        }
    }
);

// API Endpoint for Winning History
app.get('/api/user/winning-history', ensureAuthenticated, async (req, res) => {
    try {
        const winnings = await Round.find({ winner: req.user._id, status: 'completed' })
            .sort({ completedTime: -1 })
            .select('roundId completedTime totalValue payoutOfferId payoutOfferStatus taxAmount') // Select relevant fields
            .limit(50) // Limit to last 50 wins for performance
            .lean();

        const history = winnings.map(win => ({
            gameId: win.roundId,
            amountWon: win.totalValue, // This is already after-tax value for winner
            dateWon: win.completedTime,
            tradeOfferId: win.payoutOfferId,
            tradeStatus: win.payoutOfferStatus || 'Unknown'
        }));
        res.json(history);
    } catch (error) {
        console.error(`Error fetching winning history for user ${req.user._id}:`, error);
        res.status(500).json({ error: 'Server error fetching winning history.' });
    }
});


app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    if (!isBotReady) { // Check if bot is operational
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
                resolve(inv || []); // Ensure inv is an array
            });
        });

        if (!inventory?.length) return res.json([]); // Return empty array if no items

        const validItems = inventory.map(item => {
                const itemName = item.market_hash_name;
                let price = 0;
                if (itemName) price = getItemPrice(itemName);
                else console.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`);

                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

                if (!item.assetid || !item.icon_url || !itemName) { // Ensure essential properties exist
                    console.warn(`Inventory item missing required properties: assetId ${item?.assetid}, Name ${itemName}, Icon ${item?.icon_url}`);
                    return null; // Skip this item
                }
                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`; // Construct image URL
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
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.') // Basic validation for asset IDs
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

        if (!currentRound || currentRound.status !== 'active' || isRolling) { // Also check isRolling here
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }

        let latestRoundData;
        try {
            // Fetch fresh round data to check limits accurately
            latestRoundData = await Round.findById(currentRound._id).select('participants items status').lean().exec();
            if (!latestRoundData || latestRoundData.status !== 'active') { // Re-check status
                throw new Error('Round is no longer active or data unavailable.');
            }
            const isNewParticipant = !latestRoundData.participants.some(p => p.user?.toString() === user._id.toString());
            if (isNewParticipant && latestRoundData.participants.length >= MAX_PARTICIPANTS) {
                 return res.status(400).json({ error: `Participant limit (${MAX_PARTICIPANTS}) reached.` });
            }
            if (latestRoundData.items.length + requestedAssetIds.length > MAX_ITEMS_PER_POT) {
                 const slotsLeft = MAX_ITEMS_PER_POT - latestRoundData.items.length;
                 return res.status(400).json({ error: `Depositing ${requestedAssetIds.length} items would exceed pot limit (${MAX_ITEMS_PER_POT}). ${slotsLeft} slots left.` });
            }
        } catch (dbErr) {
            console.error(`Error fetching round data or round status changed during deposit for ${user.username}:`, dbErr);
            return res.status(500).json({ error: 'Internal server error or round closed while checking limits.' });
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
                if (!inventoryItem) throw new Error(`Item Asset ID ${assetId} not found in your inventory.`);
                if (!inventoryItem.tradable) throw new Error(`Item '${inventoryItem.market_hash_name}' is not tradable.`);
                const price = getItemPrice(inventoryItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) throw new Error(`Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below the minimum value of $${MIN_ITEM_VALUE.toFixed(2)}.`);
                itemsToRequest.push({
                    assetid: inventoryItem.assetid, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID,
                    _price: price, _name: inventoryItem.market_hash_name,
                     _image: `https://community.akamai.steamstatic.com/economy/image/${inventoryItem.icon_url}`
                });
                depositTotalValue += price;
            }
             if (itemsToRequest.length === 0) throw new Error("No valid items could be verified for deposit.");
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
                userId: user._id, roundId: currentRound._id, items: itemsToRequest, // Store full item details
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
            const status = await new Promise((resolve, reject) => { // Use a promise for offer.send
                offer.send((err, sendStatus) => { if (err) return reject(err); resolve(sendStatus); });
            });

            try {
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: offer.id });
                console.log(`Set pendingDepositOfferId=${offer.id} for user ${user.username}.`);
            } catch (dbUpdateError) { // Catch error if DB update fails
                 console.error(`CRITICAL: Failed to set pendingDepositOfferId for user ${user.username} after sending offer ${offer.id}.`, dbUpdateError);
                  pendingDeposits.delete(depositId); if (cleanupTimeout) clearTimeout(cleanupTimeout);
                  // Potentially try to cancel the offer if possible, though this is complex
                  return res.status(500).json({ error: 'Failed to finalize deposit request state. Please contact support immediately.' });
            }
            console.log(`Deposit offer ${offer.id} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;
            res.json({ success: true, message: 'Deposit offer created! Please accept it on Steam.', offerId: offer.id, offerURL: offerURL });
        } catch (error) { // Catches errors from createOffer, offer.send promise, or manual throws
            console.error(`Error sending deposit offer for ${user.username} (DepositID: ${depositId}): EResult ${error.eresult}`, error.message, error.stack);
            pendingDeposits.delete(depositId); if (cleanupTimeout) clearTimeout(cleanupTimeout);
            // Clear pending flag only if it was potentially set
            await User.updateOne({ steamId: user.steamId, pendingDepositOfferId: offer?.id }, { pendingDepositOfferId: null })
                 .catch(e => console.error("Error clearing user pending flag on offer send failure:", e));

            let userMessage = 'Failed to create deposit trade offer. Please try again later.';
            if (error.message.includes('unable to trade') && error.message.includes('reset your Steam account')) userMessage = `Steam Error: Your account has a temporary trade restriction. (${error.message})`;
            else if (error.message.includes('Trade URL') || error.message.includes('token') || error.eresult === 26) userMessage = 'Your Steam Trade URL might be invalid or expired. Please check your profile settings.';
            else if (error.eresult) userMessage += ` (Steam Error Code: ${error.eresult})`;
            res.status(500).json({ error: userMessage });
        }
    }
);

// --- Trade Offer Manager Event Handling ---
if (isBotConfigured && manager) {
    manager.on('newOffer', async (offer) => { // Handles incoming offers TO THE BOT
        if (!isBotReady || offer.isOurOffer) return; // Ignore offers sent by us or if bot isn't ready

        // Decline unsolicited offers (e.g., donations or wrong trades)
        // This logic assumes all legitimate incoming items are via offers the bot INITIATES and tracks via pendingDeposits
        if (offer.itemsToReceive && offer.itemsToReceive.length > 0 && (!offer.itemsToGive || offer.itemsToGive.length === 0)) {
             // Check if it's a deposit offer based on the message pattern
             if (offer.message && offer.message.includes('RustyDegen Deposit ID:')) {
                 const depositIdMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
                 const depositIdFromMessage = depositIdMatch ? depositIdMatch[1] : null;

                 if (depositIdFromMessage && pendingDeposits.has(depositIdFromMessage)) {
                     // This means the user MANUALLY accepted an offer our bot sent them, which is handled by 'sentOfferChanged'.
                     // This 'newOffer' event for an offer we sent but they just accepted can sometimes fire.
                     // We should not process it here as 'sentOfferChanged' will handle it.
                     console.log(`Offer #${offer.id} (DepositID: ${depositIdFromMessage}) is a pending deposit, will be handled by sentOfferChanged. Ignoring in newOffer.`);
                     return;
                 } else {
                     // This is an unsolicited offer that matches the deposit message format but isn't in our pending map.
                     console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like a manual/unknown deposit (ID not pending). Declining.`);
                     return offer.decline((err) => { if (err) console.error(`Error declining manual/unknown deposit offer ${offer.id}:`, err); });
                 }
             } else {
                 // Truly unsolicited item offer
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} is an unsolicited item offer (not a tracked deposit). Declining.`);
                  return offer.decline((err) => { if (err) console.error(`Error declining unsolicited offer ${offer.id}:`, err); });
             }
        }
        // Decline offers where the bot is asked to give items but it's not a tracked winning payout
        else if (offer.itemsToGive && offer.itemsToGive.length > 0) {
            console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} asks bot to give items but is not a tracked payout. Declining.`);
            return offer.decline((err) => { if (err) console.error(`Error declining unexpected outgoing item offer ${offer.id}:`, err); });
        }

        console.log(`Ignoring other unexpected incoming offer #${offer.id} from ${offer.partner.getSteamID64()}. Items to give: ${offer.itemsToGive.length}, Items to receive: ${offer.itemsToReceive.length}`);
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        // This event fires when an offer WE SENT changes state (e.g., accepted, declined by user)
        console.log(`SENT OFFER CHANGED: Offer #${offer.id} state: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()}) Msg: "${offer.message}"`);

        const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
        const depositId = messageMatch ? messageMatch[1] : null;

        if (depositId && pendingDeposits.has(depositId)) { // It's a DEPOSIT offer we sent, and user acted on it
            const depositData = pendingDeposits.get(depositId);

            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                pendingDeposits.delete(depositId); // Remove from pending map as it's processed
                console.log(`Processing accepted deposit offer #${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId}`);
                // Clear the pending flag on the user document
                User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                    .catch(e => console.error("Error clearing user pendingDepositOfferId on deposit accept:", e));

                let depositRoundCheck; // For checking round state before adding items
                try {
                     depositRoundCheck = await Round.findById(depositData.roundId).select('status participants items').exec(); // No lean here, might save
                     if (!depositRoundCheck || depositRoundCheck.status !== 'active' || isRolling) { // Also check isRolling
                          console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but round ${depositData.roundId} is no longer active or is rolling. Items will NOT be added to pot.`);
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Round ended or started rolling before offer #${offer.id} was processed. Your items were not added. Please contact support for assistance.` });
                          // Potentially handle refunding items or crediting user account value here if items were taken by bot.
                          // This is complex and depends on how strictly you want to manage this edge case.
                          // For now, items are with the bot but not in pot.
                          return;
                     }
                     // Check participant and item limits again just before committing
                     const isNewP = !depositRoundCheck.participants.some(p => p.user?.toString() === depositData.userId.toString());
                     if (isNewP && depositRoundCheck.participants.length >= MAX_PARTICIPANTS) {
                         io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error (Offer #${offer.id}): Participant limit was reached for the round. Contact support.` }); return;
                     }
                     if (depositRoundCheck.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error (Offer #${offer.id}): Pot item limit was reached. Contact support.` }); return;
                     }
                 } catch (roundCheckError) {
                      console.error(`CRITICAL DB ERROR checking round status for accepted deposit ${depositId} (Offer #${offer.id}):`, roundCheckError);
                      io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error (Offer #${offer.id}). Your items may not have been added. Contact support immediately.` });
                      return; // Prevent further processing
                 }

                let createdItemDocuments = []; // To store the actual Mongoose Item documents
                try {
                    // Create Item documents for the deposited items
                    const itemDocumentsToCreate = depositData.items.map(itemData => new Item({
                        assetId: itemData.assetid,
                        name: itemData._name, // Make sure _name, _image, _price are stored in pendingDeposits
                        image: itemData._image,
                        price: itemData._price,
                        owner: depositData.userId, // ObjectId of the user
                        roundId: depositData.roundId // ObjectId of the current round
                    }));
                    createdItemDocuments = await Item.insertMany(itemDocumentsToCreate, { ordered: false });
                    const createdItemIds = createdItemDocuments.map(doc => doc._id); // Get their MongoDB _ids

                    console.log(`Deposit ${depositId}: Inserted ${createdItemDocuments.length} items into DB. IDs: ${createdItemIds.join(', ')}`);

                    // Update user's total deposited value
                    await User.findByIdAndUpdate( depositData.userId, { $inc: { totalDepositedValue: depositData.totalValue } } );

                    // Update the round document (fetched fresh as depositRoundCheck)
                    let participantIndex = depositRoundCheck.participants.findIndex(p => p.user?.toString() === depositData.userId.toString());
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));

                    if (participantIndex !== -1) { // Existing participant
                           depositRoundCheck.participants[participantIndex].itemsValue = (depositRoundCheck.participants[participantIndex].itemsValue || 0) + depositData.totalValue;
                           depositRoundCheck.participants[participantIndex].tickets = (depositRoundCheck.participants[participantIndex].tickets || 0) + depositTickets;
                    } else { // New participant
                           if (depositRoundCheck.participants.length >= MAX_PARTICIPANTS) throw new Error("Participant limit hit before final save (should have been caught earlier).");
                           depositRoundCheck.participants.push({
                               user: depositData.userId, // Store ObjectId
                               itemsValue: depositData.totalValue,
                               tickets: depositTickets
                           });
                    }
                    depositRoundCheck.totalValue = (depositRoundCheck.totalValue || 0) + depositData.totalValue; // This is the pre-tax value displayed during the round
                    if (depositRoundCheck.items.length + createdItemIds.length > MAX_ITEMS_PER_POT) throw new Error("Pot item limit hit before final save (should have been caught earlier).");
                    depositRoundCheck.items.push(...createdItemIds); // Add the MongoDB _ids of the new items

                    const savedRound = await depositRoundCheck.save(); // Save changes to the round

                    // Fetch the fully populated round data to emit (including user details for the new deposit)
                    const latestRoundDataForEmit = await Round.findById(savedRound._id)
                        .populate('participants.user', 'steamId username avatar') // Populate user details for all participants
                        .lean(); // Use lean for emission

                    if (!latestRoundDataForEmit) throw new Error('Failed to fetch updated round data for emission after deposit.');

                    currentRound = latestRoundDataForEmit; // Update in-memory currentRound

                    // Find the specific participant's data for this deposit to emit
                    const updatedParticipantData = latestRoundDataForEmit.participants.find(p => p.user?._id.toString() === depositData.userId.toString());
                    const userInfoForEmit = updatedParticipantData?.user;

                    if (updatedParticipantData && userInfoForEmit) {
                          io.emit('participantUpdated', {
                               roundId: latestRoundDataForEmit.roundId,
                               userId: userInfoForEmit._id.toString(), // MongoDB _id
                               username: userInfoForEmit.username,
                               avatar: userInfoForEmit.avatar,
                               itemsValue: updatedParticipantData.itemsValue, // User's total value in this round
                               tickets: updatedParticipantData.tickets,       // User's total tickets in this round
                               totalValue: latestRoundDataForEmit.totalValue, // Round's total pre-tax value
                               depositedItems: createdItemDocuments.map(i => ({ // Send details of items just deposited
                                   assetId: i.assetId, name: i.name, image: i.image, price: i.price
                               }))
                          });
                    } else {
                        console.warn("Could not find participant data for emission after deposit. UserInfo:", userInfoForEmit, "ParticipantData:", updatedParticipantData);
                    }

                    // Start timer if this was the first participant and round is active
                    if (latestRoundDataForEmit.participants.length === 1 && !roundTimer && latestRoundDataForEmit.status === 'active') {
                          startRoundTimer();
                    }
                     console.log(`Deposit success processed for offer #${offer.id}. User: ${userInfoForEmit?.username}. Round pot now $${latestRoundDataForEmit.totalValue.toFixed(2)}`);
                 } catch (dbErr) {
                     console.error(`CRITICAL DB/UPDATE ERROR processing accepted deposit ${offer.id} (DepositID: ${depositId}):`, dbErr.stack || dbErr);
                     io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error (Offer #${offer.id}). Your items may not have been correctly processed. Contact support immediately.` });
                      // Attempt to rollback item creation if it happened
                      if (createdItemDocuments.length > 0) {
                          console.error(`Attempting to delete ${createdItemDocuments.length} items due to deposit processing error for offer ${offer.id}.`);
                          await Item.deleteMany({ _id: { $in: createdItemDocuments.map(d => d._id) } });
                      }
                      // Mark round as error if something went critically wrong
                      if (currentRound?._id) { // Use currentRound._id if available
                          await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } });
                          io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error.' });
                      } else if (depositData?.roundId) { // Fallback to roundId from depositData
                           await Round.updateOne({ _id: depositData.roundId }, { $set: { status: 'error' } });
                           io.emit('roundError', { roundId: (await Round.findById(depositData.roundId).select('roundId').lean())?.roundId || 'Unknown', error: 'Critical deposit database error.' });
                      }
                 }
            } else if ([
                TradeOfferManager.ETradeOfferState.Declined,
                TradeOfferManager.ETradeOfferState.Canceled, // If bot cancels it (e.g. due to time)
                TradeOfferManager.ETradeOfferState.Expired,
                TradeOfferManager.ETradeOfferState.InvalidItems // If items in offer became invalid
            ].includes(offer.state)) {
                // Offer was not accepted or failed
                const depositData = pendingDeposits.get(depositId); // Re-fetch in case it was removed by another path
                if (depositData) {
                    console.warn(`Deposit offer ${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId} was ${TradeOfferManager.ETradeOfferState[offer.state]}. Removing from pending.`);
                    pendingDeposits.delete(depositId);
                    User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                        .catch(e => console.error("Error clearing user pending flag on deposit failure/cancellation:", e));
                    const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                    io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Your deposit offer (#${offer.id}) was ${stateMessage}. Your items were not added.` });
                } else {
                    console.warn(`Offer ${offer.id} changed to ${TradeOfferManager.ETradeOfferState[offer.state]}, but no matching pending deposit found for ID ${depositId}. User flag might need manual check if it was set.`);
                     // Attempt to clear flag on user if it was this offer, just in case
                     const userWithThisOffer = await User.findOne({ pendingDepositOfferId: offer.id }).select('_id steamId').lean();
                     if (userWithThisOffer) {
                         User.updateOne({ _id: userWithThisOffer._id }, { pendingDepositOfferId: null })
                             .catch(e => console.error("Error clearing user pending flag (no pending deposit match):", e));
                         io.emit('notification', { type: 'error', userId: userWithThisOffer._id.toString(), message: `Your deposit offer (#${offer.id}) was ${TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ')}.` });
                     }
                }
            }
        } else if (offer.itemsToGive && offer.itemsToGive.length > 0 && (!offer.itemsToReceive || offer.itemsToReceive.length === 0)) {
            // This is a PAYOUT (winnings) offer we sent, and its state changed
            let payoutStatusUpdate = 'Unknown';
            let notificationType = 'info';
            let notificationMessage = `Status of your winnings offer #${offer.id} updated to ${TradeOfferManager.ETradeOfferState[offer.state]}.`;

            switch (offer.state) {
                case TradeOfferManager.ETradeOfferState.Accepted:
                    payoutStatusUpdate = 'Accepted'; notificationType = 'success';
                    notificationMessage = `Winnings from offer #${offer.id} successfully received!`;
                    break;
                case TradeOfferManager.ETradeOfferState.Declined:
                    payoutStatusUpdate = 'Declined'; notificationType = 'error';
                    notificationMessage = `Your winnings offer #${offer.id} was declined. Please contact support if this was an error.`;
                    break;
                case TradeOfferManager.ETradeOfferState.Canceled: // e.g. if bot canceled it due to time
                    payoutStatusUpdate = 'Canceled'; notificationType = 'warning';
                    notificationMessage = `Winnings offer #${offer.id} was canceled (e.g., due to timeout). Please contact support.`;
                    break;
                case TradeOfferManager.ETradeOfferState.Expired:
                    payoutStatusUpdate = 'Expired'; notificationType = 'warning';
                    notificationMessage = `Winnings offer #${offer.id} has expired. Please contact support.`;
                    break;
                case TradeOfferManager.ETradeOfferState.InvalidItems:
                    payoutStatusUpdate = 'InvalidItems'; notificationType = 'error';
                    notificationMessage = `Winnings offer #${offer.id} failed due to invalid items. This should not happen. Contact support.`;
                    break;
                case TradeOfferManager.ETradeOfferState.InEscrow:
                    payoutStatusUpdate = 'Escrow'; notificationType = 'warning';
                    notificationMessage = `Winnings offer #${offer.id} is currently held in Steam escrow.`;
                    break;
                default:
                    payoutStatusUpdate = TradeOfferManager.ETradeOfferState[offer.state] || 'Unknown';
            }

            console.log(`Payout offer #${offer.id} to ${offer.partner.getSteamID64()} changed to ${payoutStatusUpdate}.`);
            try {
                const updatedRound = await Round.findOneAndUpdate(
                    { payoutOfferId: offer.id },
                    { $set: { payoutOfferStatus: payoutStatusUpdate } },
                    { new: true }
                ).populate('winner', 'steamId _id'); // Populate to get winner's MongoDB _id

                if (updatedRound && updatedRound.winner) {
                    const winnerUserId = updatedRound.winner._id.toString();
                    notificationMessage = notificationMessage.replace('#'+offer.id, `offer <a href="https://steamcommunity.com/tradeoffer/${offer.id}/" target="_blank" rel="noopener noreferrer" class="notification-link">#${offer.id}</a> (Round #${updatedRound.roundId})`);
                    io.emit('notification', { type: notificationType, userId: winnerUserId, message: notificationMessage });
                } else if (!updatedRound) {
                    console.warn(`Could not find round associated with payout offer #${offer.id} to update status.`);
                }
            } catch (dbError) {
                console.error(`Error updating payout status for offer #${offer.id} in DB:`, dbError);
            }
        } else {
            // Offer state changed but doesn't match expected patterns (not a pending deposit, not a simple payout)
            // This could be for offers with items on both sides, or other complex scenarios not handled by current logic
            console.warn(`Offer #${offer.id} (Partner: ${offer.partner.getSteamID64()}) changed state to ${TradeOfferManager.ETradeOfferState[offer.state]}, but was not recognized as a pending deposit or standard winnings payout. Message: "${offer.message}", ItemsToGive: ${offer.itemsToGive.length}, ItemsToReceive: ${offer.itemsToReceive.length}`);
        }
    });
}

// --- Round Info API Routes ---
function formatRoundForClient(round) {
    if (!round) return null;
    const timeLeft = (round.status === 'active' && round.endTime)
        ? Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000))
        : (round.status === 'pending' ? ROUND_DURATION : (round.status === 'rolling' ? 0 : 0)); // Show 0 if rolling

    const participantsFormatted = (round.participants || []).map(p => ({
        user: p.user ? { _id: p.user._id, steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar } : null,
        itemsValue: p.itemsValue || 0, tickets: p.tickets || 0
    })).filter(p => p.user); // Ensure user object is present

    // Items in the pot (not necessarily winner's items yet if round is active/rolling)
    const itemsInPotFormatted = (round.items || []).map(i => ({
        // Ensure 'i' is a populated item object, not just an ID, if it comes from currentRound directly
        assetId: i.assetId, name: i.name, image: i.image, price: i.price || 0,
        owner: i.owner ? (i.owner._id || i.owner) : null // Handle populated or ObjectId owner
    }));


    let winnerDetails = null;
    if (round.winner && (round.winner.steamId || round.winner._id)) { // Check if winner is populated object or just ID
        winnerDetails = {
            id: round.winner._id || round.winner.toString(), // Use _id if populated, else the ID string
            steamId: round.winner.steamId,
            username: round.winner.username,
            avatar: round.winner.avatar
        };
    }

    return {
        roundId: round.roundId, status: round.status, startTime: round.startTime, endTime: round.endTime,
        timeLeft: timeLeft,
        totalValue: round.totalValue || 0, // For active/rolling, this is pre-tax. For completed, it's after-tax.
        serverSeedHash: round.serverSeedHash,
        participants: participantsFormatted,
        items: itemsInPotFormatted, // Items currently in the pot
        winner: winnerDetails,
        // Provable fair details only if round is completed
        winningTicket: round.status === 'completed' ? round.winningTicket : undefined,
        serverSeed: round.status === 'completed' ? round.serverSeed : undefined,
        clientSeed: round.status === 'completed' ? round.clientSeed : undefined,
        provableHash: round.status === 'completed' ? round.provableHash : undefined,
        taxAmount: round.status === 'completed' ? round.taxAmount : undefined
    };
}

app.get('/api/round/current', async (req, res) => {
    let roundToFormat = null;
    try {
        if (currentRound?._id) { // If currentRound is a Mongoose doc or has _id
            roundToFormat = await Round.findById(currentRound._id)
                 .populate('participants.user', 'steamId username avatar')
                 .populate('items').populate('winner', 'steamId username avatar').lean();
            if (!roundToFormat) currentRound = null; else currentRound = roundToFormat; // Update global currentRound with fresh lean data
        }

        if (!roundToFormat) { // If not found via _id or currentRound was null/stale
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                 .sort({ startTime: -1 }) // Get the latest one
                 .populate('participants.user', 'steamId username avatar')
                 .populate('items').populate('winner', 'steamId username avatar').lean();
            if (roundToFormat && !currentRound) { // If global currentRound was truly null and we found one
                 currentRound = roundToFormat;
                 // Resume timer if applicable (this logic might be redundant if ensureInitialRound also does it)
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
        const queryFilter = { status: { $in: ['completed', 'error'] } }; // Only completed or errored rounds for history
        const [rounds, totalCount] = await Promise.all([
            Round.find(queryFilter).sort('-roundId').skip(skip).limit(limit)
                 .populate('winner', 'username avatar steamId') // Populate winner details for history
                 .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount taxedItems payoutOfferId payoutOfferStatus')
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
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 }) // Client seed can be shorter
    ],
    handleValidationErrors, async (req, res) => {
    const { roundId, serverSeed, clientSeed } = req.body;
    try {
        const round = await Round.findOne({ roundId: roundId, status: 'completed' }) // Only verify completed rounds
             .populate('participants.user', 'username').populate('winner', 'username').lean(); // Lean for performance
        if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found for verification.` });

        // Verify Server Seed Hash
        const providedServerSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
        if (providedServerSeedHash !== round.serverSeedHash) {
            return res.json({ verified: false, reason: 'Server Seed Hash mismatch.', expectedServerSeedHash: round.serverSeedHash, providedServerSeed: serverSeed, calculatedHashFromProvidedSeed: providedServerSeedHash });
        }

        // If the round in DB already has a serverSeed and clientSeed, they must match what's provided for an "official" verification
        if (round.serverSeed && round.clientSeed && (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed)) {
            return res.json({
                verified: false,
                reason: 'Provided seeds do not match the official seeds recorded for this round. You can still verify with these inputs, but it won\'t match the round\'s official outcome if seeds differ.',
                expectedServerSeed: round.serverSeed,
                expectedClientSeed: round.clientSeed,
                providedServerSeed: serverSeed,
                providedClientSeed: clientSeed
            });
        }

        // Calculate provable hash using provided seeds
        const combinedString = serverSeed + clientSeed;
        const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');

        // If the round has an official provableHash, it should match
        if (round.provableHash && calculatedProvableHash !== round.provableHash) {
            return res.json({ verified: false, reason: 'Calculated Provable Hash from provided seeds does not match the official Provable Hash for the round.', officialProvableHash: round.provableHash, calculatedProvableHashFromInputs: calculatedProvableHash, combinedStringUsed: combinedString });
        }

        const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
        const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;

        if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets, cannot determine winning ticket.' });

        const calculatedWinningTicket = decimalFromHash % totalTickets;

        if (calculatedWinningTicket !== round.winningTicket) {
            return res.json({
                verified: false,
                reason: 'Calculated winning ticket from provided seeds does not match the official winning ticket for the round.',
                calculatedTicket: calculatedWinningTicket,
                actualWinningTicket: round.winningTicket,
                provableHashUsedForCalc: calculatedProvableHash,
                totalTicketsInRound: totalTickets
            });
        }

        // If all checks pass with provided seeds matching official outcome
        res.json({
            verified: true,
            message: 'Successfully verified with provided seeds, matching official round outcome.',
            roundId: round.roundId,
            serverSeedUsed: serverSeed, // The one from input, which matched
            serverSeedHashOfficial: round.serverSeedHash,
            clientSeedUsed: clientSeed, // The one from input
            combinedStringCalculated: combinedString,
            finalHashCalculated: calculatedProvableHash,
            winningTicketCalculated: calculatedWinningTicket,
            totalTicketsInRound: totalTickets,
            officialWinnerUsername: round.winner?.username || 'N/A',
            officialPotValue: round.totalValue // This is after-tax for 'completed' rounds
        });

    } catch (err) {
        console.error(`Error verifying round ${roundId}:`, err);
        res.status(500).json({ error: 'Server error during verification process.' });
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
    io.emit('updateUserCount', connectedChatUsers); // Emit to all clients
    const user = socket.request.user; // User from Passport session
    if (user && user.username) console.log(`User ${user.username} (Socket ID: ${socket.id}) connected.`);
    else console.log(`Anonymous client (Socket ID: ${socket.id}) connected.`);

    socket.on('requestRoundData', async () => { // Client requests current round state
        try {
            // Always fetch the latest from DB to ensure consistency, populate necessary fields
            let roundToSend = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                .sort({ startTime: -1 })
                .populate('participants.user', 'steamId username avatar')
                .populate('items') // Populate items in the pot
                .populate('winner', 'steamId username avatar') // Populate winner details if round is completed/rolling with winner
                .lean();

            if (roundToSend) {
                currentRound = roundToSend; // Update global currentRound with the latest lean data
                // If the fetched round is active and has participants but no timer, start it.
                // This handles cases where a timer might not have started correctly on server restart.
                if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !roundTimer) {
                    if (currentRound.endTime && new Date(currentRound.endTime) > Date.now()) {
                        startRoundTimer(true); // Resume with remaining time
                    } else if (!currentRound.endTime) {
                        startRoundTimer(false); // Start a new timer duration
                    }
                }
            } else if (!currentRound && !isRolling) { // No active/rolling/pending round and not currently creating one
                console.log("No current round found on 'requestRoundData', attempting to create one.");
                roundToSend = await createNewRound(); // Create a new round and use its data
            }

            const formattedData = formatRoundForClient(roundToSend || currentRound); // Format whatever we have
            if (formattedData) {
                socket.emit('roundData', formattedData);
            } else {
                socket.emit('noActiveRound'); // Or a specific event indicating no round
            }
        } catch (err) {
            console.error(`Error fetching round data for socket ${socket.id}:`, err);
            socket.emit('roundError', { error: 'Failed to load round data from server.' });
        }
    });

    socket.on('chatMessage', (msg) => {
        if (!user || !user._id) { // Check if user is authenticated
            socket.emit('notification', {type: 'error', message: 'You must be logged in to send chat messages.'}); return;
        }
        const userIdString = user._id.toString();
        const now = Date.now();
        const lastMsgTime = userLastMessageTime.get(userIdString) || 0;

        if (now - lastMsgTime < CHAT_COOLDOWN_SECONDS * 1000) {
            const timeLeftCooldown = Math.ceil((CHAT_COOLDOWN_SECONDS * 1000 - (now - lastMsgTime)) / 1000);
            socket.emit('notification', {type: 'warning', message: `Chat cooldown: Please wait ${timeLeftCooldown}s.`}); return;
        }

        if (typeof msg !== 'string' || msg.trim().length === 0 || msg.trim().length > MAX_CHAT_MESSAGE_LENGTH) {
            socket.emit('notification', {type: 'error', message: `Invalid message. Max length ${MAX_CHAT_MESSAGE_LENGTH} chars.`}); return;
        }

        userLastMessageTime.set(userIdString, now); // Update last message time

        const messageData = { // Data to broadcast to all clients
            username: user.username,
            avatar: user.avatar || '/img/default-avatar.png', // Use a default avatar if none
            message: msg.trim(), // Sanitization might be needed here if rendering as HTML elsewhere
            userId: userIdString, // User's MongoDB _id
            userSteamId: user.steamId, // User's SteamID
            timestamp: new Date()
        };
        io.emit('chatMessage', messageData); // Broadcast to all connected clients
        console.log(`Chat (User: ${user.username}, ID: ${userIdString}): ${msg.trim()}`);
    });

    socket.on('disconnect', (reason) => {
        connectedChatUsers--;
        io.emit('updateUserCount', connectedChatUsers);
         if (user && user.username) console.log(`User ${user.username} disconnected. Reason: ${reason}`);
         else console.log(`Anonymous client disconnected. Reason: ${reason}`);
    });
});

// --- Server Startup ---
async function startApp() {
    console.log("Performing initial price cache refresh...");
    await refreshPriceCache(); // Initial refresh
    setInterval(async () => { // Scheduled refresh
        try { await refreshPriceCache(); }
        catch (refreshErr) { console.error("Error during scheduled price cache refresh:", refreshErr); }
    }, PRICE_REFRESH_INTERVAL_MS);
    console.log(`Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log(`Site URL configured as: ${process.env.SITE_URL}`);
        if (!isBotConfigured) console.log("INFO: Steam Bot not configured. Trade features (deposits/payouts) will be disabled.");
        else if (!isBotReady) console.log("INFO: Steam Bot is configured but login may have failed or is pending. Check logs.");
        else console.log("INFO: Steam Bot is configured and appears to be ready.");
        ensureInitialRound(); // Attempt to set up or resume a round
    });
}
startApp();

function gracefulShutdown() {
    console.log('Received shutdown signal. Closing server gracefully...');
    io.close(() => { console.log('Socket.IO server closed.'); }); // Close Socket.IO connections
    server.close(async () => { // Close HTTP server
        console.log('HTTP server closed.');
        try {
            await mongoose.connection.close(); // Close MongoDB connection
            console.log('MongoDB connection closed.');
            if (manager && typeof manager.shutdown === 'function') { // Shutdown TradeOfferManager
                 console.log('Stopping TradeOfferManager polling...');
                 manager.shutdown();
            } else if (manager) {
                 console.log('TradeOfferManager will stop on process exit (no explicit shutdown method).');
            }
            console.log('Graceful shutdown complete. Exiting.');
            process.exit(0);
        } catch (e) {
            console.error("Error during final stages of graceful shutdown:", e);
            process.exit(1); // Exit with error if DB/manager shutdown fails
        }
    });
    // Force shutdown if graceful exit takes too long
    setTimeout(() => {
        console.error('Could not close connections gracefully within timeout, forcing shutdown.');
        process.exit(1);
    }, 10000); // 10 seconds timeout
}
process.on('SIGTERM', gracefulShutdown); // For `kill`
process.on('SIGINT', gracefulShutdown);  // For Ctrl+C

// Global error handler (must be last middleware)
app.use((err, req, res, next) => {
    console.error("Unhandled Error Occurred:", err.stack || err);
    const status = err.status || 500;
    const message = (process.env.NODE_ENV === 'production' && status === 500)
        ? 'An unexpected internal server error occurred.'
        : (err.message || 'Unknown server error.');

    if (res.headersSent) { // If headers already sent, delegate to Express default handler
        return next(err);
    }
    res.status(status).json({ error: message });
});

console.log("app.js backend logic has been updated and reviewed.");
