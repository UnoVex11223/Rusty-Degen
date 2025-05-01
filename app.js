// Required dependencies
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo'); // <-- ADDED: For persistent sessions
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
const csurf = require('csurf'); // <-- ADDED: For CSRF protection
const winston = require('winston'); // <-- ADDED: For logging
require('dotenv').config();

// --- Logger Setup ---
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info', // Default to 'info', set to 'debug' for more detail
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }), // Log stack traces for errors
        winston.format.splat(),
        winston.format.json() // Log in JSON format
    ),
    defaultMeta: { service: 'rusty-degen-app' },
    transports: [
        // Write all logs with level `error` and below to `error.log`
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        // Write all logs with level `info` and below to `combined.log`
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

// If not in production, also log to the console with simple format
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        ),
    }));
} else {
     // In production, log info level to console as well, but keep JSON format
     logger.add(new winston.transports.Console({
        format: winston.format.json(),
        level: 'info'
    }));
}

logger.info('Logger initialized.');

// TODO: Implement robust environment variable validation using a library like Joi or Zod
// Example placeholder:
// const { error: envError } = envSchema.validate(process.env);
// if (envError) { logger.error(`Environment variable validation failed: ${envError.message}`); process.exit(1); }

const requiredEnvVars = [
    'MONGODB_URI', 'SESSION_SECRET', 'STEAM_API_KEY', 'SITE_URL',
    // Conditionally required if bot is intended to function
    'STEAM_USERNAME', 'STEAM_PASSWORD', 'STEAM_SHARED_SECRET', 'BOT_TRADE_URL', 'SITE_NAME'
    // STEAM_IDENTITY_SECRET is optional but needed for auto-confirming trades
];
const isBotConfigured = process.env.STEAM_USERNAME && process.env.STEAM_PASSWORD && process.env.STEAM_SHARED_SECRET && process.env.BOT_TRADE_URL;
let missingVars = requiredEnvVars.filter(v => !process.env[v] && !(v.startsWith('STEAM_') || v === 'BOT_TRADE_URL' || v === 'SITE_NAME') && isBotConfigured);
if (!isBotConfigured) {
    logger.warn("Steam Bot credentials/config incomplete in .env file. Trading features will be disabled.");
} else {
    missingVars = missingVars.concat(requiredEnvVars.filter(v => (v.startsWith('STEAM_') || v === 'BOT_TRADE_URL' || v === 'SITE_NAME') && !process.env[v]));
}

if (missingVars.length > 0) {
    logger.error(`FATAL: Missing required environment variables: ${missingVars.join(', ')}`);
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
const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: process.env.SITE_URL || "*", methods: ["GET", "POST"] } });

// --- Security Middleware ---
app.set('trust proxy', 1); // Trust first proxy, important for rate limiting and secure cookies if behind proxy

// Helmet setup with improved CSP
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "default-src": ["'self'"],
            // REMOVED 'unsafe-inline' for script-src. Frontend JS needs adjustment (no inline event handlers/scripts).
            // Consider using nonces if inline scripts are absolutely necessary temporarily.
            "script-src": ["'self'", "/socket.io/socket.io.js"],
            // REMOVED 'unsafe-inline' for style-src. Frontend CSS needs adjustment (no inline styles).
            "style-src": ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
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
                        // Allow WebSocket connections based on site URL
                        sources.push(`ws://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(`wss://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(siteUrl); // Allow connections TO the site URL itself for API calls
                    } catch (e) {
                        logger.error("Invalid SITE_URL for CSP connect-src:", { siteUrl, error: e.message });
                    }
                }
                sources.push("https://rust.scmm.app"); // For pricing
                return sources;
            })(),
            "frame-src": ["'self'", "https://steamcommunity.com"], // Allow framing Steam for trades
            "frame-ancestors": ["'self'", "https://steamcommunity.com"], // Allow being framed by Steam if needed
            "object-src": ["'none'"], // Disallow objects (Flash, etc.)
            "upgrade-insecure-requests": [], // Upgrade HTTP requests to HTTPS
        },
    })
);
// Enable other relevant Helmet features
app.use(helmet.dnsPrefetchControl());
app.use(helmet.frameguard({ action: 'sameorigin' })); // Default, explicitly set
app.use(helmet.hidePoweredBy());
app.use(helmet.hsts({ maxAge: 15552000, includeSubDomains: true, preload: true })); // 180 days HSTS - consider preload implications
app.use(helmet.ieNoOpen());
app.use(helmet.noSniff());
app.use(helmet.originAgentCluster());
app.use(helmet.permittedCrossDomainPolicies());
app.use(helmet.referrerPolicy({ policy: 'same-origin' }));
app.use(helmet.xssFilter()); // Deprecated by browsers, but doesn't hurtRetryIcontinueEditContinuing with the app.js file:
javascript// Rate Limiting Setup (Apply consistently later)
const generalApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many general API requests, please try again after 15 minutes.' } });
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: { error: 'Too many login attempts from this IP, please try again after 10 minutes.' }, standardHeaders: true, legacyHeaders: false });
const sensitiveActionLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, message: { error: 'Too many requests for this action, please try again after 5 minutes.' }, standardHeaders: true, legacyHeaders: false });
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 5, message: { error: 'Too many deposit attempts, please wait a minute.' }, standardHeaders: true, legacyHeaders: false }); // Made stricter

// Configure Core Middleware
app.use(cors({ origin: process.env.SITE_URL || "*", credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public')); // Serves index.html, main.js, styles.css etc.

// --- Session Configuration (Using MongoStore) ---
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false, // Don't save session if unmodified
    saveUninitialized: false, // Don't create session until something stored
    store: MongoStore.create({ // Use MongoStore
        mongoUrl: process.env.MONGODB_URI,
        ttl: 14 * 24 * 60 * 60, // Session TTL in seconds (optional, default is 14 days)
        autoRemove: 'native' // Default behavior for removing expired sessions
    }),
    cookie: {
        maxAge: 1 * 60 * 60 * 1000, // 1 hour session cookie
        secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
        httpOnly: true, // Helps prevent XSS accessing the cookie
        sameSite: 'lax' // Helps prevent CSRF
    }
});
app.use(sessionMiddleware);

// --- Passport and CSRF Initialization ---
app.use(passport.initialize());
app.use(passport.session());
app.use(csurf()); // <-- ADDED: Initialize CSRF protection middleware AFTER session middleware

// Middleware to make CSRF token available (needed for frontend)
app.use((req, res, next) => {
    res.locals.csrfToken = req.csrfToken(); // Make token available in templates if using server-side rendering
    // Optionally set cookie for SPA frameworks
    res.cookie('XSRF-TOKEN', req.csrfToken(), { 
        httpOnly: false, 
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    });
    next();
});
javascript// --- Steam Strategy ---
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
                { $set: userData, $setOnInsert: { steamId: profile.id, tradeUrl: '', createdAt: new Date(), pendingDepositOfferId: null } },
                { new: true, upsert: true, runValidators: true }
            );
            // logger.debug(`User login/update successful: ${user.username} (ID: ${user.steamId})`);
            return done(null, user);
        } catch (err) {
            logger.error('Steam Strategy Error:', { error: err.message, stack: err.stack });
            return done(err);
        }
    }
));
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user); // Attach user object to req.user
    } catch (err) {
        logger.error("DeserializeUser Error:", { error: err.message, userId: id });
        done(err);
    }
});

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => logger.info('Successfully connected to MongoDB.'))
    .catch(err => {
        logger.error('MongoDB Connection Error:', { error: err.message, stack: err.stack });
        process.exit(1); // Exit if cannot connect to DB
    });

// --- MongoDB Schemas ---
// TODO: Review existing indexes and add more where needed (e.g., compound indexes)
// Example: userSchema.index({ steamId: 1, banned: 1 });
const userSchema = new mongoose.Schema({
    steamId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    avatar: { type: String },
    tradeUrl: {
        type: String,
        default: '',
        // Basic regex validation at schema level (more thorough validation in route)
        // Removed match for flexibility, rely on route validation
    },
    balance: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    banned: { type: Boolean, default: false },
    pendingDepositOfferId: { type: String, default: null, index: true },
    totalDeposited: { type: Number, default: 0 }, // Track total deposited value
    totalWon: { type: Number, default: 0 } // Track total won value
});
    itemSchema = new mongoose.Schema({
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
        _id: false, // Don't store _id for subdocuments unless needed
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        itemsValue: { type: Number, required: true, default: 0, min: 0 },
        tickets: { type: Number, required: true, default: 0, min: 0 }
    }],
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    winningTicket: { type: Number, min: 0 },
    serverSeed: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    serverSeedHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    clientSeed: { type: String }, // No strict match needed here
    provableHash: { type: String, match: /^[a-f0-9]{64}$/ },
    taxAmount: { type: Number, default: 0, min: 0 },
    taxedItems: [{ // Store basic info of items taken as tax
         _id: false, // Don't store _id for subdocuments
        assetId: String,
        name: String,
        price: { type: Number, min: 0 }
    }]
});
// Add index to participants.user for faster lookups if frequently queried
roundSchema.index({ 'participants.user': 1 });
// Add index for finding active/pending rounds quickly
roundSchema.index({ status: 1, startTime: -1 });

// New trade history schema
const tradeSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    offerId: { type: String, required: true, unique: true, index: true },
    type: { type: String, enum: ['deposit', 'winnings'], required: true },
    roundId: { type: mongoose.Schema.Types.ObjectId, ref: 'Round', index: true },
    totalValue: { type: Number, default: 0, min: 0 },
    items: [{
        _id: false,
        assetId: String,
        name: String,
        image: String,
        price: { type: Number, min: 0 }
    }],
    status: { type: String, enum: ['pending', 'accepted', 'declined', 'expired', 'canceled', 'error'], default: 'pending' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});
// Add index for faster lookup by status and createdAt
tradeSchema.index({ user: 1, status: 1, createdAt: -1 });

const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);
const Trade = mongoose.model('Trade', tradeSchema); // Add Trade modelRetryIcontinueEditContinuing with more of app.js:
javascript// --- Steam Bot Setup ---
const community = new SteamCommunity();
const manager = new TradeOfferManager({
    steam: community,
    domain: process.env.SITE_URL ? new URL(process.env.SITE_URL).hostname : 'localhost', // Extract hostname
    language: 'en',
    pollInterval: 10000,
    cancelTime: 10 * 60 * 1000, // 10 minutes for deposit offer expiry
    // TODO: Add confirmation polling interval if needed (only if not using identity secret reliably)
    // pendingCancelTime: 10 * 60 * 1000, // Example: Cancel offers awaiting confirmation after 10 mins
});
let isBotReady = false;
// Using Map for pending deposits - needs cleanup logic refinement
// Consider using a TTL cache like node-cache here as well if Map cleanup proves unreliable
const pendingDeposits = new Map(); // { depositId: { userId, items, roundId, steamId, totalValue, offerId, cleanupTimeout } }

// --- 2FA Code Generation ---
function generateAuthCode() {
    const secret = process.env.STEAM_SHARED_SECRET;
    if (!secret) { logger.error("STEAM_SHARED_SECRET missing. Cannot generate 2FA code."); return null; }
    try { return SteamTotp.generateAuthCode(secret); }
    catch (e) { logger.error("Error generating 2FA code:", e); return null; }
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
        logger.info(`Attempting Steam login for bot: ${loginCredentials.accountName}...`);
        community.login(loginCredentials, (err, sessionID, cookies, steamguard) => {
            // Log the error object immediately for details, regardless if it exists
            if (err) {
                logger.error('STEAM LOGIN ERROR (Callback Err Object):', {
                    message: err.message,
                    eresult: err.eresult, // EResult provides specific Steam error codes
                    emaildomain: err.emaildomain, // May indicate if email auth is needed
                    stack: err.stack
                });
            } else {
                logger.debug('Steam community.login callback received (no immediate error object reported).');
            }
                if (err || !community.steamID) {
                logger.error(`CRITICAL LOGIN FAILURE: Login callback failed or community.steamID is undefined.`, {
                    error: err ? err.message : 'N/A',
                    steamID: community.steamID,
                    eresult: err?.eresult
                });
                isBotReady = false;
                // Add specific failure hints
                if (err?.eresult === 5) logger.warn('Login Failure Hint: Invalid Password? Check .env');
                if (err?.eresult === 65) logger.warn('Login Failure Hint: Incorrect 2FA Code (Check Shared Secret/Server Time) or Account Rate Limit?');
                if (err?.eresult === 63) logger.warn('Login Failure Hint: Account Logon Denied - Check Email Auth/Steam Guard settings via Browser?');
                // TODO: Implement retry logic for login failures (e.g., exponential backoff for temporary errors)
                return; // *** DO NOT PROCEED if login failed ***
            }

            logger.info(`Steam bot ${loginCredentials.accountName} logged in successfully (SteamID: ${community.steamID}). Attempting to set cookies for TradeOfferManager...`);

            manager.setCookies(cookies, (setCookieErr) => {
                if (setCookieErr) {
                    logger.error('TradeOfferManager Error setting cookies:', { error: setCookieErr.message, stack: setCookieErr.stack });
                    isBotReady = false;
                    return;
                }
                logger.info('TradeOfferManager cookies set successfully.');
                community.setCookies(cookies); // Also set for community actions
                isBotReady = true; // Mark bot as ready ONLY after cookies are set for BOTH manager and community
                logger.info("Steam Bot is ready.");
                ensureInitialRound(); // Attempt to create the first round now that bot is ready
            });

            // Auto-accept friend requests (can run once login is confirmed valid)
            community.on('friendRelationship', (steamID, relationship) => {
                if (relationship === SteamCommunity.EFriendRelationship.RequestRecipient) {
                    logger.info(`Received friend request from ${steamID}. Accepting...`);
                    community.addFriend(steamID, (friendErr) => {
                        if (friendErr) logger.error(`Error accepting friend request from ${steamID}:`, friendErr);
                        else logger.info(`Accepted friend request from ${steamID}.`);
                    });
                }
            });
        }); // End community.login callback
    } else {
        logger.warn("Could not generate 2FA code. Steam Bot login skipped.");
        isBotReady = false;
    }
} // End if (isBotConfigured)
javascript// --- Active Round Data ---
let currentRound = null;
let roundTimer = null;
let isRolling = false;

// --- Pricing Cache and Functions ---
const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false });

function getFallbackPrice(marketHashName) {
    // logger.debug(`PRICE_INFO: Using fallback ($${MIN_ITEM_VALUE.toFixed(2)}) for: ${marketHashName}`);
    return MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0;
}

/**
 * Fetches ALL item prices from rust.scmm.app and updates the local cache.
 * TODO: Implement circuit breaker pattern here for resilience.
 */
async function refreshPriceCache() {
    logger.info("Attempting to refresh price cache from rust.scmm.app...");
    const apiUrl = `https://rust.scmm.app/api/item/prices?currency=USD`;

    // Placeholder for circuit breaker logic
    // const circuit = getCircuitBreaker('scmmPriceApi');
    // try {
    //     const response = await circuit.fire(apiUrl, { timeout: PRICE_FETCH_TIMEOUT_MS });
    //     // Process response...
    // } catch (error) {
    //      logger.error(`SCMM Price API call failed via circuit breaker: ${error.message}`);
    // }

    try {
        const response = await axios.get(apiUrl, { timeout: PRICE_FETCH_TIMEOUT_MS });

        if (response.data && Array.isArray(response.data)) {
            const items = response.data;
            let updatedCount = 0;
            let newItems = [];

            items.forEach(item => {
                if (item?.name && typeof item.price === 'number' && item.price >= 0) {
                    const key = item.name;
                    const priceInDollars = item.price / 100.0;
                    newItems.push({ key: key, val: priceInDollars });
                    updatedCount++;
                } else if (item?.name) {
                    // logger.warn(`Invalid or missing price field for item '${item.name}' in SCMM response. Raw price: ${item.price}`);
                }
            });

            if (newItems.length > 0) {
                const success = priceCache.mset(newItems);
                if (success) { logger.info(`Refreshed price cache with ${updatedCount} items from rust.scmm.app.`); }
                else { logger.error("Failed to bulk set price cache (node-cache mset returned false)."); }
            } else {
                logger.warn("No valid items found in the response from rust.scmm.app price refresh.");
            }
        } else {
            logger.error("Invalid or empty array response received from rust.scmm.app price refresh.", { status: response.status });
        }
    } catch (error) {
        logger.error(`Failed to fetch prices from ${apiUrl}.`, {
            errorCode: error.code,
            errorMessage: error.message,
            responseStatus: error.response?.status,
            // responseData: error.response?.data // Avoid logging potentially large responses
        });
    }
}
    /**
 * Gets item price from local cache, falling back if not found.
 * @param {string} marketHashName
 * @returns {number} Price in USD
 */
function getItemPrice(marketHashName) {
    if (typeof marketHashName !== 'string' || marketHashName.length === 0) {
        logger.warn("getItemPrice called with invalid marketHashName:", marketHashName);
        return 0;
    }
    const cachedPrice = priceCache.get(marketHashName);
    if (cachedPrice !== undefined) {
        return cachedPrice;
    } else {
        return getFallbackPrice(marketHashName);
    }
}

// --- Core Game Logic ---

/**
 * Creates a new round if one isn't already active or rolling.
 */
async function createNewRound() {
    if (isRolling) {
        logger.info("Cannot create new round: Current round is rolling.");
        return null;
    }
    if (currentRound && currentRound.status === 'active') {
        logger.info(`Cannot create new round: Round ${currentRound.roundId} is already active.`);
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
            status: 'active', // Start as active immediately
            startTime: new Date(),
            serverSeed: serverSeed,
            serverSeedHash: serverSeedHash,
            items: [],
            participants: [],
            totalValue: 0
        });

        await newRound.save();
        currentRound = newRound.toObject(); // Update global state

        io.emit('roundCreated', {
            roundId: newRound.roundId,
            serverSeedHash: newRound.serverSeedHash,
            timeLeft: ROUND_DURATION,
            totalValue: 0,
            participants: [],
            items: []
        });

        logger.info(`--- Round ${newRound.roundId} created and active ---`);
        return newRound.toObject();

    } catch (err) {
        logger.error('FATAL: Error creating new round:', { error: err.message, stack: err.stack });
        setTimeout(createNewRound, 10000); // Retry after 10 seconds
        return null;
    }
}
javascript/**
 * Ensure an initial round exists on startup *after* bot is ready.
 */
async function ensureInitialRound() {
    if (isBotConfigured && isBotReady) {
        if (!currentRound) {
            try {
                const existingActive = await Round.findOne({ status: 'active' })
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items')
                    .lean();
                if (existingActive) {
                    logger.info(`Found existing active round ${existingActive.roundId} on startup.`);
                    currentRound = existingActive;
                    if (currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        startRoundTimer(true);
                    } else if (currentRound.participants.length > 0 && !currentRound.endTime && !roundTimer) {
                        logger.warn(`Active round ${currentRound.roundId} found without endTime. Starting timer now.`);
                        startRoundTimer(false);
                    }
                } else {
                    logger.info("No active round found, creating initial round...");
                    await createNewRound();
                }
            } catch (dbErr) {
                logger.error("Error ensuring initial round:", { error: dbErr.message, stack: dbErr.stack });
            }
        }
    } else if (isBotConfigured && !isBotReady) {
        logger.info("Bot configured but not ready, skipping initial round check until bot is ready.");
    } else {
        logger.info("Bot not configured, skipping initial round check.");
    }
}

/**
 * Starts or restarts the countdown timer for the current round.
 * @param {boolean} useRemainingTime - If true, calculate based on endTime, else use ROUND_DURATION.
 */
function startRoundTimer(useRemainingTime = false) {
    if (roundTimer) clearInterval(roundTimer);
    if (!currentRound || currentRound.status !== 'active') {
        logger.warn("Cannot start timer: No active round or round status invalid.", { roundId: currentRound?.roundId, status: currentRound?.status });
        return;
    }

    let timeLeft;
    let calculatedEndTime;

    try { // Add try-catch around date calculations
        if (useRemainingTime && currentRound.endTime) {
            calculatedEndTime = new Date(currentRound.endTime);
            timeLeft = Math.max(0, Math.floor((calculatedEndTime.getTime() - Date.now()) / 1000));
            logger.info(`Resuming timer for round ${currentRound.roundId} with ${timeLeft}s remaining.`);
        } else {
            timeLeft = ROUND_DURATION;
            calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
            currentRound.endTime = calculatedEndTime; // Set end time on the in-memory object
            // Save end time asynchronously
            Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
                .catch(e => logger.error(`Error saving round end time for round ${currentRound?.roundId}:`, { error: e.message, stack: e.stack }));
            logger.info(`Starting timer for round ${currentRound.roundId} (${ROUND_DURATION}s). End time: ${calculatedEndTime.toISOString()}`);
        }
    } catch (dateError) {
        logger.error("Error calculating timer end time:", { error: dateError.message, stack: dateError.stack, currentRoundEndTime: currentRound?.endTime });
        // Attempt to recover by starting fresh timer
        timeLeft = ROUND_DURATION;
        calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
        currentRound.endTime = calculatedEndTime;
         Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
            .catch(e => logger.error(`Error saving recovered round end time for round ${currentRound?.roundId}:`, { error: e.message, stack: e.stack }));
         logger.warn(`Recovered by starting fresh timer for round ${currentRound.roundId}.`);
    }
        io.emit('timerUpdate', { timeLeft }); // Initial emit

    roundTimer = setInterval(async () => {
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) {
            clearInterval(roundTimer); roundTimer = null;
            logger.warn("Timer stopped: Round state became invalid during countdown.");
            return;
        }
        const now = Date.now();
        let currenttimeLeft = 0;
        try {
             currenttimeLeft = Math.max(0, Math.floor((new Date(currentRound.endTime).getTime() - now) / 1000));
        } catch (intervalDateError){
             logger.error("Error calculating time left in timer interval:", { error: intervalDateError.message, roundEndTime: currentRound.endTime });
             clearInterval(roundTimer); roundTimer = null;
             // Potentially try to end the round immediately if end time is invalid
             await endRound();
             return;
        }

        io.emit('timerUpdate', { timeLeft: currenttimeLeft });
        if (currenttimeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null;
            logger.info(`Round ${currentRound.roundId} timer reached zero.`);
            await endRound(); // Trigger round ending process
        }
    }, 1000);
}
    /**
 * Handles the process of ending the current round, calculating the winner, applying tax, and initiating payout.
 */
async function endRound() {
    if (!currentRound || isRolling || currentRound.status !== 'active') {
        logger.warn(`Attempted to end round ${currentRound?.roundId}, but state is invalid`, { status: currentRound?.status, isRolling });
        return;
    }

    isRolling = true; // Set rolling flag immediately
    const roundIdToEnd = currentRound.roundId;
    const roundMongoId = currentRound._id;
    logger.info(`--- Ending round ${roundIdToEnd}... ---`);

    let session; // For database transaction
    try {
        // --- Mark Round as Rolling ---
        await Round.updateOne({ _id: roundMongoId, status: 'active' }, { $set: { status: 'rolling', endTime: new Date() } }); // Ensure we only update if still active
        io.emit('roundRolling', { roundId: roundIdToEnd });
        logger.info(`Round ${roundIdToEnd} marked as rolling.`);

        // --- Fetch Full Round Data ---
        const round = await Round.findById(roundMongoId)
            .populate('participants.user')
            .populate('items')
            .lean(); // Use lean for performance

        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);
        if (round.status !== 'rolling') {
            // Should not happen if the updateOne above worked correctly, but good safeguard
            logger.warn(`Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Aborting endRound.`);
            isRolling = false; // Reset flag
            return;
        }
        currentRound = round; // Update in-memory state with full data

        // --- Handle Empty Round ---
        if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            logger.info(`Round ${round.roundId} ended with no valid participants or value.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date() } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants." });
            isRolling = false;
            setTimeout(createNewRound, 5000); // Schedule next round
            return;
        }
javascript        // --- Tax Calculation ---
        let finalItems = [...round.items]; // Copy items array
        let finalTotalValue = round.totalValue;
        let taxAmount = 0;
        let taxedItemsInfo = [];
        let itemsToTakeForTaxIds = new Set(); // Use Set for efficient lookup

        if (finalTotalValue >= MIN_POT_FOR_TAX) {
            const targetTaxValue = finalTotalValue * (TAX_MIN_PERCENT / 100);
            const maxTaxValue = finalTotalValue * (TAX_MAX_PERCENT / 100);
            // Sort items by price ascending to take cheapest first
            const sortedItems = [...finalItems].sort((a, b) => (a.price || 0) - (b.price || 0));
            let currentTaxValue = 0;

            for (const item of sortedItems) {
                 // Ensure item has a valid ID and price
                if (!item?._id || typeof item.price !== 'number' || item.price < 0) {
                    logger.warn(`Skipping item in tax calculation due to missing data/invalid price`, { roundId: round.roundId, itemId: item?._id, itemPrice: item?.price });
                    continue;
                }

                if (currentTaxValue + item.price <= maxTaxValue) {
                    itemsToTakeForTaxIds.add(item._id.toString()); // Add ID to set
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price });
                    currentTaxValue += item.price;
                    if (currentTaxValue >= targetTaxValue) break; // Stop if target reached or exceeded
                } else {
                    // Stop if adding the next cheapest item would exceed max tax
                    break;
                }
            }

            if (itemsToTakeForTaxIds.size > 0) {
                // Filter out the taxed items from the items to be given to the winner
                finalItems = finalItems.filter(item => !itemsToTakeForTaxIds.has(item._id.toString()));
                taxAmount = currentTaxValue; // Actual value of items taken
                finalTotalValue -= taxAmount; // Adjust final pot value
                logger.info(`Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${itemsToTakeForTaxIds.size} items). New Pot Value: $${finalTotalValue.toFixed(2)}`);
            }
        }

        // --- Winner Calculation (Provably Fair) ---
        const clientSeed = crypto.randomBytes(16).toString('hex'); // Generate fresh client seed
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16);
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);

        if (totalTickets <= 0) throw new Error(`Cannot determine winner: Total tickets is zero or invalid for round ${round.roundId}.`);

        const winningTicket = decimalFromHash % totalTickets;
        let cumulativeTickets = 0;
        let winner = null;

        for (const participant of round.participants) {
            if (!participant?.tickets || !participant.user?._id) { // Check user._id exists
                 logger.warn(`Skipping participant in winner calculation due to missing data`, { roundId: round.roundId, participantUserId: participant?.user?._id, participantTickets: participant?.tickets });
                continue; // Skip participant if data is missing
            }
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winner = participant.user; // Winner is the populated user object
                break;
            }
        }
        if (!winner) throw new Error(`Winner selection failed for round ${round.roundId}. Winning Ticket: ${winningTicket}, Total Tickets: ${totalTickets}`);
javascript        // --- Final Database Update ---
        const finalUpdateData = {
            status: 'completed', completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winner._id, // Store winner's ID
            taxAmount: taxAmount, taxedItems: taxedItemsInfo, totalValue: Math.max(0, finalTotalValue), // Ensure non-negative
            items: finalItems.map(i => i._id) // Store IDs of remaining items
        };
        await Round.updateOne({ _id: roundMongoId }, { $set: finalUpdateData });
        
        // Update winner's totalWon value
        await User.updateOne(
            { _id: winner._id },
            { $inc: { totalWon: finalTotalValue } }
        );
        
        logger.info(`Round ${round.roundId} completed. Winner: ${winner.username} (Ticket: ${winningTicket}/${totalTickets}, Value: $${finalTotalValue.toFixed(2)})`);

        // --- Emit Winner Information ---
        io.emit('roundWinner', {
            roundId: round.roundId,
            winner: { id: winner._id, steamId: winner.steamId, username: winner.username, avatar: winner.avatar },
            winningTicket: winningTicket, totalValue: finalTotalValue, totalTickets: totalTickets,
            serverSeed: round.serverSeed, clientSeed: clientSeed, provableHash: provableHash, serverSeedHash: round.serverSeedHash
        });

        // --- Initiate Payout ---
        await sendWinningTradeOffer(round, winner, finalItems); // Pass the filtered items

    } catch (err) {
        logger.error(`CRITICAL ERROR during endRound for round ${roundIdToEnd}:`, { error: err.message, stack: err.stack });
        try {
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error' } });
            io.emit('roundError', { roundId: roundIdToEnd, error: 'Internal server error during round finalization.' });
            // TODO: Implement admin notification/queue for failed rounds requiring manual review/payout.
        } catch (saveErr) {
            logger.error(`Failed to mark round ${roundIdToEnd} as error after initial error:`, { error: saveErr.message, stack: saveErr.stack });
        }
        // TODO: Consider if winner payout should be retried automatically or manually
    } finally {
        // if (session) session.endSession(); // End transaction session if used
        isRolling = false; // Reset rolling flag regardless of success/failure
        logger.info(`Scheduling next round creation after round ${roundIdToEnd} finalization attempt.`);
        // Delay slightly longer to allow winner info display on frontend
        setTimeout(createNewRound, 15000); // e.g., 15 seconds
    }
}
 /**
 * Sends the winning trade offer to the winner.
 * @param {object} round - The completed Round lean object.
 * @param {object} winner - The populated User lean object for the winner.
 * @param {Array} itemsToSend - Array of lean Item objects to send (after tax).
 */
async function sendWinningTradeOffer(round, winner, itemsToSend) {
    if (!isBotReady) {
        logger.error(`PAYOUT_ERROR: Cannot send winnings for round ${round.roundId}: Steam Bot is not ready.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Bot Error: Payout for round ${round.roundId} requires manual processing. Contact support.` });
        return;
    }
    if (!winner.tradeUrl) {
        logger.error(`PAYOUT_ERROR: Cannot send winnings for round ${round.roundId}: Winner ${winner.username} has no Trade URL set.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Please set your Trade URL in your profile to receive winnings.' });
        return;
    }
    if (!itemsToSend || itemsToSend.length === 0) {
        logger.info(`PAYOUT_INFO: No items to send for round ${round.roundId}.`, { taxAmount: round.taxAmount, finalPotValue: round.totalValue });
        if (round.taxAmount > 0 && round.totalValue <= 0) { // If tax took everything
            io.emit('notification', { type: 'info', userId: winner._id.toString(), message: `Round ${round.roundId} winnings ($${round.taxAmount.toFixed(2)}) were processed as site tax.` });
        }
        return;
    }

    logger.info(`Attempting to send ${itemsToSend.length} winning items for round ${round.roundId} to ${winner.username}...`);

    try {
        const offer = manager.createOffer(winner.tradeUrl);
        offer.addMyItems(itemsToSend.map(item => ({
            assetid: item.assetId,
            appid: RUST_APP_ID,
            contextid: RUST_CONTEXT_ID
        })));
        offer.setMessage(`Congratulations! Your winnings from Round #${round.roundId} on ${process.env.SITE_NAME || 'RustyDegen'}. Pot Value (after tax): $${round.totalValue.toFixed(2)}`);

        // Create trade history record before sending
        const tradeItems = itemsToSend.map(item => ({
            assetId: item.assetId,
            name: item.name,
            image: item.image,
            price: item.price
        }));
        
        // This will be the trade history entry
        const winningsTrade = new Trade({
            user: winner._id,
            type: 'winnings',
            roundId: round._id,
            totalValue: round.totalValue,
            items: tradeItems,
            status: 'pending',
            createdAt: new Date()
        });

        const identitySecret = process.env.STEAM_IDENTITY_SECRET;
        // Use async/await for cleaner flow
        const saveTradePromise = winningsTrade.save();
        
        // Send offer after trade is saved
        offer.send(!!identitySecret, async (err, status) => {
            try {
                // Get saved trade object
                const savedTrade = await saveTradePromise;
                
                if (err) {
                    // Log detailed error including EResult
                    logger.error(`PAYOUT_ERROR: Error sending trade offer ${offer.id || 'N/A'} for round ${round.roundId}:`, {
                        eresult: err.eresult,
                        message: err.message,
                        stack: err.stack,
                        winner: winner.steamId
                    });
                    
                    // Update trade record with error status
                    await Trade.findByIdAndUpdate(savedTrade._id, { 
                        status: 'error',
                        updatedAt: new Date()
                    });
                    
                    // Handle specific, common errors
                    let userMessage = `Error sending winnings for round ${round.roundId}. Please contact support.`;
                    if (err.message.includes('revoked') || err.message.includes('invalid') || err.eresult === 26) {
                        userMessage = 'Your Trade URL is invalid or expired. Please update it to receive winnings.';
                    } else if (err.eresult === 15 || err.eresult === 16) {
                        userMessage = 'Could not send winnings. Ensure your Steam inventory is public and not full.';
                    } else if (err.message?.includes('escrow') || err.eresult === 11) {
                        // Escrow isn't strictly an error, but notify user
                        userMessage = `Winnings sent (Offer #${offer.id}), but may be held in escrow by Steam. Ensure Steam Guard Mobile Authenticator has been active for 7 days.`;
                        io.emit('notification', { type: 'warning', userId: winner._id.toString(), message: userMessage });
                        // Still emit tradeOfferSent below for escrow cases
                    } else {
                        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: userMessage });
                    }
                    return; // Stop if send fails initially
                } // End if (err)
               // If we get here, the offer was sent successfully
                // Update trade record with offer ID
                await Trade.findByIdAndUpdate(savedTrade._id, { 
                    offerId: offer.id,
                    status: status === 'pending' || status === 'pendingConfirmation' ? 'pending' : 'accepted',
                    updatedAt: new Date()
                });

                // Send was successful (or pending confirmation)
                logger.info(`PAYOUT_SUCCESS: Trade offer ${offer.id} sent to ${winner.username} for round ${round.roundId}. Status: ${status}`);
                const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;

                io.emit('tradeOfferSent', {
                    roundId: round.roundId,
                    userId: winner._id.toString(),
                    username: winner.username,
                    offerId: offer.id,
                    offerURL: offerURL, // Send URL to client
                    status: status,
                    type: 'winnings',
                    totalValue: round.totalValue,
                    items: tradeItems
                });

                // Handle confirmation pending status
                if (status === 'pending' || status === 'pendingConfirmation') {
                    logger.warn(`Offer #${offer.id} requires confirmation (Status: ${status}). Check mobile authenticator if auto-confirmation is not setup or failed.`);
                    let notificationType = 'info';
                    let notificationMessage = `Winnings sent (Offer #${offer.id}), but require confirmation in Steam.`;
                    if (identitySecret) { // Auto-confirm was likely attempted
                        notificationType = 'warning';
                        notificationMessage = `Winnings sent (Offer #${offer.id}), but confirmation may be needed in Steam. Check your authenticator.`;
                    }
                    io.emit('notification', { type: notificationType, userId: winner._id.toString(), message: notificationMessage });
                }
            } catch (dbError) {
                logger.error(`PAYOUT_DB_ERROR: Failed to update trade record for offer ${offer.id}:`, {
                    error: dbError.message,
                    stack: dbError.stack,
                    winner: winner._id
                });
            }
        }); // End offer.send callback

    } catch (err) {
        // General catch for errors during offer *creation* (before sending)
        logger.error(`PAYOUT_ERROR: Unexpected error creating trade offer for round ${round.roundId}:`, { error: err.message, stack: err.stack });
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Error creating winnings offer for round ${round.roundId}. Please contact support.` });
    }
}
javascript// --- Authentication Routes ---
app.get('/auth/steam', authLimiter, passport.authenticate('steam', { failureRedirect: '/' }));

app.get('/auth/steam/return',
    authLimiter, // Also limit the return route
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => {
        // On successful auth, redirect home. Session is established.
        res.redirect('/');
    });

app.post('/logout', (req, res, next) => { // Changed to POST as it modifies state
    // CSRF token verification handled by csurf middleware
    req.logout(err => {
        if (err) {
            logger.error("Error during req.logout:", err);
            return next(err); // Pass to error handler
        }
        req.session.destroy(err => {
            if (err) {
                logger.error("Error destroying session during logout:", err);
                // Don't expose internal error details
                return res.status(500).json({ error: 'Logout failed due to server error.' });
            }
            res.clearCookie('connect.sid'); // Use the default session cookie name
            res.json({ success: true });
        });
    });
});
javascript// --- Middleware & API Routes ---
function ensureAuthenticated(req, res, next) {
    if (req.isAuthenticated()) { return next(); }
    res.status(401).json({ error: 'Not authenticated' });
}

// Helper Middleware for validation results
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn("Validation Errors:", { errors: errors.array(), route: req.originalUrl, ip: req.ip });
        // Send only the first error message for simplicity
        return res.status(400).json({ error: errors.array()[0].msg });
    }
    next();
};

// GET CSRF Token endpoint (for SPAs that need to fetch it)
app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// GET User Profile
// Apply general limiter, ensure authenticated
app.get('/api/user', generalApiLimiter, ensureAuthenticated, (req, res) => {
    // Return only necessary, non-sensitive user data
    const { _id, steamId, username, avatar, tradeUrl, balance, createdAt, pendingDepositOfferId, totalDeposited, totalWon } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, balance, createdAt, pendingDepositOfferId, totalDeposited, totalWon });
});

// POST Update Trade URL
// Apply stricter limiter, ensure authenticated, CSRF protection, validation
app.post('/api/user/tradeurl',
    sensitiveActionLimiter,
    ensureAuthenticated,
    // csurf middleware applied globally handles token check here for form submissions
    [
        body('tradeUrl')
            .trim()
            .custom((value) => {
                if (value === '') return true; // Allow empty string
                const urlPattern = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/;
                if (!urlPattern.test(value)) {
                    throw new Error('Invalid Steam Trade URL format. Must include partner and token, or be empty.');
                }
                return true;
            })
    ],
    handleValidationErrors,
    async (req, res) => {
        const { tradeUrl } = req.body;
        try {
            const updatedUser = await User.findByIdAndUpdate(
                req.user._id,
                { tradeUrl: tradeUrl },
                { new: true, runValidators: true }
            );
            if (!updatedUser) {
                // User not found, which shouldn't happen if authenticated
                logger.error(`User not found during trade URL update`, { userId: req.user._id });
                return res.status(404).json({ error: 'User not found.' });
            }
            logger.info(`Trade URL updated for user: ${updatedUser.username}`);
            res.json({ success: true, tradeUrl: updatedUser.tradeUrl });
        } catch (err) {
            logger.error(`Error updating trade URL for user ${req.user._id}:`, { error: err.message, stack: err.stack });
            // Avoid sending detailed Mongoose errors
            res.status(500).json({ error: 'Server error saving Trade URL.' });
        }
    });
javascript// GET User Inventory
// Apply general limiter, ensure authenticated
app.get('/api/inventory', generalApiLimiter, ensureAuthenticated, async (req, res) => {
    if (!isBotReady) {
        logger.warn(`Inventory fetch failed for ${req.user.username}: Bot service is unavailable.`);
        return res.status(503).json({ error: "Steam service temporarily unavailable. Please try again later." });
    }
    try {
        const inventory = await new Promise((resolve, reject) => {
            manager.getUserInventoryContents(req.user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                if (err) {
                    let userMessage = `Could not fetch inventory. Steam might be busy or inventory private.`;
                    if (err.message?.includes('profile is private') || err.eresult === 15) {
                        userMessage = 'Your Steam inventory is private. Please set it to public.';
                    }
                    logger.warn(`Inventory Fetch Error (Manager): User ${req.user.steamId}:`, { eresult: err.eresult, message: err.message });
                    return reject(new Error(userMessage)); // Reject with user-friendly message
                }
                resolve(inv || []);
            });
        });

        // logger.debug(`Raw inventory items count for ${req.user.username}: ${inventory?.length}`);

        const validItems = inventory
            .map(item => {
                const itemName = item.market_hash_name;
                if (!itemName) { /* logger.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`); */ return null; } // Minimal logging

                let price = getItemPrice(itemName);
                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

                if (!item.assetid || !item.icon_url) {
                    // logger.warn(`Inventory item missing required properties: assetId ${item?.assetid}, Name ${itemName}, Icon ${item?.icon_url}`);
                    return null;
                }
                if (!item.tradable || finalPrice < MIN_ITEM_VALUE) {
                    return null; // Filter non-tradables and low value items early
                }

                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`;
                return {
                    assetId: item.assetid,
                    name: itemName,
                    displayName: item.name,
                    image: imageUrl,
                    price: finalPrice,
                    tradable: item.tradable,
                    marketable: item.marketable
                };
            })
            .filter(item => item !== null); // Filter out nulls resulting from checks

        // logger.debug(`Processed validItems count for ${req.user.username}: ${validItems.length}`);
        res.json(validItems);

    } catch (err) {
        logger.error(`Error in /api/inventory for ${req.user?.username || req.user?.steamId}:`, { error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message || 'Server error fetching inventory.' }); // Send sanitized error message
    }
});
javascript// GET User Trade History
// Apply general limiter, ensure authenticated
app.get('/api/trades', generalApiLimiter, ensureAuthenticated, async (req, res) => {
    try {
        // Find all trades for the current user
        const trades = await Trade.find({ user: req.user._id })
            .sort({ createdAt: -1 }) // Most recent first
            .lean();
        
        res.json({ success: true, trades });
    } catch (err) {
        logger.error(`Error fetching trade history for user ${req.user._id}:`, { error: err.message, stack: err.stack });
        res.status(500).json({ error: 'Server error fetching trade history.' });
    }
});

// PUT Update Trade Status (for handling trade offer status updates)
app.put('/api/trades/:offerId/status', 
    sensitiveActionLimiter,
    ensureAuthenticated,
    [
        param('offerId').isString().notEmpty().withMessage('Valid offer ID is required'),
        body('status').isIn(['accepted', 'declined', 'expired', 'canceled']).withMessage('Valid status is required')
    ],
    handleValidationErrors,
    async (req, res) => {
        const { offerId } = req.params;
        const { status } = req.body;
        
        try {
            // Find the trade and verify ownership
            const trade = await Trade.findOne({ offerId, user: req.user._id });
            
            if (!trade) {
                return res.status(404).json({ error: 'Trade offer not found or not authorized' });
            }
            
            // Update status
            trade.status = status;
            trade.updatedAt = new Date();
            await trade.save();
            
            // Emit update to socket
            io.emit('tradeStatusUpdated', {
                userId: req.user._id.toString(),
                offerId,
                status
            });
            
            res.json({ success: true });
        } catch (err) {
            logger.error(`Error updating trade status for offer ${offerId}:`, { error: err.message, stack: err.stack });
            res.status(500).json({ error: 'Server error updating trade status.' });
        }
    }
);

// Apply deposit limiter, ensure authenticated, CSRF protection, validation
app.post('/api/deposit',
    depositLimiter,
    ensureAuthenticated,
    [
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`You can deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items at a time.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).matches(/^[0-9]+$/).withMessage('Invalid asset ID format.')
    ],
    handleValidationErrors,
    async (req, res) => {
        const user = req.user;
        const requestedAssetIds = req.body.assetIds;

        // --- Pre-Checks ---
        if (!isBotReady) {
            return res.status(503).json({ error: "Deposit service temporarily unavailable (Bot offline)." });
        }
        if (!user.tradeUrl) {
            return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile before depositing.' });
        }

        // Check for existing pending offer (more robust check)
        if (user.pendingDepositOfferId) {
            try {
                const offer = await manager.getOffer(user.pendingDepositOfferId);
                if (offer && [TradeOfferManager.ETradeOfferState.Active, TradeOfferManager.ETradeOfferState.Sent, TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation].includes(offer.state)) {
                    logger.info(`User ${user.username} already has pending deposit offer ${user.pendingDepositOfferId}. State: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
                    const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                    return res.status(409).json({
                        error: 'You already have an active deposit offer waiting. Please accept or decline it on Steam before creating a new one.',
                        offerId: user.pendingDepositOfferId, offerURL: offerURL
                    });
                } else {
                    logger.info(`Clearing stale pending offer ${user.pendingDepositOfferId} for user ${user.username} (State: ${TradeOfferManager.ETradeOfferState[offer?.state]}).`);
                    await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
                }
            } catch (offerFetchError) {
                if (offerFetchError.message !== 'NoMatch') { // Ignore "NoMatch" error, means offer not found
                     logger.warn(`Could not fetch pending offer ${user.pendingDepositOfferId}, clearing flag:`, { error: offerFetchError.message });
                }
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
            }
        }

        // Check Round Status/Limits
        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }
        // Fetch latest limits directly from DB to mitigate race conditions
         let latestRoundData;
         try {
             latestRoundData = await Round.findById(currentRound._id).select('participants items').lean().exec();
             if (!latestRoundData) throw new Error('Could not fetch current round data for limits check.');
             const isNewParticipant = !latestRoundData.participants.some(p => p.user?.toString() === user._id.toString());
             if (isNewParticipant && latestRoundData.participants.length >= MAX_PARTICIPANTS) {
                 return res.status(400).json({ error: `Participant limit (${MAX_PARTICIPANTS}) reached.` });
             }
             if ((latestRoundData.items?.length || 0) + requestedAssetIds.length > MAX_ITEMS_PER_POT) {
                const slotsLeft = MAX_ITEMS_PER_POT - (latestRoundData.items?.length || 0);
                 return res.status(400).json({ error: `Depositing ${requestedAssetIds.length} items would exceed the pot limit (${MAX_ITEMS_PER_POT}). Only ${slotsLeft} slots left.` });
             }
         } catch (dbErr) {
            logger.error(`Error fetching round data during deposit for ${user.username}:`, { error: dbErr.message, stack: dbErr.stack });
            return res.status(500).json({ error: 'Internal server error checking round limits. Please try again.' });
         }
javascript        // --- Verify Items and Calculate Value ---
        let itemsToRequest = [];
        let depositTotalValue = 0;
        let verificationErrorMsg = null;
        try {
            const userInventory = await new Promise((resolve, reject) => {
                 manager.getUserInventoryContents(user.steamId, RUST_APP_ID, RUST_CONTEXT_ID, true, (err, inv) => {
                    if (err) {
                        let userMessage = `Could not fetch your inventory. Ensure it's public and try again.`;
                         if (err.message?.includes('profile is private') || err.eresult === 15) { userMessage = 'Your Steam inventory is private. Please set it to public.'; }
                         logger.warn(`Inventory Fetch Error (Deposit Verification): User ${user.steamId}:`, { eresult: err.eresult, message: err.message });
                        return reject(new Error(userMessage));
                    }
                     resolve(inv || []);
                 });
            });
            const userInventoryMap = new Map(userInventory.map(item => [item.assetid, item]));

            for (const assetId of requestedAssetIds) {
                const inventoryItem = userInventoryMap.get(assetId);
                if (!inventoryItem) { verificationErrorMsg = `Item with Asset ID ${assetId} not found in your current Steam inventory.`; break; }
                if (!inventoryItem.tradable) { verificationErrorMsg = `Item '${inventoryItem.market_hash_name}' (ID: ${assetId}) is currently not tradable.`; break; }

                const price = getItemPrice(inventoryItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) { verificationErrorMsg = `Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below the minimum deposit value ($${MIN_ITEM_VALUE.toFixed(2)}).`; break; }

                itemsToRequest.push({
                    assetid: inventoryItem.assetid, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID,
                    _price: price, _name: inventoryItem.market_hash_name, _image: `https://community.akamai.steamstatic.com/economy/image/${inventoryItem.icon_url}`
                });
                depositTotalValue += price;
            }
            if (verificationErrorMsg) throw new Error(verificationErrorMsg); // Throw if any item failed
            if (itemsToRequest.length === 0) throw new Error("None of the selected items could be verified for deposit.");

            logger.info(`Verified ${itemsToRequest.length} items for deposit for ${user.username}. Total Value: $${depositTotalValue.toFixed(2)}`);

        } catch (verificationError) {
            logger.warn(`Deposit item verification failed for ${user.username}:`, { error: verificationError.message });
            return res.status(400).json({ error: verificationError.message }); // Send specific verification error
        }

        // --- Create and Send Trade Offer ---
        const depositId = uuidv4();
        const offerMessage = `RustyDegen Deposit ID: ${depositId} | Round: ${currentRound.roundId}`;
        let cleanupTimeoutId = null; // Changed variable name
            try {
            const offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsToRequest.map(({ assetid, appid, contextid }) => ({ assetid, appid, contextid })));
            offer.setMessage(offerMessage);

            // Store pending deposit details *before* sending offer
            const pendingData = {
                userId: user._id, roundId: currentRound._id, items: itemsToRequest,
                totalValue: depositTotalValue, steamId: user.steamId, offerId: null // offerId will be set after sending
            };
            pendingDeposits.set(depositId, pendingData);
            logger.info(`Stored pending deposit ${depositId} for user ${user.steamId}.`);

            // Create the trade history entry
            const tradeItems = itemsToRequest.map(item => ({
                assetId: item.assetid,
                name: item._name,
                image: item._image,
                price: item._price
            }));
            
            const depositTrade = new Trade({
                user: user._id,
                type: 'deposit',
                roundId: currentRound._id,
                totalValue: depositTotalValue,
                items: tradeItems,
                status: 'pending',
                createdAt: new Date()
            });
            
            const saveTradePromise = depositTrade.save();

            // Send the offer
            logger.info(`Sending deposit offer to ${user.username}...`);
            await new Promise((resolve, reject) => { // Wrap send in promise
                 offer.send((err, status) => {
                     if (err) {
                        logger.error(`Error initially sending deposit offer ${offer.id || 'N/A'} for DepositID ${depositId}:`, { eresult: err.eresult, message: err.message });
                        return reject(err); // Reject the promise on error
                    }
                     pendingData.offerId = offer.id; // Store offer ID after successful send initiation
                     logger.info(`Deposit offer ${offer.id} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);
                     resolve(status); // Resolve the promise on success
                 });
            });

            // Update trade record with offer ID
            const savedTrade = await saveTradePromise;
            await Trade.findByIdAndUpdate(savedTrade._id, { 
                offerId: pendingData.offerId,
                updatedAt: new Date()
            });

            // Offer sent successfully - Update user's pending offer ID in DB
            await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: pendingData.offerId });
            logger.info(`Set pendingDepositOfferId=${pendingData.offerId} for user ${user.username}.`);

            // Set timeout AFTER successfully updating DB flag
            cleanupTimeoutId = setTimeout(() => { // Assign to variable
                 if(pendingDeposits.has(depositId)) {
                     const expiredData = pendingDeposits.get(depositId);
                     logger.warn(`Deposit attempt ${depositId} (Offer ${expiredData?.offerId}) expired.`);
                     pendingDeposits.delete(depositId);
                     // Clear user flag only if it still matches the expired offer ID
                     User.updateOne({ _id: expiredData.userId, pendingDepositOfferId: expiredData.offerId }, { pendingDepositOfferId: null })
                         .catch(e => logger.error("Error clearing user flag on expiry timeout:", { userId: expiredData.userId, offerId: expiredData.offerId, error: e.message }));
                     
                     // Update trade status to expired
                     Trade.updateOne({ offerId: expiredData.offerId }, { status: 'expired', updatedAt: new Date() })
                         .catch(e => logger.error("Error updating trade status on expiry:", { offerId: expiredData.offerId, error: e.message }));
                 }
            }, manager.cancelTime || 10 * 60 * 1000);
            // Store timeout ID with pending data for potential cancellation
            pendingData.cleanupTimeout = cleanupTimeoutId;

            const offerURL = `https://steamcommunity.com/tradeoffer/${pendingData.offerId}/`;
            res.json({ success: true, message: 'Deposit offer created! Please accept it on Steam.', offerId: pendingData.offerId, offerURL: offerURL });

        } catch (error) {
            logger.error(`Error processing deposit request for ${user.username} (DepositID: ${depositId}):`, { eresult: error.eresult, message: error.message, stack: error.stack });
            // Clean up potentially stored pending data and timeout
            if (pendingDeposits.has(depositId)) {
                 const failedData = pendingDeposits.get(depositId);
                 if (failedData.cleanupTimeout) clearTimeout(failedData.cleanupTimeout);
                 pendingDeposits.delete(depositId);
            }
            // Update trade record to error status
            Trade.updateOne(
                { user: user._id, status: 'pending', offerId: { $exists: false } },
                { status: 'error', updatedAt: new Date() }
            ).catch(e => logger.error("Error updating trade status on offer creation failure:", { error: e.message }));
            
            // Attempt to clear user flag just in case it was set before the error
            await User.updateOne({ _id: user._id, pendingDepositOfferId: pendingDeposits.get(depositId)?.offerId }, { pendingDepositOfferId: null })
                 .catch(e => logger.error("Error clearing user flag on deposit offer send fail:", { userId: user._id, error: e.message }));

            let userMessage = 'Failed to create deposit trade offer. Please try again later.';
            if (error.message.includes('Trade URL') || error.message.includes('token') || error.eresult === 26) { userMessage = 'Your Steam Trade URL might be invalid or expired. Please check it in your profile.'; }
            // Add more specific error handling based on EResult if needed
            else if (error.eresult) { userMessage += ` (Code: ${error.eresult})`; }

            res.status(500).json({ error: userMessage });
        }
    });

// Apply general limiter, validation
app.get('/api/rounds',
    generalApiLimiter,
    [
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
                    .sort('-roundId') // Sort by roundId descending
                    .skip(skip)
                    .limit(limit)
                    .populate('winner', 'username avatar steamId') // Populate only necessary winner fields
                    .select('roundId completedTime totalValue winner serverSeed clientSeed winningTicket status taxAmount') // Select specific fields
                    .lean(),
                Round.countDocuments(queryFilter)
            ]);

            // Exclude sensitive seeds from the response unless specifically requested for verification?
            // For history, maybe only send hash? Decided to send seeds for now for verification ease.
            res.json({
                rounds: rounds, // Already lean objects
                totalPages: Math.ceil(totalCount / limit),
                currentPage: page,
                totalRounds: totalCount
            });
        } catch (err) {
            logger.error('Error fetching past rounds:', { error: err.message, stack: err.stack });
            res.status(500).json({ error: 'Server error fetching round history.' });
        }
    });

// GET Round Details
app.get('/api/rounds/:roundId/details', 
    generalApiLimiter, 
    [
        param('roundId').isInt({ min: 1 }).toInt().withMessage('Round ID must be a positive integer')
    ],
    handleValidationErrors,
    async (req, res) => {
        try {
            const { roundId } = req.params;
            
            const round = await Round.findOne({ roundId })
                .populate('participants.user', 'username avatar steamId')
                .populate('winner', 'username avatar steamId')
                .lean();
                
            if (!round) {
                return res.status(404).json({ error: 'Round not found' });
            }
            
            res.json(round);
        } catch (err) {
            logger.error(`Error fetching round details for ${req.params.roundId}:`, { error: err.message, stack: err.stack });
            res.status(500).json({ error: 'Server error fetching round details.' });
        }
    }
);

// Apply stricter limiter, validation
app.post('/api/verify',
    sensitiveActionLimiter,
    // CSRF protection implicitly handled by global middleware
    [
        body('roundId').notEmpty().isInt({ min: 1 }).toInt(),
        body('serverSeed').trim().notEmpty().isHexadecimal().isLength({ min: 64, max: 64 }),
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 }) // Client seed can vary
    ],
    handleValidationErrors,
    async (req, res) => {
        const { roundId, serverSeed, clientSeed } = req.body;
        try {
            const round = await Round.findOne({ roundId: roundId, status: 'completed' })
                .populate('participants.user', 'username') // Populate needed fields
                .populate('winner', 'username')
                .lean();

            if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found.` });
            if (!round.serverSeed || !round.clientSeed || !round.provableHash) {
                return res.status(400).json({ error: `Provably fair data not available for round #${roundId}.` });
            }

            // 1. Verify Server Seed Hash (using the provided seed)
            const providedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
            if (providedHash !== round.serverSeedHash) {
                return res.json({ verified: false, reason: 'Server Seed does not match the recorded Server Seed Hash.', serverSeedHash: round.serverSeedHash });
            }
            // 2. Verify Seeds Match Record
            if (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed) {
                return res.json({ verified: false, reason: 'Provided seeds do not match the official round seeds.' });
            }
            // 3. Recalculate Winning Ticket (using provided seeds)
            const combinedString = serverSeed + clientSeed;
            const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
            if (calculatedProvableHash !== round.provableHash) {
                return res.json({ verified: false, reason: 'Calculated Provable Hash does not match recorded hash.', expectedProvableHash: round.provableHash, calculatedProvableHash });
            }

            const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
            const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;
            if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets.' });
            const calculatedWinningTicket = decimalFromHash % totalTickets;

            // 4. Compare Calculated vs Actual Ticket
            if (calculatedWinningTicket !== round.winningTicket) {
                return res.json({ verified: false, reason: 'Calculated winning ticket does not match the recorded winning ticket.', calculatedWinningTicket, actualWinningTicket: round.winningTicket });
            }

            // If all checks pass
            res.json({
                verified: true, roundId: round.roundId, serverSeed: serverSeed, serverSeedHash: round.serverSeedHash, clientSeed: clientSeed,
                combinedString: combinedString, finalHash: calculatedProvableHash, winningTicket: calculatedWinningTicket,
                totalTickets: totalTickets, totalValue: round.totalValue, winnerUsername: round.winner?.username || 'N/A'
            });
        } catch (err) {
            logger.error(`Error verifying round ${roundId}:`, { error: err.message, stack: err.stack });
            res.status(500).json({ error: 'Server error during verification.' });
        }
    });

if (isBotConfigured && manager) {

    manager.on('newOffer', async (offer) => {
        if (!isBotReady) return;
        if (offer.isOurOffer) return; // Ignore offers sent by the bot itself

        // Auto-decline unsolicited offers (donations / manual deposits)
        if (offer.itemsToReceive && offer.itemsToReceive.length > 0 && (!offer.itemsToGive || offer.itemsToGive.length === 0)) {
            logger.info(`Received unsolicited incoming offer #${offer.id} from ${offer.partner.getSteamID64()}. Declining.`);
            return offer.decline((err) => {
                if (err) logger.error(`Error declining unsolicited offer ${offer.id}:`, { error: err.message });
            });
        }

        // Handle other unexpected incoming offers if necessary
        logger.warn(`Ignoring unexpected incoming offer #${offer.id} from ${offer.partner.getSteamID64()}.`);
        // Optionally decline: offer.decline().catch(e => logger.error(`Error declining unexpected offer ${offer.id}:`, e));
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        if (offer.state !== oldState) {
            logger.info(`Bot Offer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]}`, { partner: offer.partner.getSteamID64(), message: offer.message });
        }

        // --- Handle ACCEPTED DEPOSIT Offers ---
        if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
            const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
            const depositId = messageMatch ? messageMatch[1] : null;

            if (depositId && pendingDeposits.has(depositId)) {
                const depositData = pendingDeposits.get(depositId);

                // --- Critical Section: Process Deposit ---
                let depositSession; // For transaction
                try {
                    logger.info(`Processing accepted deposit offer #${offer.id} (DepositID: ${depositId})`, { userSteamId: depositData.steamId });

                    // Immediately remove from pending map and clear timeout to prevent duplicates/expiry issues
                    if (depositData.cleanupTimeout) clearTimeout(depositData.cleanupTimeout);
                    pendingDeposits.delete(depositId);

                    // --- Start Transaction (Conceptual) ---
                    // depositSession = await mongoose.startSession();
                    // depositSession.startTransaction();

                    // Clear user's pending flag (do this early)
                    await User.updateOne({ _id: depositData.userId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null } /*, { session: depositSession } */);
                     logger.info(`Cleared pendingDepositOfferId flag for user ${depositData.steamId} (Offer ${offer.id})`);

                    // Fetch round and check status/limits again right before update
                    const depositRound = await Round.findById(depositData.roundId) /* .session(depositSession) */ ; // Add session if using transactions
                    if (!depositRound) throw new Error(`Round ${depositData.roundId} not found for deposit ${depositId}.`);
                    if (depositRound.status !== 'active' || isRolling) {
                        throw new Error(`Round ${depositData.roundId} no longer active for deposit ${depositId}. Status: ${depositRound.status}, Rolling: ${isRolling}.`);
                    }
                    
                    // Re-check limits
                    const isNewParticipantCheck = !depositRound.participants.some(p => p.user?.toString() === depositData.userId.toString());
                    if (isNewParticipantCheck && depositRound.participants.length >= MAX_PARTICIPANTS) {
                        throw new Error(`Participant limit reached just before inserting deposit ${depositId}.`);
                    }
                    if (depositRound.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                        const slotsLeft = MAX_ITEMS_PER_POT - depositRound.items.length;
                        throw new Error(`Pot item limit reached just before inserting deposit ${depositId}. Only ${slotsLeft} slots left.`);
                    }

                    // Insert Item documents
                    const itemDocuments = depositData.items.map(itemData => new Item({
                        assetId: itemData.assetid, name: itemData._name, image: itemData._image,
                        price: itemData._price, owner: depositData.userId, roundId: depositData.roundId
                    }));
                    const insertedItemsResult = await Item.insertMany(itemDocuments, { ordered: false });
                    const createdItemIds = insertedItemsResult.map(doc => doc._id);
                    logger.info(`Deposit ${depositId}: Inserted ${createdItemIds.length} items into DB.`);

                    // Find participant index or prepare to add
                    let participantIndex = depositRound.participants.findIndex(p => p.user?.toString() === depositData.userId.toString());
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));

                    if (participantIndex !== -1) {
                        depositRound.participants[participantIndex].itemsValue = (depositRound.participants[participantIndex].itemsValue || 0) + depositData.totalValue;
                        depositRound.participants[participantIndex].tickets = (depositRound.participants[participantIndex].tickets || 0) + depositTickets;
                    } else {
                        depositRound.participants.push({ user: depositData.userId, itemsValue: depositData.totalValue, tickets: depositTickets });
                        participantIndex = depositRound.participants.length - 1; // Get new index
                    }

                    // Update round totals and items list
                    depositRound.totalValue = (depositRound.totalValue || 0) + depositData.totalValue;
                    depositRound.items.push(...createdItemIds);

                    // Save the updated round document
                    await depositRound.save();
                    
                    // Update user's totalDeposited value
                    await User.findByIdAndUpdate(
                        depositData.userId, 
                        { $inc: { totalDeposited: depositData.totalValue } }
                    );
                    
                    // Update trade status to accepted
                    await Trade.findOneAndUpdate(
                        { offerId: offer.id },
                        { 
                            status: 'accepted',
                            updatedAt: new Date()
                        }
                    );

                    logger.info(`Deposit ${depositId} successfully processed and saved to round ${depositData.roundId}.`);

                    // --- Emit update to clients (after successful commit) ---
                    const finalRoundData = await Round.findById(depositData.roundId)
                        .populate('participants.user', 'steamId username avatar _id') // Ensure _id is populated
                        .lean();
                    if (!finalRoundData) throw new Error(`Failed to fetch final round data for emission (Deposit ${depositId})`);

                    currentRound = finalRoundData; // Update global state

                    const updatedParticipantData = finalRoundData.participants.find(p => p.user?._id.toString() === depositData.userId.toString());
                    const userInfo = updatedParticipantData?.user;

                    if (updatedParticipantData && userInfo) {
                        io.emit('participantUpdated', {
                            roundId: finalRoundData.roundId, userId: userInfo._id.toString(),
                            username: userInfo.username, avatar: userInfo.avatar,
                            itemsValue: updatedParticipantData.itemsValue, tickets: updatedParticipantData.tickets,
                            totalValue: finalRoundData.totalValue,
                            depositedItems: depositData.items.map(i => ({ assetId: i.assetid, name: i._name, image: i._image, price: i._price }))
                        });
                    } else {
                        logger.error(`Failed to find updated participant data for emission (Deposit ${depositId})`, { userId: depositData.userId });
                    }

                    // Start timer if first participant
                    if (finalRoundData.participants.length === 1 && !roundTimer) {
                        logger.info(`First participant (${userInfo?.username}) joined round ${finalRoundData.roundId} via deposit ${depositId}. Starting timer.`);
                        startRoundTimer();
                    }
              } catch (processingError) {
                    logger.error(`CRITICAL PROCESSING ERROR for accepted deposit ${depositId} (Offer ${offer.id}):`, { error: processingError.message, stack: processingError.stack });

                    // Attempt to clean up user flag if it wasn't cleared
                    await User.updateOne({ _id: depositData.userId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                        .catch(e => logger.error("Error clearing user flag after deposit processing error:", { userId: depositData.userId, offerId: offer.id, error: e.message }));

                    // Update trade status to error
                    await Trade.findOneAndUpdate(
                        { offerId: offer.id },
                        { 
                            status: 'error',
                            updatedAt: new Date()
                        }
                    ).catch(e => logger.error("Error updating trade status on deposit error:", { offerId: offer.id, error: e.message }));

                    // Notify user of failure
                    io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error (Offer #${offer.id}): ${processingError.message.includes('limit reached') || processingError.message.includes('no longer active') ? processingError.message : 'Failed to process your accepted deposit.'} Contact support.` });

                    // IMPORTANT: Items are now in the bot's inventory but NOT in the round.
                    // TODO: Implement robust system to return these items to the user or flag for manual intervention.
                    // Example: sendReturnOffer(depositData.steamId, offer.itemsToReceive, `Deposit failed for Round ${depositData.roundId}: ${processingError.message}`);
                }
                // --- End Critical Section ---

            } // End if (depositId && pendingDeposits)

            // --- Handle ACCEPTED WINNING Offers ---
            else if (offer.itemsToGive && offer.itemsToGive.length > 0 && (!offer.itemsToReceive || offer.itemsToReceive.length === 0)) {
                logger.info(`Payout offer #${offer.id} accepted by recipient ${offer.partner.getSteamID64()}.`);
                
                // Find user and notify confirmation
                try {
                    const user = await User.findOne({ steamId: offer.partner.getSteamID64() }).lean();
                    if (user) {
                        // Update trade status to accepted
                        await Trade.findOneAndUpdate(
                            { offerId: offer.id },
                            { 
                                status: 'accepted',
                                updatedAt: new Date()
                            }
                        );
                        
                        io.emit('notification', { 
                            type: 'success', 
                            userId: user._id.toString(), 
                            message: `Winnings from offer #${offer.id} successfully received!` 
                        });
                        
                        // Also emit trade status update
                        io.emit('tradeStatusUpdated', {
                            userId: user._id.toString(),
                            offerId: offer.id,
                            status: 'accepted'
                        });
                    }
                } catch (e) {
                    logger.error("Error finding user for payout accepted notification:", e);
                }
            }
            // Else: Offer accepted, but not recognized type
            else {
                logger.warn(`Offer #${offer.id} was accepted, but wasn't recognized as a pending deposit or a winnings payout.`, { message: offer.message });
            }
        } 
        else if ([
            TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled,
            TradeOfferManager.ETradeOfferState.Expired, TradeOfferManager.ETradeOfferState.InvalidItems,
            TradeOfferManager.ETradeOfferState.Countered
        ].includes(offer.state))
        {
            const stateName = TradeOfferManager.ETradeOfferState[offer.state];
            logger.warn(`Bot Offer #${offer.id} to ${offer.partner.getSteamID64()} ended unsuccessfully. State: ${stateName}.`);

            // Check if it was a pending deposit offer
            const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
            const depositId = messageMatch ? messageMatch[1] : null;

            if (depositId && pendingDeposits.has(depositId)) {
                const depositData = pendingDeposits.get(depositId);
                logger.warn(`Deposit offer ${offer.id} (DepositID: ${depositId}) was ${stateName}. Cleaning up.`);
                if (depositData.cleanupTimeout) clearTimeout(depositData.cleanupTimeout); // Clear expiry timer
                pendingDeposits.delete(depositId);

                // Clear user's pending flag in DB
                User.updateOne({ _id: depositData.userId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                    .then(updateRes => { if(updateRes.modifiedCount > 0) logger.info(`Cleared pending flag for user ${depositData.steamId} due to offer ${stateName}.`); })
                    .catch(e => logger.error("Error clearing user flag on deposit failure/expiry:", { userId: depositData.userId, offerId: offer.id, error: e.message }));

                // Update trade status
                const tradeStatus = stateName.toLowerCase();
                Trade.findOneAndUpdate(
                    { offerId: offer.id },
                    { 
                        status: tradeStatus === 'invaliditems' ? 'error' : tradeStatus,
                        updatedAt: new Date()
                    }
                ).catch(e => logger.error("Error updating trade status:", { offerId: offer.id, error: e.message }));
                    
                // Notify user
                io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Your deposit offer (#${offer.id}) was ${stateName.toLowerCase()} and was cancelled.` });
                
                // Emit trade status update
                io.emit('tradeStatusUpdated', {
                    userId: depositData.userId.toString(),
                    offerId: offer.id,
                    status: tradeStatus === 'invaliditems' ? 'error' : tradeStatus
                });
            }
            // Check if it was a winnings payout offer
            else if (offer.itemsToGive && offer.itemsToGive.length > 0) {
                logger.warn(`Payout offer #${offer.id} failed. State: ${stateName}. Items returned to bot inventory.`);
                
                // Find user and update trade status
                try {
                    const user = await User.findOne({ steamId: offer.partner.getSteamID64() }).lean();
                    if (user) {
                        // Update trade status
                        const tradeStatus = stateName.toLowerCase();
                        await Trade.findOneAndUpdate(
                            { offerId: offer.id },
                            { 
                                status: tradeStatus === 'invaliditems' ? 'error' : tradeStatus,
                                updatedAt: new Date()
                            }
                        );
                        
                        io.emit('notification', { 
                            type: 'error', 
                            userId: user._id.toString(), 
                            message: `Failed to deliver winnings (Offer #${offer.id}). The offer was ${stateName.toLowerCase()}. Contact support if this persists.` 
                        });
                        
                        // Emit trade status update
                        io.emit('tradeStatusUpdated', {
                            userId: user._id.toString(),
                            offerId: offer.id,
                            status: tradeStatus === 'invaliditems' ? 'error' : tradeStatus
                        });
                    }
                } catch (e) {
                    logger.error("Error finding user for payout fail notification:", e);
                }
            }
        } // End if (Declined, Canceled, Expired, etc.)
    }); // End manager.on('sentOfferChanged')

} // End if (isBotConfigured && manager)
-
// Share session data with socket.io
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

io.on('connection', (socket) => {
    // Attach user info to socket if authenticated
    if (socket.request.session && socket.request.session.passport && socket.request.session.passport.user) {
        // Get user ID from session
        const userId = socket.request.session.passport.user;
        
        // Find user in DB
        User.findById(userId).then(user => {
            if (user) {
                socket.user = user;
                logger.debug(`Socket authenticated for user: ${user.username} (${socket.id})`);
                
                // Join a private room for targeted messages to this user
                socket.join(`user_${user._id}`);
            }
        }).catch(err => {
            logger.error(`Error loading user for socket ${socket.id}:`, { error: err.message });
        });
    }

    // logger.debug(`Client connected: ${socket.id}`); // Less verbose logging

    socket.on('requestRoundData', async () => {
        try {
            // Re-use the logic from the API endpoint to get consistent data
            let roundToSend = null;
            if (currentRound?._id) {
                // Fetch fresh data from DB when requested, populate fully
                roundToSend = await Round.findById(currentRound._id)
                    .populate('participants.user', 'steamId username avatar _id') // Populate _id here too
                    .populate('items')
                    .populate('winner', 'steamId username avatar _id')
                    .lean();
                if (!roundToSend) { currentRound = null; } // Clear memory if not found
                else { currentRound = roundToSend; } // Update memory
            }
            if (!roundToSend) {
                 // Attempt to find latest active/pending if memory was empty
                roundToSend = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                    .sort({ startTime: -1 }) // Find the most recent
                    .populate('participants.user', 'steamId username avatar _id')
                    .populate('items')
                    .populate('winner', 'steamId username avatar _id')
                    .lean();
                if (roundToSend && !currentRound) { // Restore to memory only if found and memory was empty
                     currentRound = roundToSend;
                     logger.info(`Restored active/pending round ${currentRound.roundId} from DB on client socket request.`);
                     // Ensure timer state matches DB state
                     if (currentRound.status === 'active' && currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                         startRoundTimer(true);
                     } else if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) {
                         startRoundTimer(false);
                     }
                }
            }

            const formattedData = formatRoundForClient(roundToSend);
            if (formattedData) {
                socket.emit('roundData', formattedData);
            } else {
                socket.emit('noActiveRound'); // Explicitly tell client no round exists
                 // Attempt to create a new round if none exists and bot is ready
                 if (!currentRound && !isRolling && isBotReady) {
                      logger.info("No active round found on client request, attempting creation...");
                      await createNewRound(); // This will emit 'roundCreated' if successful
                 }
            }
        } catch (err) {
            logger.error(`Error fetching round data for socket ${socket.id}:`, { error: err.message, stack: err.stack });
            socket.emit('roundError', { error: 'Failed to load round data.' }); // Send generic error
        }
    }); // End 'requestRoundData' listener
javascript    // Request trade history
    socket.on('requestTradeHistory', async () => {
        // Skip if not authenticated
        if (!socket.user) {
            socket.emit('tradeHistoryError', { error: 'Not authenticated' });
            return;
        }
        
        try {
            // Find all trades for the user
            const trades = await Trade.find({ user: socket.user._id })
                .sort({ createdAt: -1 }) // Most recent first
                .lean();
            
            socket.emit('tradeHistory', { trades });
        } catch (err) {
            logger.error(`Error fetching trade history for socket ${socket.id}:`, { error: err.message });
            socket.emit('tradeHistoryError', { error: 'Failed to load trade history' });
        }
    });

    socket.on('disconnect', (reason) => {
        // logger.debug(`Client disconnected: ${socket.id}. Reason: ${reason}`);
    });
});

// Helper function to format round data for client (ensure sensitive fields removed)
function formatRoundForClient(round) {
    if (!round) return null;

    let timeLeft = 0;
    if (round.status === 'active' && round.endTime) {
        try { timeLeft = Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000)); }
        catch(e) { logger.warn("Error calculating timeLeft in formatRoundForClient", { roundId: round.roundId, endTime: round.endTime }); timeLeft = 0; }
    } else if (round.status === 'pending' || (round.status === 'active' && round.participants?.length === 0)) {
        timeLeft = ROUND_DURATION;
    }

    const participantsFormatted = (round.participants || []).map(p => ({
        // Ensure user object and its properties exist before accessing
        user: p.user ? {
            _id: p.user._id, // Send MongoDB ID
            steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar
            } : null,
        itemsValue: p.itemsValue || 0,
        tickets: p.tickets || 0
    })).filter(p => p.user); // Filter out entries with missing user data

    const itemsFormatted = (round.items || []).map(i => ({
        assetId: i.assetId, name: i.name, image: i.image,
        price: i.price || 0, owner: i.owner?.toString() // Send owner's Mongo ID as string
    }));

    let winnerDetails = null;
    if (round.winner?._id) { // Check winner object and its _id
        winnerDetails = {
            id: round.winner._id, // Use id consistently
            steamId: round.winner.steamId || 'N/A',
            username: round.winner.username || 'N/A',
            avatar: round.winner.avatar || 'N/A'
        };
    }

    return {
        // Base round info
        _id: round._id, // Send Mongo ID if needed
        roundId: round.roundId,
        status: round.status,
        startTime: round.startTime,
        endTime: round.endTime,
        timeLeft: timeLeft,
        totalValue: round.totalValue || 0,
        serverSeedHash: round.serverSeedHash, // Needed before round ends
        participants: participantsFormatted,
        items: itemsFormatted,
        // Completed round info (only send if applicable)
        ...(round.status === 'completed' && {
            winner: winnerDetails,
            winningTicket: round.winningTicket,
            serverSeed: round.serverSeed,
            clientSeed: round.clientSeed,
            provableHash: round.provableHash,
            taxAmount: round.taxAmount
        })
    };
}

// CSRF Error Handler
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    logger.warn('Invalid CSRF token detected', { ip: req.ip, url: req.originalUrl, method: req.method });
    res.status(403).json({ error: 'Invalid security token. Please refresh the page and try again.' });
  } else {
    next(err); // Pass other errors on
  }
});

// General Unhandled Error Handler
app.use((err, req, res, next) => {
    logger.error("Unhandled Error:", {
        status: err.status || 500,
        message: err.message,
        stack: err.stack, // Log stack trace on server
        url: req.originalUrl,
        method: req.method,
        ip: req.ip
    });

    // Avoid sending stack traces or sensitive details in production
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.');

    if (res.headersSent) {
        return next(err); // Delegate to default Express handler if headers already sent
    }
    res.status(status).json({ error: message }); // Send generic error message
});

// --- Server Startup ---
async function startApp() {
    logger.info("Performing initial price cache refresh...");
    await refreshPriceCache();

    setInterval(async () => {
        try { await refreshPriceCache(); }
        catch (refreshErr) { logger.error("Error during scheduled price cache refresh:", { error: refreshErr.message, stack: refreshErr.stack }); }
    }, PRICE_REFRESH_INTERVAL_MS);
    logger.info(`Scheduled price cache refresh every ${PRICE_REFRESH_INTERVAL_MS / 60000} minutes.`);

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        logger.info(`Server listening on port ${PORT}`);
        logger.info(`Site URL configured as: ${process.env.SITE_URL}`);
        if (!isBotConfigured) { logger.info("Steam Bot not configured. Trade features disabled."); }
        else if (!isBotReady) { logger.warn("Steam Bot login attempt may have failed or is pending. Check logs."); }
        else { logger.info("Steam Bot is ready."); }
        ensureInitialRound(); // Check/create initial round after server starts
    });
}
startApp();

// --- Graceful Shutdown ---
function gracefulShutdown() {
    logger.info('Received shutdown signal. Closing server...');
    io.close(); // Close socket connections
    server.close(async () => {
        logger.info('HTTP server closed.');
        try {
            await mongoose.connection.close();
            logger.info('MongoDB connection closed.');
            // Stop polling if manager exists
            if (manager && typeof manager.stop === 'function') { 
                logger.info('Stopping TradeOfferManager polling...'); 
                manager.stop(); 
            }
            process.exit(0);
        } catch (e) {
            logger.error("Error during shutdown cleanup:", e);
            process.exit(1);
        }
    });
    // Force shutdown after timeout
    setTimeout(() => {
        logger.error('Could not close connections gracefully, forcing shutdown.');
        process.exit(1);
    }, 15000); // 15 second timeout
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown); // Handle Ctrl+C

module.exports = { app, server }; // Export for testing
