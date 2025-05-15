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
const MongoStore = require('connect-mongo'); // <-- ADDED: For production session store
require('dotenv').config();

// --- Configuration Constants ---
const requiredEnvVars = [
    'MONGODB_URI', 'SESSION_SECRET', 'STEAM_API_KEY', 'SITE_URL',
    // Conditionally required if bot is intended to function
    // Making STEAM_IDENTITY_SECRET explicitly required if bot is on, as auto-confirm is critical for payouts
    'STEAM_USERNAME', 'STEAM_PASSWORD', 'STEAM_SHARED_SECRET', 'STEAM_IDENTITY_SECRET', 'BOT_TRADE_URL', 'SITE_NAME'
];
const isBotConfigured = process.env.STEAM_USERNAME && process.env.STEAM_PASSWORD && process.env.STEAM_SHARED_SECRET && process.env.BOT_TRADE_URL && process.env.STEAM_IDENTITY_SECRET;
let missingVars = requiredEnvVars.filter(v => {
    if (isBotConfigured) {
        return !process.env[v]; // All are required if bot is configured
    }
    // If bot is not configured, only core non-steam vars are strictly required
    return !['STEAM_USERNAME', 'STEAM_PASSWORD', 'STEAM_SHARED_SECRET', 'STEAM_IDENTITY_SECRET', 'BOT_TRADE_URL', 'SITE_NAME'].includes(v) && !process.env[v];
});


if (missingVars.length > 0) {
    console.error(`FATAL: Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1);
}
if (!isBotConfigured) {
    console.warn("WARN: Steam Bot credentials/config incomplete or STEAM_IDENTITY_SECRET missing in .env file. Trading features will be disabled.");
}


const RUST_APP_ID = 252490;
const RUST_CONTEXT_ID = 2;
const ROUND_DURATION = parseInt(process.env.ROUND_DURATION_SECONDS) || 90; // Default 90s
const TICKET_VALUE_RATIO = parseFloat(process.env.TICKET_VALUE) || 0.01; // 1 ticket per $0.01
const PRICE_CACHE_TTL_SECONDS = parseInt(process.env.PRICE_CACHE_TTL_SECONDS) || 15 * 60; // 15 minutes
const PRICE_REFRESH_INTERVAL_MS = (parseInt(process.env.PRICE_REFRESH_MINUTES) || 10) * 60 * 1000; // 10 minutes
const MIN_ITEM_VALUE = parseFloat(process.env.MIN_ITEM_VALUE) || 0.05; // Min value for an item to be depositable
const PRICE_FETCH_TIMEOUT_MS = parseInt(process.env.PRICE_FETCH_TIMEOUT_MS) || 15000; // 15 seconds for price API
const MAX_PARTICIPANTS = parseInt(process.env.MAX_PARTICIPANTS) || 50; // Max participants per round
const MAX_ITEMS_PER_POT = parseInt(process.env.MAX_ITEMS_PER_POT) || 250; // Max items in a single pot
const MAX_ITEMS_PER_DEPOSIT = parseInt(process.env.MAX_ITEMS_PER_DEPOSIT) || 15; // Limit items per single deposit trade
const TAX_MIN_PERCENT = parseFloat(process.env.TAX_MIN_PERCENT) || 5; // Min tax percentage (e.g., 5 for 5%)
const TAX_MAX_PERCENT = parseFloat(process.env.TAX_MAX_PERCENT) || 10; // Max tax percentage
const MIN_POT_FOR_TAX = parseFloat(process.env.MIN_POT_FOR_TAX) || 20; // Min pot value before tax is applied

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: process.env.SITE_URL || "http://localhost:3000", // Be specific in production
        methods: ["GET", "POST"],
        credentials: true
    }
});

// --- Security Middleware ---
// Helmet helps secure Express apps by setting various HTTP headers.
app.set('trust proxy', 1); // Trust first proxy for rate limiting, IP determination if behind one
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "default-src": ["'self'"],
            "script-src": [
                "'self'",
                "/socket.io/socket.io.js", // Socket.IO client
                // If you use inline scripts for specific, small, controlled things and can't move them:
                // "'unsafe-inline'", // Review carefully if this is needed.
                // For specific CDNs if absolutely necessary:
                // "https://cdnjs.cloudflare.com"
            ],
            "script-src-attr": ["'unsafe-inline'"], // For inline event handlers like onclick, consider refactoring to JS files
            "style-src": ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com", "'unsafe-inline'"], // unsafe-inline for styles is less risky but ideally refactor
            "img-src": ["'self'", "data:", "*.steamstatic.com", "*.akamai.steamstatic.com"], // For Steam avatars
            "font-src": ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"], // For Font Awesome & Google Fonts
            "connect-src": (() => {
                const sources = ["'self'", "https://rust.scmm.app"]; // SCMM for pricing
                const siteUrl = process.env.SITE_URL;
                if (siteUrl) {
                    try {
                        const url = new URL(siteUrl);
                        // Websocket connections for Socket.IO
                        sources.push(`ws://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(`wss://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(siteUrl); // Allow connections TO the site URL itself for API calls
                    } catch (e) {
                        console.error("CSP_ERROR: Invalid SITE_URL for CSP connect-src:", siteUrl, e);
                    }
                } else {
                    // Fallback for local development if SITE_URL is not set
                    sources.push('ws://localhost:3000');
                    sources.push('wss://localhost:3000');
                }
                return sources;
            })(),
            "frame-src": ["'self'", "https://steamcommunity.com"], // If you embed Steam trade offer windows
            "frame-ancestors": ["'self'"], // Disallow site from being iframed by others, except self
            "object-src": ["'none'"], // Disallow <object>, <embed>, <applet>
            "upgrade-insecure-requests": process.env.NODE_ENV === 'production' ? [] : [], // Enable in prod if SSL is setup
        },
    },
    hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false, // Enable HSTS in production
    frameguard: { action: 'deny' }, // Disallow site from being iframed to prevent clickjacking
    xContentTypeOptions: true, // Prevents MIME-sniffing
    xDnsPrefetchControl: { allow: false }, // Disable DNS prefetching
    xDownloadOptions: true, // For IE8+ to prevent 'Open' of file downloads
    xFrameOptions: { action: 'deny' }, // Same as frameguard
    xPoweredBy: false, // Remove X-Powered-By header
    xXssProtection: true, // Enable XSS protection (though modern browsers have their own)
}));


// Rate Limiting Setup
const generalApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many API requests from this IP, please try again after 15 minutes.' } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 7, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts from this IP, please try again after 15 minutes.' } });
const sensitiveActionLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests for this action, please try again after 10 minutes.' } });
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many deposit attempts, please wait a minute.' } });

// Apply general limiter to API routes (more specific limiters can override this per-route)
app.use('/api/', generalApiLimiter);

// Configure middleware
app.use(cors({
    origin: process.env.SITE_URL || "http://localhost:3000", // Be specific in production
    credentials: true
}));
app.use(bodyParser.json({ limit: '500kb' })); // Limit payload size
app.use(bodyParser.urlencoded({ extended: true, limit: '500kb' }));
app.use(express.static('public'));

// Session Configuration
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        ttl: 14 * 24 * 60 * 60, // 14 days session TTL in seconds
        autoRemove: 'native', // Default, uses MongoDB's TTL indexing
        touchAfter: 24 * 3600 // time period in seconds to touch session (optional)
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24, // 24 hours session cookie
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax', // CSRF protection
        // domain: process.env.NODE_ENV === 'production' ? new URL(process.env.SITE_URL).hostname : undefined // Set domain in production
    }
}));
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
                username: profile.displayName,
                avatar: profile._json.avatarfull || '',
            };
            const user = await User.findOneAndUpdate(
                { steamId: profile.id },
                {
                    $set: userData,
                    $setOnInsert: {
                        steamId: profile.id,
                        tradeUrl: '',
                        createdAt: new Date(),
                        totalDeposited: 0, // Initialize new fields
                        totalWon: 0,
                        wins: 0,
                        pendingDepositOfferId: null
                    }
                },
                { new: true, upsert: true, runValidators: true }
            );
            // console.log(`User login/update: ${user.username} (ID: ${user.steamId})`);
            return done(null, user);
        } catch (err) {
            console.error('Steam Strategy Error:', { message: err.message, stack: err.stack, steamProfileId: profile?.id });
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
        console.error("DeserializeUser Error:", { message: err.message, stack: err.stack, userId: id });
        done(err);
    }
});

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGODB_URI, {
    // useNewUrlParser: true, // no longer needed
    // useUnifiedTopology: true, // no longer needed
    // useCreateIndex: true, // no longer needed
    // useFindAndModify: false, // no longer needed
    autoIndex: process.env.NODE_ENV !== 'production', // Disable autoIndex in production for performance
    serverSelectionTimeoutMS: 5000 // Timeout after 5s instead of 30s
})
    .then(() => console.log('Successfully connected to MongoDB.'))
    .catch(err => {
        console.error('MongoDB Connection Error:', { message: err.message, stack: err.stack });
        process.exit(1); // Exit if DB connection fails on startup
    });

// --- MongoDB Schemas ---
const userSchema = new mongoose.Schema({
    steamId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    avatar: { type: String },
    tradeUrl: {
        type: String,
        default: '',
        // More robust validation in the route handler; this is a basic schema check
        validate: {
            validator: function (v) {
                if (v === '') return true; // Allow empty string
                return /^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/.test(v);
            },
            message: props => `${props.value} is not a valid Steam Trade URL format.`
        }
    },
    balance: { type: Number, default: 0, min: 0 }, // Not used by jackpot, but can be for other games
    totalDeposited: { type: Number, default: 0, min: 0, index: true }, // ADDED
    totalWon: { type: Number, default: 0, min: 0, index: true },       // ADDED
    wins: { type: Number, default: 0, min: 0 },                  // ADDED
    createdAt: { type: Date, default: Date.now },
    banned: { type: Boolean, default: false, index: true },
    pendingDepositOfferId: { type: String, default: null, index: true }
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
    serverSeedHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, index: true },
    clientSeed: { type: String, match: /^[a-f0-9]+$/ },
    provableHash: { type: String, match: /^[a-f0-9]{64}$/ },
    taxAmount: { type: Number, default: 0, min: 0 },
    taxedItems: [{
        assetId: String,
        name: String,
        price: { type: Number, min: 0 }
    }]
});
roundSchema.index({ 'participants.user': 1 });
roundSchema.index({ status: 1, startTime: -1 }); // For finding current/recent rounds

const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);

// --- Steam Bot Setup ---
const community = new SteamCommunity();
const manager = new TradeOfferManager({
    steam: community,
    domain: process.env.SITE_URL ? new URL(process.env.SITE_URL).hostname : 'localhost', // Use hostname only
    language: 'en',
    pollInterval: parseInt(process.env.STEAM_POLL_INTERVAL) || 8000, // Default 8s
    cancelTime: (parseInt(process.env.STEAM_OFFER_CANCEL_MINUTES) || 10) * 60 * 1000, // Cancel deposit offers after X mins
    // acceptEscrowTrades: true, // Consider if you want to accept escrowed trades - might complicate item management
});
let isBotReady = false;
const pendingDeposits = new Map();

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
        community.login(loginCredentials, (err, sessionID, cookies, steamguard, oAuthToken) => { // Added oAuthToken
            if (err || !community.steamID) {
                console.error(`CRITICAL BOT LOGIN FAILURE: community.login callback failed or community.steamID undefined. Error: ${err ? err.message : 'N/A'}, SteamID: ${community.steamID}, EResult: ${err?.eresult}`);
                isBotReady = false;
                if (err?.eresult === 5) console.warn('Login Hint: Invalid Password or Account Name?');
                if (err?.eresult === 65 || err?.eresult === 84) console.warn('Login Hint: Incorrect 2FA Code (check Shared Secret/Server Time) or Account Rate Limit?');
                if (err?.eresult === 63) console.warn('Login Hint: Account Logon Denied - Check Email Auth/Steam Guard settings?');
                // Consider adding a retry mechanism with backoff for login failures
                return;
            }

            console.log(`Steam bot ${loginCredentials.accountName} logged in successfully (SteamID: ${community.steamID}). Setting cookies...`);
            manager.setCookies(cookies, process.env.STEAM_IDENTITY_SECRET, (setCookieErr) => { // Pass identitySecret here
                if (setCookieErr) {
                    console.error('TradeOfferManager Error setting cookies:', { error: setCookieErr.message, stack: setCookieErr.stack });
                    isBotReady = false;
                    return;
                }
                console.log('TradeOfferManager cookies & identity_secret set successfully.');
                community.setCookies(cookies); // Also for community actions

                // Set persona AFTER cookies are confirmed set
                community.gamesPlayed([RUST_APP_ID, process.env.SITE_NAME || 'RustyDegen']);
                community.setPersona(SteamCommunity.EPersonaState.Online);

                isBotReady = true;
                console.log("Steam Bot is fully ready and online.");
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

            // Handle web session to confirm trades if identity secret is used
            if (process.env.STEAM_IDENTITY_SECRET && oAuthToken) {
                 community.oAuthLogin(steamguard, oAuthToken, (err) => {
                     if (err) {
                         console.error('OAuth login for web session failed:', err);
                         // Bot might still work for some things, but trade confirmations might fail
                     } else {
                         console.log('OAuth web session established for confirmations.');
                     }
                 });
            }


        });
    } else {
        console.warn("Could not generate 2FA code for bot. Login skipped.");
        isBotReady = false;
    }
} else {
    console.warn("Steam Bot not configured. Trading features will be disabled.");
}

// --- Active Round Data ---
let currentRound = null;
let roundTimer = null;
let isRolling = false;

// --- Pricing Cache and Functions ---
const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false });

function getFallbackPrice(marketHashName) {
    // console.warn(`PRICE_INFO: Using fallback for: ${marketHashName}`);
    return MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0.01; // Ensure a tiny value if MIN_ITEM_VALUE is 0
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
                } else if (item?.name) {
                    // console.warn(`PRICE_WARN: Invalid price for '${item.name}'. SCMM Price: ${item.price}`);
                }
            });

            if (newItems.length > 0) {
                priceCache.mset(newItems);
                console.log(`PRICE_SUCCESS: Refreshed price cache with ${updatedCount} items.`);
            } else {
                console.warn("PRICE_WARN: No valid items found in SCMM price refresh.");
            }
        } else {
            console.error("PRICE_ERROR: Invalid or empty array from SCMM. Status:", response.status);
        }
    } catch (error) {
        console.error(`PRICE_ERROR: Failed to fetch prices from ${apiUrl}. Code: ${error.code}, Message: ${error.message}`);
        // Further error details can be logged if needed (error.response, error.request)
    }
}

function getItemPrice(marketHashName) {
    if (typeof marketHashName !== 'string' || marketHashName.length === 0) return 0;
    const cachedPrice = priceCache.get(marketHashName);
    return cachedPrice !== undefined ? cachedPrice : getFallbackPrice(marketHashName);
}

// --- Core Game Logic ---
async function createNewRound() {
    if (isRolling) {
        console.log("Cannot create new round: Current round is rolling.");
        return null;
    }
    if (currentRound && currentRound.status === 'active') {
        console.log(`Cannot create new round: Round ${currentRound.roundId} is already active.`);
        return currentRound; // Return the existing active round object
    }

    try {
        isRolling = false;
        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
        const lastRound = await Round.findOne().sort({ roundId: -1 }); // Ensure sorting by roundId
        const nextRoundId = lastRound ? lastRound.roundId + 1 : 1;

        const newRoundDoc = new Round({
            roundId: nextRoundId,
            status: 'active',
            startTime: new Date(),
            serverSeed: serverSeed,
            serverSeedHash: serverSeedHash,
            items: [],
            participants: [],
            totalValue: 0
        });

        await newRoundDoc.save();
        currentRound = newRoundDoc.toObject({ virtuals: true }); // Use toObject for plain JS object, include virtuals if any

        io.emit('roundCreated', {
            roundId: currentRound.roundId,
            serverSeedHash: currentRound.serverSeedHash,
            timeLeft: ROUND_DURATION,
            totalValue: 0,
            participants: [],
            items: []
        });
        console.log(`--- Round ${currentRound.roundId} created and active (ServerSeedHash: ${currentRound.serverSeedHash}) ---`);
        return currentRound;
    } catch (err) {
        console.error('FATAL: Error creating new round:', { message: err.message, stack: err.stack });
        setTimeout(createNewRound, 10000); // Retry after 10 seconds
        return null;
    }
}

async function ensureInitialRound() {
    if (!isBotConfigured || !isBotReady) {
        console.log(`Bot not ready (Configured: ${isBotConfigured}, Ready: ${isBotReady}), skipping initial round check.`);
        return;
    }
    if (currentRound) return; // Already have a round in memory

    try {
        const existingActiveOrRolling = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
            .sort({ startTime: -1 }) // Get the latest one
            .populate('participants.user', 'steamId username avatar')
            .populate('items')
            .populate('winner', 'steamId username avatar') // Populate winner for rolling/completed rounds
            .lean();

        if (existingActiveOrRolling) {
            console.log(`Found existing round ${existingActiveOrRolling.roundId} (Status: ${existingActiveOrRolling.status}) on startup.`);
            currentRound = existingActiveOrRolling;

            if (currentRound.status === 'rolling') {
                console.log(`Round ${currentRound.roundId} was rolling. Attempting to re-finalize.`);
                // If it was rolling, it might mean the server crashed mid-roll.
                // We should try to re-process the endRound logic.
                // This needs careful handling to avoid double payouts.
                // For now, let's assume endRound can handle it or it will be manually resolved.
                // Or, we could try to re-trigger endRound if we're sure about its idempotency.
                // For safety, we might just let it be and schedule a new round.
                isRolling = false; // Reset rolling flag
                setTimeout(createNewRound, 5000); // Start a new round
                return;
            }

            if (currentRound.status === 'active' || currentRound.status === 'pending') {
                 if (currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                    startRoundTimer(true);
                } else if (currentRound.participants.length > 0 && !currentRound.endTime && !roundTimer) {
                    console.warn(`Active round ${currentRound.roundId} found without endTime and has participants. Starting timer now.`);
                    startRoundTimer(false);
                } else if (currentRound.participants.length === 0 && currentRound.status === 'active') {
                    console.log(`Round ${currentRound.roundId} is active but has no participants. Waiting for first deposit to start timer.`);
                }
                 // Emit the current state to newly connected clients
                io.emit('roundData', formatRoundForClient(currentRound));
            }

        } else {
            console.log("No active/pending round found, creating initial round...");
            await createNewRound();
        }
    } catch (dbErr) {
        console.error("DB_ERROR: Error ensuring initial round:", { message: dbErr.message, stack: dbErr.stack });
    }
}

function startRoundTimer(useRemainingTime = false) {
    if (roundTimer) clearInterval(roundTimer);
    if (!currentRound || currentRound.status !== 'active') {
        console.warn("TIMER_WARN: Cannot start timer: No active round or round status invalid.");
        return;
    }

    let timeLeft;
    let calculatedEndTime;

    if (useRemainingTime && currentRound.endTime) {
        calculatedEndTime = new Date(currentRound.endTime);
        timeLeft = Math.max(0, Math.floor((calculatedEndTime.getTime() - Date.now()) / 1000));
        console.log(`TIMER_INFO: Resuming timer for round ${currentRound.roundId} with ${timeLeft}s remaining.`);
    } else {
        timeLeft = ROUND_DURATION;
        calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
        currentRound.endTime = calculatedEndTime;
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
            .catch(e => console.error(`DB_ERROR: Error saving round end time for round ${currentRound?.roundId}:`, e));
        console.log(`TIMER_INFO: Starting timer for round ${currentRound.roundId} (${ROUND_DURATION}s). End time: ${calculatedEndTime.toISOString()}`);
    }
    currentRound.timeLeft = timeLeft; // Keep timeLeft in currentRound object in sync

    io.emit('timerUpdate', { timeLeft });

    roundTimer = setInterval(async () => {
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) {
            clearInterval(roundTimer); roundTimer = null;
            console.warn("TIMER_WARN: Timer stopped: Round state became invalid.");
            return;
        }
        const now = Date.now();
        let currenttimeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - now) / 1000));
        currentRound.timeLeft = currenttimeLeft; // Update in-memory state

        io.emit('timerUpdate', { timeLeft: currenttimeLeft });
        if (currenttimeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null;
            console.log(`TIMER_INFO: Round ${currentRound.roundId} timer reached zero.`);
            await endRound();
        }
    }, 1000);
}
// ... (The rest of your app.js will go here in the next step)

// (Code from the first half would be here)
// ...
// --- Core Game Logic (Continued from first half) ---

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
    const roundMongoId = currentRound._id; // Assuming _id is present in currentRound
    console.log(`--- Ending round ${roundIdToEnd}... ---`);

    try {
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } });
        io.emit('roundRolling', { roundId: roundIdToEnd });

        const round = await Round.findById(roundMongoId)
            .populate('participants.user') // Populate with all user fields needed, including tradeUrl
            .populate('items')
            .lean();

        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);
        if (round.status !== 'rolling') {
             console.warn(`Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Aborting endRound.`);
             isRolling = false; return;
           }
        currentRound = round; // Update in-memory state with the fully populated lean object

        // --- Handle Empty Round ---
        if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            console.log(`Round ${round.roundId} ended with no valid participants or value.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date(), clientSeed: crypto.randomBytes(16).toString('hex') } }); // Add a client seed for empty rounds for consistency
            io.emit('roundCompleted', {
                roundId: round.roundId,
                message: "No participants.",
                serverSeedHash: round.serverSeedHash, // Send hash even for empty rounds
                serverSeed: round.serverSeed, // Reveal server seed
                clientSeed: round.clientSeed || 'N/A-EmptyRound',
                provableHash: round.provableHash || 'N/A-EmptyRound'
            });
            isRolling = false;
            setTimeout(createNewRound, 5000); // Start new round after a short delay
            return;
        }

        // --- Tax Calculation ---
        let finalItems = [...round.items]; // Use a copy to modify
        let potValueForWinner = round.totalValue;
        let taxAmount = 0;
        let taxedItemsInfo = [];
        let itemsToTakeForTaxIds = new Set(); // Use a Set for efficient ID checking

        if (potValueForWinner >= MIN_POT_FOR_TAX) {
            const taxPercentage = Math.max(TAX_MIN_PERCENT, Math.min(TAX_MAX_PERCENT, parseFloat(process.env.SITE_TAX_PERCENT) || TAX_MIN_PERCENT)) / 100;
            const targetTaxValue = potValueForWinner * taxPercentage;
            console.log(`Calculating tax for round ${round.roundId}: Target ${taxPercentage*100}% of $${potValueForWinner.toFixed(2)} = $${targetTaxValue.toFixed(2)}`);

            const sortedItemsForTax = [...finalItems].sort((a, b) => a.price - b.price); // Sort by price ascending
            let currentTaxCollected = 0;

            for (const item of sortedItemsForTax) {
                if (currentTaxCollected + item.price <= targetTaxValue + 0.50) { // Allow slight overshoot to get closer
                    itemsToTakeForTaxIds.add(item._id.toString());
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price });
                    currentTaxCollected += item.price;
                } else if (itemsToTakeForTaxIds.size === 0 && sortedItemsForTax.length === 1 && item.price > targetTaxValue) {
                    // If only one item and it's > target tax, but pot is taxable, take it if it's not excessively over the max tax.
                    // This prevents scenarios where a single high-value item avoids tax entirely in a taxable pot.
                    const maxTaxValueThreshold = potValueForWinner * (TAX_MAX_PERCENT / 100) * 1.5; // e.g., allow taking item if it's up to 1.5x the max tax % value
                    if (item.price <= maxTaxValueThreshold) {
                        itemsToTakeForTaxIds.add(item._id.toString());
                        taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price });
                        currentTaxCollected += item.price;
                    }
                    break; // Stop after considering the single item
                } else if (itemsToTakeForTaxIds.size > 0 && currentTaxCollected >= targetTaxValue) {
                    break; // Stop if we've met or slightly exceeded the target
                }
            }
            if (itemsToTakeForTaxIds.size > 0) {
                finalItems = finalItems.filter(item => !itemsToTakeForTaxIds.has(item._id.toString()));
                taxAmount = currentTaxCollected;
                potValueForWinner = Math.max(0, round.totalValue - taxAmount); // Recalculate winner's pot value
                console.log(`Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${taxedItemsInfo.length} items). New Pot Value for Winner: $${potValueForWinner.toFixed(2)}`);
            } else {
                console.log(`No suitable items found for tax in round ${round.roundId}. Tax Amount: $0.00`);
            }
        } else {
            console.log(`Pot value $${potValueForWinner.toFixed(2)} below MIN_POT_FOR_TAX ($${MIN_POT_FOR_TAX}). No tax applied for round ${round.roundId}.`);
        }

        // --- Winner Calculation (Provably Fair) ---
        const clientSeed = crypto.randomBytes(16).toString('hex'); // Generate client seed now
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16); // More reliable for full range

        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);
        if (totalTickets <= 0) {
            console.error(`CRITICAL_ERROR: Cannot determine winner: Total tickets is zero or invalid for round ${round.roundId}. Participants:`, round.participants);
            // This state should ideally not be reached if empty rounds are handled.
            // Mark round as error and start new one.
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', completedTime: new Date(), clientSeed: clientSeed, provableHash: provableHash, error_message: 'Zero total tickets' } });
            io.emit('roundError', { roundId: round.roundId, error: 'Internal error: Zero tickets.' });
            isRolling = false;
            setTimeout(createNewRound, 5000);
            return;
        }
        const winningTicket = decimalFromHash % totalTickets;

        let cumulativeTickets = 0;
        let winnerData = null; // Store the full participant object of the winner

        for (const participant of round.participants) {
            if (!participant?.user || typeof participant.tickets !== 'number' || participant.tickets <= 0) continue; // Skip if no user or invalid tickets
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winnerData = participant; // participant.user is already populated
                break;
            }
        }
        if (!winnerData || !winnerData.user) {
            console.error(`CRITICAL_ERROR: Winner selection failed for round ${round.roundId}. Winning Ticket: ${winningTicket}, Total Tickets: ${totalTickets}. Participants: `, round.participants);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', completedTime: new Date(), clientSeed: clientSeed, provableHash: provableHash, error_message: 'Winner selection failed' } });
            io.emit('roundError', { roundId: round.roundId, error: 'Internal error: Winner selection failed.' });
            isRolling = false;
            setTimeout(createNewRound, 5000);
            return;
        }

        const winnerUser = winnerData.user; // This is the populated user object

        // --- Update User Stats for Winner ---
        try {
            const valueWon = potValueForWinner; // Value after tax
            await User.findByIdAndUpdate(winnerUser._id, {
                $inc: { totalWon: valueWon, wins: 1 }
            });
            console.log(`STATS_UPDATE: User ${winnerUser.username} won $${valueWon.toFixed(2)}. Wins incremented.`);
        } catch (statErr) {
            console.error(`STATS_ERROR: Failed to update winner stats for ${winnerUser.username} (Round ${round.roundId}):`, statErr);
            // Non-critical for round progression, but should be monitored.
        }


        // --- Prepare Final Database Update ---
        const finalUpdateData = {
            status: 'completed', completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winnerUser._id, // Store winner's ObjectId
            taxAmount: taxAmount, taxedItems: taxedItemsInfo,
            totalValue: round.totalValue, // Store original total value before tax
            potValueAfterTax: potValueForWinner, // Store value for winner
            items: finalItems.map(i => i._id)
        };
        await Round.updateOne({ _id: roundMongoId }, { $set: finalUpdateData });
        console.log(`Round ${round.roundId} completed. Winner: ${winnerUser.username} (Ticket: ${winningTicket}/${totalTickets}, Value Won: $${potValueForWinner.toFixed(2)})`);

        // Emit winner information (ensure winnerUser has necessary fields like steamId if used by client)
        io.emit('roundWinner', {
            roundId: round.roundId,
            winner: {
                _id: winnerUser._id, // Send MongoDB ID
                steamId: winnerUser.steamId,
                username: winnerUser.username,
                avatar: winnerUser.avatar
            },
            winningTicket: winningTicket,
            totalValue: potValueForWinner, // Send the value the winner actually gets
            totalTickets: totalTickets,
            serverSeed: round.serverSeed, // Reveal server seed
            clientSeed: clientSeed,
            provableHash: provableHash,
            serverSeedHash: round.serverSeedHash // Original hash for verification
        });

        // --- Initiate Payout ---
        await sendWinningTradeOffer(round, winnerUser, finalItems); // Pass the populated winnerUser

    } catch (err) {
        console.error(`CRITICAL ERROR during endRound for round ${roundIdToEnd}:`, { message: err.message, stack: err.stack, roundData: currentRound }); // Log more context
        try {
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', completedTime: new Date(), error_message: err.message } });
            io.emit('roundError', { roundId: roundIdToEnd, error: 'Internal server error during round finalization.' });
        } catch (saveErr) {
            console.error(`Failed to mark round ${roundIdToEnd} as error after initial error:`, saveErr);
        }
    } finally {
        isRolling = false;
        console.log(`SCHEDULING_INFO: Scheduling next round creation after round ${roundIdToEnd} finalization.`);
        setTimeout(createNewRound, 10000); // Delay before creating new round
    }
}

/**
 * Sends the winning trade offer to the winner.
 * @param {object} round - The completed Round lean object (from DB).
 * @param {object} winnerUser - The populated User lean object for the winner.
 * @param {Array} itemsToSend - Array of lean Item objects to send (after tax).
 */
async function sendWinningTradeOffer(round, winnerUser, itemsToSend) {
    if (!isBotConfigured || !isBotReady) {
        console.error(`PAYOUT_ERROR: Bot not ready. Cannot send winnings for round ${round.roundId} to ${winnerUser.username}.`);
        io.to(winnerUser._id.toString()).emit('notification', { type: 'error', message: `Bot Error: Payout for round ${round.roundId} requires manual processing. Contact support.` });
        return;
    }
    if (!winnerUser.tradeUrl) {
        console.error(`PAYOUT_ERROR: Winner ${winnerUser.username} (Round ${round.roundId}) has no Trade URL set.`);
        io.to(winnerUser._id.toString()).emit('notification', { type: 'error', message: 'Please set your Trade URL in your profile to receive winnings.' });
        return;
    }
    if (!itemsToSend || itemsToSend.length === 0) {
        console.log(`PAYOUT_INFO: No items to send for round ${round.roundId} (Pot Value: $${(round.potValueAfterTax || 0).toFixed(2)}, Tax: $${(round.taxAmount || 0).toFixed(2)}).`);
        if (round.taxAmount > 0 && (round.potValueAfterTax || 0) <= 0) {
            io.to(winnerUser._id.toString()).emit('notification', { type: 'info', message: `Winnings for round ${round.roundId} ($${(round.taxAmount || 0).toFixed(2)}) were processed as site tax.` });
        }
        return;
    }

    console.log(`PAYOUT_ATTEMPT: Attempting to send ${itemsToSend.length} winning items (Value: $${(round.potValueAfterTax || 0).toFixed(2)}) for round ${round.roundId} to ${winnerUser.username}...`);

    try {
        const offer = manager.createOffer(winnerUser.tradeUrl);
        offer.addMyItems(itemsToSend.map(item => ({
            assetid: item.assetId,
            appid: RUST_APP_ID,
            contextid: RUST_CONTEXT_ID
        })));
        offer.setMessage(`Congratulations! Your winnings from Round #${round.roundId} on ${process.env.SITE_NAME || 'RustyDegen'}. Pot Value (after tax): $${(round.potValueAfterTax || 0).toFixed(2)}`);

        const identitySecret = process.env.STEAM_IDENTITY_SECRET; // Already checked in isBotConfigured
        // steam-tradeoffer-manager handles auto-confirmation if identitySecret was passed to setCookies
        offer.send((err, status) => {
            if (err) {
                console.error(`PAYOUT_SEND_ERROR: Offer ${offer.id} for round ${round.roundId} to ${winnerUser.username}. EResult: ${err.eresult}, Message: ${err.message}`);
                let userMessage = 'Error sending winnings. Please contact support.';
                if (err.message?.includes('revoked') || err.message?.includes('invalid') || err.eresult === 26 || err.eresult === 15) { // 15 = Access Denied (often bad trade token/URL)
                    userMessage = 'Your Trade URL is invalid, private, or expired. Please update it and contact support for your winnings.';
                } else if (err.eresult === 16) { // Target cannot receive (inventory full/private)
                    userMessage = "Could not send winnings. Your Steam inventory might be full or private. Please check and contact support.";
                } else if (err.message?.includes('escrow') || err.eresult === 11 || status === 'pendingConfirmation') {
                    userMessage = `Winnings sent (Offer #${offer.id}), but may be held in escrow or require mobile confirmation. Check Steam.`;
                     io.to(winnerUser._id.toString()).emit('notification', { type: 'warning', message: userMessage, offerId: offer.id, offerURL: `https://steamcommunity.com/tradeoffer/${offer.id}/` });
                    // Even with escrow, still emit tradeOfferSent
                } else {
                     io.to(winnerUser._id.toString()).emit('notification', { type: 'error', message: userMessage });
                }
                // TODO: Implement a robust retry/manual intervention queue for persistent failed payouts
                return;
            }

            console.log(`PAYOUT_SENT: Trade offer ${offer.id} sent to ${winnerUser.username} for round ${round.roundId}. Status: ${status}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;
            io.to(winnerUser._id.toString()).emit('tradeOfferSent', { // Emit specifically to the winner's socket if possible
                roundId: round.roundId,
                offerId: offer.id,
                offerURL: offerURL,
                status: status
            });

            if (status === 'pendingConfirmation') { // Explicitly handle this status from TOM
                console.warn(`PAYOUT_CONFIRM_PENDING: Offer #${offer.id} (Round ${round.roundId}) requires mobile confirmation.`);
                io.to(winnerUser._id.toString()).emit('notification', { type: 'warning', message: `Winnings sent (Offer #${offer.id}), but require confirmation in your Steam Mobile Authenticator.`, offerId: offer.id, offerURL });
            }
        });

    } catch (createErr) {
        console.error(`PAYOUT_CREATE_ERROR: Failed to create trade offer for round ${round.roundId} to ${winnerUser.username}:`, createErr);
        io.to(winnerUser._id.toString()).emit('notification', { type: 'error', message: 'Error creating winnings trade offer. Please contact support.' });
    }
}


// --- Authentication Routes ---
app.get('/auth/steam', authLimiter, passport.authenticate('steam', { failureRedirect: '/' }));
app.get('/auth/steam/return',
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => {
        // On successful login, redirect to where the user was, or home.
        // req.session.returnTo is a common pattern but needs to be set before redirecting to /auth/steam
        const returnTo = req.session.returnTo || '/';
        delete req.session.returnTo;
        res.redirect(returnTo);
    }
);

app.post('/logout', (req, res, next) => {
    req.logout(err => {
        if (err) {
            console.error("Logout error (passport):", err);
            return next(err); // Pass to error handler
        }
        req.session.destroy(err => {
            if (err) {
                console.error("Error destroying session during logout:", err);
                return res.status(500).json({ error: 'Logout failed to destroy session.' });
            }
            res.clearCookie('connect.sid', { path: '/' }); // Ensure path matches how it was set
            console.log("User logged out, session destroyed, cookie cleared.");
            res.status(200).json({ success: true, message: "Logged out successfully." });
        });
    });
});


// --- Middleware & API Routes ---
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) { return next(); }
    // If AJAX request, send 401, otherwise redirect to login page (or home with prompt)
    if (req.xhr || req.headers.accept?.includes('json')) {
        return res.status(401).json({ error: 'Not authenticated. Please log in.' });
    }
    // Store the original URL they were trying to access
    // req.session.returnTo = req.originalUrl; // Be careful with this if it creates open redirect vulnerabilities
    res.redirect('/'); // Or a dedicated login page
}

const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.warn("Validation Errors:", { errors: errors.array(), path: req.path, body: req.body, query: req.query });
        return res.status(400).json({ error: errors.array({ onlyFirstError: true })[0].msg }); // Send only the first error message
    }
    next();
};

// GET User Profile (already updated in first half)
app.get('/api/user', ensureAuthenticated, (req, res) => {
    const { _id, steamId, username, avatar, tradeUrl, balance, createdAt, pendingDepositOfferId, totalDeposited, totalWon, wins } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, balance, createdAt, pendingDepositOfferId, totalDeposited, totalWon, wins });
});


app.post('/api/user/tradeurl',
    sensitiveActionLimiter,
    ensureAuthenticated,
    [
        body('tradeUrl')
            .trim()
            .custom((value) => {
                if (value === '') return true; // Allow empty string to clear
                const urlPattern = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/;
                if (!urlPattern.test(value)) {
                    throw new Error('Invalid Steam Trade URL format. Must include partner and token, or be empty.');
                }
                // Additional check: Ensure the partner ID in the trade URL matches the logged-in user's Steam ID's account ID part.
                // This is an advanced check and might be complex to implement correctly without SteamID library on backend.
                // For now, format check is good.
                return true;
            })
    ],
    handleValidationErrors,
    async (req, res) => {
        const { tradeUrl } = req.body;
        try {
            // We might want to re-fetch the user here to avoid race conditions if the user object in req.user is stale
            const user = await User.findById(req.user._id);
            if (!user) {
                return res.status(404).json({ error: 'User not found.' });
            }
            user.tradeUrl = tradeUrl;
            await user.save(); // This will run schema validators
            console.log(`Trade URL updated for user: ${user.username} to "${tradeUrl}"`);
            res.json({ success: true, tradeUrl: user.tradeUrl });
        } catch (err) {
            if (err.name === 'ValidationError') {
                console.warn(`Trade URL Mongoose Validation Error for user ${req.user?._id}:`, err.message);
                return res.status(400).json({ error: err.errors?.tradeUrl?.message || err.message });
            }
            console.error(`Error updating trade URL for user ${req.user?._id}:`, err);
            res.status(500).json({ error: 'Server error saving Trade URL.' });
        }
    }
);

app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    if (!isBotConfigured || !isBotReady) {
        console.warn(`Inventory fetch failed for ${req.user.username}: Bot service unavailable.`);
        return res.status(503).json({ error: "Steam service temporarily unavailable. Please try again later." });
    }
    try {
        const inventory = await new Promise((resolve, reject) => {
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv, currency) => { // currency can be ignored
                if (err) {
                    if (err.message?.includes('profile is private') || err.eresult === 15) { // EResult 15 is Access Denied
                        return reject(new Error('Your Steam inventory is private. Please set it to public in your Steam profile privacy settings.'));
                    }
                    console.error(`Inventory Fetch Error (Manager) for ${req.user.steamId}: EResult ${err.eresult}, Msg: ${err.message || err}`);
                    return reject(new Error(`Could not fetch your inventory (EResult: ${err.eresult || 'Unknown'}). Steam might be busy or inventory private.`));
                }
                resolve(inv || []);
            });
        });

        // console.log(`Raw inventory items count for ${req.user.username}: ${inventory?.length}`);
        if (!inventory?.length) return res.json([]);

        const validItems = inventory
            .map(item => {
                const itemName = item.market_hash_name;
                let price = 0;
                if (itemName) price = getItemPrice(itemName);
                // else console.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`);

                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

                if (!item.assetid || !item.icon_url || !itemName) {
                    // console.warn(`Inventory item missing required properties: assetId ${item?.assetid}, Name ${itemName}, Icon ${item?.icon_url}`);
                    return null;
                }
                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`;
                return {
                    assetId: item.assetid, name: itemName, displayName: item.name, image: imageUrl,
                    price: finalPrice, tradable: item.tradable, marketable: item.marketable
                };
            })
            .filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE && item.name); // Ensure name exists and is tradable + meets min value

        // console.log(`Processed validItems count for ${req.user.username}: ${validItems.length}`);
        res.json(validItems);

    } catch (err) {
        console.error(`Error in /api/inventory for ${req.user?.username || req.user?.steamId}:`, err.message);
        res.status(500).json({ error: err.message || 'Server error fetching inventory.' });
    }
});

// POST Initiate Deposit Request
app.post('/api/deposit',
    depositLimiter,
    ensureAuthenticated,
    [
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`You can deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.').escape() // Added escape
    ],
    handleValidationErrors,
    async (req, res) => {
        const user = req.user; // User object (Mongoose document)
        const requestedAssetIds = req.body.assetIds;

        if (!isBotConfigured || !isBotReady) return res.status(503).json({ error: "Deposit service temporarily unavailable (Bot offline)." });
        if (!user.tradeUrl) return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile before depositing.' });

        // Re-fetch user to get the latest pendingDepositOfferId to prevent race conditions
        const freshUser = await User.findById(user._id).lean(); // Use lean for quick read
        if (!freshUser) return res.status(404).json({ error: "User not found."});

        if (freshUser.pendingDepositOfferId) {
            try {
                const offer = await manager.getOffer(freshUser.pendingDepositOfferId);
                if (offer && [TradeOfferManager.ETradeOfferState.Active, TradeOfferManager.ETradeOfferState.Sent, TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation].includes(offer.state)) {
                    console.log(`User ${user.username} already has active pending deposit offer ${freshUser.pendingDepositOfferId}. State: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
                    const offerURL = `https://steamcommunity.com/tradeoffer/${freshUser.pendingDepositOfferId}/`;
                    return res.status(409).json({
                        error: 'You already have an active deposit offer. Please accept or decline it on Steam.',
                        offerId: freshUser.pendingDepositOfferId, offerURL: offerURL
                    });
                } else {
                    console.log(`Clearing stale pending offer ${freshUser.pendingDepositOfferId} for ${user.username} (State: ${TradeOfferManager.ETradeOfferState[offer?.state]}).`);
                    await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }); // Update actual user doc
                }
            } catch (offerFetchError) {
                console.warn(`Could not fetch pending offer ${freshUser.pendingDepositOfferId} for ${user.username}, clearing flag:`, offerFetchError.message);
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
            }
        }

        // Check Round Status and Limits
        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }
        // Fetch latest round data for limits check (again, to mitigate race conditions)
        let latestRoundData = await Round.findById(currentRound._id).select('participants items').lean();
        if (!latestRoundData) return res.status(500).json({ error: 'Could not fetch current round data.' });

        const isNewParticipant = !latestRoundData.participants.some(p => p.user?.toString() === user._id.toString());
        if (isNewParticipant && latestRoundData.participants.length >= MAX_PARTICIPANTS) {
            return res.status(400).json({ error: `Participant limit (${MAX_PARTICIPANTS}) reached.` });
        }
        if (latestRoundData.items.length + requestedAssetIds.length > MAX_ITEMS_PER_POT) {
            const slotsLeft = MAX_ITEMS_PER_POT - latestRoundData.items.length;
            return res.status(400).json({ error: `Depositing ${requestedAssetIds.length} items would exceed the pot limit (${MAX_ITEMS_PER_POT}). Only ${slotsLeft > 0 ? slotsLeft : 0} slots left.` });
        }

        let itemsToRequest = [];
        let depositTotalValue = 0;
        try {
            const userSteamInventory = await new Promise((resolve, reject) => { // Renamed to avoid conflict
                manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                    if (err) {
                        if (err.message?.includes('profile is private') || err.eresult === 15) return reject(new Error('Your Steam inventory is private. Please set it to public.'));
                        console.error(`Inventory Fetch Error (Deposit Attempt) for ${user.steamId}: EResult ${err.eresult}`, err);
                        return reject(new Error(`Could not fetch your inventory (EResult: ${err.eresult || 'Unknown'}). Steam might be busy or inventory private.`));
                    }
                    resolve(inv || []);
                });
            });

            const userInventoryMap = new Map(userSteamInventory.map(item => [item.assetid, item]));
            for (const assetId of requestedAssetIds) {
                const inventoryItem = userInventoryMap.get(assetId);
                if (!inventoryItem) throw new Error(`Item with Asset ID ${assetId} not found in your current Steam inventory or already in a trade.`);
                if (!inventoryItem.tradable) throw new Error(`Item '${inventoryItem.market_hash_name}' (ID: ${assetId}) is not tradable.`);
                const price = getItemPrice(inventoryItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) throw new Error(`Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below minimum value ($${MIN_ITEM_VALUE.toFixed(2)}).`);

                itemsToRequest.push({
                    assetid: inventoryItem.assetid, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID,
                    _price: price, _name: inventoryItem.market_hash_name, _image: `https://community.akamai.steamstatic.com/economy/image/${inventoryItem.icon_url}`
                });
                depositTotalValue += price;
            }
            if (itemsToRequest.length === 0) throw new Error("None of the selected items could be verified for deposit.");
            console.log(`DEPOSIT_VERIFY: Verified ${itemsToRequest.length} items for deposit for ${user.username}. Total Value: $${depositTotalValue.toFixed(2)}`);

        } catch (verificationError) {
            console.warn(`DEPOSIT_VERIFY_FAIL: User ${user.username}:`, verificationError.message);
            return res.status(400).json({ error: verificationError.message });
        }

        const depositId = uuidv4();
        const offerMessage = `${process.env.SITE_NAME || 'RustyDegen'} Deposit ID: ${depositId} | Round: ${currentRound.roundId}`;
        let cleanupTimeout = null;

        try {
            const offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsToRequest.map(({ assetid, appid, contextid }) => ({ assetid, appid, contextid })));
            offer.setMessage(offerMessage);

            pendingDeposits.set(depositId, {
                userId: user._id, roundId: currentRound._id, items: itemsToRequest,
                totalValue: depositTotalValue, steamId: user.steamId
            });
            console.log(`DEPOSIT_PENDING: Stored pending deposit ${depositId} for user ${user.steamId}. Offer to be sent.`);

            cleanupTimeout = setTimeout(async () => { // Make async
                if (pendingDeposits.has(depositId)) {
                    console.log(`DEPOSIT_EXPIRED: Deposit attempt ${depositId} (Offer ${offer?.id || 'N/A'}) expired. Cleaning up.`);
                    pendingDeposits.delete(depositId);
                    // Use findOneAndUpdate to ensure atomicity if possible, or at least log if user not found/already cleared
                    const updatedUser = await User.findOneAndUpdate(
                        { steamId: user.steamId, pendingDepositOfferId: offer?.id || 'expired_unknown_id' },
                        { $set: { pendingDepositOfferId: null } },
                        { new: true } // Optional: get the updated doc for logging
                    );
                    if (updatedUser) console.log(`DEPOSIT_EXPIRED: Cleared pendingDepositOfferId for user ${user.steamId} due to expiry.`);
                    else console.warn(`DEPOSIT_EXPIRED: User ${user.steamId} pendingDepositOfferId was not ${offer?.id || 'expired_unknown_id'} or user not found on expiry.`);
                }
            }, manager.cancelTime || 10 * 60 * 1000);


            const status = await new Promise((resolve, reject) => {
                offer.send((err, status) => {
                    if (err) return reject(err);
                    resolve(status);
                });
            });

            // IMPORTANT: Update user's pendingDepositOfferId *after* the offer is successfully sent by manager.
            // And ensure it's the offer.id from the sent offer object.
            await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: offer.id });
            console.log(`DEPOSIT_OFFER_SENT: Offer ${offer.id} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;
            res.json({
                success: true, message: 'Deposit offer created! Please accept it on Steam.',
                offerId: offer.id, offerURL: offerURL
            });

        } catch (error) {
            console.error(`DEPOSIT_SEND_FAIL: User ${user.username} (DepositID: ${depositId}): EResult ${error.eresult}, Msg: ${error.message}`);
            pendingDeposits.delete(depositId);
            if (cleanupTimeout) clearTimeout(cleanupTimeout);
            await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user flag on offer send fail:", e));

            let userMessage = 'Failed to create deposit trade offer. Please try again later.';
            if (error.message?.includes('unable to trade') || error.eresult === 25) { // EResult 25: LimitExceeded (Often trade ban / cooldown)
                 userMessage = `Steam Error: Your account may have a temporary trade restriction. Please check Steam. (${error.message})`;
            } else if (error.message?.includes('Trade URL') || error.message?.includes('token') || error.eresult === 26 || error.eresult === 15) {
                userMessage = 'Your Steam Trade URL might be invalid or expired. Please check it in your profile.';
            } else if (error.eresult) {
                userMessage += ` (Steam Error Code: ${error.eresult})`;
            }
            res.status(500).json({ error: userMessage });
        }
    });

// --- Trade Offer Manager Event Handling ---
if (isBotConfigured && manager) {
    manager.on('newOffer', async (offer) => {
        if (!isBotReady || offer.isOurOffer) return;
        console.log(`TRADE_RECEIVED: Incoming offer #${offer.id} from ${offer.partner.getSteamID64()}. ItemsToReceive: ${offer.itemsToReceive?.length}, ItemsToGive: ${offer.itemsToGive?.length}`);
        // Decline ALL unsolicited incoming offers
        try {
            await offer.decline();
            console.log(`TRADE_DECLINED: Declined unsolicited incoming offer #${offer.id} from ${offer.partner.getSteamID64()}.`);
        } catch (declineErr) {
            console.error(`TRADE_DECLINE_ERROR: Failed to decline unsolicited offer #${offer.id}:`, declineErr);
        }
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        if (offer.state !== oldState) {
            console.log(`BOT_OFFER_CHANGED: Offer #${offer.id} to ${offer.partner.getSteamID64()} (${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]}). Message: "${offer.message}"`);
        }

        if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
            const messageMatch = offer.message?.match(/Deposit ID: ([a-f0-9-]+)/i);
            const depositId = messageMatch ? messageMatch[1] : null;

            if (depositId && pendingDeposits.has(depositId)) {
                const depositData = pendingDeposits.get(depositId);
                pendingDeposits.delete(depositId); // Prevent reprocessing

                console.log(`DEPOSIT_ACCEPTED: Processing accepted deposit offer #${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId}`);
                // Clear user's pending offer flag
                await User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null });

                // --- Validate Round and Limits before adding items ---
                let depositRound;
                try {
                    depositRound = await Round.findById(depositData.roundId);
                    if (!depositRound) throw new Error(`Round ${depositData.roundId} not found during deposit processing.`);
                    if (depositRound.status !== 'active' || isRolling) {
                        console.warn(`DEPOSIT_REJECT_LATE: Round ${depositData.roundId} no longer active for deposit ${depositId} (Offer ${offer.id}). Status: ${depositRound.status}, Rolling: ${isRolling}.`);
                        io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Deposit for Round ${depositData.roundId} could not be processed: Round ended or is rolling.` });
                        // TODO: Implement item return logic for items received after round closed.
                        // This could involve creating a 'return queue' or similar.
                        // For now, log and items remain with bot. This is a critical recovery point.
                        console.error(`CRITICAL_ITEM_HANDLING: Items from Offer #${offer.id} (DepositID ${depositId}) received for closed/rolling round. Manual intervention may be needed to return items. Items:`, offer.itemsToReceive);
                        return;
                    }
                    // Re-check limits
                    const isNewParticipantCheck = !depositRound.participants.some(p => p.user?.toString() === depositData.userId.toString());
                    if (isNewParticipantCheck && depositRound.participants.length >= MAX_PARTICIPANTS) {
                         console.warn(`DEPOSIT_REJECT_LIMIT: Participant limit reached for deposit ${depositId}.`);
                         // TODO: Return items
                         return;
                    }
                    if (depositRound.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                        console.warn(`DEPOSIT_REJECT_LIMIT: Pot item limit reached for deposit ${depositId}.`);
                        // TODO: Return items
                        return;
                    }
                } catch (roundCheckError) {
                    console.error(`CRITICAL DB ERROR checking round for deposit ${depositId}:`, roundCheckError);
                     // TODO: Return items / Critical error state
                    return;
                }
                // --- End Validate Round ---

                try {
                    const itemDocuments = depositData.items.map(itemData => new Item({
                        assetId: itemData.assetid, name: itemData._name, image: itemData._image,
                        price: itemData._price, owner: depositData.userId, roundId: depositData.roundId
                    }));
                    const insertedItemsResult = await Item.insertMany(itemDocuments, { ordered: false });
                    const createdItemIds = insertedItemsResult.map(doc => doc._id);
                    console.log(`DEPOSIT_ITEMS_DB: Inserted ${createdItemIds.length} items for deposit ${depositId}.`);

                    // --- Update User's totalDeposited ---
                    await User.findByIdAndUpdate(depositData.userId, {
                        $inc: { totalDeposited: depositData.totalValue }
                    });
                    console.log(`STATS_UPDATE: User ${depositData.steamId} totalDeposited updated by $${depositData.totalValue.toFixed(2)}.`);

                    // --- Atomic Round Update ---
                    const updatedRound = await Round.findOneAndUpdate(
                        { _id: depositData.roundId, status: 'active' }, // Ensure still active
                        {
                            $inc: { totalValue: depositData.totalValue },
                            $push: { items: { $each: createdItemIds } }
                        },
                        { new: true }
                    ).populate('participants.user', 'steamId username avatar'); // Repopulate for emit

                    if (!updatedRound) {
                        // This means the round status changed between the check and now, or it was deleted.
                        // This is a critical race condition / error state.
                        console.error(`CRITICAL_RACE: Round ${depositData.roundId} status changed or deleted during deposit ${depositId} finalization.`);
                        // Items were inserted but not added to round. Attempt to delete them or flag for admin.
                        await Item.deleteMany({ _id: { $in: createdItemIds } });
                        console.error(`CRITICAL_CLEANUP: Deleted ${createdItemIds.length} orphaned items for deposit ${depositId}.`);
                        // TODO: Attempt to return items to user if possible.
                        io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Critical error processing your deposit for round ${depositData.roundId}. Items not added. Please contact support.` });
                        return;
                    }

                    let participant = updatedRound.participants.find(p => p.user?._id.equals(depositData.userId));
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));

                    if (participant) {
                        participant.itemsValue += depositData.totalValue;
                        participant.tickets += depositTickets;
                    } else {
                        updatedRound.participants.push({
                            user: depositData.userId, itemsValue: depositData.totalValue, tickets: depositTickets
                        });
                    }
                    await updatedRound.save(); // Save participant changes

                    const fullyPopulatedRound = await Round.findById(updatedRound._id)
                        .populate('participants.user', 'steamId username avatar _id') // Ensure _id is populated for user
                        .populate('items')
                        .lean();

                    currentRound = fullyPopulatedRound; // Update global state with the latest populated data

                    const updatedParticipantData = fullyPopulatedRound.participants.find(p => p.user?._id.equals(depositData.userId));
                    const userInfo = updatedParticipantData?.user;

                    if (updatedParticipantData && userInfo) {
                        io.emit('participantUpdated', {
                            roundId: fullyPopulatedRound.roundId,
                            userId: userInfo._id.toString(), username: userInfo.username, avatar: userInfo.avatar,
                            itemsValue: updatedParticipantData.itemsValue, tickets: updatedParticipantData.tickets,
                            totalValue: fullyPopulatedRound.totalValue,
                            depositedItems: depositData.items.map(i => ({ assetId: i.assetid, name: i._name, image: i._image, price: i._price }))
                        });
                    }

                    if (fullyPopulatedRound.participants.length === 1 && !roundTimer) {
                        console.log(`TIMER_START: First participant (${userInfo?.username}) joined round ${fullyPopulatedRound.roundId}. Starting timer.`);
                        startRoundTimer();
                    }
                    console.log(`DEPOSIT_SUCCESS: Offer #${offer.id} (Deposit ${depositId}) fully processed for ${userInfo?.username}.`);

                } catch (dbErr) {
                    console.error(`CRITICAL DB/UPDATE ERROR processing accepted deposit ${depositId} (Offer ${offer.id}):`, dbErr);
                    // Items may have been received by bot but not credited. Flag for admin.
                    io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Critical error processing your deposit (Offer #${offer.id}). Please contact support immediately.` });
                    // Potentially mark round as error
                    if (currentRound) {
                         Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error', error_message: `DB error on deposit ${depositId}` } })
                            .catch(e => console.error("Failed to set round to error state:", e));
                         io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error.' });
                    }
                }
            } else if (offer.itemsToGive && offer.itemsToGive.length > 0 && (!offer.itemsToReceive || offer.itemsToReceive.length === 0)) {
                // This is a WINNINGS offer sent by the bot that the user accepted
                console.log(`PAYOUT_ACCEPTED: Winnings offer #${offer.id} accepted by recipient ${offer.partner.getSteamID64()}.`);
                const winnerUser = await User.findOne({ steamId: offer.partner.getSteamID64() }).lean();
                if (winnerUser) {
                    io.to(winnerUser._id.toString()).emit('notification', { type: 'success', message: `Winnings from offer #${offer.id} successfully received! Enjoy your skins!` });
                    // Optionally update a 'lastPayoutClaimedAt' field on the user or round.
                }
            } else {
                console.warn(`Offer #${offer.id} accepted, but not a recognized deposit or winnings payout. Message: "${offer.message}"`);
            }
        } else if (
            [
                TradeOfferManager.ETradeOfferState.Declined,
                TradeOfferManager.ETradeOfferState.Canceled, // Bot might cancel expired offers via manager.cancelTime
                TradeOfferManager.ETradeOfferState.Expired,
                TradeOfferManager.ETradeOfferState.InvalidItems, // Items became unavailable
                TradeOfferManager.ETradeOfferState.Countered
            ].includes(offer.state)
        ) {
            const messageMatch = offer.message?.match(/Deposit ID: ([a-f0-9-]+)/i);
            const depositId = messageMatch ? messageMatch[1] : null;

            if (depositId && pendingDeposits.has(depositId)) {
                const depositData = pendingDeposits.get(depositId);
                console.warn(`DEPOSIT_FAIL_CLEANUP: Deposit offer ${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId} was ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                pendingDeposits.delete(depositId);
                await User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null });
                const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                io.to(depositData.userId.toString()).emit('notification', { type: 'error', message: `Your deposit offer (#${offer.id}) was ${stateMessage} and has been cancelled.` });
            } else if (offer.itemsToGive && offer.itemsToGive.length > 0) {
                // This was likely a winnings payout offer that failed
                console.warn(`PAYOUT_FAIL: Winnings offer #${offer.id} to ${offer.partner.getSteamID64()} ended as ${TradeOfferManager.ETradeOfferState[offer.state]}. Items returned to bot inventory.`);
                const userToNotify = await User.findOne({ steamId: offer.partner.getSteamID64() }).lean();
                if (userToNotify) {
                    const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                    io.to(userToNotify._id.toString()).emit('notification', { type: 'error', message: `Failed to deliver winnings (Offer #${offer.id}). The offer was ${stateMessage}. Please ensure your trade URL is correct and inventory is public, then contact support.` });
                }
                // TODO: Flag for manual admin review / retry for failed payouts.
            }
        }
    });
}

// --- Round Info API Routes ---
function formatRoundForClient(round) {
    if (!round) return null;
    let timeLeft = 0;
    if (round.status === 'active' && round.endTime) {
        timeLeft = Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000));
    } else if (round.status === 'pending' || (round.status === 'active' && (!round.participants || round.participants.length === 0))) {
        timeLeft = ROUND_DURATION;
    }

    const participantsFormatted = (round.participants || []).map(p => ({
        user: p.user ? { _id: p.user._id, steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar } : null,
        itemsValue: p.itemsValue || 0,
        tickets: p.tickets || 0
    })).filter(p => p.user);

    const itemsFormatted = (round.items || []).map(i => ({
        assetId: i.assetId, name: i.name, image: i.image, price: i.price || 0,
        owner: i.owner?._id || i.owner // Send owner's MongoDB ID
    }));

    let winnerDetails = null;
    if (round.winner) { // Ensure winner object is populated
        const winnerUser = round.participants?.find(p => p.user?._id.equals(round.winner))?.user || round.winner; // Prefer populated user from participants
        winnerDetails = {
            _id: winnerUser?._id || round.winner, // Fallback to just ID if not populated
            steamId: winnerUser?.steamId,
            username: winnerUser?.username,
            avatar: winnerUser?.avatar
        };
    }
    return {
        _id: round._id, roundId: round.roundId, status: round.status, startTime: round.startTime, endTime: round.endTime,
        timeLeft: timeLeft, totalValue: round.totalValue || 0, serverSeedHash: round.serverSeedHash,
        participants: participantsFormatted, items: itemsFormatted,
        winner: winnerDetails, winningTicket: round.status === 'completed' ? round.winningTicket : undefined,
        serverSeed: round.status === 'completed' ? round.serverSeed : undefined,
        clientSeed: round.status === 'completed' ? round.clientSeed : undefined,
        provableHash: round.status === 'completed' ? round.provableHash : undefined,
        taxAmount: round.taxAmount,
        potValueAfterTax: round.potValueAfterTax // Send this new field
    };
}

app.get('/api/round/current', async (req, res) => {
    let roundToFormat = null;
    try {
        if (currentRound?._id) { // Prioritize in-memory, but re-fetch to ensure latest populated data
            roundToFormat = await Round.findById(currentRound._id)
                .populate('participants.user', 'steamId username avatar _id') // Ensure _id is populated
                .populate('items')
                .populate('winner', 'steamId username avatar _id')
                .lean();
            if (roundToFormat) currentRound = roundToFormat; // Update memory with latest
            else currentRound = null; // Clear if not found (e.g. DB manually cleared)
        }

        if (!roundToFormat) { // Fallback to DB if memory is empty or round was not found
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                .sort({ startTime: -1 })
                .populate('participants.user', 'steamId username avatar _id')
                .populate('items')
                .populate('winner', 'steamId username avatar _id')
                .lean();
            if (roundToFormat && (!currentRound || currentRound.status === 'completed' || currentRound.status === 'error')) {
                 currentRound = roundToFormat; // Restore to memory
                 console.log(`Restored active/pending round ${currentRound.roundId} from DB to memory via API.`);
                 // Timer handling if restored
                 if (currentRound.status === 'active' && currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                    startRoundTimer(true);
                } else if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) {
                    startRoundTimer(false);
                }
            }
        }
        const formattedData = formatRoundForClient(roundToFormat);
        if (formattedData) res.json(formattedData);
        else res.status(404).json({ error: 'No active or pending round found.' });
    } catch (err) {
        console.error('Error fetching/formatting current round:', err);
        res.status(500).json({ error: 'Server error retrieving round details.' });
    }
});

app.get('/api/rounds',
    [
        query('page').optional().isInt({ min: 1 }).toInt(),
        query('limit').optional().isInt({ min: 1, max: 25 }).toInt() // Max 25 for history
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
                    .sort({ roundId: -1 }) // Sort by roundId descending
                    .skip(skip)
                    .limit(limit)
                    .populate('winner', 'username avatar steamId _id') // Populate winner
                    .select('roundId completedTime totalValue winner serverSeed serverSeedHash clientSeed winningTicket provableHash status taxAmount potValueAfterTax taxedItems.name taxedItems.price') // Select fields, include taxed item details
                    .lean(),
                Round.countDocuments(queryFilter)
            ]);
            res.json({
                rounds: rounds.map(r => ({ // Ensure consistent formatting for client
                    ...r,
                    totalValue: r.totalValue || 0, // Use original totalValue for display
                    potValueAfterTax: r.potValueAfterTax !== undefined ? r.potValueAfterTax : (r.totalValue || 0) - (r.taxAmount || 0),
                    winner: r.winner ? { _id: r.winner._id, username: r.winner.username, avatar: r.winner.avatar, steamId: r.winner.steamId } : null
                })),
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
    sensitiveActionLimiter,
    [
        body('roundId').notEmpty().isInt({ min: 1 }).toInt(),
        body('serverSeed').trim().notEmpty().isHexadecimal().isLength({ min: 64, max: 64 }).withMessage('Server seed must be 64 hex characters.'),
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 }).withMessage('Client seed must be between 1 and 128 characters.')
    ],
    handleValidationErrors,
    async (req, res) => {
        const { roundId, serverSeed, clientSeed } = req.body;
        try {
            const round = await Round.findOne({ roundId: parseInt(roundId), status: 'completed' }) // Ensure roundId is number
                .populate('participants.user', 'username')
                .populate('winner', 'username')
                .lean();

            if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found or seeds not yet available for verification.` });
            if (!round.serverSeed || !round.clientSeed || !round.provableHash || round.winningTicket == null) {
                return res.status(400).json({ error: `Round #${roundId} data is incomplete for verification (missing seeds or ticket).` });
            }

            const providedServerSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
            if (providedServerSeedHash !== round.serverSeedHash) {
                return res.json({ verified: false, reason: 'Server Seed Hash mismatch.', expectedHash: round.serverSeedHash, providedSeed: serverSeed, calculatedHash: providedServerSeedHash });
            }
            if (serverSeed !== round.serverSeed) { // Also check if the provided server seed matches the *actual* revealed one
                return res.json({ verified: false, reason: 'Provided Server Seed does not match the officially revealed Server Seed for this round.' });
            }
             if (clientSeed !== round.clientSeed) {
                return res.json({ verified: false, reason: 'Provided Client Seed does not match the officially recorded Client Seed for this round.' });
            }

            const combinedString = serverSeed + clientSeed;
            const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
            if (calculatedProvableHash !== round.provableHash) {
                return res.json({ verified: false, reason: 'Calculated Provable Hash does not match recorded hash.', expectedProvableHash: round.provableHash, calculatedProvableHash: calculatedProvableHash, combinedString: combinedString });
            }

            const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
            const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);
            if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets for calculation.' });
            const calculatedWinningTicket = decimalFromHash % totalTickets;

            if (calculatedWinningTicket !== round.winningTicket) {
                return res.json({ verified: false, reason: 'Calculated winning ticket does not match the recorded winning ticket.', calculatedTicket: calculatedWinningTicket, actualWinningTicket: round.winningTicket, provableHashUsed: calculatedProvableHash, totalTickets: totalTickets });
            }

            res.json({
                verified: true, roundId: round.roundId, serverSeed: serverSeed, serverSeedHash: round.serverSeedHash, clientSeed: clientSeed,
                combinedString: combinedString, finalHash: calculatedProvableHash, winningTicket: calculatedWinningTicket,
                totalTickets: totalTickets, totalValue: round.totalValue, potValueAfterTax: round.potValueAfterTax, winnerUsername: round.winner?.username || 'N/A'
            });
        } catch (err) {
            console.error(`Error verifying round ${roundId}:`, err);
            res.status(500).json({ error: 'Server error during verification.' });
        }
    });

// --- Socket.io Connection Handling ---
io.on('connection', (socket) => {
    // console.log(`Socket.io: Client connected: ${socket.id}`);
    socket.on('requestRoundData', async () => {
        try {
            let roundToSend = currentRound; // Prefer in-memory first
            if (!roundToSend || !['active', 'rolling', 'pending'].includes(roundToSend.status)) { // If memory is stale or ended
                roundToSend = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                    .sort({ startTime: -1 })
                    .populate('participants.user', 'steamId username avatar _id')
                    .populate('items')
                    .populate('winner', 'steamId username avatar _id')
                    .lean();
                if (roundToSend && (!currentRound || currentRound._id.toString() !== roundToSend._id.toString() || currentRound.status !== roundToSend.status)) {
                     currentRound = roundToSend; // Update global only if fetched is newer or different status
                     console.log(`Socket.io: Restored/updated round ${currentRound?.roundId} from DB for client ${socket.id}.`);
                     // Timer logic might need re-evaluation here if status changed
                }
            }
            const formattedData = formatRoundForClient(roundToSend);
            if (formattedData) socket.emit('roundData', formattedData);
            else socket.emit('noActiveRound');
        } catch (err) {
            console.error(`Socket.io: Error fetching round data for socket ${socket.id}:`, err);
            socket.emit('roundError', { error: 'Failed to load round data.' });
        }
    });
    socket.on('disconnect', (reason) => { /* console.log(`Socket.io: Client disconnected: ${socket.id}. Reason: ${reason}`); */ });
});

// --- Server Startup ---
async function startApp() {
    console.log("APP_START: Performing initial price cache refresh...");
    await refreshPriceCache();
    setInterval(refreshPriceCache, PRICE_REFRESH_INTERVAL_MS);
    console.log(`APP_START: Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`HTTP Server listening on port ${PORT}`);
        console.log(`Site URL configured as: ${process.env.SITE_URL}`);
        if (!isBotConfigured) console.warn("BOT_STATUS: Steam Bot NOT configured. Trade features disabled.");
        else if (!isBotReady) console.warn("BOT_STATUS: Steam Bot configured but login attempt FAILED or is PENDING. Check logs above.");
        else console.log("BOT_STATUS: Steam Bot is ready and online.");
        ensureInitialRound();
    });
}

startApp().catch(err => {
    console.error("FATAL_STARTUP_ERROR:", err);
    process.exit(1);
});

// --- Graceful Shutdown ---
function gracefulShutdown(signal) {
    console.log(`Received ${signal}. Closing server gracefully...`);
    io.close(() => { console.log('Socket.IO connections closed.'); });
    server.close(async () => {
        console.log('HTTP server closed.');
        try {
            await mongoose.connection.close();
            console.log('MongoDB connection closed.');
        } catch (e) {
            console.error("Error closing MongoDB connection during shutdown:", e);
        } finally {
             console.log('Exiting process.');
            process.exit(0);
        }
    });
    // Force shutdown after a timeout if graceful shutdown fails
    setTimeout(() => {
        console.error('Could not close connections gracefully in time, forcing shutdown.');
        process.exit(1);
    }, 10000); // 10 seconds
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT')); // Handle Ctrl+C

// --- Basic Error Handling Middleware (Place LAST) ---
// Improved error handling
app.use((err, req, res, next) => {
    // Log the full error for server-side debugging
    console.error("UNHANDLED_ERROR:", {
        message: err.message,
        stack: err.stack,
        status: err.status,
        path: req.path,
        method: req.method,
        ip: req.ip
    });

    const statusCode = typeof err.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500;
    
    // Avoid sending sensitive error details to the client in production
    const clientErrorMessage = (process.env.NODE_ENV === 'production' && statusCode === 500)
        ? 'An unexpected internal server error occurred. Please try again later.'
        : (err.message || 'Unknown server error.');

    if (res.headersSent) {
        return next(err); // Delegate to default Express handler if headers already sent
    }

    res.status(statusCode).json({ error: clientErrorMessage });
});
