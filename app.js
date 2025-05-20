// app.js (Corrected and Complete with Chat Logic & Winning History Backend)
// Modifications:
// - Ensure 'roundWinnerPendingAcceptance' event is emitted with correct data for frontend animation.
// - Ensure 'sendWinningTradeOffer' (called by '/api/round/accept-winnings') correctly generates Steam trade link with items minus site fee
//   and emits necessary info for the winnings modal.

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
const TAX_MIN_PERCENT = 5;
const TAX_MAX_PERCENT = 10;
const MIN_POT_FOR_TAX = parseFloat(process.env.MIN_POT_FOR_TAX) || 100; // Example value
const MAX_CHAT_MESSAGE_LENGTH = 200;
const CHAT_COOLDOWN_SECONDS = parseInt(process.env.CHAT_COOLDOWN_SECONDS) || 5;

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
            "script-src": ["'self'", "/socket.io/socket.io.js", "'unsafe-inline'"], // unsafe-inline for now for simpler setup with existing inline scripts
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
                        sources.push(`ws://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(`wss://${url.hostname}${url.port ? `:${url.port}` : ''}`);
                        sources.push(siteUrl); // For API calls
                    } catch (e) {
                        console.error("Invalid SITE_URL for CSP connect-src:", siteUrl, e);
                    }
                }
                sources.push("https://rust.scmm.app"); // For price fetching
                return sources;
            })(),
             "frame-src": ["'self'", "https://steamcommunity.com"], // If you embed Steam login/trade offers
             "frame-ancestors": ["'self'", "https://steamcommunity.com"], // Allow Steam to embed your site if necessary for OpenID
            "object-src": ["'none'"],
            "upgrade-insecure-requests": [],
        },
    })
);


const generalApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many login attempts from this IP, please try again after 10 minutes', standardHeaders: true, legacyHeaders: false });
const sensitiveActionLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, message: 'Too many requests for this action, please try again after 5 minutes', standardHeaders: true, legacyHeaders: false });
const depositLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 10, message: 'Too many deposit attempts, please wait a minute.', standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20,
    message: 'Too many chat messages from this IP. Please wait a moment.',
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', generalApiLimiter);
app.use(cors({ origin: process.env.SITE_URL || "*", credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session Configuration with MongoStore
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        ttl: 14 * 24 * 60 * 60, // 14 days
        autoRemove: 'native' // Default
    }),
    cookie: {
        maxAge: 3600000 * 24, // 1 day
        secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
        httpOnly: true,
        sameSite: 'lax' // Or 'strict' depending on your needs
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
    providerURL: 'https://steamcommunity.com/openid' // Default, can be omitted
},
    async (identifier, profile, done) => {
        try {
            // Ensure profile and _json exist
            if (!profile || !profile._json) {
                throw new Error('Steam profile data is missing or incomplete.');
            }
            const userData = {
                username: profile.displayName || `User${profile.id.substring(profile.id.length - 5)}`,
                avatar: profile._json.avatarfull || profile._json.avatar || '/img/default-avatar.png',
            };
            const user = await User.findOneAndUpdate(
                { steamId: profile.id },
                {
                    $set: userData,
                    $setOnInsert: { // Only set on document creation (new user)
                        steamId: profile.id,
                        tradeUrl: '',
                        createdAt: new Date(),
                        pendingDepositOfferId: null,
                        totalDepositedValue: 0,
                        totalWinningsValue: 0
                    }
                },
                { new: true, upsert: true, runValidators: true }
            );
            return done(null, user);
        } catch (err) {
            console.error('Steam Strategy Error:', err);
            return done(err);
        }
    }
));
passport.serializeUser((user, done) => done(null, user.id)); // Store user.id in session
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
        process.exit(1);
    });

// --- MongoDB Schemas ---
const userSchema = new mongoose.Schema({
    steamId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    avatar: { type: String },
    tradeUrl: {
        type: String,
        default: '',
        // Looser validation to allow empty string, strict validation on POST
        validate: {
            validator: function(v) {
                if (v === '') return true; // Allow empty string
                return /^https?:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[a-zA-Z0-9_-]+$/.test(v);
            },
            message: props => `${props.value} is not a valid Steam Trade URL!`
        }
    },
    createdAt: { type: Date, default: Date.now },
    banned: { type: Boolean, default: false },
    pendingDepositOfferId: { type: String, default: null, index: true },
    totalDepositedValue: { type: Number, default: 0, min: 0 },
    totalWinningsValue: { type: Number, default: 0, min: 0 }
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
    status: { type: String, enum: ['pending', 'active', 'rolling', 'completed', 'error', 'completed_pending_acceptance'], default: 'pending', index: true },
    startTime: { type: Date },
    endTime: { type: Date }, // When timer is supposed to end
    completedTime: { type: Date }, // When winner selection & processing actually finishes
    totalValue: { type: Number, default: 0, min: 0 }, // For winner, this is post-tax value. For active round, it's pre-tax.
    items: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }], // For winner, these are post-tax items. For active round, all items.
    participants: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        itemsValue: { type: Number, required: true, default: 0, min: 0 }, // Total value deposited by this user in this round
        tickets: { type: Number, required: true, default: 0, min: 0 }
    }],
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    winningTicket: { type: Number, min: 0 },
    serverSeed: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    serverSeedHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    clientSeed: { type: String, match: /^[a-f0-9]+$/ },
    provableHash: { type: String, match: /^[a-f0-9]{64}$/ },
    taxAmount: { type: Number, default: 0, min: 0 },
    taxedItems: [{ // Storing info about items taken as tax, not full Item docs
        assetId: String,
        name: String,
        price: { type: Number, min: 0 }
    }],
    payoutOfferId: { type: String, index: true },
    payoutOfferStatus: { type: String, enum: ['Sent', 'Accepted', 'Declined', 'Canceled', 'Expired', 'InvalidItems', 'Escrow', 'Failed', 'Unknown', 'PendingAcceptanceByWinner', 'No Items Won', 'Failed - No Trade URL', 'Failed - Inventory Issue', 'Failed - Bad URL', 'PendingConfirmation'], default: 'Unknown' }
});
roundSchema.index({ 'participants.user': 1 });
roundSchema.index({ winner: 1, status: 1, completedTime: -1 }); // For winning history

const User = mongoose.model('User', userSchema);
const Item = mongoose.model('Item', itemSchema);
const Round = mongoose.model('Round', roundSchema);


// --- Steam Bot Setup ---
const community = new SteamCommunity();
const manager = new TradeOfferManager({
    steam: community, // Use the community instance for login
    domain: process.env.SITE_URL ? process.env.SITE_URL.replace(/^https?:\/\//, '') : 'localhost', // Your domain name
    language: 'en', // Language for trade offer messages
    pollInterval: 10000, // How often to poll for new trade offers (ms)
    cancelTime: 10 * 60 * 1000, // Time before an offer sent by the bot is automatically cancelled (ms)
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
                // This block might be reached even on some login failures if err object isn't immediately populated.
                // The critical check is `community.steamID` below.
                console.log('Steam community.login callback received (no immediate error object reported).');
            }

            // Critical check after login attempt
            if (err || !community.steamID) { // Check community.steamID to confirm successful login
                console.error(`CRITICAL LOGIN FAILURE: Login callback failed or community.steamID is undefined. Error: ${err ? err.message : 'N/A'}, SteamID: ${community.steamID}, EResult: ${err?.eresult}`);
                isBotReady = false;
                if (err?.eresult === 5) console.warn('Login Failure Hint: Invalid Password? Check .env');
                if (err?.eresult === 65) console.warn('Login Failure Hint: Incorrect 2FA Code (Check Shared Secret/Server Time) or Account Rate Limit?');
                if (err?.eresult === 63) console.warn('Login Failure Hint: Account Logon Denied - Check Email Auth/Steam Guard settings via Browser?');
                return; // Stop further bot setup
            }

            console.log(`Steam bot ${loginCredentials.accountName} logged in successfully (SteamID: ${community.steamID}). Attempting to set cookies for TradeOfferManager...`);
            manager.setCookies(cookies, (setCookieErr) => {
                if (setCookieErr) {
                    console.error('TradeOfferManager Error setting cookies:', { error: setCookieErr.message, stack: setCookieErr.stack });
                    isBotReady = false; return;
                }
                console.log('TradeOfferManager cookies set successfully.');
                community.setCookies(cookies); // Also set cookies for the community instance if needed for other operations
                isBotReady = true;
                console.log("Steam Bot is ready and operational.");
                ensureInitialRound(); // Now safe to ensure round as bot is ready
            });

            // Optional: Auto-accept friend requests
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
let isRolling = false; // True if in the process of selecting winner and sending trade

const priceCache = new NodeCache({ stdTTL: PRICE_CACHE_TTL_SECONDS, checkperiod: PRICE_CACHE_TTL_SECONDS * 0.2, useClones: false });

function getFallbackPrice(marketHashName) {
    // Could have more sophisticated logic here if needed
    return MIN_ITEM_VALUE > 0 ? MIN_ITEM_VALUE : 0; // Default to MIN_ITEM_VALUE or 0
}

async function refreshPriceCache() {
    console.log("PRICE_INFO: Attempting to refresh price cache from rust.scmm.app...");
    const apiUrl = `https://rust.scmm.app/api/item/prices?currency=USD`; // USD prices
    try {
        const response = await axios.get(apiUrl, { timeout: PRICE_FETCH_TIMEOUT_MS });
        if (response.data && Array.isArray(response.data)) {
            const items = response.data;
            let updatedCount = 0;
            let newItems = [];
            items.forEach(item => {
                if (item?.name && typeof item.price === 'number' && item.price >= 0) {
                    // Prices from SCMM are in cents, convert to dollars
                    const priceInDollars = item.price / 100.0;
                    newItems.push({ key: item.name, val: priceInDollars });
                    updatedCount++;
                }
            });
            if (newItems.length > 0) {
                const success = priceCache.mset(newItems);
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
            console.error(` -> Status: ${error.response.status}, Response:`, error.response.data || error.message);
        } else if (error.request) {
            console.error(` -> Error: No response received (Network issue?).`, error.message);
        } else {
            console.error(' -> Error setting up request:', error.message);
        }
    }
}

function getItemPrice(marketHashName) {
    if (typeof marketHashName !== 'string' || marketHashName.length === 0) {
        console.warn("getItemPrice called with invalid marketHashName:", marketHashName);
        return 0; // Return 0 for invalid input
    }
    const cachedPrice = priceCache.get(marketHashName);
    return (cachedPrice !== undefined) ? cachedPrice : getFallbackPrice(marketHashName);
}

// --- Core Game Logic ---
async function createNewRound() {
    if (isRolling) {
        console.log("Cannot create new round: Current round is rolling.");
        return null;
    }
    if (currentRound && currentRound.status === 'active') {
        console.log(`Cannot create new round: Round ${currentRound.roundId} is already active.`);
        return currentRound; // Return the existing active round
    }

    try {
        isRolling = false; // Ensure isRolling is false when a new round starts
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
            totalValue: 0,
            payoutOfferStatus: 'Unknown' // Initial payout status
        });
        await newRound.save();
        currentRound = newRound.toObject(); // Store as a plain object for easier manipulation

        // Emit only essential data for round creation to avoid overwhelming clients
        io.emit('roundCreated', {
            roundId: newRound.roundId,
            serverSeedHash: newRound.serverSeedHash,
            timeLeft: ROUND_DURATION, // Initial time
            totalValue: 0,
            participants: [],
            items: [],
            status: 'active'
        });
        console.log(`--- Round ${newRound.roundId} created and active ---`);
        return newRound.toObject();
    } catch (err) {
        console.error('FATAL: Error creating new round:', err);
        // Consider a more robust retry or notification mechanism if round creation fails
        setTimeout(createNewRound, 10000); // Retry after a delay
        return null;
    }
}

async function ensureInitialRound() {
    if (isBotConfigured && isBotReady) { // Only proceed if bot is configured AND ready
        if (!currentRound) {
            try {
                // Look for an existing active round or one pending acceptance
                const existingRound = await Round.findOne({ status: { $in: ['active', 'completed_pending_acceptance', 'rolling'] } })
                    .populate('participants.user', 'steamId username avatar')
                    .populate('items') // Populate actual items
                    .populate('winner', 'steamId username avatar') // Populate winner if exists
                    .lean();

                if (existingRound) {
                    console.log(`Found existing round ${existingRound.roundId} (status: ${existingRound.status}) on startup.`);
                    currentRound = existingRound;
                    // If active and has participants, and timer should be running
                    if (currentRound.status === 'active' && currentRound.participants.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) {
                        startRoundTimer(true); // Resume timer
                    } else if (currentRound.status === 'active' && currentRound.participants.length > 0 && !currentRound.endTime && !roundTimer) {
                        console.warn(`Active round ${currentRound.roundId} found without endTime. Starting timer now.`);
                        startRoundTimer(false); // Start timer if it was missing
                    } else if (currentRound.status === 'rolling' || currentRound.status === 'completed_pending_acceptance') {
                        // If server restarts while rolling or pending acceptance, it might need re-evaluation or manual intervention.
                        // For now, log it. A more robust solution might try to re-process or reset.
                        console.warn(`Server started with round ${currentRound.roundId} in status '${currentRound.status}'. Manual check might be needed if it's stuck.`);
                        // Potentially trigger endRound again if rolling and enough time has passed, or if pending acceptance
                        // This requires careful state management to avoid double processing.
                        // For now, if it's 'completed_pending_acceptance', the user needs to click to get their items.
                        // If 'rolling', it might need to re-roll or complete based on stored data.
                        // Let's assume for now that if it was 'rolling', it should try to complete.
                        if (currentRound.status === 'rolling') {
                            console.log(`Attempting to re-finalize round ${currentRound.roundId} that was 'rolling'.`);
                            isRolling = false; // Reset lock
                            await endRound(); // Try to re-process the end.
                        }
                    }
                } else {
                    console.log("No resumable round found, creating initial round...");
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
    if (roundTimer) clearInterval(roundTimer);
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
        // Update currentRound in memory and persist to DB
        currentRound.endTime = calculatedEndTime.toISOString(); // Store as ISO string or Date
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

        io.emit('timerUpdate', { timeLeft: currenttimeLeft }); // Emit updated time

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
        return;
    }
    isRolling = true; // Lock to prevent concurrent endRound calls
    const roundIdToEnd = currentRound.roundId;
    const roundMongoId = currentRound._id; // Assuming currentRound is a Mongoose object or has ._id
    console.log(`--- Ending round ${roundIdToEnd}... ---`);

    try {
        // Mark round as 'rolling' in DB first
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'rolling', endTime: new Date() } });
        io.emit('roundRolling', { roundId: roundIdToEnd }); // Notify clients

        // Fetch the full round data needed for winner selection
        const round = await Round.findById(roundMongoId)
            .populate('participants.user', 'steamId username avatar tradeUrl') // Populate user details for participants
            .populate('items') // Populate all items initially in the pot
            .lean(); // Use lean for performance as we're mostly reading

        if (!round) throw new Error(`Round ${roundIdToEnd} data missing after status update.`);
        if (round.status !== 'rolling') { // Check if status changed unexpectedly
             console.warn(`Round ${roundIdToEnd} status changed unexpectedly after marking as rolling. Aborting endRound.`);
             isRolling = false; return;
        }
        currentRound = round; // Update global currentRound with the populated lean object

        if (round.participants.length === 0 || round.items.length === 0 || round.totalValue <= 0) {
            console.log(`Round ${round.roundId} ended with no valid participants or value.`);
            await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'completed', completedTime: new Date(), payoutOfferStatus: 'No Items Won' } });
            io.emit('roundCompleted', { roundId: round.roundId, message: "No participants." });
            isRolling = false;
            setTimeout(createNewRound, 5000); // Schedule next round
            return;
        }

        let allItemsInPot = [...round.items]; // These are populated Item documents
        let originalPotValue = round.totalValue; // This should be the sum of all item values before tax
        let valueForWinner = originalPotValue;
        let taxAmount = 0;
        let taxedItemsInfo = [];
        let itemsToGiveToWinner = [...allItemsInPot]; // Start with all items

        if (originalPotValue >= MIN_POT_FOR_TAX) {
            const targetTaxPercent = Math.random() * (TAX_MAX_PERCENT - TAX_MIN_PERCENT) + TAX_MIN_PERCENT;
            const targetTaxValue = originalPotValue * (targetTaxPercent / 100);
            // Sort items by price (ascending) to take cheaper items first for tax
            const sortedItemsForTax = [...allItemsInPot].sort((a, b) => (a.price || 0) - (b.price || 0));
            let currentTaxValueAccumulated = 0;
            let tempItemsTakenForTaxIds = new Set();

            for (const item of sortedItemsForTax) {
                if (currentTaxValueAccumulated + item.price <= targetTaxValue + 0.05) { // Allow slight overshoot for one item
                    tempItemsTakenForTaxIds.add(item._id.toString());
                    taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price });
                    currentTaxValueAccumulated += item.price;
                } else if (currentTaxValueAccumulated < targetTaxValue && tempItemsTakenForTaxIds.size < sortedItemsForTax.length) {
                    // If we haven't met target and can still take more items (and this one is too big)
                    // continue to see if smaller items can fill the gap. This logic might be complex.
                    // For simplicity, if the current item is too big and we're close, we might stop or take it if it's the last/only option.
                    // A common approach is to take items until the tax value is met or slightly exceeded by the last item.
                    // Let's refine: try to get as close as possible without significantly overshooting, prioritizing the target %.
                    // If currentTaxValue + item.price significantly overshoots, maybe skip it.
                    // For now, we'll stick to taking items that don't push total tax too far beyond max percentage.
                    // Max tax to collect would be `originalPotValue * (TAX_MAX_PERCENT / 100)`
                    const maxAllowedTaxValue = originalPotValue * (TAX_MAX_PERCENT / 100);
                     if (currentTaxValueAccumulated + item.price <= maxAllowedTaxValue) {
                         tempItemsTakenForTaxIds.add(item._id.toString());
                         taxedItemsInfo.push({ assetId: item.assetId, name: item.name, price: item.price });
                         currentTaxValueAccumulated += item.price;
                     } // else, this item is too big even for max tax, skip it.
                }
                if (currentTaxValueAccumulated >= targetTaxValue) break; // Stop if target tax met or exceeded
            }


            if (tempItemsTakenForTaxIds.size > 0) {
                itemsToGiveToWinner = allItemsInPot.filter(item => !tempItemsTakenForTaxIds.has(item._id.toString()));
                taxAmount = currentTaxValueAccumulated;
                valueForWinner = originalPotValue - taxAmount;
                console.log(`Tax Applied for Round ${round.roundId}: $${taxAmount.toFixed(2)} (${tempItemsTakenForTaxIds.size} items). Original Value: $${originalPotValue.toFixed(2)}. New Pot Value for Winner: $${valueForWinner.toFixed(2)}`);
            }
        }


        const clientSeed = crypto.randomBytes(16).toString('hex');
        const combinedString = round.serverSeed + clientSeed;
        const provableHash = crypto.createHash('sha256').update(combinedString).digest('hex');
        const decimalFromHash = parseInt(provableHash.substring(0, 8), 16);
        const totalTickets = round.participants.reduce((sum, p) => sum + (p?.tickets || 0), 0);

        if (totalTickets <= 0) throw new Error(`Cannot determine winner: Total tickets is zero for round ${round.roundId}.`);
        const winningTicket = decimalFromHash % totalTickets;
        let cumulativeTickets = 0;
        let winnerParticipantData = null;

        for (const participant of round.participants) { // round.participants.user is populated
            if (!participant?.tickets || !participant.user) continue;
            cumulativeTickets += participant.tickets;
            if (winningTicket < cumulativeTickets) {
                winnerParticipantData = participant; // This contains the populated user object
                break;
            }
        }

        if (!winnerParticipantData || !winnerParticipantData.user?._id) throw new Error(`Winner selection failed for round ${round.roundId}.`);
        const winnerUserObject = winnerParticipantData.user; // The populated user document

        await User.findByIdAndUpdate(winnerUserObject._id, { $inc: { totalWinningsValue: valueForWinner } });

        const finalUpdateData = {
            status: 'completed_pending_acceptance',
            completedTime: new Date(), clientSeed: clientSeed,
            provableHash: provableHash, winningTicket: winningTicket, winner: winnerUserObject._id,
            taxAmount: taxAmount, taxedItems: taxedItemsInfo,
            totalValue: valueForWinner, // This is the value the winner gets
            items: itemsToGiveToWinner.map(i => i._id), // Store IDs of items winner gets
            payoutOfferStatus: 'PendingAcceptanceByWinner'
        };

        // Update the round and get the version with the winner populated for the event
        const updatedRoundForEvent = await Round.findOneAndUpdate({ _id: roundMongoId }, { $set: finalUpdateData }, { new: true })
            .populate('winner', 'steamId username avatar') // Populate winner for the event
            .lean();

        if (!updatedRoundForEvent || !updatedRoundForEvent.winner) throw new Error("Failed to save or populate winner for completed round data.");

        console.log(`Round ${round.roundId} completed. Winner: ${updatedRoundForEvent.winner.username} (Ticket: ${winningTicket}/${totalTickets}, Value Won: $${valueForWinner.toFixed(2)})`);
        console.log(`Emitting 'roundWinnerPendingAcceptance' for round ${round.roundId}. Frontend should start animation.`);

        io.emit('roundWinnerPendingAcceptance', {
            roundId: round.roundId,
            winner: { // Send structured winner info
                id: updatedRoundForEvent.winner._id,
                steamId: updatedRoundForEvent.winner.steamId,
                username: updatedRoundForEvent.winner.username,
                avatar: updatedRoundForEvent.winner.avatar
            },
            winningTicket: winningTicket,
            totalValue: valueForWinner, // Value after tax
            totalTickets: totalTickets,
            serverSeed: round.serverSeed, // Revealed server seed
            clientSeed: clientSeed,
            provableHash: provableHash,
            serverSeedHash: round.serverSeedHash // Initial hash
        });
        // Trade offer is NOT sent here. It's sent when user clicks "Accept My Winnings"

    } catch (err) {
        console.error(`CRITICAL ERROR during endRound for round ${roundIdToEnd}:`, err);
        await Round.updateOne({ _id: roundMongoId }, { $set: { status: 'error', payoutOfferStatus: 'Failed' } }).catch(e => console.error("Error marking round as error after endRound failure:", e));
        io.emit('roundError', { roundId: roundIdToEnd, error: 'Internal server error during round finalization.' });
    } finally {
        isRolling = false; // Release lock
        console.log(`Scheduling next round creation after round ${roundIdToEnd} finalization process.`);
        // Schedule next round regardless of success/failure of this one, to keep game moving.
        setTimeout(createNewRound, 10000); // Delay before starting next round
    }
}

async function sendWinningTradeOffer(roundDoc, winner, itemsToSend) {
    // roundDoc is the Mongoose document for the round.
    // winner is the populated Mongoose document for the winner.
    // itemsToSend is an array of populated Mongoose Item documents for the winner (after tax).
    if (!isBotReady) {
        console.error(`PAYOUT_ERROR: Bot not ready. Round ${roundDoc.roundId}.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: `Bot Error: Payout for round ${roundDoc.roundId} delayed.` });
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed', status: 'completed' } });
        return;
    }
    if (!winner.tradeUrl) {
        console.error(`PAYOUT_ERROR: Winner ${winner.username} no Trade URL. Round ${roundDoc.roundId}.`);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: 'Set Trade URL for winnings.' });
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'Failed - No Trade URL', status: 'completed' } });
        return;
    }
    if (!itemsToSend || itemsToSend.length === 0) {
        console.log(`PAYOUT_INFO: No items for winner. Round ${roundDoc.roundId}. Tax might have taken all.`);
        io.emit('notification', { type: 'info', userId: winner._id.toString(), message: `Round ${roundDoc.roundId}: No items to send (potentially all taxed).` });
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: 'No Items Won', status: 'completed' } });
        return;
    }

    const totalWinningsValue = itemsToSend.reduce((sum, item) => sum + (item.price || 0), 0);
    console.log(`Attempting to send ${itemsToSend.length} items (calculated value $${totalWinningsValue.toFixed(2)}) for round ${roundDoc.roundId} to ${winner.username}.`);

    try {
        const offer = manager.createOffer(winner.tradeUrl);
        offer.addMyItems(itemsToSend.map(item => ({ assetid: item.assetId, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID })));
        offer.setMessage(`Winnings from Round #${roundDoc.roundId} on ${process.env.SITE_NAME}. Value: $${totalWinningsValue.toFixed(2)}`);

        const identitySecret = process.env.STEAM_IDENTITY_SECRET;
        const sentOfferDetails = await new Promise((resolve, reject) => {
            offer.send(!!identitySecret, (err, statusCallback) => { // statusCallback is like 'pending', 'sent' from offer.send
                if (err) return reject(err);
                resolve({ statusCallback, offerId: offer.id, offerState: offer.state });
            });
        });
        
        const offerURL = `https://steamcommunity.com/tradeoffer/${sentOfferDetails.offerId}/`;
        let finalOfferStatus = 'Sent'; // Default

        if (sentOfferDetails.offerState === TradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation || sentOfferDetails.statusCallback === 'pending') {
            finalOfferStatus = 'PendingConfirmation';
        } else if (sentOfferDetails.offerState === TradeOfferManager.ETradeOfferState.InEscrow) {
            finalOfferStatus = 'Escrow';
        } else if (sentOfferDetails.offerState === TradeOfferManager.ETradeOfferState.Active) { // Active means sent and awaiting user action
            finalOfferStatus = 'Sent';
        }

        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferId: sentOfferDetails.offerId, payoutOfferStatus: finalOfferStatus, status: 'completed' } });
        console.log(`PAYOUT_SUCCESS: Offer ${sentOfferDetails.offerId} sent to ${winner.username} for round ${roundDoc.roundId}. Final Status: ${finalOfferStatus}`);

        io.emit('tradeOfferSent', {
            roundId: roundDoc.roundId, userId: winner._id.toString(),
            offerId: sentOfferDetails.offerId, offerURL: offerURL, status: finalOfferStatus, type: 'winning',
            winnerInfo: { id: winner._id, steamId: winner.steamId, username: winner.username, avatar: winner.avatar },
            totalValue: totalWinningsValue // The actual value of items in the trade
        });

    } catch (err) {
        let offerStatusUpdate = 'Failed';
        let userMessage = `Error sending winnings for round ${roundDoc.roundId}. Please contact support.`;
        if (err.message?.includes('revoked') || err.message?.includes('invalid') || err.eresult === 26 || err.eresult === 15) { // 15 can be bad trade URL too
            userMessage = 'Your Trade URL is invalid or expired. Please update it to receive winnings.'; offerStatusUpdate = 'Failed - Bad URL';
        } else if (err.eresult === 16 || err.message?.includes('Target cannot trade')) {
            userMessage = 'Could not send winnings. Ensure your Steam inventory is public, not full, and you are not trade banned.'; offerStatusUpdate = 'Failed - Inventory Issue';
        } else if (err.message?.includes('escrow') || err.eresult === 11 || err.message?.includes('Trade Hold')) {
            userMessage = `Winnings sent, but may be held in escrow/trade hold by Steam.`; offerStatusUpdate = 'Escrow';
        }
        console.error(`PAYOUT_ERROR: Offer for round ${roundDoc.roundId}. EResult ${err.eresult} - ${err.message}`, err);
        io.emit('notification', { type: 'error', userId: winner._id.toString(), message: userMessage });
        await Round.updateOne({ _id: roundDoc._id }, { $set: { payoutOfferStatus: offerStatusUpdate, status: 'completed' } });
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
            res.clearCookie('connect.sid'); 
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
        return res.status(400).json({ error: errors.array()[0].msg }); 
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
            if (value === '') return true; 
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
            if (err.name === 'ValidationError') { 
                 console.error(`Trade URL Validation Error (Mongoose) for user ${req.user._id}:`, err.message);
                 return res.status(400).json({ error: err.message });
            }
            console.error(`Error updating trade URL for user ${req.user._id}:`, err);
            res.status(500).json({ error: 'Server error saving Trade URL.' });
        }
    }
);

app.get('/api/user/winning-history', ensureAuthenticated, async (req, res) => {
    try {
        const winnings = await Round.find({ winner: req.user._id, status: { $in: ['completed', 'completed_pending_acceptance']} })
            .sort({ completedTime: -1 })
            .select('roundId completedTime totalValue payoutOfferId payoutOfferStatus taxAmount') // totalValue here is after-tax
            .limit(50) 
            .lean();

        const history = winnings.map(win => ({
            gameId: win.roundId,
            amountWon: win.totalValue, 
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

app.post('/api/round/accept-winnings', ensureAuthenticated, sensitiveActionLimiter, async (req, res) => {
    try {
        const user = req.user; // Populated by Passport

        const round = await Round.findOne({
            winner: user._id,
            status: 'completed_pending_acceptance',
            payoutOfferStatus: 'PendingAcceptanceByWinner'
        }).sort({ completedTime: -1 }) // Get the latest one if multiple (should not happen)
          .populate('winner') // Populate the winner field which refers to User schema
          .populate('items'); // Populate the items field which refers to Item schema

        if (!round) {
            return res.status(404).json({ error: 'No winnings pending your acceptance found or round already processed.' });
        }
        if (!round.winner) { // Should be populated
            return res.status(500).json({ error: 'Winner data missing in round.' });
        }
        if (!round.winner.tradeUrl) {
            // Do not change round status here, sendWinningTradeOffer will handle it.
            return res.status(400).json({ error: 'Please set your Steam Trade URL in your profile to accept winnings.' });
        }

        // 'round.items' here are the populated item documents that the winner gets (after tax).
        const itemsToWin = round.items;

        if (!itemsToWin || itemsToWin.length === 0) {
             if (round.taxAmount > 0 && round.totalValue <=0) { // totalValue is already after-tax for winner
                 console.log(`User ${user.username} accepted winnings for round ${round.roundId}, but all value was taxed.`);
                 await Round.updateOne({ _id: round._id }, { $set: { payoutOfferStatus: 'No Items Won', status: 'completed' } });
                 // Notify user that it was all tax.
                 io.to(user._id.toString()).emit('notification', { // Example of direct emit to user, or use general 'tradeOfferSent'
                     type: 'info',
                     message: `Winnings for Round #${round.roundId} were entirely site tax. No items to send.`
                 });
                 return res.json({ success: true, message: 'Winnings were site tax. No items to send.' });
             }
             console.warn(`User ${user.username} accepted winnings for round ${round.roundId}, but no items were found in the round.items array.`);
             await Round.updateOne({ _id: round._id }, { $set: { payoutOfferStatus: 'Failed', status: 'completed' } });
             return res.status(500).json({ error: 'No items found to send for this win. Please contact support.' });
        }

        // Call the sendWinningTradeOffer function
        // It will update round status to 'Sent', 'Failed', etc., and main status to 'completed'
        // It will also emit the 'tradeOfferSent' event with all necessary details for the modal.
        await sendWinningTradeOffer(round, round.winner, itemsToWin);

        res.json({ success: true, message: 'Winnings accepted. Trade offer is being processed. Check notifications for status.' });

    } catch (error) {
        console.error('Error accepting winnings:', error);
        res.status(500).json({ error: 'Server error while accepting winnings. Please try again or contact support.' });
    }
});


app.get('/api/inventory', ensureAuthenticated, async (req, res) => {
    if (!isBotReady) { 
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
                resolve(inv || []); 
            });
        });

        if (!inventory?.length) return res.json([]); 

        const validItems = inventory.map(item => {
                const itemName = item.market_hash_name;
                let price = 0;
                if (itemName) price = getItemPrice(itemName);
                else console.warn(`Inventory item missing market_hash_name: assetId ${item.assetid}`);

                const finalPrice = (typeof price === 'number' && !isNaN(price)) ? price : 0;

                if (!item.assetid || !item.icon_url || !itemName) { 
                    console.warn(`Inventory item missing required properties: assetId ${item?.assetid}, Name ${itemName}, Icon ${item?.icon_url}`);
                    return null; 
                }
                const imageUrl = `https://community.akamai.steamstatic.com/economy/image/${item.icon_url}`; 
                return { assetId: item.assetid, name: itemName, image: imageUrl, price: finalPrice, tradable: item.tradable };
            })
            .filter(item => item && item.tradable && item.price >= MIN_ITEM_VALUE); 

        res.json(validItems);
    } catch (err) {
        console.error(`Error in /api/inventory for ${req.user?.username || req.user?.steamId}:`, err.message);
        res.status(500).json({ error: err.message || 'Server error fetching inventory.' });
    }
});

app.post('/api/deposit', depositLimiter, ensureAuthenticated,
    [
        body('assetIds').isArray({ min: 1, max: MAX_ITEMS_PER_DEPOSIT }).withMessage(`You can deposit between 1 and ${MAX_ITEMS_PER_DEPOSIT} items at a time.`),
        body('assetIds.*').isString().isLength({ min: 5, max: 30 }).withMessage('Invalid asset ID format.') 
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

        if (!currentRound || currentRound.status !== 'active' || isRolling) {
            return res.status(400).json({ error: 'Deposits are currently closed for this round.' });
        }

        let latestRoundData;
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
                if (!inventoryItem) throw new Error(`Item Asset ID ${assetId} not in inventory.`);
                if (!inventoryItem.tradable) throw new Error(`Item '${inventoryItem.market_hash_name}' not tradable.`);
                const price = getItemPrice(inventoryItem.market_hash_name);
                if (price < MIN_ITEM_VALUE) throw new Error(`Item '${inventoryItem.market_hash_name}' ($${price.toFixed(2)}) is below min value ($${MIN_ITEM_VALUE}).`);
                itemsToRequest.push({
                    assetid: inventoryItem.assetid, appid: RUST_APP_ID, contextid: RUST_CONTEXT_ID,
                    _price: price, _name: inventoryItem.market_hash_name,
                     _image: `https://community.akamai.steamstatic.com/economy/image/${inventoryItem.icon_url}`
                });
                depositTotalValue += price;
            }
             if (itemsToRequest.length === 0) throw new Error("No items could be verified for deposit.");
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
                userId: user._id, roundId: currentRound._id, items: itemsToRequest,
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
            const status = await new Promise((resolve, reject) => {
                offer.send((err, sendStatus) => { if (err) return reject(err); resolve(sendStatus); });
            });
            try {
                await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: offer.id });
                console.log(`Set pendingDepositOfferId=${offer.id} for user ${user.username}.`);
            } catch (dbUpdateError) {
                 console.error(`CRITICAL: Failed to set pendingDepositOfferId for user ${user.username} after sending offer ${offer.id}.`, dbUpdateError);
                  pendingDeposits.delete(depositId); clearTimeout(cleanupTimeout);
                  return res.status(500).json({ error: 'Failed to finalize deposit request state. Contact support.' });
            }
            console.log(`Deposit offer ${offer.id} sent to ${user.username}. Status: ${status}. DepositID: ${depositId}`);
            const offerURL = `https://steamcommunity.com/tradeoffer/${offer.id}/`;
            res.json({ success: true, message: 'Deposit offer created! Accept on Steam.', offerId: offer.id, offerURL: offerURL });
        } catch (error) {
            console.error(`Error sending deposit offer for ${user.username} (DepositID: ${depositId}): EResult ${error.eresult}`, error.message);
            pendingDeposits.delete(depositId); if (cleanupTimeout) clearTimeout(cleanupTimeout);
            await User.findByIdAndUpdate(user._id, { pendingDepositOfferId: null }).catch(e => console.error("Error clearing user flag on offer fail:", e));
            let userMessage = 'Failed to create deposit trade offer. Try again later.';
            if (error.message?.includes('unable to trade') && error.message.includes('reset your Steam account')) userMessage = `Steam Error: Account has temporary trade restriction. (${error.message})`;
            else if (error.message.includes('Trade URL') || error.message.includes('token') || error.eresult === 26) userMessage = 'Your Steam Trade URL might be invalid/expired. Check profile.';
            else if (error.eresult) userMessage += ` (Code: ${error.eresult})`;
            res.status(500).json({ error: userMessage });
        }
    }
);

// --- Trade Offer Manager Event Handling ---
if (isBotConfigured && manager) {
    manager.on('newOffer', async (offer) => {
        if (!isBotReady || offer.isOurOffer) return; // Ignore offers sent by the bot itself or if bot isn't ready
        // Decline unsolicited offers (offers where bot receives items without giving any)
        if (offer.itemsToReceive && offer.itemsToReceive.length > 0 && (!offer.itemsToGive || offer.itemsToGive.length === 0)) {
             if (offer.message && offer.message.includes('RustyDegen Deposit ID:')) { // Check if it's a deposit message
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like a manual deposit (user initiated to bot). Declining.`);
                 return offer.decline((err) => { if (err) console.error(`Error declining manual deposit offer ${offer.id}:`, err); });
             } else {
                 console.log(`Offer #${offer.id} from ${offer.partner.getSteamID64()} looks like an unsolicited item offer (donation?). Declining for safety.`);
                  return offer.decline((err) => { if (err) console.error(`Error declining unsolicited offer ${offer.id}:`, err); });
             }
        }
        console.log(`Ignoring unexpected incoming offer #${offer.id} from ${offer.partner.getSteamID64()}. Message: "${offer.message}"`);
    });

    manager.on('sentOfferChanged', async (offer, oldState) => {
        console.log(`Bot Offer #${offer.id} state changed: ${TradeOfferManager.ETradeOfferState[oldState]} -> ${TradeOfferManager.ETradeOfferState[offer.state]} (Partner: ${offer.partner.getSteamID64()}) Msg: "${offer.message}"`);

        const messageMatch = offer.message.match(/Deposit ID: ([a-f0-9-]+)/i);
        const depositId = messageMatch ? messageMatch[1] : null;

        if (depositId && pendingDeposits.has(depositId)) { // This is a deposit offer
            if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                const depositData = pendingDeposits.get(depositId);
                pendingDeposits.delete(depositId); // Remove from pending map
                console.log(`Processing accepted deposit offer #${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId}`);
                // Clear pending flag from user
                User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                    .catch(e => console.error("Error clearing user pending flag on deposit accept:", e));

                let depositRound;
                try {
                     // Ensure round is still active and valid for deposit
                     depositRound = await Round.findById(depositData.roundId).select('status participants items').exec(); // No lean, will save
                     if (!depositRound || depositRound.status !== 'active' || isRolling) { // isRolling check here too
                          console.warn(`Deposit ${depositId} (Offer ${offer.id}) accepted, but round invalid. Items NOT added.`);
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Round ended before offer #${offer.id} processed. Contact support.` });
                          // TODO: Potentially return items to user if round is invalid? Complex.
                          return;
                     }
                     const isNewP = !depositRound.participants.some(p => p.user?.toString() === depositData.userId.toString());
                     if (isNewP && depositRound.participants.length >= MAX_PARTICIPANTS) {
                         io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Participant limit reached for offer #${offer.id}. Contact support.` }); return;
                     }
                     if (depositRound.items.length + depositData.items.length > MAX_ITEMS_PER_POT) {
                          io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Deposit Error: Pot item limit reached for offer #${offer.id}. Contact support.` }); return;
                     }
                 } catch (roundCheckError) {
                      console.error(`CRITICAL DB ERROR checking round status for deposit ${depositId}:`, roundCheckError);
                      io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Contact support.` });
                      return; // Stop processing this deposit
                 }

                let createdItemIds = [];
                try {
                    // Create Item documents for the deposited items
                    const itemDocuments = depositData.items.map(itemData => new Item({
                        assetId: itemData.assetid, name: itemData._name, image: itemData._image,
                        price: itemData._price, owner: depositData.userId, roundId: depositData.roundId
                    }));
                    const insertedItemsResult = await Item.insertMany(itemDocuments, { ordered: false }); // ordered:false allows valid items to insert if some fail
                    createdItemIds = insertedItemsResult.map(doc => doc._id);
                    console.log(`Deposit ${depositId}: Inserted ${createdItemIds.length} items into DB.`);

                    // Update user's total deposited value
                    await User.findByIdAndUpdate( depositData.userId, { $inc: { totalDepositedValue: depositData.totalValue } } );

                    // Update the round with new participant/items
                    const roundToUpdate = await Round.findById(depositData.roundId); // Re-fetch to ensure working with latest if needed, or use depositRound if careful
                    if (!roundToUpdate || roundToUpdate.status !== 'active') throw new Error("Round status became invalid before final deposit update.");

                    let participantIndex = roundToUpdate.participants.findIndex(p => p.user?.toString() === depositData.userId.toString());
                    const depositTickets = Math.max(1, Math.floor(depositData.totalValue / TICKET_VALUE_RATIO));

                    if (participantIndex !== -1) { // Existing participant
                           roundToUpdate.participants[participantIndex].itemsValue += depositData.totalValue;
                           roundToUpdate.participants[participantIndex].tickets += depositTickets;
                    } else { // New participant
                           if (roundToUpdate.participants.length >= MAX_PARTICIPANTS) throw new Error("Participant limit hit before final save.");
                           roundToUpdate.participants.push({ user: depositData.userId, itemsValue: depositData.totalValue, tickets: depositTickets });
                    }
                    roundToUpdate.totalValue += depositData.totalValue;
                    if (roundToUpdate.items.length + createdItemIds.length > MAX_ITEMS_PER_POT) throw new Error("Pot item limit hit before final save.");
                    roundToUpdate.items.push(...createdItemIds); // Add new item ObjectIds to round

                    const savedRound = await roundToUpdate.save(); // Save changes to the round

                    // Fetch fresh data for emitting to clients
                    const latestRoundDataForEmit = await Round.findById(savedRound._id)
                        .populate('participants.user', 'steamId username avatar') // Populate user for emission
                        .lean(); // Use lean for emission object

                    if (!latestRoundDataForEmit) throw new Error('Failed to fetch updated round data for emission.');
                    currentRound = latestRoundDataForEmit; // Update global currentRound

                    const updatedParticipantDataForEmit = latestRoundDataForEmit.participants.find(p => p.user?._id.toString() === depositData.userId.toString());
                    const userInfoForEmit = updatedParticipantDataForEmit?.user;

                    if (updatedParticipantDataForEmit && userInfoForEmit) {
                          io.emit('participantUpdated', {
                               roundId: latestRoundDataForEmit.roundId, userId: userInfoForEmit._id.toString(), username: userInfoForEmit.username,
                               avatar: userInfoForEmit.avatar, itemsValue: updatedParticipantDataForEmit.itemsValue,
                               tickets: updatedParticipantDataForEmit.tickets, totalValue: latestRoundDataForEmit.totalValue,
                               depositedItems: depositData.items.map(i => ({ assetId: i.assetid, name: i._name, image: i._image, price: i._price }))
                          });
                    }
                    // Start timer if first participant
                    if (latestRoundDataForEmit.participants.length === 1 && !roundTimer && latestRoundDataForEmit.status === 'active') {
                          startRoundTimer();
                    }
                     console.log(`Deposit success processed for offer #${offer.id}. User: ${userInfoForEmit?.username}`);
                 } catch (dbErr) {
                     console.error(`CRITICAL DB/UPDATE ERROR processing deposit ${offer.id} (DepositID ${depositId}):`, dbErr);
                     io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `CRITICAL Deposit Error for offer #${offer.id}. Contact support.` });
                      // Attempt to rollback item creation if DB update failed
                      if (createdItemIds.length > 0) {
                          await Item.deleteMany({ _id: { $in: createdItemIds } });
                          console.warn(`Rolled back ${createdItemIds.length} items for failed deposit ${depositId}`);
                      }
                      if (currentRound) { // Mark current round as error if this critical failure happens
                          await Round.updateOne({ _id: currentRound._id }, { $set: { status: 'error' } });
                          io.emit('roundError', { roundId: currentRound.roundId, error: 'Critical deposit database error.' });
                      }
                 }
            } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired, TradeOfferManager.ETradeOfferState.InvalidItems].includes(offer.state)) {
                const depositData = pendingDeposits.get(depositId);
                if (depositData) { 
                    console.warn(`Deposit offer ${offer.id} (DepositID: ${depositId}) for user ${depositData.steamId} was ${TradeOfferManager.ETradeOfferState[offer.state]}.`);
                    pendingDeposits.delete(depositId);
                    User.updateOne({ steamId: depositData.steamId, pendingDepositOfferId: offer.id }, { pendingDepositOfferId: null })
                        .catch(e => console.error("Error clearing user flag on deposit failure:", e));
                    const stateMessage = TradeOfferManager.ETradeOfferState[offer.state].toLowerCase().replace(/_/g, ' ');
                    io.emit('notification', { type: 'error', userId: depositData.userId.toString(), message: `Your deposit offer (#${offer.id}) was ${stateMessage}.` });
                }
            }
        } else if (offer.itemsToGive && offer.itemsToGive.length > 0 && (!offer.itemsToReceive || offer.itemsToReceive.length === 0)) {
            // This is likely a Payout (Winnings) Offer
            let payoutStatusUpdate = 'Unknown';
            switch (offer.state) {
                case TradeOfferManager.ETradeOfferState.Accepted: payoutStatusUpdate = 'Accepted'; break;
                case TradeOfferManager.ETradeOfferState.Declined: payoutStatusUpdate = 'Declined'; break;
                case TradeOfferManager.ETradeOfferState.Canceled: payoutStatusUpdate = 'Canceled'; break;
                case TradeOfferManager.ETradeOfferState.Expired: payoutStatusUpdate = 'Expired'; break;
                case TradeOfferManager.ETradeOfferState.InvalidItems: payoutStatusUpdate = 'InvalidItems'; break;
                case TradeOfferManager.ETradeOfferState.InEscrow: payoutStatusUpdate = 'Escrow'; break;
                default: payoutStatusUpdate = TradeOfferManager.ETradeOfferState[offer.state] || 'Unknown';
            }

            console.log(`Payout offer #${offer.id} to ${offer.partner.getSteamID64()} changed to ${payoutStatusUpdate}.`);
            try {
                const updatedRound = await Round.findOneAndUpdate(
                    { payoutOfferId: offer.id },
                    { $set: { payoutOfferStatus: payoutStatusUpdate, status: 'completed' } }, // Ensure round is marked completed
                    { new: true }
                ).populate('winner', 'steamId _id'); // Populate winner to get their ID for notification

                if (updatedRound && updatedRound.winner) {
                    const winnerUserId = updatedRound.winner._id.toString();
                     if (offer.state === TradeOfferManager.ETradeOfferState.Accepted) {
                        io.emit('notification', { type: 'success', userId: winnerUserId, message: `Winnings from offer #${offer.id} (Round #${updatedRound.roundId}) received!` });
                    } else if ([TradeOfferManager.ETradeOfferState.Declined, TradeOfferManager.ETradeOfferState.Canceled, TradeOfferManager.ETradeOfferState.Expired].includes(offer.state)) {
                        io.emit('notification', { type: 'error', userId: winnerUserId, message: `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) was ${payoutStatusUpdate}. Contact support if this was an error.` });
                    } else if (offer.state === TradeOfferManager.ETradeOfferState.InEscrow) {
                         io.emit('notification', { type: 'warning', userId: winnerUserId, message: `Winnings offer #${offer.id} (Round #${updatedRound.roundId}) is held in Steam escrow.` });
                    }
                    // Potentially emit a specific event if frontend needs to update Winning History modal live
                    // io.emit('winningOfferStatusChanged', { roundId: updatedRound.roundId, offerId: offer.id, newStatus: payoutStatusUpdate, userId: winnerUserId });
                } else if (!updatedRound) {
                    console.warn(`Could not find round associated with payout offer #${offer.id} to update status.`);
                }
            } catch (dbError) {
                console.error(`Error updating payout status for offer #${offer.id} in DB:`, dbError);
            }
        } else {
            // Other types of offers or states not specifically handled
            console.warn(`Offer #${offer.id} changed state to ${TradeOfferManager.ETradeOfferState[offer.state]}, but not recognized as pending deposit or standard winnings. Message: "${offer.message}"`);
        }
    });
}

// --- Round Info API Routes ---
function formatRoundForClient(round) {
    if (!round) return null;
    const timeLeft = (round.status === 'active' && round.endTime)
        ? Math.max(0, Math.floor((new Date(round.endTime).getTime() - Date.now()) / 1000))
        : (round.status === 'pending' ? ROUND_DURATION : 0);

    const participantsFormatted = (round.participants || []).map(p => ({
        user: p.user ? { _id: p.user._id, steamId: p.user.steamId, username: p.user.username, avatar: p.user.avatar } : null,
        itemsValue: p.itemsValue || 0, tickets: p.tickets || 0
    })).filter(p => p.user); // Filter out any participants with null user

    // Items for client are simplified: assetId, name, image, price, owner (ID)
    const itemsFormatted = (round.items || []).map(i => {
        // If 'items' are ObjectIds (not populated), this won't work. They MUST be populated for this.
        // If 'items' are already populated Item documents (as they should be from .populate('items')):
        if (!i || typeof i.price !== 'number') {
            // console.warn("Formatting client round: Skipping item with invalid price or structure:", i);
            return null; // Skip malformed items
        }
        return {
            assetId: i.assetId, name: i.name, image: i.image, price: i.price || 0,
            // Ensure owner is just the ID if it's a populated object
            owner: i.owner?._id || i.owner // Handle both populated and non-populated owner field
        };
    }).filter(item => item !== null);


    let winnerDetails = null;
    if (round.winner && round.winner.steamId) { // Check if winner is populated with steamId
        winnerDetails = {
            id: round.winner._id, steamId: round.winner.steamId,
            username: round.winner.username, avatar: round.winner.avatar
        };
    } else if (round.winner) { // If winner is just an ObjectId string
         winnerDetails = { id: round.winner.toString() }; // Send just the ID
    }

    return {
        roundId: round.roundId, status: round.status, startTime: round.startTime, endTime: round.endTime,
        timeLeft: timeLeft, totalValue: round.totalValue || 0, serverSeedHash: round.serverSeedHash,
        participants: participantsFormatted, items: itemsFormatted,
        winner: winnerDetails, // Formatted winner object or null
        winningTicket: (round.status === 'completed' || round.status === 'completed_pending_acceptance') ? round.winningTicket : undefined,
        serverSeed: (round.status === 'completed' || round.status === 'completed_pending_acceptance') ? round.serverSeed : undefined,
        clientSeed: (round.status === 'completed' || round.status === 'completed_pending_acceptance') ? round.clientSeed : undefined,
        provableHash: (round.status === 'completed' || round.status === 'completed_pending_acceptance') ? round.provableHash : undefined,
        taxAmount: round.taxAmount,
        payoutOfferId: (round.status === 'completed' || round.status === 'completed_pending_acceptance') ? round.payoutOfferId : undefined,
        payoutOfferStatus: (round.status === 'completed' || round.status === 'completed_pending_acceptance') ? round.payoutOfferStatus : undefined,
    };
}

app.get('/api/round/current', async (req, res) => {
    let roundToFormat = null;
    try {
        // Prioritize the global currentRound if it exists and seems valid
        if (currentRound?._id) {
            // Re-fetch from DB to ensure it's the latest, especially participant/item details
            roundToFormat = await Round.findById(currentRound._id)
                 .populate('participants.user', 'steamId username avatar') // Ensure these fields are selected
                 .populate('items') // Populate full item details
                 .populate('winner', 'steamId username avatar') // Populate winner details
                 .lean();
            if (!roundToFormat) currentRound = null; // Clear global if not found (e.g., deleted)
            else currentRound = roundToFormat; // Update global with latest DB state
        }
        
        // If global currentRound wasn't valid or didn't exist, try to find a suitable one
        if (!roundToFormat) {
            roundToFormat = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending', 'completed_pending_acceptance'] } })
                 .sort({ startTime: -1 }) // Get the latest one
                 .populate('participants.user', 'steamId username avatar')
                 .populate('items')
                 .populate('winner', 'steamId username avatar')
                 .lean();
            
            if (roundToFormat && !currentRound) { // If we found one and global was null
                 currentRound = roundToFormat;
                 // If it's an active round that should have a timer running
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
        const queryFilter = { status: { $in: ['completed', 'error', 'completed_pending_acceptance'] } };
        const [rounds, totalCount] = await Promise.all([
            Round.find(queryFilter).sort('-roundId').skip(skip).limit(limit)
                 .populate('winner', 'username avatar steamId') // Ensure winner is populated
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
        body('clientSeed').trim().notEmpty().isString().isLength({ min: 1, max: 128 }) // Allow reasonable length
    ],
    handleValidationErrors, async (req, res) => {
    const { roundId, serverSeed, clientSeed } = req.body;
    try {
        const round = await Round.findOne({ roundId: roundId, status: {$in: ['completed', 'completed_pending_acceptance']} })
             .populate('participants.user', 'username').populate('winner', 'username').lean();
        if (!round) return res.status(404).json({ error: `Completed round #${roundId} not found.` });
        
        const providedHashOfServerSeed = crypto.createHash('sha256').update(serverSeed).digest('hex');
        if (providedHashOfServerSeed !== round.serverSeedHash) {
            return res.json({ verified: false, reason: 'Server Seed Hash mismatch. The provided Server Seed does not match the hash shown before the round.', serverSeedHash: round.serverSeedHash, calculatedHash: providedHashOfServerSeed });
        }
        
        // If the round officially used different seeds than provided (e.g. user mistake)
        if (round.serverSeed && round.clientSeed && (serverSeed !== round.serverSeed || clientSeed !== round.clientSeed)) {
            console.warn(`Verification attempt for round ${roundId} with non-matching official seeds. Provided: S=${serverSeed}/C=${clientSeed}, Official: S=${round.serverSeed}/C=${round.clientSeed}`);
            // Still proceed with calculation based on provided seeds for user to see, but mark as unverified due to official mismatch
        }

        const combinedString = serverSeed + clientSeed;
        const calculatedProvableHash = crypto.createHash('sha256').update(combinedString).digest('hex');

        // Check against the stored provable hash if it exists
        if (round.provableHash && calculatedProvableHash !== round.provableHash) {
            return res.json({ verified: false, reason: 'Calculated Provable Hash (from provided seeds) mismatch with stored Provable Hash.', expectedProvableHash: round.provableHash, calculatedProvableHash, combinedString });
        }

        const decimalFromHash = parseInt(calculatedProvableHash.substring(0, 8), 16);
        const totalTickets = round.participants?.reduce((sum, p) => sum + (p?.tickets || 0), 0) ?? 0;
        if (totalTickets <= 0) return res.json({ verified: false, reason: 'Round had zero total tickets.' });
        const calculatedWinningTicket = decimalFromHash % totalTickets;

        if (calculatedWinningTicket !== round.winningTicket) {
            return res.json({ verified: false, reason: 'Calculated winning ticket mismatch.', calculatedTicket: calculatedWinningTicket, actualWinningTicket: round.winningTicket, provableHashUsed: calculatedProvableHash, totalTickets });
        }

        // If all checks pass with provided seeds matching stored outcome
        res.json({
            verified: true, roundId: round.roundId, serverSeed, serverSeedHash: round.serverSeedHash, clientSeed,
            combinedString, finalHash: calculatedProvableHash, winningTicket: calculatedWinningTicket,
            totalTickets, totalValue: round.totalValue, // This is post-tax value for winner
            winnerUsername: round.winner?.username || 'N/A'
        });
    } catch (err) {
        console.error(`Error verifying round ${roundId}:`, err);
        res.status(500).json({ error: 'Server error during verification.' });
    }
});

// --- Socket.io Connection Handling ---
io.use((socket, next) => { sessionMiddleware(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.initialize()(socket.request, socket.request.res || {}, next); });
io.use((socket, next) => { passport.session()(socket.request, socket.request.res || {}, next); });

let connectedChatUsers = 0;
const userLastMessageTime = new Map(); // Prevents chat spam

io.on('connection', (socket) => {
    connectedChatUsers++;
    io.emit('updateUserCount', connectedChatUsers); // Update for all clients
    const user = socket.request.user; // User object from Passport
    if (user && user.username) console.log(`User ${user.username} (Socket ID: ${socket.id}) connected.`);
    else console.log(`Anonymous client (Socket ID: ${socket.id}) connected.`);

    socket.on('requestRoundData', async () => {
        try {
            let roundToSend = null;
             // Try to use the global currentRound if it's populated
             if (currentRound?._id) {
                 // Re-fetch from DB to ensure data is fresh, especially participant/item details
                 roundToSend = await Round.findById(currentRound._id)
                       .populate('participants.user', 'steamId username avatar')
                       .populate('items') // Populate the Item documents themselves
                       .populate('winner', 'steamId username avatar') // Populate winner if any
                       .lean();
                 if (!roundToSend) currentRound = null; // Clear if not found (e.g., deleted or error)
                 else currentRound = roundToSend; // Update global with the fresh DB state
             }
             
             // If global currentRound wasn't useful, fetch the latest relevant round
             if (!roundToSend) {
                 roundToSend = await Round.findOne({ status: { $in: ['active', 'rolling', 'pending', 'completed_pending_acceptance'] } })
                       .sort({ startTime: -1 }) // Get the latest one
                       .populate('participants.user', 'steamId username avatar')
                       .populate('items')
                       .populate('winner', 'steamId username avatar')
                       .lean();
                 if (roundToSend && !currentRound) { // If we found one and global was null
                      currentRound = roundToSend;
                      // If it's an active round that should have a timer running
                      if (currentRound.status === 'active' && currentRound.participants?.length > 0 && currentRound.endTime && new Date(currentRound.endTime) > Date.now() && !roundTimer) startRoundTimer(true);
                      else if (currentRound.status === 'active' && currentRound.participants?.length > 0 && !currentRound.endTime && !roundTimer) startRoundTimer(false);
                 }
             }
            const formattedData = formatRoundForClient(roundToSend); // Ensure this populates items and winner correctly
            if (formattedData) socket.emit('roundData', formattedData);
            else socket.emit('noActiveRound'); // Or some other indicator
        } catch (err) {
            console.error(`Error fetching round data for socket ${socket.id}:`, err);
            socket.emit('roundError', { error: 'Failed to load round data.' });
        }
    });

    socket.on('chatMessage', (msg) => {
        if (!user || !user._id) { // Check if user is authenticated
            socket.emit('notification', {type: 'error', message: 'You must be logged in to chat.'}); return;
        }
        const userId = user._id.toString();
        const now = Date.now();
        const lastMessageTime = userLastMessageTime.get(userId) || 0;
        if (now - lastMessageTime < CHAT_COOLDOWN_SECONDS * 1000) {
            const timeLeft = Math.ceil((CHAT_COOLDOWN_SECONDS * 1000 - (now - lastMessageTime)) / 1000);
            socket.emit('notification', {type: 'warning', message: `Please wait ${timeLeft}s before sending another message.`}); return;
        }
        if (typeof msg !== 'string' || msg.trim().length === 0 || msg.trim().length > MAX_CHAT_MESSAGE_LENGTH) {
            socket.emit('notification', {type: 'error', message: `Invalid message. Max ${MAX_CHAT_MESSAGE_LENGTH} characters.`}); return;
        }
        userLastMessageTime.set(userId, now); // Update last message time
        // Sanitize message if needed (though usually handled client-side for display, backend for storage)
        const messageData = {
            username: user.username, avatar: user.avatar || '/img/default-avatar.png',
            message: msg.trim(), userId: userId, userSteamId: user.steamId, timestamp: new Date()
        };
        io.emit('chatMessage', messageData); // Broadcast to all clients
        console.log(`Chat (User: ${user.username}, ID: ${userId}): ${msg.trim()}`);
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
        if (!isBotConfigured) console.log("INFO: Steam Bot not configured. Trade features disabled.");
        else if (!isBotReady) console.log("INFO: Steam Bot login attempt may have failed or is pending.");
        else console.log("INFO: Steam Bot is ready.");
        ensureInitialRound(); // Call after bot readiness is determined
    });
}
startApp();

function gracefulShutdown() {
    console.log('Received shutdown signal. Closing server...');
    io.close(() => { // Close Socket.IO connections
        console.log('Socket.IO connections closed.');
        server.close(async () => { // Close HTTP server
            console.log('HTTP server closed.');
            try {
                await mongoose.connection.close(); // Close MongoDB connection
                console.log('MongoDB connection closed.');
                if (manager && typeof manager.shutdown === 'function') {
                     console.log('Stopping TradeOfferManager polling...');
                     manager.shutdown(); // Properly stop trade offer polling
                } else if (manager) {
                     console.log('TradeOfferManager will stop on process exit (no explicit shutdown method called).');
                }
                process.exit(0);
            } catch (e) {
                console.error("Error during shutdown resource cleanup:", e);
                process.exit(1);
            }
        });
    });
    // Force shutdown if graceful fails
    setTimeout(() => {
        console.error('Could not close connections gracefully in time, forcing shutdown.');
        process.exit(1);
    }, 10000); // 10 seconds timeout
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown); // Catches Ctrl+C

// Global error handler (must be last middleware)
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    const status = err.status || 500;
    const message = process.env.NODE_ENV === 'production' ? 'An unexpected server error occurred.' : (err.message || 'Unknown server error.');
    if (res.headersSent) return next(err); // If response already started, delegate to Express default handler
    res.status(status).json({ error: message });
});

console.log("app.js: Winnings trade offer logic and event emissions refined.");
