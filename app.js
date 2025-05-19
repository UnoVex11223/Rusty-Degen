// app (18).js - PART 1 of 2
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
const ROUND_DURATION = parseInt(process.env.ROUND_DURATION_SECONDS) || 99; //
const TICKET_VALUE_RATIO = parseFloat(process.env.TICKET_VALUE) || 0.01;
const PRICE_CACHE_TTL_SECONDS = parseInt(process.env.PRICE_CACHE_TTL_SECONDS) || 15 * 60;
const PRICE_REFRESH_INTERVAL_MS = (parseInt(process.env.PRICE_REFRESH_MINUTES) || 10) * 60 * 1000;
const MIN_ITEM_VALUE = parseFloat(process.env.MIN_ITEM_VALUE) || 0.10;
const PRICE_FETCH_TIMEOUT_MS = 30000;
const MAX_PARTICIPANTS = 20; //
const MAX_ITEMS_PER_POT = 200; //
const MAX_ITEMS_PER_DEPOSIT = parseInt(process.env.MAX_ITEMS_PER_DEPOSIT) || 20;
const TAX_MIN_PERCENT = 5;
const TAX_MAX_PERCENT = 10;
const MIN_POT_FOR_TAX = parseFloat(process.env.MIN_POT_FOR_TAX) || 100;
const MAX_CHAT_MESSAGE_LENGTH = 200;
const CHAT_COOLDOWN_SECONDS = parseInt(process.env.CHAT_COOLDOWN_SECONDS) || 5; // ADDED: Chat cooldown

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
            "img-src": ["'self'", "data:", "*.steamstatic.com", "*.akamai.steamstatic.com", "steamcommunity-a.akamaihd.net"], // MODIFICATION: Added steamcommunity-a.akamaihd.net for some avatars
            "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"], //
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


const generalApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }); //
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many login attempts from this IP, please try again after 10 minutes', standardHeaders: true, legacyHeaders: false }); //
const sensitiveActionLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, message: 'Too many requests for this action, please try again after 5 minutes', standardHeaders: true, legacyHeaders: false }); //
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 10, message: 'Too many deposit attempts, please wait a minute.', standardHeaders: true, legacyHeaders: false }); //
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, // Max 20 messages per minute per IP
    message: 'Too many chat messages from this IP. Please wait a moment.',
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', generalApiLimiter);
app.use(cors({ origin: process.env.SITE_URL || "*", credentials: true }));
app.use(express.json()); // Replaces bodyParser.json()
app.use(express.urlencoded({ extended: true })); // Replaces bodyParser.urlencoded()
app.use(express.static('public')); //

// Session Configuration with MongoStore
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ //
        mongoUrl: process.env.MONGODB_URI,
        ttl: 14 * 24 * 60 * 60, // Session TTL: 14 days
        autoRemove: 'native' //
    }),
    cookie: {
        maxAge: 3600000 * 24, // 24 hours
        secure: process.env.NODE_ENV === 'production', // Set to true if using HTTPS
        httpOnly: true, //
        sameSite: 'lax' // Recommended for CSRF protection if not using csurf
    }
});
app.use(sessionMiddleware);

app.use(passport.initialize()); //
app.use(passport.session()); //


// --- Steam Strategy ---
passport.use(new SteamStrategy({
    returnURL: `${process.env.SITE_URL}/auth/steam/return`, //
    realm: process.env.SITE_URL, //
    apiKey: process.env.STEAM_API_KEY, //
    providerURL: 'https://steamcommunity.com/openid' // Standard OpenID endpoint
},
    async (identifier, profile, done) => {
        try {
            // MODIFICATION: Ensure a default avatar if Steam provides none
            const avatarFull = profile._json.avatarfull || profile._json.avatar || '/img/default-avatar.png'; //
            const userData = {
                username: profile.displayName || `User${profile.id.substring(profile.id.length - 5)}`, //
                avatar: avatarFull, //
            };
            const user = await User.findOneAndUpdate(
                { steamId: profile.id }, //
                {
                    $set: userData,
                    $setOnInsert: { // Fields to set only on document creation
                        steamId: profile.id, //
                        tradeUrl: '', // Initialize as empty
                        createdAt: new Date(), //
                        pendingDepositOfferId: null, //
                        totalDepositedValue: 0, //
                        totalWinningsValue: 0 //
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
        const user = await User.findById(id); //
        done(null, user);
    } catch (err) {
        console.error("DeserializeUser Error:", err);
        done(err);
    }
});

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGODB_URI) //
    .then(() => console.log('Successfully connected to MongoDB.'))
    .catch(err => {
        console.error('MongoDB Connection Error:', err);
        process.exit(1); // Exit if DB connection fails
    });

// --- MongoDB Schemas ---
const userSchema = new mongoose.Schema({
    steamId: { type: String, required: true, unique: true, index: true }, //
    username: { type: String, required: true }, //
    avatar: { type: String }, //
    tradeUrl: {
        type: String,
        default: '',
        // MODIFICATION: Allow empty string explicitly in regex for validation
        match: [/^$|^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/, 'Invalid Steam Trade URL format or empty string'] //
    },
    createdAt: { type: Date, default: Date.now }, //
    banned: { type: Boolean, default: false }, //
    pendingDepositOfferId: { type: String, default: null, index: true }, //
    totalDepositedValue: { type: Number, default: 0, min: 0 }, //
    totalWinningsValue: { type: Number, default: 0, min: 0 } //
});

const itemSchema = new mongoose.Schema({
    assetId: { type: String, required: true, index: true }, //
    name: { type: String, required: true }, // Market hash name
    image: { type: String, required: true }, // Image URL
    price: { type: Number, required: true, min: 0 }, //
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, //
    roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', required: true, index: true }, //
    depositedAt: { type: Date, default: Date.now } //
});

const roundSchema = new mongoose.Schema({
    roundId: { type: Number, required: true, unique: true, index: true }, //
    status: { type: String, enum: ['pending', 'active', 'rolling', 'completed', 'error'], default: 'pending', index: true }, //
    startTime: { type: Date }, //
    endTime: { type: Date }, // Stores the calculated absolute end time of the round
    completedTime: { type: Date }, //
    totalValue: { type: Number, default: 0, min: 0 }, // For winner, this is after-tax value. Original pre-tax pot value is sum of participant itemsValues.
    items: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }], // References to Item documents (items given to winner)
    participants: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, //
        itemsValue: { type: Number, required: true, default: 0, min: 0 }, // Total value deposited by this user in this round
        tickets: { type: Number, required: true, default: 0, min: 0 } // Number of tickets based on value
    }],
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, //
    winningTicket: { type: Number, min: 0 }, //
    serverSeed: { type: String, required: true, match: /^[a-f0-9]{64}$/ }, // 64 char hex
    serverSeedHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ }, //
    clientSeed: { type: String, match: /^[a-f0-9]+$/ }, // Can vary in length
    provableHash: { type: String, match: /^[a-f0-9]{64}$/ }, // Hash of ServerSeed + ClientSeed
    taxAmount: { type: Number, default: 0, min: 0 }, //
    taxedItems: [{ assetId: String, name: String, price: { type: Number, min: 0 } }], // Info about items taken as tax
    payoutOfferId: { type: String, index: true }, // ID of the trade offer sent for winnings
    payoutOfferStatus: { type: String, enum: ['Sent', 'Accepted', 'Declined', 'Canceled', 'Expired', 'InvalidItems', 'Escrow', 'Failed', 'Unknown', 'Pending Send', 'No Items Won'], default: 'Unknown' } // Status of the payout trade offer
});
roundSchema.index({ 'participants.user': 1 }); // Index for querying participants
roundSchema.index({ winner: 1, status: 1, completedTime: -1 }); // For winning history query

const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);


// --- Steam Bot Setup ---
const community = new SteamCommunity(); //
const manager = new TradeOfferManager({ //
    steam: community, // Use the logged-in community instance
    domain: process.env.SITE_URL ? process.env.SITE_URL.replace(/^https?:\/\//, '') : 'localhost', // Your site's domain
    language: 'en', // Language for trade offers
    pollInterval: 10000, // Poll for new offers every 10 seconds
    cancelTime: 10 * 60 * 1000, // Cancel offers that haven't been accepted in 10 minutes
});
let isBotReady = false; //
const pendingDeposits = new Map(); // Stores { depositId: { userId, roundId, items, totalValue, steamId } }

function generateAuthCode() { //
    const secret = process.env.STEAM_SHARED_SECRET; //
    if (!secret) { console.error("STEAM_SHARED_SECRET missing. Cannot generate 2FA code."); return null; }
    try { return SteamTotp.generateAuthCode(secret); } //
    catch (e) { console.error("Error generating 2FA code:", e); return null; }
}

if (isBotConfigured) { //
    const loginCredentials = {
        accountName: process.env.STEAM_USERNAME, //
        password: process.env.STEAM_PASSWORD, //
        twoFactorCode: generateAuthCode() //
    };
    if (loginCredentials.twoFactorCode) {
        console.log(`Attempting Steam login for bot: ${loginCredentials.accountName}...`);
        community.login(loginCredentials, (err, sessionID, cookies, steamguard) => { //
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
            manager.setCookies(cookies, (setCookieErr) => { //
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
            community.on('friendRelationship', (steamID, relationship) => { //
                if (relationship === SteamCommunity.EFriendRelationship.RequestRecipient) { //
                    console.log(`Received friend request from ${steamID}. Accepting...`);
                    community.addFriend(steamID, (friendErr) => { //
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

let currentRound = null; //
let roundTimer = null; //
let isRolling = false; // Flag to indicate if a round is currently being rolled/processed

const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false }); //

// Fallback pricing (consider a more robust strategy if scmm.app is down)
function getFallbackPrice(marketHashName) { //
    // For now, just return minimum, but you might want logging or alternative sources
    return MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0;
}

async function refreshPriceCache() { //
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

function getItemPrice(marketHashName) { //
    if (typeof marketHashName !== 'string' || marketHashName.length === 0) {
        console.warn("getItemPrice called with invalid marketHashName:", marketHashName);
        return 0; // Or throw an error, depending on desired strictness
    }
    const cachedPrice = priceCache.get(marketHashName); //
    return (cachedPrice !== undefined) ? cachedPrice : getFallbackPrice(marketHashName); //
}

// --- Core Game Logic ---
async function createNewRound() { //
    if (isRolling) {
        console.log("Cannot create new round: Current round is rolling.");
        return null;
    }
    if (currentRound && currentRound.status === 'active') {
        console.log(`Cannot create new round: Round ${currentRound.roundId} is already active.`);
        return currentRound; // Return existing active round
    }

    try {
        isRolling = false; // Reset rolling flag
        const serverSeed = crypto.randomBytes(32).toString('hex'); //
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex'); //

        const lastRound = await Round.findOne().sort('-roundId'); // Get the latest roundId
        const nextRoundId = lastRound ? lastRound.roundId + 1 : 1; //

        const newRound = new Round({
            roundId: nextRoundId, //
            status: 'active', // Start as active
            startTime: new Date(), //
            endTime: null, // MODIFICATION: endTime will be set when the timer actually starts (first deposit)
            serverSeed: serverSeed, //
            serverSeedHash: serverSeedHash, //
            items: [], //
            participants: [], //
            totalValue: 0, //
            payoutOfferStatus: 'Unknown' // Initialize for winning history
        });
        await newRound.save();
        currentRound = newRound.toObject(); // Update in-memory currentRound

        io.emit('roundCreated', { //
            roundId: newRound.roundId,
            serverSeedHash: newRound.serverSeedHash,
            timeLeft: ROUND_DURATION, // Client will show full time until timer actually starts
            totalValue: 0,
            participants: [],
            items: []
        });
        console.log(`--- Round ${newRound.roundId} created and active (waiting for deposits) ---`);
        // Timer will start when the first participant joins
        return newRound.toObject();
    } catch (err) {
        console.error('FATAL: Error creating new round:', err);
        setTimeout(createNewRound, 10000); // Retry after delay if critical error
        return null;
    }
}

async function ensureInitialRound() { //
    if (isBotConfigured && isBotReady) { // Only if bot is configured and ready
        if (!currentRound) {
            try {
                const existingActiveOrPending = await Round.findOne({ status: { $in: ['active', 'pending'] } }) // Look for active or pending
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items')
                    .lean(); // Use lean for performance if not modifying

                if (existingActiveOrPending) {
                    console.log(`Found existing round ${existingActiveOrPending.roundId} (status: ${existingActiveOrPending.status}) on startup.`);
                    currentRound = JSON.parse(JSON.stringify(existingActiveOrPending)); // Use a clean object copy
                    // If round has participants and an end time in the future, resume timer
                    if (currentRound.status === 'active' && currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) { //
                        console.log(`Resuming timer for existing active round ${currentRound.roundId}.`);
                        startRoundTimer(true); // Resume with remaining time
                    } else if (currentRound.status === 'active' && currentRound.participants.length > 0 && !currentRound.endTime && !roundTimer) { //
                        // If no end time but participants, start timer (e.g. server restart recovery)
                        console.warn(`Active round ${currentRound.roundId} found without endTime but has participants. Starting timer now.`);
                        startRoundTimer(false); //
                    } else if (currentRound.status === 'active' && currentRound.participants.length === 0) {
                        console.log(`Active round ${currentRound.roundId} has no participants. Timer will start on first deposit.`);
                    } else if (currentRound.status === 'pending') {
                        // If it's pending, change to active. Timer will start on first deposit.
                        console.log(`Found pending round ${currentRound.roundId}. Setting to active.`);
                        currentRound.status = 'active';
                        await Round.updateOne({_id: currentRound._id}, {$set: {status: 'active', startTime: new Date() }});
                         io.emit('roundCreated', formatRoundForClient(currentRound)); // Notify clients about this "new" active round
                    }
                } else {
                    console.log("No active or pending round found, creating initial round...");
                    await createNewRound(); //
                }
            } catch (dbErr) {
                console.error("Error ensuring initial round:", dbErr);
            }
        }
    } else if (isBotConfigured && !isBotReady) { //
        console.log("Bot configured but not ready, skipping initial round check until bot is ready.");
    } else { //
        console.log("Bot not configured, skipping initial round check.");
    }
}

// MODIFICATION: Enhanced startRoundTimer logic
function startRoundTimer(useRemainingTime = false) { //
    if (roundTimer) clearInterval(roundTimer); // Clear existing timer
    if (!currentRound || currentRound.status !== 'active') {
        console.warn(`Cannot start timer: No active round or round status invalid. Round: ${currentRound ? currentRound.roundId : 'N/A'}, Status: ${currentRound ? currentRound.status : 'N/A'}`);
        return;
    }

    let timeLeft;
    let calculatedEndTime;

    if (useRemainingTime && currentRound.endTime && new Date(currentRound.endTime) > Date.now()) { //
        // Only use remaining time if endTime is valid and in the future
        calculatedEndTime = new Date(currentRound.endTime); //
        timeLeft = Math.max(0, Math.floor((calculatedEndTime.getTime() - Date.now()) / 1000)); //
        console.log(`TIMER: Resuming timer for round ${currentRound.roundId} with ${timeLeft}s remaining. End time: ${calculatedEndTime.toISOString()}`);
    } else {
        // This block executes for a new timer start (e.g., first deposit, or if resuming an old round where endTime was past/invalid)
        timeLeft = ROUND_DURATION; //
        calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000); //
        currentRound.endTime = calculatedEndTime; // Store in memory
        // Update endTime in DB
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } }) //
            .then(() => console.log(`TIMER: Set endTime in DB for round ${currentRound.roundId} to ${calculatedEndTime.toISOString()}`))
            .catch(e => console.error(`TIMER_ERROR: Error saving round end time for round ${currentRound?.roundId}:`, e));
        console.log(`TIMER: Starting new timer for round ${currentRound.roundId} (${timeLeft}s). Calculated End time: ${calculatedEndTime.toISOString()}`);
    }

    io.emit('timerUpdate', { timeLeft }); // Initial timer update

    roundTimer = setInterval(async () => { //
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) { //
            clearInterval(roundTimer); roundTimer = null; //
            console.warn("TIMER: Stopped. Round state became invalid during countdown (e.g., no longer active or endTime missing).");
            return;
        }

        const now = Date.now(); //
        let currenttimeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - now) / 1000)); //

        io.emit('timerUpdate', { timeLeft: currenttimeLeft }); //

        if (currenttimeLeft <= 0) { //
            clearInterval(roundTimer); roundTimer = null; //
            console.log(`TIMER: Round ${currentRound.roundId} timer reached zero. Proceeding to end round.`);
            // MODIFICATION: Ensure isRolling is false before calling endRound if it's a direct timer expiry
            if (!isRolling) { // Add this check
                await endRound(); // endRound will handle isRolling flag itself
            } else {
                console.warn(`TIMER: Timer expired for round ${currentRound.roundId}, but isRolling is already true. endRound will not be called again by timer.`);
            }
        }
    }, 1000);
}

// MODIFICATION: Enhanced endRound with more robust data fetching and event emission
async function endRound() { //
    if (!currentRound || isRolling || currentRound.status !== 'active') { //
        console.warn(`ENDROUND_WARN: Attempted to end round ${currentRound?.roundId}, but state is invalid (Status: ${currentRound?.status}, Rolling: ${isRolling}, Active: ${currentRound?.status === 'active'})`);
        if (isRolling) console.warn(`ENDROUND_WARN: Another endRound process might be running or was already triggered.`);
        return;
    }
    isRolling = true; // Set rolling flag AT THE VERY BEGINNING
    const roundIdToEnd = currentRound.roundId; //
    const roundMongoId = currentRound._id; // Ensure we have the _id
    console.log(`--- ENDROUND: Ending round ${roundIdToEnd}... Setting isRolling=true ---`);

    try {
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } }); // endTime here marks when rolling started
        // currentRound.status = 'rolling'; // Update in-memory status AFTER DB for safety, or rely on re-fetch
        io.emit('roundRolling', { roundId: roundIdToEnd }); //
        console.log(`ENDROUND: Round ${roundIdToEnd} status set to 'rolling' in DB and emitted.`);

        // Fetch the most up-to-date round data, especially populated participants and items.
        const roundDataForProcessing = await Round.findById(roundMongoId) //
            .populate('participants.user', 'steamId username avatar tradeUrl') //
            .populate('items') // Ensure items are populated FOR ROULETTE AND TAX
            .lean(); // Use .lean() for performance

        if (!roundDataForProcessing) { //
            throw new Error(`ENDROUND_ERROR: Round ${roundIdToEnd} data missing after status update to rolling.`);
        }
        if (roundDataForProcessing.status !== 'rolling') { // Double check status
             console.warn(`ENDROUND_WARN: Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Current DB status: ${roundDataForProcessing.status}. Aborting endRound.`);
             isRolling = false; return; // Reset rolling if we abort
        }
        // Update the global currentRound with this fresh, populated data. Make a deep copy.
        currentRound = JSON.parse(JSON.stringify(roundDataForProcessing)); //

        if (currentRound.participants.length === 0 || currentRound.items.length === 0 || currentRound.totalValue <= 0) { //
            console.log(`ENDROUND: Round ${currentRound.roundId} ended with no valid participants or value. Completing without winner.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date() } }); //
            io.emit('roundCompleted', { roundId: currentRound.roundId, message: "No participants or items in pot." }); //
            isRolling = false; //
            console.log(`ENDROUND: Round ${currentRound.roundId} completed (no winner). isRolling=false. Scheduling new round.`);
            setTimeout(createNewRound, 5000); // Short delay for empty rounds
            return;
        }
        console.log(`ENDROUND: Processing round ${currentRound.roundId} with ${currentRound.participants.length} participants and ${currentRound.items.length} items. Stored totalValue (pre-tax): $${currentRound.totalValue.toFixed(2)}.`);

        let finalItemsForWinner = [...currentRound.items]; // These are full item objects from DB, currentRound is now populated
        let originalPotValue = currentRound.participants.reduce((sum, p) => sum + (p?.itemsValue || 0), 0); // Recalculate for accuracy
        console.log(`ENDROUND_RECALC: Recalculated originalPotValue for round ${currentRound.roundId} is $${originalPotValue.toFixed(2)} based on participant deposits.`);

        let valueForWinnerCalculation = originalPotValue; //
        let taxAmountCalculation = 0; //
        let taxedItemsInfoForDB = []; //
        let itemsToTakeForTaxIds = new Set(); //

        if (originalPotValue >= MIN_POT_FOR_TAX) { //
            const targetTaxValue = originalPotValue * (TAX_MIN_PERCENT / 100); //
            const maxTaxValue = originalPotValue * (TAX_MAX_PERCENT / 100); //
            const sortedItemsForTax = [...currentRound.items].sort((a, b) => (a.price || 0) - (b.price || 0)); //
            let currentTaxValueAccumulated = 0; //

            for (const item of sortedItemsForTax) { //
                if (currentTaxValueAccumulated + item.price <= maxTaxValue) { //
                    itemsToTakeForTaxIds.add(item._id.toString()); // Store MongoDB _id string
                    taxedItemsInfoForDB.push({ assetId: item.assetId, name: item.name, price: item.price }); //
                    currentTaxValueAccumulated += item.price; //
                    if (currentTaxValueAccumulated >= targetTaxValue) break; //
                } else {
                    break; //
                }
            }

            if (itemsToTakeForTaxIds.size > 0) { //
                finalItemsForWinner = currentRound.items.filter(item => !itemsToTakeForTaxIds.has(item._id.toString())); //
                taxAmountCalculation = currentTaxValueAccumulated; //
                valueForWinnerCalculation = originalPotValue - taxAmountCalculation; //
                console.log(`ENDROUND_TAX: Tax Applied for Round ${currentRound.roundId}: $${taxAmountCalculation.toFixed(2)} (${itemsToTakeForTaxIds.size} items). Original Value: $${originalPotValue.toFixed(2)}. New Pot Value for Winner: $${valueForWinnerCalculation.toFixed(2)}`);
            } else {
                console.log(`ENDROUND_TAX: No tax applied for Round ${currentRound.roundId} (pot value $${originalPotValue.toFixed(2)} or no suitable items found).`);
            }
        } else {
             console.log(`ENDROUND_TAX: Pot value $${originalPotValue.toFixed(2)} below MIN_POT_FOR_TAX ($${MIN_POT_FOR_TAX}). No tax applied for Round ${currentRound.roundId}.`);
        }

        const clientSeed = crypto.randomBytes(16).toString('hex'); //
        const combinedString = currentRound.serverSeed + clientSeed; // Use serverSeed from the currentRound object
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex'); //
        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16); // Use first 8 hex chars for ticket
        const totalTickets = currentRound.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0); //

        if (totalTickets <= 0) throw new Error(`ENDROUND_ERROR: Cannot determine winner: Total tickets is zero for round ${currentRound.roundId}.`); //
        const winningTicketNumber = decimalFromHash % totalTickets; //
        let cumulativeTickets = 0; //
        let winnerDataObject = null; // This will be the populated user object of the winner

        for (const participant of currentRound.participants) { //
            if (!participant?.tickets || !participant.user) continue; // Skip if participant data is incomplete
            cumulativeTickets += participant.tickets; //
            if (winningTicketNumber < cumulativeTickets) { //
                winnerDataObject = participant.user; // participant.user is already populated from the .populate() earlier
                break;
            }
        }

        if (!winnerDataObject || !winnerDataObject._id) throw new Error(`ENDROUND_ERROR: Winner selection failed for round ${currentRound.roundId}. winningTicketNumber: ${winningTicketNumber}, totalTickets: ${totalTickets}`); //

        await User.findByIdAndUpdate(winnerDataObject._id, { $inc: { totalWinningsValue: valueForWinnerCalculation } }); //
        console.log(`ENDROUND_STATS: Updated winnings stats for ${winnerDataObject.username}. Added $${valueForWinnerCalculation.toFixed(2)}.`);

        const finalUpdateDataForDB = {
            status: 'completed', //
            completedTime: new Date(), //
            clientSeed: clientSeed, //
            provableHash: provableHash, //
            winningTicket: winningTicketNumber, //
            winner: winnerDataObject._id, // Store winner's MongoDB ID
            taxAmount: taxAmountCalculation, //
            taxedItems: taxedItemsInfoForDB, //
            totalValue: valueForWinnerCalculation, // This is the after-tax value the winner gets
            items: finalItemsForWinner.map(i => i._id), // Store IDs of items given to winner
            payoutOfferStatus: 'Pending Send' // Initial status before attempting to send
        };

        const completedRoundDB = await Round.findOneAndUpdate({ _id: roundMongoId }, { $set: finalUpdateDataForDB }, { new: true }); //
        if (!completedRoundDB) throw new Error("ENDROUND_ERROR: Failed to save completed round data to DB."); //

        console.log(`ENDROUND: Round ${currentRound.roundId} completed. Winner: ${winnerDataObject.username} (Ticket: ${winningTicketNumber}/${totalTickets}, Value Won: $${valueForWinnerCalculation.toFixed(2)})`);

        let offerURLForClientEmit = null; //
        if (winnerDataObject.tradeUrl) { //
            try {
                const partnerMatch = winnerDataObject.tradeUrl.match(/partner=(\d+)/); //
                const tokenMatch = winnerDataObject.tradeUrl.match(/token=([a-zA-Z0-9_-]+)/); //
                if (partnerMatch && partnerMatch[1] && tokenMatch && tokenMatch[1]) { //
                    offerURLForClientEmit = `https://steamcommunity.com/tradeoffer/new/?partner=${partnerMatch[1]}&token=${tokenMatch[1]}`; //
                }
            } catch (e) { console.error("ENDROUND_ERROR: Error parsing winner trade URL for client emission:", e); }
        }
        
        // MODIFICATION: Ensure all original items from the round are sent for roulette display
        const allOriginalItemsForRoulette = currentRound.items.map(item => ({ //
            assetId: item.assetId, name: item.name, image: item.image, price: item.price,
            // Ensure owner is consistently an ID string if populated, or null.
            owner: item.owner ? (item.owner._id ? item.owner._id.toString() : (typeof item.owner === 'string' ? item.owner : null)) : null
        }));
        console.log(`ENDROUND_DEBUG: Items for roulette: ${allOriginalItemsForRoulette.length}, item example owner: ${allOriginalItemsForRoulette[0]?.owner}`);


        io.emit('roundWinner', { //
            roundId: currentRound.roundId, //
            winner: { id: winnerDataObject._id.toString(), steamId: winnerDataObject.steamId, username: winnerDataObject.username, avatar: winnerDataObject.avatar }, //
            winningTicket: winningTicketNumber, //
            totalValue: valueForWinnerCalculation, // After-tax value for the winner
            totalTickets: totalTickets, //
            serverSeed: currentRound.serverSeed, // Revealed server seed
            clientSeed: clientSeed,       // Revealed client seed
            provableHash: provableHash, //
            serverSeedHash: currentRound.serverSeedHash, // Original hash
            payoutOfferId: completedRoundDB.payoutOfferId || null, //
            offerURL: offerURLForClientEmit, // Pre-filled trade link for winner (convenience)
            items: allOriginalItemsForRoulette, // MODIFICATION: ALL items that were in the pot for roulette creation
            // winningItems: finalItemsForWinner.map(item => ({ assetId: item.assetId, name: item.name, image: item.image, price: item.price })) // Items the winner actually gets (after tax)
        });
        console.log(`ENDROUND: Emitted 'roundWinner' for round ${currentRound.roundId} with ${allOriginalItemsForRoulette.length} items for roulette display.`);

        // Send winning trade offer (this uses finalItemsForWinner)
        await sendWinningTradeOffer(completedRoundDB, winnerDataObject, finalItemsForWinner); //

    } catch (err) {
        console.error(`ENDROUND_CRITICAL_ERROR: Error during endRound for round ${roundIdToEnd}:`, err);
        // Attempt to mark round as error in DB
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', payoutOfferStatus: 'Failed' } }) //
            .catch(e => console.error("ENDROUND_ERROR: Error marking round as error after endRound failure:", e));
        io.emit('roundError', { roundId: roundIdToEnd, error: 'Internal server error during round finalization.' }); //
    } finally {
        isRolling = false; // CRITICAL: Reset rolling flag
        console.log(`ENDROUND_FINALLY: Round ${roundIdToEnd} finalization complete. isRolling=false. Scheduling new round creation.`);
        setTimeout(createNewRound, 10000); // Standard delay after a round completes or errors
    }
}


// app (18).js - PART 2 of 2

// MODIFICATION: Added more logging to sendWinningTradeOffer
async function sendWinningTradeOffer(roundDoc, winner, itemsToSend) { // roundDoc is the completed round from DB
    if (!isBotReady) { //
        console.error(`PAYOUT_ERROR (Bot Offline): Bot not ready. Cannot send winnings for round ${roundDoc.roundId}.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Bot Error: Payout for round ${roundDoc.roundId} delayed. Bot offline.` }); //
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed' } }); //
        return;
    }
    if (!winner.tradeUrl) { //
        console.error(`PAYOUT_ERROR (No Trade URL): Winner ${winner.username} (ID: ${winner._id}) has no Trade URL set for round ${roundDoc.roundId}.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Please set your Steam Trade URL in your profile to receive winnings.' }); //
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed' } }); //
        return;
    }
    if (!itemsToSend || itemsToSend.length === 0) { //
        console.log(`PAYOUT_INFO (No Items): No items to send to winner ${winner.username} for round ${roundDoc.roundId}. Pot value was $${roundDoc.totalValue.toFixed(2)} (after tax).`);
        // totalValue in roundDoc is already after-tax. If it's >0 but itemsToSend is empty, it's an inconsistency.
        // If totalValue is 0 (or very small) and itemsToSend is empty, that's fine (e.g., all taxed).
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'No Items Won' } }); //
        if (roundDoc.taxAmount > 0 && roundDoc.totalValue <= 0.001) { // If tax took everything
             io.emit('notification', { type: 'info', userId: winner._id.toString(), message: `Winnings for round ${roundDoc.roundId} ($${roundDoc.taxAmount.toFixed(2)}) were collected as site tax.` }); //
        } else if (roundDoc.totalValue > 0.001) { // // MODIFICATION: Check against a small epsilon
            console.warn(`PAYOUT_WARN (Inconsistency): Round ${roundDoc.roundId} winner ${winner.username} should get $${roundDoc.totalValue.toFixed(2)}, but no itemsToSend provided to sendWinningTradeOffer.`);
            io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Internal error processing winnings for round ${roundDoc.roundId}. No items were prepared. Please contact support.` }); //
        }
        return;
    }

    console.log(`PAYOUT_ATTEMPT: Attempting to send ${itemsToSend.length} items (Value: $${roundDoc.totalValue.toFixed(2)}) for round ${roundDoc.roundId} to winner ${winner.username} (Trade URL: ${winner.tradeUrl}).`);
    let sentOfferDetails = null; //
    let steamOfferURL = null; //

    try {
        const offer = manager.createOffer(winner.tradeUrl); //
        const itemsForOfferObject = itemsToSend.map(item => ({ assetid: item.assetId, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID })); //
        
        if (itemsForOfferObject.length === 0) { // Should be caught by earlier check, but as a safeguard
            console.error(`PAYOUT_CRITICAL: No valid item objects to add to trade offer for round ${roundDoc.roundId}, though itemsToSend was not empty. itemsToSend:`, itemsToSend);
            throw new Error("No valid items to add to the trade offer object despite itemsToSend list having content.");
        }
        offer.addMyItems(itemsForOfferObject); //
        offer.setMessage(`Congratulations! Your winnings from Round #${roundDoc.roundId} on ${process.env.SITE_NAME}. Total Value Won: $${roundDoc.totalValue.toFixed(2)}.`); //
        console.log(`PAYOUT_INFO: Trade offer for round ${roundDoc.roundId} created locally with ${itemsForOfferObject.length} items.`);

        const identitySecret = process.env.STEAM_IDENTITY_SECRET; // For auto-confirmations, if set up

        // Promisify offer.send
        const offerResult = await new Promise((resolve, reject) => { //
            offer.send(!!identitySecret, (err, status) => { // Second arg for auto-confirm with identitySecret
                if (err) {
                    console.error(`PAYOUT_SEND_ERROR (offer.send callback) for round ${roundDoc.roundId}: EResult ${err.eresult}, Message: ${err.message}`, err);
                    return reject(err); // This err will be caught by the outer catch block
                }
                // status can be 'pending', 'sent', 'escrow', etc.
                resolve({ status, offerId: offer.id }); // Resolve with status and offerId
            });
        });
        
        sentOfferDetails = offerResult; // Store the result from the promise
        steamOfferURL = `https://steamcommunity.com/tradeoffer/${sentOfferDetails.offerId}/`; //
        console.log(`PAYOUT_SEND_SUCCESS: Offer ${sentOfferDetails.offerId} for round ${roundDoc.roundId} sent to ${winner.username}. Status from Steam: ${sentOfferDetails.status}. URL: ${steamOfferURL}`);

        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferId: sentOfferDetails.offerId, payoutOfferStatus: 'Sent' } }); //
        console.log(`PAYOUT_DB_UPDATE: Round ${roundDoc.roundId} DB updated with payoutOfferId: ${sentOfferDetails.offerId} and status 'Sent'.`);

        // Emit an event to the client that the offer has been created
        // This is crucial for the "Accept Trade" button functionality
        if (sentOfferDetails && sentOfferDetails.offerId) { //
            io.emit('winningOfferCreated', { //
                roundId: roundDoc.roundId,
                userId: winner._id.toString(),
                username: winner.username,
                offerId: sentOfferDetails.offerId,
                offerURL: steamOfferURL // Send the direct offer URL
            });
            console.log(`PAYOUT_SOCKET_EMIT: Emitted 'winningOfferCreated' for offer ${sentOfferDetails.offerId}.`);
        }


        // Optional: Handle specific statuses like escrow or pending confirmation by updating the round and notifying user
        if (sentOfferDetails.status === 'pending' || sentOfferDetails.status === 'pendingConfirmation' || sentOfferDetails.status === 'escrow' || (typeof sentOfferDetails.status === 'number' && sentOfferDetails.status === 9)) { // ETradeOfferState.CreatedNeedsConfirmation is 9
             await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Escrow' } }); // Or a more specific status
             console.log(`PAYOUT_ESCROW: Offer #${sentOfferDetails.offerId} requires confirmation or is in escrow (Status: ${sentOfferDetails.status}). DB status updated to 'Escrow'.`);
             const notifMsg = `Your winnings (Offer #${sentOfferDetails.offerId}) for round ${roundDoc.roundId} have been sent but may require confirmation in Steam or could be held in escrow.`; //
             io.emit('notification', { type: 'warning', userId: winner._id.toString(), message: notifMsg }); //
        }

    } catch (err) { // Catches errors from createOffer, offer.send, or the Promise reject
        let offerStatusUpdateOnError = 'Failed'; //
        let userMessageOnError = `Error sending your winnings for round ${roundDoc.roundId}. Please contact support. (Ref: ${err.message ? err.message.substring(0,50) : 'Unknown'})`; //
        // MODIFICATION: More detailed error logging
        console.error(`PAYOUT_EXCEPTION sending offer for round ${roundDoc.roundId} to ${winner.username}. Steam EResult: ${err.eresult}, Steam Message: ${err.steamError ? err.steamError.message : 'N/A'}, General Message: ${err.message}`, err);


        if (err.message?.includes('revoked') || err.message?.includes('invalid') || err.eresult === 26 || err.eresult === 25) { // 25 is limit reached, 26 bad url
            userMessageOnError = 'Your Steam Trade URL is invalid, expired, or you cannot receive more offers. Please update it in your profile to receive winnings.'; offerStatusUpdateOnError = 'Failed - Bad URL/Limit'; //
        } else if (err.eresult === 15 || err.eresult === 16) { // Inventory full or private
            userMessageOnError = 'Could not send your winnings. Please ensure your Steam inventory is set to public and has space.'; offerStatusUpdateOnError = 'Failed - Inventory Issue'; //
        } else if (err.message?.toLowerCase().includes('escrow') || err.eresult === 11 || err.message?.includes('trade hold')) { // Eresul 11 can mean many things, but often related to trade holds/escrow
            userMessageOnError = `Your winnings offer for round ${roundDoc.roundId} (Offer ${sentOfferDetails?.offerId || 'ID N/A'}) was sent but may be held in Steam escrow.`; offerStatusUpdateOnError = 'Escrow'; //
        }
        
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: userMessageOnError }); //
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: offerStatusUpdateOnError, payoutOfferId: sentOfferDetails?.offerId || null } }) // Store offer ID even if send failed, if available
            .catch(dbErr => console.error(`PAYOUT_ERROR_DB_UPDATE: Failed to update round ${roundDoc.roundId} status after send error: `, dbErr));
    }
}


// --- Authentication Routes ---
app.get('/auth/steam', authLimiter, passport.authenticate('steam', { failureRedirect: '/' })); //
app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }), //
    (req, res) => { res.redirect('/'); } //
);
app.post('/logout', (req, res, next) => { //
    req.logout(err => { //
        if (err) { return next(err); }
        req.session.destroy(err => { //
            if (err) {
                console.error("Error destroying session during logout:", err);
                return res.status(500).json({ error: 'Logout failed.' });
            }
            res.clearCookie('connect.sid'); // Ensure session cookie is cleared
            res.json({ success: true }); //
        });
    });
});

// --- Middleware & API Routes ---
function ensureAuthenticated(req, res, next) { //
    if (req.isAuthenticated()) { return next(); } //
    res.status(401).json({ error: 'Not authenticated' }); //
}
const handleValidationErrors = (req, res, next) => { //
    const errors = validationResult(req); //
    if (!errors.isEmpty()) { //
        console.warn("Validation Errors:", errors.array());
        return res.status(400).json({ error: errors.array()[0].msg }); // Send first error message
    }
    next(); //
};

app.get('/api/user', ensureAuthenticated, (req, res) => { //
    const { _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue } = req.user; //
    res.json({ _id, steamId, username, avatar, tradeUrl, createdAt, pendingDepositOfferId, totalDepositedValue, totalWinningsValue }); //
});

app.post('/api/user/tradeurl', //
    sensitiveActionLimiter, ensureAuthenticated, //
    [
        body('tradeUrl').trim().custom((value) => { //
            if (value === '') return true; // Allow empty string to clear URL
            const urlPattern = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/; //
            if (!urlPattern.test(value)) throw new Error('Invalid Steam Trade URL format. Must include partner and token, or be empty.'); //
            return true; //
        })
    ],
    handleValidationErrors, //
    async (req, res) => {
        const { tradeUrl } = req.body; //
        try {
            const updatedUser = await User.findByIdAndUpdate(req.user._id, { tradeUrl: tradeUrl }, { new: true, runValidators: true }); //
            if (!updatedUser) return res.status(404).json({ error: 'User not found.' }); //
            console.log(`Trade URL updated for user: ${updatedUser.username}`);
            res.json({ success: true, tradeUrl: updatedUser.tradeUrl }); //
        } catch (err) {
            if (err.name === 'ValidationError') { // Mongoose validation error
                 console.error(`Trade URL Validation Error (Mongoose) for user ${req.user._id}:`, err.message);
                 return res.status(400).json({ error: err.message }); //
            }
            console.error(`Error updating trade URL for user ${req.user._id}:`, err);
            res.status(500).json({ error: 'Server error saving Trade URL.' }); //
        }
    }
);

// API Endpoint for Winning History
app.get('/api/user/winning-history', ensureAuthenticated, async (req, res) => { //
    try {
        const winnings = await Round.find({ winner: req.user._id, status: 'completed' }) //
            .sort({ completedTime: -1 }) //
            .select('roundId completedTime totalValue payoutOfferId payoutOfferStatus taxAmount') // Select relevant fields
            .limit(50) // Limit to last 50 wins for performance
            .lean(); //

        const history = winnings.map(win => ({ //
            gameId: win.roundId, //
            amountWon: win.totalValue, // This is already after-tax value for winner
            dateWon: win.completedTime, //
            tradeOfferId: win.payoutOfferId, //
            tradeStatus: win.payoutOfferStatus || 'Unknown' //
        }));
        res.json(history); //
    } catch (error) {
        console.error(`Error fetching winning history for user ${req.user._id}:`, error);
        res.status(500).json({ error: 'Server error fetching winning history.' }); //
    }
});


app.get('/api/inventory', ensureAuthenticated, async (req, res) => { //
    if (!isBotReady) { // Check if bot is operational
        console.warn(`Inventory fetch failed for ${req.user.username}: Bot service is unavailable.`);
        return res.status(503).json({ error: "Steam service temporarily unavailable. Please try again later." }); //
    }
    try {
        const inventory = await new Promise((resolve, reject) => { //
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => { //
                if (err) { //
                    if (err.message?.includes('profile is private') || err.eresult === 15) { //
                        return reject(new Error('Your Steam inventory is private. Please set it to public.')); //
                    }
                    console.error(`Inventory Fetch Error (Manager): User ${req.user.steamId}: EResult ${err.eresult} - ${err.message || err}`);
                    return reject(new Error(`Could not fetch inventory. Steam might be busy or inventory private.`)); //
                }
                resolve(inv || []); // Ensure inv is an array
            });
        });

        if (!inventory?.length) return res.json([]); // Return empty array if no items

        const validItems = inventory.map(item => { //
                const itemName = item.market_hash_name; //
                let price = 0; //
                if (itemName) price = getItemPrice(itemName); //
                else console.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`);

                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0; //

                if (!item.assetid || !item.icon_url || !itemName) { // Ensure essential properties exist
                    console.warn(`Inventory item missing required properties: assetId ${item?.assetid}, Name ${itemName}, Icon ${item?.icon_url}`);
                    return null; // Skip this item
                }
                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`; // Construct image URL
                return { assetId: item.assetid, name: itemName, image: imageUrl, price: finalPrice, tradable: item.tradable }; //
            })
            .filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE); // Filter out non-tradable or below min value

        res.json(validItems); //
    } catch (err) {
        console.error(`Error in /api/inventory for ${req.user?.username || req.user?.steamId}:`, err.message);
        res.status(500).json({ error: err.message || 'Server error fetching inventory.' }); //
    }
});

app.post('/api/deposit', depositLimiter, ensureAuthenticated, //
    [
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`You can deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items at a time.`), //
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.') // Basic validation for asset IDs
    ],
    handleValidationErrors, //
    async (req, res) => {
        const user = req.user; //
        const requestedAssetIds = req.body.assetIds; //

        if (!isBotReady) return res.status(503).json({ error: "Deposit service temporarily unavailable (Bot offline)." }); //
        if (!user.tradeUrl) return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile before depositing.' }); //

        if (user.pendingDepositOfferId) { //
             try {
                 const offer = await manager.getOffer(user.pendingDepositOfferId); //
                 if (offer && [TradeOfferManager.ETradeOfferState.Active, TradeOfferManager.ETradeOfferState.Sent, TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation].includes(offer.state)) { //
                     console.log(`User ${user.username} already has pending deposit offer ${user.pendingDepositOfferId}. State: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
                     const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`; //
                     return res.status(409).json({ error: 'You already have an active deposit offer waiting. Please accept or decline it on Steam.', offerId: user.pendingDepositOfferId, offerURL: offerURL }); //
                 } else { //
                      console.log(`Clearing stale pending offer ${user.pendingDepositOfferId} for user ${user.username} (State: ${TradeOfferManager.ETradeOfferState[offer?.state]}).`);
                      await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }); //
                 }
             } catch (offerFetchError) {
                 console.warn(`Could not fetch pending offer ${user.pendingDepositOfferId}, clearing flag:`, offerFetchError.message);
                 await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }); //
             }
        }

        if (!currentRound || currentRound.status !== 'active' || isRolling) { // Check isRolling here too
            console.warn(`Deposit attempt by ${user.username} failed: Round not active or rolling. Current round ID: ${currentRound?.roundId}, Status: ${currentRound?.status}, isRolling: ${isRolling}`);
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' }); //
        }

        let latestRoundData; //
        try {
            latestRoundData = await Round.findById(currentRound._id.toString()).select('participants items status').lean().exec(); // Ensure status is fetched
            if (!latestRoundData) throw new Error('Could not fetch current round data for deposit.'); //
            if (latestRoundData.status !== 'active') { // Re-check status after fetching, as it might have changed
                 console.warn(`Deposit attempt by ${user.username} for round ${currentRound.roundId} failed: Round status became ${latestRoundData.status} during check.`);
                 return res.status(400).json({ error: 'Deposits are closed as round is no longer active.' }); //
            }
            const isNewParticipant = !latestRoundData.participants.some(p => p.user?.toString() === user._id.toString()); //
            if (isNewParticipant && latestRoundData.participants.length >= MAX_PARTICIPANTS) { //
                 return res.status(400).json({ error: `Participant limit (${MAX_PARTICIPANTS}) reached.` }); //
            }
            if (latestRoundData.items.length + requestedAssetIds.length > MAX_ITEMS_PER_POT) { //
                 const slotsLeft = MAX_ITEMS_PER_POT - latestRoundData.items.length; //
                 return res.status(400).json({ error: `Depositing ${requestedAssetIds.length} items would exceed pot limit (${MAX_ITEMS_PER_POT}). ${slotsLeft} slots left.` }); //
            }
        } catch (dbErr) {
            console.error(`Error fetching round data during deposit for ${user.username}:`, dbErr);
            return res.status(500).json({ error: 'Internal server error checking round limits.' }); //
        }

        let itemsToRequest = []; //
        let depositTotalValue = 0; //

        try {
            console.log(`Verifying inventory for ${user.username} (SteamID: ${user.steamId}) to confirm deposit items...`);
            const userInventory = await new Promise((resolve, reject) => { //
                manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => { //
                    if (err) { //
                        if (err.message?.includes('profile is private') || err.eresult === 15) return reject(new Error('Your Steam inventory is private.')); //
                        console.error(`Inventory Fetch Error (Deposit): User ${user.steamId}: EResult ${err.eresult}`, err);
                        return reject(new Error(`Could not fetch inventory. Ensure it's public.`)); //
                    }
                    resolve(inv || []); //
                });
            });
            const userInventoryMap = new Map(userInventory.map(item => [item.assetid, item])); //

            for (const assetId of requestedAssetIds) { //
                const inventoryItem = userInventoryMap.get(assetId); //
                if (!inventoryItem) throw new Error(`Item Asset ID ${assetId} not in inventory.`); //
                if (!inventoryItem.tradable) throw new Error(`Item '${inventoryItem.market_hash_name}' not tradable.`); //
                const price = getItemPrice(inventoryItem.market_hash_name); //
                if (price < MIN_ITEM_VALUE) throw new Error(`Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below min value ($${MIN_ITEM_VALUE}).`); //
                itemsToRequest.push({ //
                    assetid: inventoryItem.assetid, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID, //
                    _price: price, _name: inventoryItem.market_hash_name, //
                     _image: `https://community.akamai.steamstatic.com/economy/image/${inventoryItem.icon_url}` //
                });
                depositTotalValue += price; //
            }
             if (itemsToRequest.length === 0) throw new Error("No items could be verified for deposit."); //
             console.log(`Verified ${itemsToRequest.length} items for deposit for ${user.username}. Total Value: $${depositTotalValue.toFixed(2)}`);
        } catch (verificationError) {
            console.warn(`Deposit item verification failed for ${user.username}:`, verificationError.message);
            return res.status(400).json({ error: verificationError.message }); //
        }

        const depositId = uuidv4(); //
        const offerMessage = `RustyDegen Deposit ID: ${depositId} | Round: ${currentRound.roundId}`; //
        let cleanupTimeout = null; //

        try {
            const offer = manager.createOffer(user.tradeUrl); //
            offer.addTheirItems(itemsToRequest.map(({ assetid, appid, contextid }) => ({ assetid, appid, contextid }))); //
            offer.setMessage(offerMessage); //
            pendingDeposits.set(depositId, { //
                userId: user._id, roundId: currentRound._id, items: itemsToRequest, //
                totalValue: depositTotalValue, steamId: user.steamId //
            });
            console.log(`Stored pending deposit ${depositId} for user ${user.steamId}.`);
            cleanupTimeout = setTimeout(() => { //
                 if(pendingDeposits.has(depositId)) { //
                     console.log(`Deposit attempt ${depositId} expired.`);
                      pendingDeposits.delete(depositId); //
                      User.updateOne({ steamId: user.steamId, pendingDepositOfferId: offer?.id || 'expired' }, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user pending flag on expiry:", e)); //
                 }
            }, manager.cancelTime || 10 * 60 * 1000); //

            console.log(`Sending deposit offer to ${user.username} (Trade URL: ${user.tradeUrl})...`);
            const status = await new Promise((resolve, reject) => { //
                offer.send((err, sendStatus) => { if (err) return reject(err); resolve(sendStatus); }); //
            });
            try {
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: offer.id }); //
                console.log(`Set pendingDepositOfferId=${offer.id} for user ${user.username}.`);
            } catch (dbUpdateError) { //
                 console.error(`CRITICAL: Failed to set pendingDepositOfferId for user ${user.username} after sending offer ${offer.id}.`, dbUpdateError);
                  pendingDeposits.delete(depositId); clearTimeout(cleanupTimeout); //
                  return res.status(500).json({ error: 'Failed to finalize deposit request state. Contact support.' }); //
            }
            console.log(`Deposit offer ${offer.id} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`; //
            res.json({ success: true, message: 'Deposit offer created! Accept on Steam.', offerId: offer.id, offerURL: offerURL }); //
        } catch (error) {
            console.error(`Error sending deposit offer for ${user.username} (DepositID: ${depositId}): EResult ${error.eresult}`, error.message);
            pendingDeposits.delete(depositId); if (cleanupTimeout) clearTimeout(cleanupTimeout); //
            await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user flag on offer fail:", e)); //
            let userMessage = 'Failed to create deposit trade offer. Try again later.'; //
            if (error.message.includes('unable to trade') && error.message.includes('reset your Steam account')) userMessage = `Steam Error: Account has temporary trade restriction. (${error.message})`; //
            else if (error.message.includes('Trade URL') || error.message.includes('token') || error.eresult === 26) userMessage = 'Your Steam Trade URL might be invalid/expired. Check profile.'; //
            else if (error.eresult) userMessage += ` (Code: ${error.eresult})`; //
            res.status(500).json({ error: userMessage }); //
        }
    }
);

// --- Trade Offer Manager Event Handling ---
if (isBotConfigured && manager) { //
    manager.on('newOffer', async (offer) => { //
        if (!isBotReady || offer.isOurOffer) return; //
        // Decline unsolicited offers or manual deposits not initiated via API
        if (offer.itemsToReceive && offer.itemsToReceive.length > 0 && (!offer.itemsToGive || offer.itemsToGive.length === 0)) { //
             // Check if it's a deposit from an unknown source (no depositId in message)
             if (!offer.message || !offer.message.includes('RustyDegen Deposit ID:')) { //
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} is an unsolicited item offer or manual deposit. Declining.`);
                 return offer.decline((err) => { if (err) console.error(`Error declining unsolicited/manual offer ${offer.id}:`, err); }); //
             }
        }
        // If it has a Deposit ID but isn't in pendingDeposits, it might be old/re-sent; best to decline.
        const messageMatch = offer.message ? offer.message.match(/Deposit ID: ([a-f0-9-]+)/i) : null;
        const depositIdFromOffer = messageMatch ? messageMatch[1] : null;
        if (depositIdFromOffer && !pendingDeposits.has(depositIdFromOffer)) {
            console.log(`Offer #${offer.id} (DepositID: ${depositIdFromOffer}) from ${offer.partner.getSteamID64()} not found in pending deposits. Declining.`);
            return offer.decline((err) => { if (err) console.error(`Error declining unrecognized deposit offer ${offer.id}:`, err); });
        }

        console.log(`Ignoring unexpected incoming offer #${offer.id} from ${offer.partner.getSteamID64()} that wasn't a deposit or was handled by sentOfferChanged.`);
    });

    manager.on('sentOfferChanged', async (offer, oldState) => { //
        console.log(`Bot Offer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()}) Msg: "${offer.message}"`);

        const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i); //
        const depositId = messageMatch ? messageMatch[1] : null; //

        if (depositId && pendingDeposits.has(depositId)) { // It's a deposit offer
            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) { //
                const depositData = pendingDeposits.get(depositId); //
                pendingDeposits.delete(depositId); // Remove from pending once accepted
                console.log(`Processing accepted deposit offer #${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId}`);
                User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null }) //
                    .catch(e => console.error("Error clearing user pending flag on deposit accept:", e));

                let depositRoundDB; //
                try {
                     depositRoundDB = await Round.findById(depositData.roundId.toString()).select('status participants items endTime').exec(); // Fetch endTime too
                     if (!depositRoundDB || depositRoundDB.status !== 'active' || isRolling) { // Check isRolling
                          console.warn(`DEPOSIT_ACCEPTED_ROUND_INVALID: Deposit ${depositId} (Offer ${offer.id}) accepted, but round invalid (Status: ${depositRoundDB?.status}, isRolling: ${isRolling}). Items NOT added.`);
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Round ended or is rolling before offer #${offer.id} processed. Contact support.` }); //
                          // Potentially handle refund or item return logic here if critical
                          return;
                     }
                     const isNewP = !depositRoundDB.participants.some(p => p.user?.toString() === depositData.userId.toString()); //
                     if (isNewP && depositRoundDB.participants.length >= MAX_PARTICIPANTS) { //
                         io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Participant limit reached for offer #${offer.id}. Contact support.` }); return; //
                     }
                     if (depositRoundDB.items.length + depositData.items.length > MAX_ITEMS_PER_POT) { //
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Pot item limit reached for offer #${offer.id}. Contact support.` }); return; //
                     }
                 } catch (roundCheckError) {
                      console.error(`CRITICAL DB ERROR checking round status for deposit ${depositId}:`, roundCheckError);
                      io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Contact support.` }); //
                      return;
                 }

                let createdItemIds = []; //
                try {
                    const itemDocuments = depositData.items.map(itemData => new Item({ //
                        assetId: itemData.assetid, name: itemData._name, image: itemData._image, //
                        price: itemData._price, owner: depositData.userId, roundId: depositData.roundId //
                    }));
                    const insertedItemsResult = await Item.insertMany(itemDocuments, { ordered: false }); //
                    createdItemIds = insertedItemsResult.map(doc => doc._id); //
                    console.log(`Deposit ${depositId}: Inserted ${createdItemIds.length} items into DB.`);
                    await User.findByIdAndUpdate( depositData.userId, { $inc: { totalDepositedValue: depositData.totalValue } } ); //
                    console.log(`User ${depositData.steamId} totalDepositedValue updated by $${depositData.totalValue}.`);

                    // Re-fetch the round to perform atomic-like updates or ensure using the latest version
                    const roundToUpdate = await Round.findById(depositData.roundId.toString()); //
                    if (!roundToUpdate || roundToUpdate.status !== 'active') { // Check status again before updating
                        throw new Error(`Round status invalid (current: ${roundToUpdate?.status}) before final deposit update for offer ${offer.id}.`);
                    }

                    let participantIndex = roundToUpdate.participants.findIndex(p => p.user?.toString() === depositData.userId.toString()); //
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO)); //
                    if (participantIndex !== -1) { //
                           roundToUpdate.participants[participantIndex].itemsValue += depositData.totalValue; //
                           roundToUpdate.participants[participantIndex].tickets += depositTickets; //
                    } else { //
                           if (roundToUpdate.participants.length >= MAX_PARTICIPANTS) throw new Error("Participant limit hit just before final save of deposit."); //
                           roundToUpdate.participants.push({ user: depositData.userId, itemsValue: depositData.totalValue, tickets: depositTickets }); //
                    }
                    roundToUpdate.totalValue += depositData.totalValue; //
                    if (roundToUpdate.items.length + createdItemIds.length > MAX_ITEMS_PER_POT) throw new Error("Pot item limit hit just before final save of deposit."); //
                    roundToUpdate.items.push(...createdItemIds); //
                    
                    // MODIFICATION: Only set endTime if it's not already set (timer shouldn't restart if already running)
                    let needsTimerStart = false;
                    if (roundToUpdate.participants.length === 1 && !roundToUpdate.endTime) { // Only first participant AND no endTime yet
                        roundToUpdate.endTime = new Date(Date.now() + ROUND_DURATION * 1000);
                        needsTimerStart = true;
                        console.log(`DEPOSIT_TIMER_LOGIC: First participant for round ${roundToUpdate.roundId}, setting endTime to ${roundToUpdate.endTime.toISOString()}.`);
                    }
                    
                    const savedRound = await roundToUpdate.save(); //
                    // Update in-memory global currentRound with the saved version
                    currentRound = await Round.findById(savedRound._id) // Re-populate for consistency
                        .populate('participants.user', 'steamId username avatar _id') // MODIFICATION: Ensure _id is populated
                        .populate('items') // MODIFICATION: Populate items
                        .lean();
                    currentRound = JSON.parse(JSON.stringify(currentRound)); // Deep clone to handle Mongoose object quirks


                    const updatedParticipantData = currentRound.participants.find(p => p.user?._id.toString() === depositData.userId.toString()); //
                    const userInfo = updatedParticipantData?.user; //
                    if (updatedParticipantData && userInfo) { //
                          io.emit('participantUpdated', { //
                               roundId: currentRound.roundId, userId: userInfo._id.toString(), username: userInfo.username, //
                               avatar: userInfo.avatar, itemsValue: updatedParticipantData.itemsValue, //
                               tickets: updatedParticipantData.tickets, totalValue: currentRound.totalValue, //
                               depositedItems: depositData.items.map(i => ({ assetId: i.assetid, name: i._name, image: i._image, price: i._price })) //
                          });
                    }
                    // Start timer if it's the first participant and timer hasn't started (indicated by needsTimerStart)
                    if (needsTimerStart && !roundTimer) { //
                          console.log(`DEPOSIT_TIMER_LOGIC: First participant deposit for round ${currentRound.roundId} processed. Starting round timer.`);
                          startRoundTimer(false); // false = don't use remaining time, start new
                    } else if (currentRound.participants.length > 0 && currentRound.status === 'active' && !currentRound.endTime && !roundTimer) { //
                        // This case handles if server restarted, round was active with participants but no endTime.
                        console.log(`DEPOSIT_TIMER_LOGIC: Round ${currentRound.roundId} has participants but no endTime. Starting timer.`);
                        startRoundTimer(false); //
                    } else if (currentRound.endTime && !roundTimer && currentRound.status === 'active' && new Date(currentRound.endTime) > Date.now()) {
                        // If endTime is set, timer isn't running, but should be (e.g. after a quick restart)
                        console.log(`DEPOSIT_TIMER_LOGIC: Round ${currentRound.roundId} has endTime but no active timer. Resuming/Starting timer.`);
                        startRoundTimer(true); // Try to use remaining time
                    }


                     console.log(`DEPOSIT_SUCCESS: Offer #${offer.id} processed. User: ${userInfo?.username}. Round: ${currentRound.roundId}`);
                 } catch (dbErr) {
                     console.error(`CRITICAL DB/UPDATE ERROR processing accepted deposit ${offer.id}:`, dbErr);
                     io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Contact support immediately.` }); //
                      if (createdItemIds.length > 0) { // Attempt to rollback item creation if DB update failed
                          await Item.deleteMany({ _id: { $in: createdItemIds } }); //
                          console.error(`Rolled back ${createdItemIds.length} items for failed deposit ${offer.id}.`);
                      }
                      // Mark round as error if deposit processing critically fails
                      if (currentRound?._id.toString() === depositData.roundId.toString()) { //
                          await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } }); //
                          io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error. Round halted.' }); //
                          isRolling = false; // Ensure rolling is false if round errors out here
                          currentRound.status = 'error'; // Update in-memory
                      }
                 }
            } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired, TradeOfferManager.ETradeOfferState.InvalidItems].includes(offer.state)) { //
                const depositData = pendingDeposits.get(depositId); //
                if (depositData) { //
                    console.warn(`Deposit offer ${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId} was ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                    pendingDeposits.delete(depositId); //
                    User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null }) //
                        .catch(e => console.error("Error clearing user flag on deposit failure:", e));
                    const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' '); //
                    io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Your deposit offer (#${offer.id}) was ${stateMessage}.` }); //
                }
            }
        } else if (offer.itemsToGive && offer.itemsToGive.length > 0 && (!offer.itemsToReceive || offer.itemsToReceive.length === 0)) { //
            // This is a payout (winnings) offer
            let payoutStatusUpdate = 'Unknown'; //
            switch (offer.state) { //
                case TradeOfferManager.ETradeOfferState.Accepted: payoutStatusUpdate = 'Accepted'; break; //
                case TradeOfferManager.ETradeOfferState.Declined: payoutStatusUpdate = 'Declined'; break; //
                case TradeOfferManager.ETradeOfferState.Canceled: payoutStatusUpdate = 'Canceled'; break; //
                case TradeOfferManager.ETradeOfferState.Expired: payoutStatusUpdate = 'Expired'; break; //
                case TradeOfferManager.ETradeOfferState.InvalidItems: payoutStatusUpdate = 'InvalidItems'; break; //
                case TradeOfferManager.ETradeOfferState.InEscrow: payoutStatusUpdate = 'Escrow'; break; //
                default: payoutStatusUpdate = TradeOfferManager.ETradeOfferState[offer.state] || 'Unknown'; // Use enum name if available //
            }

            console.log(`Payout offer #${offer.id} to ${offer.partner.getSteamID64()} changed to ${payoutStatusUpdate}.`);
            try {
                const updatedRound = await Round.findOneAndUpdate( //
                    { payoutOfferId: offer.id }, //
                    { $set: { payoutOfferStatus: payoutStatusUpdate } }, //
                    { new: true } //
                ).populate('winner', 'steamId _id'); // Populate to get winner's MongoDB _id

                if (updatedRound && updatedRound.winner) { //
                    const winnerUserId = updatedRound.winner._id.toString(); //
                     if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) { //
                        io.emit('notification', { type: 'success', userId: winnerUserId, message: `Winnings from offer #${offer.id} (Round #${updatedRound.roundId}) received!` }); //
                    } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired].includes(offer.state)) { //
                        io.emit('notification', { type: 'error', userId: winnerUserId, message: `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) was ${payoutStatusUpdate}. Contact support if this was an error.` }); //
                    } else if (offer.state === TradeOfferManager.ETradeOfferState.InEscrow) { //
                         io.emit('notification', { type: 'warning', userId: winnerUserId, message: `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) is held in Steam escrow.` }); //
                    }
                } else if (!updatedRound) { //
                    console.warn(`Could not find round associated with payout offer #${offer.id} to update status.`);
                }
            } catch (dbError) {
                console.error(`Error updating payout status for offer #${offer.id} in DB:`, dbError);
            }
        } else { //
            console.warn(`Offer #${offer.id} changed state to ${TradeOfferManager.ETradeOfferState[offer.state]}, but not recognized as pending deposit or standard winnings. Message: "${offer.message}"`);
        }
    });
}

// --- Round Info API Routes ---
// MODIFICATION: formatRoundForClient ensures _id is string and owner is string ID
function formatRoundForClient(round) { //
    if (!round) return null; //
    let timeLeft = 0; //
    if (round.status === 'active') { //
        if (round.endTime) { //
            const remainingMs = new Date(round.endTime).getTime() - Date.now(); //
            timeLeft = Math.max(0, Math.floor(remainingMs / 1000)); //
        } else if (round.participants && round.participants.length > 0) { //
            timeLeft = ROUND_DURATION; // Default to full if active, has participants, but no endTime yet
        } else { //
            timeLeft = ROUND_DURATION; // Active but no participants, show full time
        }
    } else if (round.status === 'pending') { //
        timeLeft = ROUND_DURATION; //
    }


    const participantsFormatted = (round.participants || []).map(p => ({ //
        user: p.user ? { _id: p.user._id ? p.user._id.toString() : null, steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar } : null, //
        itemsValue: p.itemsValue || 0, tickets: p.tickets || 0 //
    })).filter(p => p.user && p.user._id); // Ensure user and user._id exist

    const itemsFormatted = (round.items || []).map(i => ({ //
        assetId: i.assetId, name: i.name, image: i.image, price: i.price || 0, //
        // MODIFICATION: Ensure owner is consistently an ID string if populated, or null.
        owner: i.owner ? (i.owner._id ? i.owner._id.toString() : (typeof i.owner === 'string' ? i.owner : (i.owner.toString ? i.owner.toString() : null))) : null
    }));

    let winnerDetails = null; //
    if (round.winner && round.winner.steamId) { // If winner is populated
        winnerDetails = { //
            id: round.winner._id ? round.winner._id.toString() : null, steamId: round.winner.steamId, //
            username: round.winner.username, avatar: round.winner.avatar //
        };
    } else if (round.winner) { // If winner is just an ID
         winnerDetails = { id: round.winner.toString() }; // Convert ObjectId to string if necessary
    }


    return { //
        _id: round._id ? round._id.toString() : null, // Add MongoDB ID
        roundId: round.roundId, status: round.status, startTime: round.startTime, endTime: round.endTime, //
        timeLeft: timeLeft, totalValue: round.totalValue || 0, serverSeedHash: round.serverSeedHash, //
        participants: participantsFormatted, items: itemsFormatted, //
        winner: winnerDetails, //
        winningTicket: round.status === 'completed' ? round.winningTicket : undefined, //
        serverSeed: round.status === 'completed' ? round.serverSeed : undefined, //
        clientSeed: round.status === 'completed' ? round.clientSeed : undefined, //
        provableHash: round.status === 'completed' ? round.provableHash : undefined, //
        taxAmount: round.taxAmount, //
        payoutOfferId: round.payoutOfferId || null, //
    };
}

app.get('/api/round/current', async (req, res) => { //
    let roundToFormat = null; //
    try {
        // MODIFICATION: Use a clean copy for currentRound if fetched
        if (currentRound && currentRound._id) { // Prioritize in-memory currentRound if it has a MongoDB ID
            const freshRound = await Round.findById(currentRound._id.toString()) //
                 .populate('participants.user', 'steamId username avatar _id') // Ensure _id is populated
                 .populate('items').populate('winner', 'steamId username avatar _id') // Ensure _id is populated
                 .lean(); //
            if (!freshRound) {
                console.log("In-memory currentRound was stale, _id not found in DB. Clearing currentRound.");
                currentRound = null;
            } else {
                // Make a deep copy to avoid Mongoose object issues with modification/re-assignment
                currentRound = JSON.parse(JSON.stringify(freshRound)); //
                roundToFormat = currentRound;
            }
        }
        // If currentRound was null or became null (stale), try fetching any active/pending/rolling
        if (!roundToFormat) { //
            const foundRound = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } }) //
                 .sort({ startTime: -1 }) // Get the latest one
                 .populate('participants.user', 'steamId username avatar _id') //
                 .populate('items').populate('winner', 'steamId username avatar _id') //
                 .lean(); //
            if (foundRound) { // If we found one and currentRound was truly null or cleared
                 currentRound = JSON.parse(JSON.stringify(foundRound)); // Set it as the in-memory currentRound (deep copy)
                 roundToFormat = currentRound;
                 // Logic to potentially resume timer if needed
                 if (currentRound.status === 'active' && currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) startRoundTimer(true); //
                 else if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) startRoundTimer(false); //
            }
        }

        const formattedData = formatRoundForClient(roundToFormat); //
        if (formattedData) {
            // console.log(`DEBUG /api/round/current: Sending round ${formattedData.roundId}, status ${formattedData.status}, timeLeft ${formattedData.timeLeft}`);
            res.json(formattedData); //
        }
        else res.status(404).json({ error: 'No active or pending round found.' }); //
    } catch (err) {
        console.error('Error fetching/formatting current round data:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' }); //
    }
});

app.get('/api/rounds', //
    [query('page').optional().isInt({ min: 1 }).toInt(), query('limit').optional().isInt({ min: 1, max: 50 }).toInt()], //
    handleValidationErrors, async (req, res) => { //
    try {
        const page = req.query.page || 1; const limit = req.query.limit || 10; const skip = (page - 1) * limit; //
        const queryFilter = { status: { $in: ['completed', 'error'] } }; //
        const [rounds, totalCount] = await Promise.all([ //
            Round.find(queryFilter).sort('-roundId').skip(skip).limit(limit) //
                 .populate('winner', 'username avatar steamId') //
                 .select('roundId startTime endTime completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount taxedItems payoutOfferId payoutOfferStatus') //
                 .lean(), //
            Round.countDocuments(queryFilter) //
        ]);
        res.json({ rounds, totalPages: Math.ceil(totalCount / limit), currentPage: page, totalRounds: totalCount }); //
    } catch (err) {
        console.error('Error fetching past rounds:', err);
        res.status(500).json({ error: 'Server error fetching round history.' }); //
    }
});

app.post('/api/verify', sensitiveActionLimiter, //
    [
        body('roundId').notEmpty().isInt({ min: 1 }).toInt(), //
        body('serverSeed').trim().notEmpty().isHexadecimal().isLength({ min: 64, max: 64 }), //
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 }) // Allow reasonable length for client seed
    ],
    handleValidationErrors, async (req, res) => { //
    const { roundId, serverSeed, clientSeed } = req.body; //
    try {
        const round = await Round.findOne({ roundId: roundId, status: 'completed' }) //
             .populate('participants.user', 'username').populate('winner', 'username').lean(); //
        if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found.` }); //
        const providedHash = crypto.createHash('sha256').update(serverSeed).digest('hex'); //
        if (providedHash !== round.serverSeedHash) return res.json({ verified: false, reason: 'Server Seed Hash mismatch.', expectedHash: round.serverSeedHash, providedSeed: serverSeed, calculatedHash: providedHash }); //
        // If official seeds are present, they must match for this verification path
        if (round.serverSeed && round.clientSeed && (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed)) { //
            return res.json({ verified: false, reason: 'Provided seeds do not match official round seeds.', expectedServerSeed: round.serverSeed, expectedClientSeed: round.clientSeed, providedServerSeed: serverSeed, providedClientSeed: clientSeed }); //
        }
        const combinedString = serverSeed + clientSeed; //
        const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex'); //
        if (round.provableHash && calculatedProvableHash !== round.provableHash) return res.json({ verified: false, reason: 'Calculated Provable Hash mismatch.', expectedProvableHash: round.provableHash, calculatedProvableHash, combinedString }); //
        const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16); //
        const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0; //
        if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets.' }); //
        const calculatedWinningTicket = decimalFromHash % totalTickets; //
        if (calculatedWinningTicket !== round.winningTicket) return res.json({ verified: false, reason: 'Calculated winning ticket mismatch.', calculatedTicket: calculatedWinningTicket, actualWinningTicket: round.winningTicket, provableHashUsed: calculatedProvableHash, totalTickets }); //
        res.json({ //
            verified: true, roundId: round.roundId, serverSeed, serverSeedHash: round.serverSeedHash, clientSeed, //
            combinedString, finalHash: calculatedProvableHash, winningTicket: calculatedWinningTicket, //
            totalTickets, totalValue: round.totalValue, //
            winnerUsername: round.winner?.username || 'N/A' //
        });
    } catch (err) {
        console.error(`Error verifying round ${roundId}:`, err);
        res.status(500).json({ error: 'Server error during verification.' }); //
    }
});

// --- Socket.io Connection Handling ---
io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); }); //
io.use((socket, next) => { passport.initialize()(socket.request, socket.request.res || {}, next); }); //
io.use((socket, next) => { passport.session()(socket.request, socket.request.res || {}, next); }); //

let connectedChatUsers = 0; //
const userLastMessageTime = new Map(); //

io.on('connection', (socket) => { //
    connectedChatUsers++; //
    io.emit('updateUserCount', connectedChatUsers); //
    const user = socket.request.user; //
    if (user && user.username) console.log(`User ${user.username} (Socket ID: ${socket.id}) connected.`); //
    else console.log(`Anonymous client (Socket ID: ${socket.id}) connected.`); //

    socket.on('requestRoundData', async () => { //
        try {
            let roundToSend = null; //
             // MODIFICATION: Use a clean copy for currentRound if fetched
             if (currentRound && currentRound._id) { //
                 const freshRound = await Round.findById(currentRound._id.toString()) //
                       .populate('participants.user', 'steamId username avatar _id') //
                       .populate('items').populate('winner', 'steamId username avatar _id').lean(); //
                 if (!freshRound) { //
                    currentRound = null; //
                 } else { //
                    currentRound = JSON.parse(JSON.stringify(freshRound)); // Deep copy
                    roundToSend = currentRound; //
                 }
             }
             if (!roundToSend) { // If still no round (e.g., currentRound was null or became null)
                 const foundRound = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } }) //
                       .sort({ startTime: -1 }) //
                       .populate('participants.user', 'steamId username avatar _id') //
                       .populate('items').populate('winner', 'steamId username avatar _id').lean(); //
                 if (foundRound) { // If we found one and currentRound was truly null or cleared
                      currentRound = JSON.parse(JSON.stringify(foundRound)); // Set it as the in-memory currentRound (deep copy)
                      roundToSend = currentRound; //
                      // Logic to potentially resume timer if needed
                      if (currentRound.status === 'active' && currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) startRoundTimer(true); //
                      else if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) startRoundTimer(false); //
                 }
             }
            const formattedData = formatRoundForClient(roundToSend); //
            if (formattedData) {
                 console.log(`SOCKET_EMIT ('roundData') for socket ${socket.id}: Round ${formattedData.roundId}, Status: ${formattedData.status}, TimeLeft: ${formattedData.timeLeft}, Items: ${formattedData.items.length}`);
                 socket.emit('roundData', formattedData); //
            } else {
                 console.log(`SOCKET_EMIT ('noActiveRound') for socket ${socket.id}`);
                 socket.emit('noActiveRound'); // Client should handle this state
            }
        } catch (err) {
            console.error(`Error fetching round data for socket ${socket.id}:`, err);
            socket.emit('roundError', { error: 'Failed to load round data.' }); //
        }
    });

    socket.on('chatMessage', (msg) => { //
        if (!user || !user._id) { //
            socket.emit('notification', {type: 'error', message: 'You must be logged in to chat.'}); return; //
        }
        const userId = user._id.toString(); //
        const now = Date.now(); //
        const lastMessageTime = userLastMessageTime.get(userId) || 0; //
        if (now - lastMessageTime < CHAT_COOLDOWN_SECONDS * 1000) { //
            const timeLeft = Math.ceil((CHAT_COOLDOWN_SECONDS * 1000 - (now - lastMessageTime)) / 1000); //
            socket.emit('notification', {type: 'warning', message: `Please wait ${timeLeft}s before sending another message.`}); return; //
        }
        if (typeof msg !== 'string' || msg.trim().length === 0 || msg.trim().length > MAX_CHAT_MESSAGE_LENGTH) { //
            socket.emit('notification', {type: 'error', message: `Invalid message. Max ${MAX_CHAT_MESSAGE_LENGTH} characters.`}); return; //
        }
        userLastMessageTime.set(userId, now); //
        const messageData = { //
            username: user.username, avatar: user.avatar || '/img/default-avatar.png', //
            message: msg.trim(), userId: userId, userSteamId: user.steamId, timestamp: new Date() //
        };
        io.emit('chatMessage', messageData); //
        console.log(`Chat (User: ${user.username}, ID: ${userId}): ${msg.trim()}`);
    });

    socket.on('disconnect', (reason) => { //
        connectedChatUsers = Math.max(0, connectedChatUsers - 1); // Prevent negative
        io.emit('updateUserCount', connectedChatUsers); //
         if (user && user.username) console.log(`User ${user.username} disconnected. Reason: ${reason}`); //
         else console.log(`Anonymous client disconnected. Reason: ${reason}`); //
    });
});

// --- Server Startup ---
async function startApp() { //
    console.log("Performing initial price cache refresh...");
    await refreshPriceCache(); //
    setInterval(async () => { //
        try { await refreshPriceCache(); } //
        catch (refreshErr) { console.error("Error during scheduled price cache refresh:", refreshErr); }
    }, PRICE_REFRESH_INTERVAL_MS); //
    console.log(`Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);
    const PORT = process.env.PORT || 3000; //
    server.listen(PORT, () => { //
        console.log(`Server listening on port ${PORT}`);
        console.log(`Site URL configured as: ${process.env.SITE_URL}`);
        if (!isBotConfigured) console.log("INFO: Steam Bot not configured. Trade features disabled."); //
        else if (!isBotReady) console.log("INFO: Steam Bot login attempt may have failed or is pending. Will retry or check logs."); //
        else console.log("INFO: Steam Bot is ready."); //
        ensureInitialRound(); //
    });
}
startApp(); //

function gracefulShutdown() { //
    console.log('Received shutdown signal. Closing server...');
    io.close(() => { // Close socket.io connections first
        console.log('Socket.IO connections closed.');
        server.close(async () => { //
            console.log('HTTP server closed.');
            try {
                await mongoose.connection.close(); //
                console.log('MongoDB connection closed.');
                if (manager && typeof manager.shutdown === 'function') { //
                     console.log('Stopping TradeOfferManager polling...');
                     manager.shutdown(); // This method exists in some versions or custom forks.
                } else if (manager) { //
                     console.log('TradeOfferManager will stop on process exit (no explicit shutdown method called).');
                }
                process.exit(0); //
            } catch (e) {
                console.error("Error during shutdown resource cleanup:", e);
                process.exit(1); //
            }
        });
    });
    // Force shutdown if graceful fails
    setTimeout(() => { //
        console.error('Could not close connections gracefully in time, forcing shutdown.');
        process.exit(1); //
    }, 10000); // 10 seconds timeout
}
process.on('SIGTERM', gracefulShutdown); //
process.on('SIGINT', gracefulShutdown); //

// Global error handler
app.use((err, req, res, next) => { //
    console.error("Unhandled Error in Express middleware/route:", err.stack || err);
    const status = err.status || 500; //
    const message = process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.'); //
    if (res.headersSent) { // If headers already sent, delegate to default Express error handler
        return next(err); //
    }
    res.status(status).json({ error: message }); //
});

console.log("app.js fully loaded and corrections applied.");
