// Required dependencies
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
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
const csurf = require('csurf');
const winston = require('winston');
// Consider adding a library like 'joi' or 'zod' for more robust environment variable validation
// const Joi = require('joi'); // Example, if you were to use Joi
require('dotenv').config();

// --- Logger Setup ---
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'rusty-degen-app' },
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        ),
    }));
} else {
    logger.add(new winston.transports.Console({
        format: winston.format.json(),
        level: 'info'
    }));
}

logger.info('Logger initialized.');

// --- Configuration Constants & Environment Variable Validation ---
// For a production application, consider using a dedicated library like Joi or Zod
// for more comprehensive environment variable validation and type checking.
// Example with basic loop validation:
const baseRequiredEnvVars = ['MONGODB_URI', 'SESSION_SECRET', 'STEAM_API_KEY', 'SITE_URL'];
const botSpecificEnvVars = ['STEAM_USERNAME', 'STEAM_PASSWORD', 'STEAM_SHARED_SECRET', 'BOT_TRADE_URL', 'SITE_NAME'];
// STEAM_IDENTITY_SECRET is optional but needed for auto-confirming trades

let allRequiredEnvVars = [...baseRequiredEnvVars];
const isBotConfigIntended = process.env.ENABLE_BOT_FEATURES === 'true'; // Example: Add a flag to explicitly enable bot features

if (isBotConfigIntended) {
    logger.info("Bot features are intended to be enabled. Checking bot-specific environment variables.");
    allRequiredEnvVars = allRequiredEnvVars.concat(botSpecificEnvVars);
} else {
    logger.warn("Bot features are NOT explicitly enabled (ENABLE_BOT_FEATURES is not 'true'). Trading features will be disabled.");
}

const missingVars = [];
allRequiredEnvVars.forEach(varName => {
    if (!process.env[varName]) {
        missingVars.push(varName);
    }
});

if (missingVars.length > 0) {
    logger.error(`FATAL: Missing required environment variables: ${missingVars.join(', ')}`);
    logger.error("Please ensure all required variables are set in your .env file or environment.");
    if (isBotConfigIntended && botSpecificEnvVars.some(v => missingVars.includes(v))) {
        logger.error("Some missing variables are critical for bot functionality.");
    }
    process.exit(1);
}

const isBotConfigured = isBotConfigIntended && botSpecificEnvVars.every(v => !!process.env[v]);
if (isBotConfigIntended && !isBotConfigured) {
    logger.warn("Bot features were intended, but some bot-specific environment variables are missing. Trading features might be impaired or disabled.");
}


const RUST_APP_ID = 252490;
const RUST_CONTEXT_ID = 2;
const ROUND_DURATION = parseInt(process.env.ROUND_DURATION_SECONDS) || 90; // Defaulted to 90 as per original
const TICKET_VALUE_RATIO = parseFloat(process.env.TICKET_VALUE) || 0.01;
const PRICE_CACHE_TTL_SECONDS = parseInt(process.env.PRICE_CACHE_TTL_SECONDS) || 15 * 60;
const PRICE_REFRESH_INTERVAL_MS = (parseInt(process.env.PRICE_REFRESH_MINUTES) || 10) * 60 * 1000;
const MIN_ITEM_VALUE = parseFloat(process.env.MIN_ITEM_VALUE) || 0.10;
const PRICE_FETCH_TIMEOUT_MS = parseInt(process.env.PRICE_FETCH_TIMEOUT_MS) || 30000;
const MAX_PARTICIPANTS = parseInt(process.env.MAX_PARTICIPANTS) || 20;
const MAX_ITEMS_PER_POT = parseInt(process.env.MAX_ITEMS_PER_POT) || 200;
const MAX_ITEMS_PER_DEPOSIT = parseInt(process.env.MAX_ITEMS_PER_DEPOSIT) || 20;
const TAX_MIN_PERCENT = parseFloat(process.env.TAX_MIN_PERCENT) || 5;
const TAX_MAX_PERCENT = parseFloat(process.env.TAX_MAX_PERCENT) || 10;
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
            "script-src": ["'self'", "/socket.io/socket.io.js"], // Ensure frontend JS is served from self
            "style-src": ["'self'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"], // Ensure frontend CSS is served from self or trusted CDNs
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
                        logger.error("Invalid SITE_URL for CSP connect-src:", { siteUrl, error: e.message });
                    }
                }
                sources.push("https://rust.scmm.app"); // For pricing
                return sources;
            })(),
            "frame-src": ["'self'", "https://steamcommunity.com"],
            "frame-ancestors": ["'self'", "https://steamcommunity.com"],
            "object-src": ["'none'"],
            "upgrade-insecure-requests": process.env.NODE_ENV === 'production' ? [] : null, // Only in production
        },
    })
);
app.use(helmet.dnsPrefetchControl());
app.use(helmet.frameguard({ action: 'sameorigin' }));
app.use(helmet.hidePoweredBy());
if (process.env.NODE_ENV === 'production') { // HSTS only in production
    app.use(helmet.hsts({ maxAge: 15552000, includeSubDomains: true, preload: true }));
}
app.use(helmet.ieNoOpen());
app.use(helmet.noSniff());
app.use(helmet.originAgentCluster());
app.use(helmet.permittedCrossDomainPolicies());
app.use(helmet.referrerPolicy({ policy: 'same-origin' }));
// helmet.xssFilter() is deprecated and often handled by modern browsers.
// If you still need it, ensure it doesn't cause issues.
// app.use(helmet.xssFilter());

// Rate Limiting Setup
const generalApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many general API requests, please try again after 15 minutes.' } });
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: { error: 'Too many login attempts from this IP, please try again after 10 minutes.' }, standardHeaders: true, legacyHeaders: false });
const sensitiveActionLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, message: { error: 'Too many requests for this action, please try again after 5 minutes.' }, standardHeaders: true, legacyHeaders: false });
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 5, message: { error: 'Too many deposit attempts, please wait a minute.' }, standardHeaders: true, legacyHeaders: false });

// Configure Core Middleware
app.use(cors({ origin: process.env.SITE_URL || "*", credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- Session Configuration (Using MongoStore) ---
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        ttl: 14 * 24 * 60 * 60,
        autoRemove: 'native'
    }),
    cookie: {
        maxAge: 1 * 60 * 60 * 1000, // 1 hour
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax'
    }
});
app.use(sessionMiddleware);

// --- Passport and CSRF Initialization ---
app.use(passport.initialize());
app.use(passport.session());
app.use(csurf());

app.use((req, res, next) => {
    res.locals.csrfToken = req.csrfToken();
    // For SPAs, it's common to send the CSRF token as a cookie that JS can read.
    // res.cookie('XSRF-TOKEN', req.csrfToken(), { sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    next();
});

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
                { $set: userData, $setOnInsert: { steamId: profile.id, tradeUrl: '', createdAt: new Date(), pendingDepositOfferId: null } },
                { new: true, upsert: true, runValidators: true }
            );
            logger.debug(`User login/update successful: ${user.username} (ID: ${user.steamId})`);
            return done(null, user);
        } catch (err) {
            logger.error('Steam Strategy Error:', { error: err.message, stack: err.stack, steamProfileId: profile?.id });
            return done(err);
        }
    }
));
passport.serializeUser((user, done) => done(null, user.id)); // user.id is MongoDB's _id
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
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
        process.exit(1);
    });

// --- MongoDB Schemas ---
// Consider adding more specific indexes based on query patterns.
// For example, compound indexes or indexes on frequently queried sub-document fields.
const userSchema = new mongoose.Schema({
    steamId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    avatar: { type: String },
    tradeUrl: { type: String, default: '' },
    balance: { type: Number, default: 0, min: 0 },
    createdAt: { type: Date, default: Date.now },
    banned: { type: Boolean, default: false, index: true },
    pendingDepositOfferId: { type: String, default: null, index: true } // Offer ID from Steam
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
        _id: false,
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        itemsValue: { type: Number, required: true, default: 0, min: 0 },
        tickets: { type: Number, required: true, default: 0, min: 0 }
    }],
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    winningTicket: { type: Number, min: 0 },
    serverSeed: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    serverSeedHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    clientSeed: { type: String },
    provableHash: { type: String, match: /^[a-f0-9]{64}$/ },
    taxAmount: { type: Number, default: 0, min: 0 },
    taxedItems: [{
        _id: false,
        assetId: String,
        name: String,
        price: { type: Number, min: 0 }
    }]
});
roundSchema.index({ 'participants.user': 1 });
roundSchema.index({ status: 1, startTime: -1 });

const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);

// --- Steam Bot Setup ---
const community = new SteamCommunity();
const manager = new TradeOfferManager({
    steam: community,
    domain: process.env.SITE_URL ? new URL(process.env.SITE_URL).hostname : 'localhost',
    language: 'en',
    pollInterval: parseInt(process.env.STEAM_POLL_INTERVAL) || 10000, // Configurable poll interval
    cancelTime: (parseInt(process.env.STEAM_DEPOSIT_OFFER_EXPIRY_MINUTES) || 10) * 60 * 1000, // Deposit offer expiry
    // pendingCancelTime: (parseInt(process.env.STEAM_PENDING_CONFIRM_EXPIRY_MINUTES) || 10) * 60 * 1000, // For offers needing mobile confirmation
});
let isBotReady = false;
// NOTE: `pendingDeposits` is an in-memory map. If the server restarts, this data is lost.
// The `user.pendingDepositOfferId` helps recover state for ongoing offers.
// For high-reliability, consider a persistent store (e.g., Redis) for this if issues arise.
const pendingDeposits = new Map(); // { depositId: { userId, items, roundId, steamId, totalValue, offerId, cleanupTimeout } }

// --- 2FA Code Generation ---
function generateAuthCode() {
    const secret = process.env.STEAM_SHARED_SECRET;
    if (!secret) { logger.error("STEAM_SHARED_SECRET missing. Cannot generate 2FA code."); return null; }
    try { return SteamTotp.generateAuthCode(secret); }
    catch (e) { logger.error("Error generating 2FA code:", e); return null; }
}

// --- Steam Bot Login ---
// TODO: Implement exponential backoff for login retries on specific EResult codes (e.g., rate limits).
if (isBotConfigured) {
    const loginCredentials = {
        accountName: process.env.STEAM_USERNAME,
        password: process.env.STEAM_PASSWORD,
        twoFactorCode: generateAuthCode()
    };

    if (loginCredentials.twoFactorCode) {
        logger.info(`Attempting Steam login for bot: ${loginCredentials.accountName}...`);
        community.login(loginCredentials, (err, sessionID, cookies, steamguard) => {
            if (err) {
                logger.error('STEAM LOGIN ERROR (Callback Err Object):', {
                    message: err.message, eresult: err.eresult, emaildomain: err.emaildomain, stack: err.stack
                });
            } else {
                logger.debug('Steam community.login callback received (no immediate error object reported).');
            }

            if (err || !community.steamID) {
                logger.error(`CRITICAL LOGIN FAILURE: Login callback failed or community.steamID is undefined. Bot will be OFFLINE.`, {
                    error: err ? err.message : 'N/A', steamID: community.steamID, eresult: err?.eresult
                });
                isBotReady = false;
                if (err?.eresult === 5) logger.warn('Login Failure Hint: Invalid Password? Check .env');
                if (err?.eresult === 65) logger.warn('Login Failure Hint: Incorrect 2FA Code (Check Shared Secret/Server Time) or Account Rate Limit?');
                if (err?.eresult === 63) logger.warn('Login Failure Hint: Account Logon Denied - Check Email Auth/Steam Guard settings via Browser?');
                return;
            }

            logger.info(`Steam bot ${loginCredentials.accountName} logged in successfully (SteamID: ${community.steamID}). Attempting to set cookies for TradeOfferManager...`);
            manager.setCookies(cookies, (setCookieErr) => {
                if (setCookieErr) {
                    logger.error('TradeOfferManager Error setting cookies. Bot will be OFFLINE.', { error: setCookieErr.message, stack: setCookieErr.stack });
                    isBotReady = false;
                    return;
                }
                logger.info('TradeOfferManager cookies set successfully.');
                community.setCookies(cookies);
                isBotReady = true;
                logger.info("Steam Bot is ready.");
                ensureInitialRound();
            });

            community.on('friendRelationship', (steamID, relationship) => {
                if (relationship === SteamCommunity.EFriendRelationship.RequestRecipient) {
                    logger.info(`Received friend request from ${steamID}. Accepting...`);
                    community.addFriend(steamID, (friendErr) => {
                        if (friendErr) logger.error(`Error accepting friend request from ${steamID}:`, friendErr);
                        else logger.info(`Accepted friend request from ${steamID}.`);
                    });
                }
            });
        });
    } else {
        logger.warn("Could not generate 2FA code. Steam Bot login skipped. Bot will be OFFLINE.");
        isBotReady = false;
    }
} else {
    logger.info("Steam Bot is not configured (isBotConfigured=false). Trading features disabled.");
    isBotReady = false; // Explicitly set if not configured
}

// --- Active Round Data ---
let currentRound = null;
let roundTimer = null;
let isRolling = false;

// --- Pricing Cache and Functions ---
const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false });

// Placeholder for a more sophisticated circuit breaker
// const scmmPriceApiCircuit = {
//     fire: async (url, options) => {
//         // In a real implementation, this would track failures, open/close circuit, etc.
//         // For now, it just makes the request.
//         return axios.get(url, options);
//     },
//     isOpen: () => false // Example: always closed
// };

async function refreshPriceCache() {
    logger.info("Attempting to refresh price cache from rust.scmm.app...");
    const apiUrl = `https://rust.scmm.app/api/item/prices?currency=USD`;

    // if (scmmPriceApiCircuit.isOpen()) {
    //     logger.warn("SCMM Price API circuit breaker is open. Skipping price refresh.");
    //     return;
    // }

    try {
        // const response = await scmmPriceApiCircuit.fire(apiUrl, { timeout: PRICE_FETCH_TIMEOUT_MS });
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
            errorCode: error.code, errorMessage: error.message, responseStatus: error.response?.status,
        });
        // TODO: Increment failure count for circuit breaker if implementing one.
    }
}

function getItemPrice(marketHashName) {
    if (typeof marketHashName !== 'string' || marketHashName.length === 0) {
        logger.warn("getItemPrice called with invalid marketHashName:", marketHashName);
        return 0;
    }
    const cachedPrice = priceCache.get(marketHashName);
    if (cachedPrice !== undefined) {
        return cachedPrice;
    } else {
        // Fallback price is MIN_ITEM_VALUE if it's defined and > 0, otherwise 0
        return MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0;
    }
}

// --- Core Game Logic ---
async function createNewRound() {
    if (!isBotReady && isBotConfigured) { // Check if bot is configured but not ready
        logger.warn("Cannot create new round: Bot is configured but not ready. Retrying round creation later.");
        // Optionally, set a timeout to retry or handle this state appropriately
        setTimeout(createNewRound, 15000); // Retry after 15 seconds
        return null;
    }
    if (!isBotConfigured && isBotConfigIntended) { // If bot features were intended but config is missing
        logger.error("Cannot create new round: Bot features enabled but bot is not configured. Check .env variables.");
        // Potentially stop trying to create rounds or alert admin
        return null;
    }
    if (!isBotConfigIntended) { // If bot is not even supposed to be running
        logger.info("Bot features not enabled, cannot create game rounds.");
        return null;
    }


    if (isRolling) {
        logger.info("Cannot create new round: Current round is rolling.");
        return null;
    }
    if (currentRound && currentRound.status === 'active') {
        logger.info(`Cannot create new round: Round ${currentRound.roundId} is already active.`);
        return currentRound;
    }

    try {
        isRolling = false; // Ensure this is reset if a previous round errored out before resetting

        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');

        const lastRound = await Round.findOne().sort({ roundId: -1 }); // More explicit sort
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

        io.emit('roundCreated', formatRoundForClient(currentRound)); // Use formatter
        logger.info(`--- Round ${newRound.roundId} created and active ---`);
        return currentRound;

    } catch (err) {
        logger.error('FATAL: Error creating new round:', { error: err.message, stack: err.stack });
        setTimeout(createNewRound, 10000);
        return null;
    }
}

async function ensureInitialRound() {
    if (!isBotConfigIntended) {
        logger.info("Bot features not enabled, skipping initial round check.");
        return;
    }
    if (!isBotReady) {
        logger.warn("Bot not ready, ensureInitialRound will wait for bot readiness via login callback.");
        return;
    }

    if (!currentRound) {
        try {
            const existingActiveOrRolling = await Round.findOne({ status: { $in: ['active', 'rolling'] } })
                .populate('participants.user', 'steamId username avatar _id')
                .populate('items')
                .populate('winner', 'steamId username avatar _id')
                .lean();

            if (existingActiveOrRolling) {
                logger.info(`Found existing round ${existingActiveOrRolling.roundId} (status: ${existingActiveOrRolling.status}) on startup.`);
                currentRound = existingActiveOrRolling;

                if (currentRound.status === 'rolling') {
                    logger.warn(`Round ${currentRound.roundId} was 'rolling'. Attempting to finalize it.`);
                    isRolling = false; // Reset flag before attempting to end
                    await endRound(); // This will handle the rest
                } else if (currentRound.status === 'active') {
                    if (currentRound.participants && currentRound.participants.length > 0 && !roundTimer) {
                        logger.info(`Active round ${currentRound.roundId} has participants. Starting/resuming timer.`);
                        startRoundTimer(!!currentRound.endTime); // Use remaining if endTime exists
                    } else if (!currentRound.participants || currentRound.participants.length === 0) {
                        logger.info(`Active round ${currentRound.roundId} has no participants. Timer will start on first deposit.`);
                    }
                }
            } else {
                logger.info("No active/rolling round found, creating initial round...");
                await createNewRound();
            }
        } catch (dbErr) {
            logger.error("Error ensuring initial round:", { error: dbErr.message, stack: dbErr.stack });
            setTimeout(ensureInitialRound, 10000); // Retry ensuring round
        }
    }
}


function startRoundTimer(useRemainingTime = false) {
    if (roundTimer) clearInterval(roundTimer);
    if (!currentRound || currentRound.status !== 'active') {
        logger.warn("Cannot start timer: No active round or round status invalid.", { roundId: currentRound?.roundId, status: currentRound?.status });
        return;
    }

    let timeLeft;
    let calculatedEndTime;

    try {
        if (useRemainingTime && currentRound.endTime) {
            calculatedEndTime = new Date(currentRound.endTime);
            if (isNaN(calculatedEndTime.getTime())) throw new Error('Invalid currentRound.endTime date');
            timeLeft = Math.max(0, Math.floor((calculatedEndTime.getTime() - Date.now()) / 1000));
            logger.info(`Resuming timer for round ${currentRound.roundId} with ${timeLeft}s remaining.`);
        } else {
            timeLeft = ROUND_DURATION;
            calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
            currentRound.endTime = calculatedEndTime;
            Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
                .catch(e => logger.error(`Error saving round end time for round ${currentRound?.roundId}:`, { error: e.message, stack: e.stack }));
            logger.info(`Starting timer for round ${currentRound.roundId} (${ROUND_DURATION}s). End time: ${calculatedEndTime.toISOString()}`);
        }
    } catch (dateError) {
        logger.error("Error calculating timer end time:", { error: dateError.message, stack: dateError.stack, currentRoundEndTime: currentRound?.endTime });
        timeLeft = ROUND_DURATION; // Fallback to full duration
        calculatedEndTime = new Date(Date.now() + ROUND_DURATION * 1000);
        currentRound.endTime = calculatedEndTime;
        Round.updateOne({ _id: currentRound._id }, { $set: { endTime: calculatedEndTime } })
            .catch(e => logger.error(`Error saving recovered round end time for round ${currentRound?.roundId}:`, { error: e.message, stack: e.stack }));
        logger.warn(`Recovered by starting fresh timer for round ${currentRound.roundId}.`);
    }

    io.emit('timerUpdate', { timeLeft });

    roundTimer = setInterval(async () => {
        if (!currentRound || currentRound.status !== 'active' || !currentRound.endTime) {
            clearInterval(roundTimer); roundTimer = null;
            logger.warn("Timer stopped: Round state became invalid during countdown.");
            return;
        }
        const now = Date.now();
        let currenttimeLeft = 0;
        try {
            const endTimeDate = new Date(currentRound.endTime);
            if (isNaN(endTimeDate.getTime())) throw new Error('Invalid currentRound.endTime in interval');
            currenttimeLeft = Math.max(0, Math.floor((endTimeDate.getTime() - now) / 1000));
        } catch (intervalDateError) {
            logger.error("Error calculating time left in timer interval:", { error: intervalDateError.message, roundEndTime: currentRound.endTime });
            clearInterval(roundTimer); roundTimer = null;
            if (currentRound && currentRound.status === 'active' && !isRolling) { // Ensure we don't double-trigger endRound
                logger.warn(`Attempting to end round ${currentRound.roundId} due to timer error.`);
                await endRound();
            }
            return;
        }

        io.emit('timerUpdate', { timeLeft: currenttimeLeft });
        if (currenttimeLeft <= 0) {
            clearInterval(roundTimer); roundTimer = null;
            logger.info(`Round ${currentRound.roundId} timer reached zero.`);
            await endRound();
        }
    }, 1000);
}

async function endRound() {
    if (!currentRound || currentRound.status !== 'active') { // Check if already rolling or not active
        logger.warn(`Attempted to end round ${currentRound?.roundId}, but state is invalid (Status: ${currentRound?.status}, IsRolling: ${isRolling}). Aborting endRound.`);
        if (isRolling && currentRound?.status === 'rolling') {
            // This means endRound might have been called again while already processing.
            logger.info(`endRound called for round ${currentRound.roundId} which is already rolling. Allowing first call to complete.`);
        }
        return;
    }
    if (isRolling) { // Another safeguard if the first check passed somehow
      logger.warn(`endRound called for round ${currentRound?.roundId} but isRolling is already true. Aborting to prevent race condition.`);
      return;
    }


    isRolling = true;
    const roundToEndId = currentRound.roundId;
    const roundToEndMongoId = currentRound._id; // Store _id before currentRound is potentially reassigned
    logger.info(`--- Ending round ${roundToEndId}... ---`);

    // NOTE: For true atomicity, the following operations (DB updates, winner selection, payout initiation)
    // should be wrapped in a MongoDB transaction if your setup supports it (replica set required).
    // This is a conceptual placeholder for transaction logic.
    // let session;
    try {
        // session = await mongoose.startSession();
        // session.startTransaction();

        // Mark Round as Rolling
        const updateResult = await Round.updateOne(
            { _id: roundToEndMongoId, status: 'active' }, // Ensure it's still active
            { $set: { status: 'rolling', endTime: new Date() } }
            // { session } // Pass session to DB operations
        );

        if (updateResult.modifiedCount === 0 && updateResult.matchedCount > 0) {
            logger.warn(`Round ${roundToEndId} was already marked rolling or completed. Aborting duplicate endRound call.`);
            // if (session) await session.abortTransaction();
            isRolling = false;
            return;
        }
        if (updateResult.matchedCount === 0) {
             logger.error(`Round ${roundToEndId} not found or not active when trying to mark as rolling. Aborting endRound.`);
            // if (session) await session.abortTransaction();
            isRolling = false;
            // Potentially try to create a new round if currentRound is now inconsistent
            currentRound = null; // Clear potentially stale currentRound
            ensureInitialRound();
            return;
        }


        io.emit('roundRolling', { roundId: roundToEndId });
        logger.info(`Round ${roundToEndId} marked as rolling.`);

        const round = await Round.findById(roundToEndMongoId)
            .populate('participants.user', 'steamId username avatar _id tradeUrl') // Add tradeUrl for winner
            .populate('items')
            .lean(); // Use .session(session) if transactions are active

        if (!round) {
            throw new Error(`Round ${roundToEndId} data missing after status update.`);
        }
        // Update currentRound in memory with the fully populated one
        currentRound = round;


        if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            logger.info(`Round ${round.roundId} ended with no valid participants or value.`);
            await Round.updateOne({ _id: roundToEndMongoId }, { $set: { status: 'completed', completedTime: new Date() } }/*, { session }*/);
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants." });
            // await session.commitTransaction(); // Commit if transaction was started
            isRolling = false;
            currentRound = null; // Clear current round before creating new
            setTimeout(createNewRound, 5000);
            return;
        }

        // Tax Calculation
        let finalItems = [...round.items];
        let finalTotalValue = round.totalValue;
        let taxAmount = 0;
        let taxedItemsInfo = [];
        let itemsToTakeForTaxIds = new Set();

        if (finalTotalValue >= MIN_POT_FOR_TAX) {
            const targetTaxValue = finalTotalValue * (TAX_MIN_PERCENT / 100);
            const maxTaxValue = finalTotalValue * (TAX_MAX_PERCENT / 100);
            const sortedItems = [...finalItems].sort((a, b) => (a.price || 0) - (b.price || 0));
            let currentTaxValue = 0;

            for (const item of sortedItems) {
                if (!item?._id || typeof item.price !== 'number' || item.price < 0) {
                    logger.warn(`Skipping item in tax calculation due to missing data/invalid price`, { roundId: round.roundId, itemId: item?._id, itemPrice: item?.price });
                    continue;
                }
                if (currentTaxValue + item.price <= maxTaxValue) {
                    itemsToTakeForTaxIds.add(item._id.toString());
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price });
                    currentTaxValue += item.price;
                    if (currentTaxValue >= targetTaxValue) break;
                } else {
                    break;
                }
            }
            if (itemsToTakeForTaxIds.size > 0) {
                finalItems = finalItems.filter(item => !itemsToTakeForTaxIds.has(item._id.toString()));
                taxAmount = currentTaxValue;
                finalTotalValue -= taxAmount;
                logger.info(`Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${itemsToTakeForTaxIds.size} items). New Pot Value: $${finalTotalValue.toFixed(2)}`);
            }
        }

        // Winner Calculation
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
            if (!participant?.tickets || !participant.user?._id) {
                logger.warn(`Skipping participant in winner calculation due to missing data`, { roundId: round.roundId, participantUserId: participant?.user?._id, participantTickets: participant?.tickets });
                continue;
            }
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winner = participant.user;
                break;
            }
        }
        if (!winner || !winner._id) { // Ensure winner and winner._id are valid
             throw new Error(`Winner selection failed or winner object is invalid for round ${round.roundId}. Winning Ticket: ${winningTicket}, Total Tickets: ${totalTickets}`);
        }


        const finalUpdateData = {
            status: 'completed', completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winner._id,
            taxAmount: taxAmount, taxedItems: taxedItemsInfo, totalValue: Math.max(0, finalTotalValue),
            items: finalItems.map(i => i._id)
        };
        await Round.updateOne({ _id: roundToEndMongoId }, { $set: finalUpdateData }/*, { session }*/);
        logger.info(`Round ${round.roundId} completed. Winner: ${winner.username} (Ticket: ${winningTicket}/${totalTickets}, Value: $${finalTotalValue.toFixed(2)})`);

        io.emit('roundWinner', {
            roundId: round.roundId,
            winner: { id: winner._id.toString(), steamId: winner.steamId, username: winner.username, avatar: winner.avatar },
            winningTicket: winningTicket, totalValue: finalTotalValue, totalTickets: totalTickets,
            serverSeed: round.serverSeed, clientSeed: clientSeed, provableHash: provableHash, serverSeedHash: round.serverSeedHash
        });

        await sendWinningTradeOffer(round, winner, finalItems); // Pass the populated winner object
        // await session.commitTransaction(); // Commit transaction if all successful

    } catch (err) {
        logger.error(`CRITICAL ERROR during endRound for round ${roundToEndId}:`, { error: err.message, stack: err.stack });
        // if (session) await session.abortTransaction(); // Abort transaction on error
        try {
            await Round.updateOne({ _id: roundToEndMongoId }, { $set: { status: 'error' } });
            io.emit('roundError', { roundId: roundToEndId, error: 'Internal server error during round finalization.' });
            // TODO: Queue this round for manual admin review/payout.
            // Log detailed error and round state to a separate admin log or database collection.
        } catch (saveErr) {
            logger.error(`Failed to mark round ${roundToEndId} as error after initial error:`, { error: saveErr.message, stack: saveErr.stack });
        }
    } finally {
        // if (session) session.endSession(); // Always end the session
        isRolling = false;
        currentRound = null; // Clear current round before creating new
        logger.info(`Scheduling next round creation after round ${roundToEndId} finalization attempt.`);
        setTimeout(createNewRound, 15000);
    }
}

async function sendWinningTradeOffer(round, winnerUser, itemsToSend) { // Renamed winner to winnerUser for clarity
    if (!isBotReady) {
        logger.error(`PAYOUT_ERROR: Cannot send winnings for round ${round.roundId}: Steam Bot is not ready.`);
        // TODO: Implement a robust retry queue for failed payouts.
        // For now, notify user and log for manual intervention.
        io.emit('notification', { type: 'error', userId: winnerUser._id.toString(), message: `Bot Error: Payout for round ${round.roundId} requires manual processing. Contact support.` });
        return;
    }
    if (!winnerUser || !winnerUser.tradeUrl) { // Check winnerUser object and its tradeUrl
        logger.error(`PAYOUT_ERROR: Cannot send winnings for round ${round.roundId}: Winner ${winnerUser?.username || 'N/A'} has no Trade URL set.`);
        io.emit('notification', { type: 'error', userId: winnerUser?._id?.toString(), message: 'Please set your Trade URL in your profile to receive winnings.' });
        return;
    }
    if (!itemsToSend || itemsToSend.length === 0) {
        logger.info(`PAYOUT_INFO: No items to send for round ${round.roundId}.`, { taxAmount: round.taxAmount, finalPotValue: round.totalValue });
        if (round.taxAmount > 0 && round.totalValue <= 0) {
            io.emit('notification', { type: 'info', userId: winnerUser._id.toString(), message: `Round ${round.roundId} winnings ($${round.taxAmount.toFixed(2)}) were processed as site tax.` });
        }
        return;
    }

    logger.info(`Attempting to send ${itemsToSend.length} winning items for round ${round.roundId} to ${winnerUser.username}...`);

    try {
        const offer = manager.createOffer(winnerUser.tradeUrl);
        offer.addMyItems(itemsToSend.map(item => ({
            assetid: item.assetId, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID
        })));
        offer.setMessage(`Congratulations! Your winnings from Round #${round.roundId} on ${process.env.SITE_NAME || 'RustyDegen'}. Pot Value (after tax): $${round.totalValue.toFixed(2)}`);

        const identitySecret = process.env.STEAM_IDENTITY_SECRET;
        offer.send(!!identitySecret, (err, status) => { // Callback is safer for this library
            if (err) {
                logger.error(`PAYOUT_ERROR: Error sending trade offer ${offer.id || 'N/A'} for round ${round.roundId}:`, {
                    eresult: err.eresult, message: err.message, stack: err.stack, winner: winnerUser.steamId
                });
                let userMessage = `Error sending winnings for round ${round.roundId}. Please contact support. (Offer ID: ${offer.id || 'N/A'})`;
                if (err.message.includes('revoked') || err.message.includes('invalid') || err.eresult === 26) {
                    userMessage = 'Your Trade URL is invalid or expired. Please update it to receive winnings.';
                } else if (err.eresult === 15 || err.eresult === 16) {
                    userMessage = 'Could not send winnings. Ensure your Steam inventory is public and not full.';
                } else if (err.message?.includes('escrow') || err.eresult === 11) {
                     userMessage = `Winnings sent (Offer #${offer.id}), but may be held in escrow by Steam. Ensure Steam Guard Mobile Authenticator has been active for 7 days.`;
                     io.emit('notification', { type: 'warning', userId: winnerUser._id.toString(), message: userMessage });
                } else {
                    io.emit('notification', { type: 'error', userId: winnerUser._id.toString(), message: userMessage });
                }
                // TODO: Add this failed payout to a persistent queue for retry/manual processing.
                // Log details: roundId, winnerId, itemAssetIds, offerId (if available), error.
                return;
            }

            logger.info(`PAYOUT_SUCCESS: Trade offer ${offer.id} sent to ${winnerUser.username} for round ${round.roundId}. Status: ${status}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;
            io.emit('tradeOfferSent', {
                roundId: round.roundId, userId: winnerUser._id.toString(), username: winnerUser.username,
                offerId: offer.id, offerURL: offerURL, status: status
            });

            if (status === 'pending' || status === 'pendingConfirmation') { // 'pendingConfirmation' is a common status
                logger.warn(`Offer #${offer.id} requires confirmation (Status: ${status}). Check mobile authenticator if auto-confirmation is not setup or failed.`);
                let notificationType = 'info';
                let notificationMessage = `Winnings sent (Offer #${offer.id}), but require confirmation in Steam.`;
                if (identitySecret) {
                    notificationType = 'warning';
                    notificationMessage = `Winnings sent (Offer #${offer.id}), but confirmation may be needed in Steam. Check your authenticator.`;
                }
                io.emit('notification', { type: notificationType, userId: winnerUser._id.toString(), message: notificationMessage });
            }
        });
    } catch (err) {
        logger.error(`PAYOUT_ERROR: Unexpected error CREATING trade offer for round ${round.roundId}:`, { error: err.message, stack: err.stack });
        io.emit('notification', { type: 'error', userId: winnerUser._id.toString(), message: `Error creating winnings offer for round ${round.roundId}. Please contact support.` });
        // TODO: Add to failed payout queue here as well.
    }
}

// --- Authentication Routes ---
app.get('/auth/steam', authLimiter, passport.authenticate('steam', { failureRedirect: '/' }));
app.get('/auth/steam/return',
    authLimiter,
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('/');
    });

app.post('/logout', (req, res, next) => {
    req.logout(err => {
        if (err) {
            logger.error("Error during req.logout:", err);
            return next(err);
        }
        req.session.destroy(destroyErr => {
            if (destroyErr) {
                logger.error("Error destroying session during logout:", destroyErr);
                return res.status(500).json({ error: 'Logout failed due to server error.' });
            }
            res.clearCookie('connect.sid'); // Default session cookie name
            res.json({ success: true, message: 'Logged out successfully.' });
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
        logger.warn("Validation Errors:", { errors: errors.array(), route: req.originalUrl, ip: req.ip, userId: req.user?._id });
        return res.status(400).json({ error: errors.array()[0].msg });
    }
    next();
};

app.get('/api/csrf-token', (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
});

app.get('/api/user', generalApiLimiter, ensureAuthenticated, (req, res) => {
    if (!req.user) { // Should not happen if ensureAuthenticated works
        return res.status(401).json({ error: 'User data not found in request.' });
    }
    const { _id, steamId, username, avatar, tradeUrl, balance, createdAt, pendingDepositOfferId } = req.user;
    res.json({ _id, steamId, username, avatar, tradeUrl, balance, createdAt, pendingDepositOfferId });
});

app.post('/api/user/tradeurl',
    sensitiveActionLimiter,
    ensureAuthenticated,
    [
        body('tradeUrl')
            .trim()
            .custom((value) => {
                if (value === '') return true;
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
                logger.error(`User not found during trade URL update`, { userId: req.user._id });
                return res.status(404).json({ error: 'User not found.' });
            }
            logger.info(`Trade URL updated for user: ${updatedUser.username}`);
            res.json({ success: true, tradeUrl: updatedUser.tradeUrl });
        } catch (err) {
            logger.error(`Error updating trade URL for user ${req.user._id}:`, { error: err.message, stack: err.stack });
            res.status(500).json({ error: 'Server error saving Trade URL.' });
        }
    });

app.get('/api/inventory', generalApiLimiter, ensureAuthenticated, async (req, res) => {
    if (!isBotReady && isBotConfigured) { // More specific check
        logger.warn(`Inventory fetch failed for ${req.user.username}: Bot service is configured but not ready.`);
        return res.status(503).json({ error: "Steam service temporarily unavailable (Bot not ready). Please try again later." });
    }
    if (!isBotConfigured) {
        logger.warn(`Inventory fetch failed for ${req.user.username}: Bot service is not configured.`);
        return res.status(503).json({ error: "Steam service is not configured on this site." });
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
                    return reject(new Error(userMessage));
                }
                resolve(inv || []);
            });
        });

        const validItems = inventory
            .map(item => {
                const itemName = item.market_hash_name;
                if (!itemName) { return null; }
                let price = getItemPrice(itemName);
                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

                if (!item.assetid || !item.icon_url) { return null; }
                if (!item.tradable || finalPrice < MIN_ITEM_VALUE) { return null; }

                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`;
                return {
                    assetId: item.assetid, name: itemName, displayName: item.name,
                    image: imageUrl, price: finalPrice, tradable: item.tradable, marketable: item.marketable
                };
            })
            .filter(item => item !== null);
        res.json(validItems);
    } catch (err) {
        logger.error(`Error in /api/inventory for ${req.user?.username || req.user?.steamId}:`, { error: err.message, stack: err.stack });
        res.status(500).json({ error: err.message || 'Server error fetching inventory.' });
    }
});

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

        if (!isBotReady && isBotConfigured) {
            return res.status(503).json({ error: "Deposit service temporarily unavailable (Bot not ready)." });
        }
        if (!isBotConfigured) {
             return res.status(503).json({ error: "Deposit service is not configured on this site." });
        }
        if (!user.tradeUrl) {
            return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile before depositing.' });
        }

        if (user.pendingDepositOfferId) {
            try {
                const offer = await manager.getOffer(user.pendingDepositOfferId);
                if (offer && [TradeOfferManager.ETradeOfferState.Active, TradeOfferManager.ETradeOfferState.Sent, TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation].includes(offer.state)) {
                    logger.info(`User ${user.username} already has pending deposit offer ${user.pendingDepositOfferId}. State: ${TradeOfferManager.ETradeOfferState[offer.state]}`);
                    const offerURL = `https://steamcommunity.com/tradeoffer/${user.pendingDepositOfferId}/`;
                    return res.status(409).json({
                        error: 'You already have an active deposit offer waiting. Please accept or decline it on Steam.',
                        offerId: user.pendingDepositOfferId, offerURL: offerURL
                    });
                } else {
                    logger.info(`Clearing stale pending offer ${user.pendingDepositOfferId} for user ${user.username} (State: ${TradeOfferManager.ETradeOfferState[offer?.state]}).`);
                    await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
                }
            } catch (offerFetchError) {
                if (offerFetchError.message !== 'NoMatch') {
                    logger.warn(`Could not fetch pending offer ${user.pendingDepositOfferId}, clearing flag:`, { error: offerFetchError.message });
                }
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null });
            }
        }

        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }
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
            if (verificationErrorMsg) throw new Error(verificationErrorMsg);
            if (itemsToRequest.length === 0) throw new Error("None of the selected items could be verified for deposit.");
            logger.info(`Verified ${itemsToRequest.length} items for deposit for ${user.username}. Total Value: $${depositTotalValue.toFixed(2)}`);
        } catch (verificationError) {
            logger.warn(`Deposit item verification failed for ${user.username}:`, { error: verificationError.message });
            return res.status(400).json({ error: verificationError.message });
        }

        const depositId = uuidv4();
        const offerMessage = `RustyDegen Deposit ID: ${depositId} | Round: ${currentRound.roundId}`;
        let cleanupTimeoutId = null;

        try {
            const offer = manager.createOffer(user.tradeUrl);
            offer.addTheirItems(itemsToRequest.map(({ assetid, appid, contextid }) => ({ assetid, appid, contextid })));
            offer.setMessage(offerMessage);

            const pendingData = {
                userId: user._id, roundId: currentRound._id, items: itemsToRequest,
                totalValue: depositTotalValue, steamId: user.steamId, offerId: null
            };
            pendingDeposits.set(depositId, pendingData);
            logger.info(`Stored pending deposit ${depositId} for user ${user.steamId}.`);

            logger.info(`Sending deposit offer to ${user.username}...`);
            await new Promise((resolve, reject) => {
                offer.send((err, status) => {
                    if (err) {
                        logger.error(`Error initially sending deposit offer ${offer.id || 'N/A'} for DepositID ${depositId}:`, { eresult: err.eresult, message: err.message });
                        return reject(err);
                    }
                    pendingData.offerId = offer.id;
                    logger.info(`Deposit offer ${offer.id} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);
                    resolve(status);
                });
            });

            await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: pendingData.offerId });
            logger.info(`Set pendingDepositOfferId=${pendingData.offerId} for user ${user.username}.`);

            cleanupTimeoutId = setTimeout(async () => { // Made async for potential await inside
                if (pendingDeposits.has(depositId)) {
                    const expiredData = pendingDeposits.get(depositId);
                    logger.warn(`Deposit attempt ${depositId} (Offer ${expiredData?.offerId}) expired or timed out locally.`);
                    pendingDeposits.delete(depositId);
                    try {
                        // Clear user flag only if it still matches the expired offer ID
                        await User.updateOne({ _id: expiredData.userId, pendingDepositOfferId: expiredData.offerId }, { pendingDepositOfferId: null });
                    } catch (e) {
                        logger.error("Error clearing user pending flag on expiry timeout:", { userId: expiredData.userId, offerId: expiredData.offerId, error: e.message });
                    }
                }
            }, manager.cancelTime || 10 * 60 * 1000);
            pendingData.cleanupTimeout = cleanupTimeoutId;

            const offerURL = `https://steamcommunity.com/tradeoffer/${pendingData.offerId}/`;
            res.json({ success: true, message: 'Deposit offer created! Please accept it on Steam.', offerId: pendingData.offerId, offerURL: offerURL });

        } catch (error) {
            logger.error(`Error processing deposit request for ${user.username} (DepositID: ${depositId}):`, { eresult: error.eresult, message: error.message, stack: error.stack });
            if (pendingDeposits.has(depositId)) {
                const failedData = pendingDeposits.get(depositId);
                if (failedData.cleanupTimeout) clearTimeout(failedData.cleanupTimeout);
                pendingDeposits.delete(depositId);
            }
            try {
                await User.updateOne({ _id: user._id, pendingDepositOfferId: pendingDeposits.get(depositId)?.offerId }, { pendingDepositOfferId: null });
            } catch (e) {
                logger.error("Error clearing user flag on deposit offer send fail:", { userId: user._id, error: e.message });
            }

            let userMessage = 'Failed to create deposit trade offer. Please try again later.';
            if (error.message.includes('Trade URL') || error.message.includes('token') || error.eresult === 26) { userMessage = 'Your Steam Trade URL might be invalid or expired. Please check it in your profile.'; }
            else if (error.eresult) { userMessage += ` (Code: ${error.eresult})`; }
            res.status(500).json({ error: userMessage });
        }
    });

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
                    .sort({ roundId: -1 })
                    .skip(skip)
                    .limit(limit)
                    .populate('winner', 'username avatar steamId _id') // Ensure _id is populated
                    .select('roundId completedTime totalValue winner serverSeed clientSeed winningTicket status taxAmount serverSeedHash') // Added serverSeedHash
                    .lean(),
                Round.countDocuments(queryFilter)
            ]);

            res.json({
                rounds: rounds.map(r => formatRoundForClient(r)), // Use formatter for consistency
                totalPages: Math.ceil(totalCount / limit),
                currentPage: page,
                totalRounds: totalCount
            });
        } catch (err) {
            logger.error('Error fetching past rounds:', { error: err.message, stack: err.stack });
            res.status(500).json({ error: 'Server error fetching round history.' });
        }
    });

app.post('/api/verify',
    sensitiveActionLimiter,
    [
        body('roundId').notEmpty().isInt({ min: 1 }).toInt(),
        body('serverSeed').trim().notEmpty().isHexadecimal().isLength({ min: 64, max: 64 }),
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 })
    ],
    handleValidationErrors,
    async (req, res) => {
        const { roundId, serverSeed, clientSeed } = req.body;
        try {
            const round = await Round.findOne({ roundId: roundId, status: 'completed' })
                .populate('participants.user', 'username steamId _id')
                .populate('winner', 'username steamId _id')
                .lean();

            if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found.` });
            if (!round.serverSeed || !round.clientSeed || !round.provableHash || !round.serverSeedHash) {
                return res.status(400).json({ error: `Provably fair data not fully available for round #${roundId}.` });
            }

            const providedServerSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
            if (providedServerSeedHash !== round.serverSeedHash) {
                return res.json({ verified: false, reason: 'Server Seed does not match the recorded Server Seed Hash.', serverSeedHash: round.serverSeedHash, providedServerSeedHash });
            }
            if (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed) {
                return res.json({ verified: false, reason: 'Provided seeds do not match the official round seeds.' });
            }
            const combinedString = serverSeed + clientSeed;
            const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
            if (calculatedProvableHash !== round.provableHash) {
                return res.json({ verified: false, reason: 'Calculated Provable Hash does not match recorded hash.', expectedProvableHash: round.provableHash, calculatedProvableHash });
            }

            const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
            const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;
            if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets.' });
            const calculatedWinningTicket = decimalFromHash % totalTickets;

            if (calculatedWinningTicket !== round.winningTicket) {
                return res.json({ verified: false, reason: 'Calculated winning ticket does not match the recorded winning ticket.', calculatedWinningTicket, actualWinningTicket: round.winningTicket });
            }

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

// --- Trade Offer Manager Event Handling ---
if (isBotConfigured && manager) { // Only set up listeners if bot is configured
    manager.on('newOffer', async (offer) => {
        if (!isBotReady) {
            logger.debug(`Bot not ready, ignoring newOffer ${offer.id}`);
            return;
        }
        if (offer.isOurOffer) return;

        // Auto-decline unsolicited offers (donations / manual deposits not through /api/deposit)
        // This check is basic; more sophisticated logic might be needed if you allow other types of incoming offers.
        if (offer.itemsToReceive && offer.itemsToReceive.length > 0 && (!offer.itemsToGive || offer.itemsToGive.length === 0)) {
            // Check if this offer matches any known pending deposit by its ID (if user somehow accepted before our system recorded it)
            // This is a fallback, primary handling is via `sentOfferChanged`
            const matchedDeposit = Array.from(pendingDeposits.values()).find(pd => pd.offerId === offer.id && pd.steamId === offer.partner.getSteamID64());
            if (matchedDeposit) {
                logger.info(`New offer #${offer.id} from ${offer.partner.getSteamID64()} matches a pending deposit. Allowing sentOfferChanged to handle.`);
                return;
            }

            logger.info(`Received unsolicited incoming offer #${offer.id} from ${offer.partner.getSteamID64()}. Declining.`);
            return offer.decline((err) => {
                if (err) logger.error(`Error declining unsolicited offer ${offer.id}:`, { error: err.message });
            });
        }
        logger.warn(`Ignoring unexpected incoming offer #${offer.id} from ${offer.partner.getSteamID64()} (not a deposit or not matching criteria).`);
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        if (!isBotReady) { // Critical check
            logger.debug(`Bot not ready, ignoring sentOfferChanged for offer ${offer.id}`);
            return;
        }

        if (offer.state !== oldState) {
            logger.info(`Bot Offer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]}`, { partner: offer.partner.getSteamID64(), message: offer.message });
        }

        if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
            const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
            const depositId = messageMatch ? messageMatch[1] : null;

            if (depositId && pendingDeposits.has(depositId)) {
                const depositData = pendingDeposits.get(depositId);

                // Ensure this offer hasn't been processed already (e.g. by a duplicate event)
                if (!depositData) { // Should not happen if pendingDeposits.has(depositId) is true, but defensive check
                    logger.warn(`Deposit data for ${depositId} (Offer ${offer.id}) not found in pendingDeposits map, though it was expected. Offer might have been processed already.`);
                    return;
                }

                // --- Critical Section: Process Deposit ---
                // For MongoDB replica sets, wrap these operations in a transaction.
                // let depositSession;
                try {
                    // depositSession = await mongoose.startSession();
                    // depositSession.startTransaction();

                    logger.info(`Processing accepted deposit offer #${offer.id} (DepositID: ${depositId})`, { userSteamId: depositData.steamId });

                    if (depositData.cleanupTimeout) clearTimeout(depositData.cleanupTimeout);
                    pendingDeposits.delete(depositId); // Remove from map early to prevent reprocessing

                    await User.updateOne({ _id: depositData.userId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null }/*, { session: depositSession }*/);
                    logger.info(`Cleared pendingDepositOfferId flag for user ${depositData.steamId} (Offer ${offer.id})`);

                    const depositRound = await Round.findById(depositData.roundId) /*.session(depositSession)*/;
                    if (!depositRound) throw new Error(`Round ${depositData.roundId} not found for deposit ${depositId}.`);
                    if (depositRound.status !== 'active' || isRolling) { // isRolling check is important here
                        throw new Error(`Round ${depositData.roundId} no longer active for deposit ${depositId}. Status: ${depositRound.status}, Rolling: ${isRolling}.`);
                    }
                    const isNewParticipantCheck = !depositRound.participants.some(p => p.user?.toString() === depositData.userId.toString());
                    if (isNewParticipantCheck && depositRound.participants.length >= MAX_PARTICIPANTS) {
                        throw new Error(`Participant limit reached just before inserting deposit ${depositId}.`);
                    }
                    if (depositRound.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                        const slotsLeft = MAX_ITEMS_PER_POT - depositRound.items.length;
                        throw new Error(`Pot item limit reached for deposit ${depositId}. Only ${slotsLeft} slots left.`);
                    }

                    const itemDocuments = depositData.items.map(itemData => new Item({
                        assetId: itemData.assetid, name: itemData._name, image: itemData._image,
                        price: itemData._price, owner: depositData.userId, roundId: depositData.roundId
                    }));
                    const insertedItemsResult = await Item.insertMany(itemDocuments, { /*session: depositSession,*/ ordered: false });
                    const createdItemIds = insertedItemsResult.map(doc => doc._id);
                    logger.info(`Deposit ${depositId}: Inserted ${createdItemIds.length} items into DB.`);

                    let participantIndex = depositRound.participants.findIndex(p => p.user?.toString() === depositData.userId.toString());
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));

                    if (participantIndex !== -1) {
                        depositRound.participants[participantIndex].itemsValue = (depositRound.participants[participantIndex].itemsValue || 0) + depositData.totalValue;
                        depositRound.participants[participantIndex].tickets = (depositRound.participants[participantIndex].tickets || 0) + depositTickets;
                    } else {
                        depositRound.participants.push({ user: depositData.userId, itemsValue: depositData.totalValue, tickets: depositTickets });
                        participantIndex = depositRound.participants.length - 1;
                    }

                    depositRound.totalValue = (depositRound.totalValue || 0) + depositData.totalValue;
                    depositRound.items.push(...createdItemIds);
                    await depositRound.save({ /*session: depositSession*/ });
                    // await depositSession.commitTransaction();
                    logger.info(`Deposit ${depositId} successfully processed and saved to round ${depositData.roundId}.`);

                    const finalRoundData = await Round.findById(depositData.roundId)
                        .populate('participants.user', 'steamId username avatar _id')
                        .populate('items') // Populate items to send full state
                        .lean();
                    if (!finalRoundData) throw new Error(`Failed to fetch final round data for emission (Deposit ${depositId})`);

                    currentRound = finalRoundData; // Update global state with latest, fully populated data

                    io.emit('roundUpdated', formatRoundForClient(currentRound)); // Send full updated round

                    if (finalRoundData.participants.length === 1 && !roundTimer) {
                        const userInfo = finalRoundData.participants[0]?.user;
                        logger.info(`First participant (${userInfo?.username}) joined round ${finalRoundData.roundId}. Starting timer.`);
                        startRoundTimer();
                    }

                } catch (processingError) {
                    // if (depositSession) await depositSession.abortTransaction();
                    logger.error(`CRITICAL PROCESSING ERROR for accepted deposit ${depositId} (Offer ${offer.id}):`, { error: processingError.message, stack: processingError.stack });
                    await User.updateOne({ _id: depositData.userId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                        .catch(e => logger.error("Error clearing user flag after deposit processing error:", { userId: depositData.userId, offerId: offer.id, error: e.message }));
                    io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error (Offer #${offer.id}): ${processingError.message.includes('limit reached') || processingError.message.includes('no longer active') ? processingError.message : 'Failed to process your accepted deposit.'} Contact support.` });
                    // TODO: Implement robust system to return these items to the user (e.g., create a return trade offer).
                    // Log to a specific "failed_transactions" collection for manual review.
                    // Example: await logFailedDeposit(depositData, offer.itemsToReceive, processingError.message);
                } /*finally {
                    // if (depositSession) depositSession.endSession();
                }*/
            } else if (offer.itemsToGive && offer.itemsToGive.length > 0 && (!offer.itemsToReceive || offer.itemsToReceive.length === 0)) {
                logger.info(`Payout offer #${offer.id} accepted by recipient ${offer.partner.getSteamID64()}.`);
                User.findOne({ steamId: offer.partner.getSteamID64() }).lean().then(user => {
                    if (user) io.emit('notification', { type: 'success', userId: user._id.toString(), message: `Winnings from offer #${offer.id} successfully received!` });
                }).catch(e => logger.error("Error finding user for payout accepted notification:", e));
            } else {
                logger.warn(`Offer #${offer.id} was accepted, but wasn't recognized as a pending deposit or a winnings payout.`, { message: offer.message });
            }
        } else if ([
            TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled,
            TradeOfferManager.ETradeOfferState.Expired, TradeOfferManager.ETradeOfferState.InvalidItems,
            TradeOfferManager.ETradeOfferState.Countered
        ].includes(offer.state)) {
            const stateName = TradeOfferManager.ETradeOfferState[offer.state];
            logger.warn(`Bot Offer #${offer.id} to ${offer.partner.getSteamID64()} ended unsuccessfully. State: ${stateName}.`);

            const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
            const depositId = messageMatch ? messageMatch[1] : null;

            if (depositId && pendingDeposits.has(depositId)) {
                const depositData = pendingDeposits.get(depositId);
                logger.warn(`Deposit offer ${offer.id} (DepositID: ${depositId}) was ${stateName}. Cleaning up.`);
                if (depositData.cleanupTimeout) clearTimeout(depositData.cleanupTimeout);
                pendingDeposits.delete(depositId);

                User.updateOne({ _id: depositData.userId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                    .then(updateRes => { if (updateRes.modifiedCount > 0) logger.info(`Cleared pending flag for user ${depositData.steamId} due to offer ${stateName}.`); })
                    .catch(e => logger.error("Error clearing user flag on deposit failure/expiry:", { userId: depositData.userId, offerId: offer.id, error: e.message }));
                io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Your deposit offer (#${offer.id}) was ${stateName.toLowerCase()} and was cancelled.` });
            } else if (offer.itemsToGive && offer.itemsToGive.length > 0) {
                logger.warn(`Payout offer #${offer.id} failed. State: ${stateName}. Items returned to bot inventory.`);
                User.findOne({ steamId: offer.partner.getSteamID64() }).lean().then(user => {
                    if (user) io.emit('notification', { type: 'error', userId: user._id.toString(), message: `Failed to deliver winnings (Offer #${offer.id}). The offer was ${stateName.toLowerCase()}. Contact support if this persists.` });
                }).catch(e => logger.error("Error finding user for payout fail notification:", e));
                // TODO: Flag failed payout for admin review/retry.
            }
        }
    });
}

// --- Socket.io Connection Handling ---
io.on('connection', (socket) => {
    socket.on('requestRoundData', async () => {
        try {
            let roundToSend = null;
            if (currentRound?._id) {
                roundToSend = await Round.findById(currentRound._id)
                    .populate('participants.user', 'steamId username avatar _id')
                    .populate('items')
                    .populate('winner', 'steamId username avatar _id')
                    .lean();
                if (!roundToSend) { currentRound = null; }
                else { currentRound = roundToSend; } // Update in-memory with fresh data
            }
            if (!roundToSend) {
                roundToSend = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending'] } })
                    .sort({ startTime: -1 })
                    .populate('participants.user', 'steamId username avatar _id')
                    .populate('items')
                    .populate('winner', 'steamId username avatar _id')
                    .lean();
                if (roundToSend && !currentRound) {
                    currentRound = roundToSend;
                    logger.info(`Restored round ${currentRound.roundId} (status: ${currentRound.status}) from DB on client socket request.`);
                    if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !roundTimer) {
                        startRoundTimer(!!currentRound.endTime);
                    } else if (currentRound.status === 'rolling' && !isRolling) {
                        logger.warn(`Found round ${currentRound.roundId} in 'rolling' state on client request. Attempting to finalize.`);
                        await endRound(); // This will handle the rest, including creating a new round after.
                        // The client will get updated via the endRound/roundCreated events.
                        return; // Avoid sending potentially stale data if endRound is now processing.
                    }
                }
            }

            const formattedData = formatRoundForClient(roundToSend);
            if (formattedData) {
                socket.emit('roundData', formattedData);
            } else {
                socket.emit('noActiveRound');
                if (!currentRound && !isRolling && isBotReady && isBotConfigured) { // Added isBotConfigured
                    logger.info("No active round found on client request, attempting creation...");
                    await createNewRound();
                }
            }
        } catch (err) {
            logger.error(`Error fetching round data for socket ${socket.id}:`, { error: err.message, stack: err.stack });
            socket.emit('roundError', { error: 'Failed to load round data.' });
        }
    });

    socket.on('disconnect', (reason) => {
        // logger.debug(`Client disconnected: ${socket.id}. Reason: ${reason}`);
    });
});

function formatRoundForClient(round) {
    if (!round) return null;

    let timeLeft = 0;
    if (round.status === 'active' && round.endTime) {
        try {
            const endTimeDate = new Date(round.endTime);
            if (isNaN(endTimeDate.getTime())) { timeLeft = ROUND_DURATION; } // Fallback if endTime is invalid
            else { timeLeft = Math.max(0, Math.floor((endTimeDate.getTime() - Date.now()) / 1000)); }
        }
        catch (e) { logger.warn("Error calculating timeLeft in formatRoundForClient", { roundId: round.roundId, endTime: round.endTime }); timeLeft = ROUND_DURATION; }
    } else if (round.status === 'pending' || (round.status === 'active' && (!round.participants || round.participants.length === 0))) {
        timeLeft = ROUND_DURATION;
    }


    const participantsFormatted = (round.participants || []).map(p => ({
        user: p.user ? {
            _id: p.user._id?.toString(), // Ensure _id is stringified
            steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar
        } : null,
        itemsValue: p.itemsValue || 0,
        tickets: p.tickets || 0
    })).filter(p => p.user && p.user._id); // Ensure user and user._id exist

    const itemsFormatted = (round.items || []).map(i => ({
        // Ensure item 'i' is an object and has expected properties before accessing
        assetId: i?.assetId, name: i?.name, image: i?.image,
        price: i?.price || 0,
        owner: i?.owner?._id?.toString() || i?.owner?.toString() // Handle populated or just ID
    })).filter(i => i.assetId && i.name); // Basic filter for valid items

    let winnerDetails = null;
    if (round.winner?._id) {
        winnerDetails = {
            id: round.winner._id.toString(), steamId: round.winner.steamId || 'N/A',
            username: round.winner.username || 'N/A', avatar: round.winner.avatar || 'N/A'
        };
    }

    return {
        _id: round._id?.toString(), roundId: round.roundId, status: round.status,
        startTime: round.startTime, endTime: round.endTime, timeLeft: timeLeft,
        totalValue: round.totalValue || 0, serverSeedHash: round.serverSeedHash,
        participants: participantsFormatted, items: itemsFormatted,
        ...(round.status === 'completed' && winnerDetails && { // Ensure winnerDetails is not null
            winner: winnerDetails, winningTicket: round.winningTicket,
            serverSeed: round.serverSeed, clientSeed: round.clientSeed,
            provableHash: round.provableHash, taxAmount: round.taxAmount
        })
    };
}

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
        if (!isBotConfigIntended) { logger.info("Bot features are NOT enabled (ENABLE_BOT_FEATURES is not 'true'). Trading features disabled."); }
        else if (!isBotConfigured) { logger.warn("Bot features intended, but bot is NOT fully configured. Trading features likely disabled or impaired. Check .env and logs."); }
        else if (!isBotReady) { logger.warn("Steam Bot login attempt may have failed or is pending. Check logs. Bot is currently OFFLINE."); }
        else { logger.info("Steam Bot is ready."); }

        // ensureInitialRound is called after bot login success or if bot is not configured to run.
        // If bot is configured but not ready, ensureInitialRound will wait.
        if (isBotReady || !isBotConfigIntended) {
             ensureInitialRound();
        }
    });
}
startApp();

// --- Graceful Shutdown ---
// TODO: Enhance graceful shutdown further:
// - Wait for pending database operations (especially writes in transactions).
// - Allow active trade offers (payouts) to complete or be safely re-queued.
// - Set a flag to stop accepting new deposits/rounds during shutdown.
function gracefulShutdown() {
    logger.info('Received shutdown signal. Closing server...');
    io.close(() => {
        logger.info('Socket.IO connections closed.');
    });
    server.close(async () => {
        logger.info('HTTP server closed.');
        try {
            await mongoose.connection.close();
            logger.info('MongoDB connection closed.');
            if (manager && typeof manager.stopPoll === 'function') { // Check if stopPoll method exists
                logger.info('Stopping TradeOfferManager polling...');
                manager.stopPoll(); // Or manager.shutdown() or similar, check library docs
            }
            process.exit(0);
        } catch (e) {
            logger.error("Error during shutdown cleanup:", e);
            process.exit(1);
        }
    });
    setTimeout(() => {
        logger.error('Could not close connections gracefully within timeout, forcing shutdown.');
        process.exit(1);
    }, 15000);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// --- Final Error Handling Middleware ---
app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
        logger.warn('Invalid CSRF token detected', { ip: req.ip, url: req.originalUrl, method: req.method, userId: req.user?._id });
        res.status(403).json({ error: 'Invalid security token. Please refresh the page and try again.' });
    } else {
        next(err);
    }
});

app.use((err, req, res, next) => {
    logger.error("Unhandled Error:", {
        status: err.status || 500, message: err.message, stack: err.stack,
        url: req.originalUrl, method: req.method, ip: req.ip, userId: req.user?._id
    });
    const status = err.status || 500;
    const message = (process.env.NODE_ENV === 'production' && status === 500)
        ? 'An unexpected server error occurred.'
        : (err.message || 'Unknown server error.');
    if (res.headersSent) {
        return next(err);
    }
    res.status(status).json({ error: message });
});
