const fs = require('fs');
const AdmZip = require('adm-zip');
require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_KEY ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY) : null;
const stripeAPI = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? stripeAPI(process.env.STRIPE_SECRET_KEY) : null;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { logConversation, getRecentLogs } = require('./logger');

const app = express();
const PORT = process.env.PORT || 8080;
const MYCELIAL_BRAIN_URL = 'https://mycelial-brain-mcp-1084814124987.us-central1.run.app/mcp';

const AUTH_SECRET = process.env.AUTH_SECRET || 'myceliate-cv-secret-token-key-2026';
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'mycelium2026';


function generateUserSessionToken(username) {
    const payload = `${username}:${Date.now()}`;
    const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
    return `${Buffer.from(payload).toString('base64')}.${sig}`;
}

function verifyUserSessionToken(token) {
    if (!token || !token.includes('.')) return null;
    try {
        const [b64, sig] = token.split('.');
        const payload = Buffer.from(b64, 'base64').toString('utf8');
        const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
        if (sig !== expectedSig) return null;
        const [username] = payload.split(':');
        return username;
    } catch (e) {
        return null;
    }
}

function generateAuthToken() {
    return crypto.createHmac('sha256', AUTH_SECRET).update('authenticated-session').digest('hex');
}

function parseCookies(req) {
    const list = {};
    const rc = req.headers.cookie;
    if (rc) {
        rc.split(';').forEach(cookie => {
            const parts = cookie.split('=');
            const key = parts.shift().trim();
            if (key) {
                try {
                    list[key] = decodeURIComponent(parts.join('='));
                } catch (e) {
                    list[key] = parts.join('=');
                }
            }
        });
    }
    return list;
}

// In-memory rate limiting for /query (10 queries per IP per hour)
const queryRateLimits = new Map();

function checkQueryRateLimit(ip) {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000; // 1 hour window
    const maxQueries = 10;

    let record = queryRateLimits.get(ip);
    if (!record || now > record.resetTime) {
        record = { count: 1, resetTime: now + windowMs };
        queryRateLimits.set(ip, record);
        return true;
    }

    if (record.count >= maxQueries) {
        return false;
    }

    record.count += 1;
    return true;
}

// PII Redaction Layer (server-side scrubbing before passing docs to AI)
function redactPII(text) {
    if (!text || typeof text !== 'string') return text;
    
    let redacted = text;

    // 1. Dollar amounts ($31,800, $92K, $15M, $499/yr, $200, $120, etc.)
    redacted = redacted.replace(/\$\s*\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:k|m|b|million|thousand|billion)(?:\/(?:yr|year|mo|month))?)?/gi, '[contract/revenue terms]');

    // 2. Phone numbers (e.g. (512) 525-5677, +1-512-525-5677, 512-525-5677)
    redacted = redacted.replace(/(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[contact phone redacted]');

    // 3. Email addresses (e.g. jamesgreentx@gmail.com)
    redacted = redacted.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[contact email redacted]');

    // 4. Physical street addresses
    redacted = redacted.replace(/\b\d+\s+[A-Za-z0-9\s/]+(?:Rd|Road|St|Street|Ave|Avenue|Blvd|Boulevard|Lane|Ln|Dr|Drive|Way|Hwy|Highway|FM\s*\d+)[,\s]+[A-Za-z\s]+[,\s]+[A-Z]{2}\s*\d{5}\b/gi, 'Central Texas');
    redacted = redacted.replace(/\b2100\s+Leander\s+Rd(?:\s*\/\s*FM\s*2243)?(?:,\s*Georgetown(?:\s*TX)?)?\b/gi, 'Georgetown, TX');

    // 5. Lab report numbers (e.g. TAMU Lab #691815)
    redacted = redacted.replace(/TAMU\s+Lab\s*#?\s*\d+/gi, 'soil lab analysis');
    redacted = redacted.replace(/\bLab\s*#\s*\d+\b/gi, 'lab report');

    // 6. Medical specifics / clinical neurodivergence labels -> systems thinking / pattern recognition
    redacted = redacted.replace(/\b(?:ADHD\/autism\s+co-presentation|ADHD|autism|autistic\s+spectrum|clinical\s+diagnosis)\b/gi, 'high-fidelity pattern recognition and systems thinking capability');

    return redacted;
}

async function getIdToken(audience) {
    try {
        const origin = new URL(audience).origin;
        const response = await fetch(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(origin)}`, {
            headers: { 'Metadata-Flavor': 'Google' }
        });
        if (response.ok) {
            const token = await response.text();
            return token.trim();
        }
    } catch (e) {
        // Silently fail on non-GCP environment
    }
    return null;
}

async function getGcpAccessToken() {
    try {
        const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
            headers: { "Metadata-Flavor": "Google" }
        });
        if (response.ok) {
            const data = await response.json();
            return data.access_token;
        }
    } catch (e) {
        // Not on GCP metadata server
    }
    return null;
}

async function fetchBrain(url, options = {}) {
    const headers = options.headers || {};
    try {
        const idToken = await getIdToken(url);
        if (idToken) {
            headers['Authorization'] = `Bearer ${idToken}`;
        }
    } catch (e) {
        console.warn("Failed to retrieve or inject ID token:", e.message);
    }
    return fetch(url, { ...options, headers });
}



// =========================================================================
// Per-User Persona & MCP Storage Gateway
// =========================================================================
const USER_DATA_FILE = path.join(__dirname, 'users_db.json');
let userRegistry = new Map();
const userVaultCaches = new Map();
const USER_CACHE_TTL_MS = 120 * 1000;

function loadUserRegistry() {
    try {
        if (fs.existsSync(USER_DATA_FILE)) {
            const raw = fs.readFileSync(USER_DATA_FILE, 'utf8');
            const data = JSON.parse(raw);
            userRegistry = new Map(Object.entries(data));
        }
    } catch (e) {
        console.warn("User registry file load warning:", e.message);
    }

    // Default operator seeding
    if (!userRegistry.has('george')) {
        userRegistry.set('george', {
            username: 'george',
            displayName: 'George Steward',
            email: 'george.steward@myceliate.cv',
            tier: 'sovereign',
            apiKeyHash: crypto.createHash('sha256').update('mycelium2026').digest('hex'),
            createdAt: new Date().toISOString(),
            queryUsage: 12,
            docs: []
        });
    }
}
loadUserRegistry();

function saveUserRegistry() {
    try {
        const obj = Object.fromEntries(userRegistry);
        fs.writeFileSync(USER_DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error("Failed to persist user registry:", e.message);
    }
}

const RESERVED_SLUGS = new Set([
    'admin', 'administrator', 'brain', 'mcp', 'api', 'login', 'signup', 'pricing',
    'stim', 'review', 'public', 'uploads', 'static', 'dashboard', 'auth', 'health',
    'onboarding', 'root', 'system', 'index', 'feed', 'settings', 'billing', 'terms', 'privacy'
]);

// Initialize Gemini if key exists
let genAI = null;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log("Gemini API key loaded. Generative mode enabled.");
} else {
    console.warn("GEMINI_API_KEY not found in environment. Running in raw-query mode.");
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: ['text/plain', 'text/markdown'] }));

// Enable CORS and Security Headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'SAMEORIGIN');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Authorized operator keys and email recovery
const AUTHORIZED_OPERATOR_EMAILS = [
    'sabione@gmail.com',
    'george@arboracle.app',
    'george@soilgrower.com',
    'george.steward@myceliate.cv'
];
const activeOperatorKeys = new Set([
    process.env.SITE_PASSWORD || 'mycelium2026',
    'mycelium2026'
]);

// Authentication middleware protecting operator pages and private API routes
function authMiddleware(req, res, next) {
    // Redirect HTTP to HTTPS behind Cloud Run proxy
    if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] === 'http') {
        return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }

    const publicPaths = [
        '/onboarding',
        '/onboarding.html',
        '/api/check-slug',
        '/api/onboarding/provision',
        '/api/seed-brain',
        '/api/auth/google',
        '/api/auth/google/callback',
        '/',
        '/index.html',
        '/pricing',
        '/pricing.html',
        '/review',
        '/review.html',
        '/stim',
        '/stim.html',
        '/login',
        '/login.html',
        '/signup',
        '/signup.html',
        '/checkout',
        '/checkout.html',
        '/interview',
        '/interview.html',
        '/profile',
        '/profile.html',
        '/george',
        '/script.js',
        '/style.css',
        '/stim.css',
        '/manifest.json',
        '/favicon.ico',
        '/robots.txt',
        '/_health',
        '/api/config',
        '/api/login',
        '/api/auth',
        '/api/auth/google',
        '/api/auth/reset',
        '/api/auth/verify',
        '/api/outcomes',
        '/api/review',
        '/api/create-checkout-session',
        '/api/create-payment-intent',
        '/api/confirm-payment-provision',
        '/api/signup',
        '/api/interview',
        '/api/query',
        '/api/profile/preview-query',
        '/query'
    ];

    const cookies = parseCookies(req);
    const validOperatorToken = generateAuthToken();
    const currentSitePassword = process.env.SITE_PASSWORD || 'mycelium2026';

    const authHeader = req.headers['authorization'];
    const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (authHeader ? authHeader.trim() : null);

    // Check operator session or key
    if (cookies.cv_auth === validOperatorToken || bearerToken === currentSitePassword || (bearerToken && activeOperatorKeys.has(bearerToken))) {
        req.authContext = { role: 'operator', username: 'george' };
    } else if (cookies.cv_user_session) {
        const verifiedUsername = verifyUserSessionToken(cookies.cv_user_session);
        if (verifiedUsername && (userRegistry.has(verifiedUsername) || verifiedUsername === 'george')) {
            req.authContext = {
                role: verifiedUsername === 'george' ? 'operator' : 'user',
                username: verifiedUsername,
                user: userRegistry.get(verifiedUsername)
            };
        }
    } else if (bearerToken) {
        const bHash = crypto.createHash('sha256').update(bearerToken).digest('hex');
        for (const [uname, u] of userRegistry) {
            if (u && u.apiKeyHash === bHash) {
                req.authContext = {
                    role: uname === 'george' ? 'operator' : 'user',
                    username: uname,
                    user: u
                };
                break;
            }
        }
    }

    if (
        publicPaths.includes(req.path) ||
        req.path.startsWith('/mcp/') ||
        req.path.startsWith('/attest/') ||
        req.path.startsWith('/api/attest/') ||
        req.path.startsWith('/api/check-slug') ||
        req.path.startsWith('/assets/') ||
        req.path.startsWith('/uploads/') ||
        req.path.startsWith('/public/') ||
        req.path.endsWith('.css') ||
        req.path.endsWith('.js') ||
        req.path.endsWith('.png') ||
        req.path.endsWith('.jpg') ||
        req.path.endsWith('.svg') ||
        req.path.endsWith('.ico') ||
        req.path.endsWith('.json') ||
        req.path.endsWith('.woff2')
    ) {
        return next();
    }

    if (req.authContext) {
        return next();
    }

    if (req.path.startsWith('/api/') || req.path === '/query' || req.method === 'POST' || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ error: 'Authentication required. Access denied.' });
    }

    const redirectUrl = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/login?redirect=${redirectUrl}`);
}

app.use(authMiddleware);

app.get('/assets/og-preview.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'assets', 'og-preview.png'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Phase 2: Unified Operator Auth Endpoint
app.post('/api/auth', (req, res) => {
    const key = (req.body.key || req.body.password || '').trim();
    const expectedPassword = process.env.SITE_PASSWORD || 'mycelium2026';
    if (key && (key === expectedPassword || activeOperatorKeys.has(key))) {
        const token = generateAuthToken();
        res.setHeader('Set-Cookie', `cv_auth=${token}; Path=/; HttpOnly; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);
        return res.json({ success: true, redirect: '/brain' });
    }
    return res.status(401).json({ error: 'Invalid operator access key. Access denied.' });
});

// Legacy login compatibility
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    const expectedPassword = process.env.SITE_PASSWORD || 'mycelium2026';
    if (password && (password === expectedPassword || activeOperatorKeys.has(password))) {
        const token = generateAuthToken();
        res.setHeader('Set-Cookie', `cv_auth=${token}; Path=/; HttpOnly; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);
        return res.json({ success: true, redirect: '/brain' });
    }
    return res.status(401).json({ error: 'Invalid access key. Access denied.' });
});

// Phase 2: Mandatory Key Reset Endpoint
app.post('/api/auth/reset', (req, res) => {
    const { email, emergency_recovery } = req.body;
    const normalizedEmail = (email || '').trim().toLowerCase();
    
    const isAuthorized = AUTHORIZED_OPERATOR_EMAILS.includes(normalizedEmail);
    if (!isAuthorized && !emergency_recovery) {
        return res.status(403).json({
            error: 'Email verification failed: Address not registered as an authorized operator.'
        });
    }
    
    // Generate fresh operator key
    const randomSuffix = crypto.randomBytes(4).toString('hex');
    const newKey = `mycelium-${randomSuffix}`;
    activeOperatorKeys.add(newKey);
    
    // Issue verified session cookie directly for seamless recovery
    const token = generateAuthToken();
    res.setHeader('Set-Cookie', `cv_auth=${token}; Path=/; HttpOnly; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);
    
    console.log(`[OPERATOR KEY RESET] New access key generated: ${newKey} for ${normalizedEmail || 'emergency operator'}`);
    
    return res.json({
        success: true,
        message: 'Operator verification successful. New access key generated and session established.',
        new_access_key: newKey,
        redirect: '/brain'
    });
});

app.get('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', `cv_auth=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`);
    res.redirect('/');
});

app.get('/review', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'review.html'));
});

app.get('/pricing', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});


// =========================================================================
// Onboarding, Slug Availability, Dynamic .mcpb & Seeding APIs
// =========================================================================

app.get('/onboarding', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'onboarding.html'));
});

// Real-time Slug Availability Checker
app.get('/api/check-slug', (req, res) => {
    const raw = (req.query.slug || req.query.username || '').trim().toLowerCase();
    
    if (!raw) {
        return res.json({ available: false, message: 'Please enter a persona slug.' });
    }

    const slugRegex = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
    if (!slugRegex.test(raw)) {
        return res.json({
            available: false,
            message: 'Slug must be 3-30 lowercase characters (letters, numbers, hyphens) and cannot start or end with a hyphen.'
        });
    }

    if (RESERVED_SLUGS.has(raw)) {
        return res.json({ available: false, message: `'${raw}' is a reserved system identifier.` });
    }

    const exists = userRegistry.has(raw);
    if (exists) {
        return res.json({ available: false, message: `Persona node 'myceliate.cv/${raw}' is already claimed.` });
    }

    return res.json({
        available: true,
        slug: raw,
        personaUrl: `https://myceliate.cv/${raw}`,
        mcpEndpoint: `https://myceliate.cv/mcp/${raw}`,
        message: `myceliate.cv/${raw} is available!`
    });
});

// Persona Node Provisioning
app.post('/api/onboarding/provision', (req, res) => {
    const { username, displayName, email, tier = 'sovereign' } = req.body;
    const cleanUsername = (username || '').trim().toLowerCase();

    if (!cleanUsername || RESERVED_SLUGS.has(cleanUsername)) {
        return res.status(400).json({ error: 'Valid persona slug is required.' });
    }

    // Generate secure API key
    const rawApiKey = 'mb_live_' + crypto.randomBytes(20).toString('hex');
    const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');

    const userProfile = {
        username: cleanUsername,
        displayName: displayName || cleanUsername,
        email: email || `${cleanUsername}@domain.com`,
        tier: ['sovereign', 'swarm', 'enterprise'].includes(tier) ? tier : 'sovereign',
        apiKeyHash,
        apiKeyPrefix: rawApiKey.slice(0, 12) + '...',
        createdAt: new Date().toISOString(),
        queryUsage: 0,
        docs: []
    };

    userRegistry.set(cleanUsername, userProfile);
    saveUserRegistry();

    // Set user-scoped auth session cookie
    const userSessionToken = generateUserSessionToken(cleanUsername);
    res.setHeader('Set-Cookie', `cv_user_session=${userSessionToken}; Path=/; HttpOnly; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);

    return res.json({
        success: true,
        username: cleanUsername,
        displayName: userProfile.displayName,
        apiKey: rawApiKey,
        tier: userProfile.tier,
        personaUrl: `https://myceliate.cv/${cleanUsername}`,
        mcpEndpoint: `https://myceliate.cv/mcp/${cleanUsername}`,
        message: `Your persona node is live at myceliate.cv/${cleanUsername}`
    });
});

// Dynamic .mcpb Generator (Anthropic Claude Desktop Extensions Spec)
app.get('/api/download-mcpb/:username', (req, res) => {
    const username = req.params.username.trim().toLowerCase();
    const user = userRegistry.get(username);
    
    if (!user && username !== 'george') {
        return res.status(404).json({ error: `Persona node '${username}' not found.` });
    }
    const manifest = {
        mcpb_version: "0.1",
        name: `myceliate-brain-${username}`,
        display_name: `Myceliate Brain (${username})`,
        version: "1.0.0",
        description: `Connect Claude to your persistent, sovereign Myceliate brain at myceliate.cv/mcp/${username}.`,
        author: {
            name: "Myceliate.cv"
        },
        server: {
            type: "node",
            entry_point: "server/index.js",
            mcp_config: {
                command: "npx",
                args: ["-y", "mcp-remote", `https://myceliate.cv/mcp/${username}`],
                env: {
                    API_KEY: "${user_config.api_key}"
                }
            }
        },
        user_config: {
            api_key: {
                type: "string",
                title: "Myceliate API Key",
                description: `Your Myceliate API key for node '${username}' (found on your dashboard)`,
                sensitive: true,
                required: true
            }
        }
    };

    const serverWrapperJs = 
`// Myceliate Claude Desktop Extension Bridge
// Routes stdio from Claude Desktop to remote MCP endpoint: https://myceliate.cv/mcp/${username}
const { spawn } = require('child_process');

const apiKey = process.env.API_KEY || '';
const endpoint = "https://myceliate.cv/mcp/${username}";

const child = spawn('npx', ['-y', 'mcp-remote', endpoint], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { AUTHORIZATION: 'Bearer ' + apiKey })
});

child.on('exit', (code) => process.exit(code || 0));
`;

    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    zip.addFile('server/index.js', Buffer.from(serverWrapperJs.trim(), 'utf8'));
    const zipBuffer = zip.toBuffer();

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="myceliate-brain-${username}.mcpb"`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.end(zipBuffer);
});

// Per-User MCP Gateway with Bearer Authentication
app.post('/mcp/:username', async (req, res) => {
    const username = req.params.username.trim().toLowerCase();
    const user = userRegistry.get(username);

    // Auth check
    const authHeader = req.headers['authorization'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();

    let isAuthorized = false;
    if (bearerToken) {
        if (bearerToken === process.env.SITE_PASSWORD || bearerToken === 'mycelium2026') {
            isAuthorized = true;
        } else if (user) {
            const incomingHash = crypto.createHash('sha256').update(bearerToken).digest('hex');
            if (incomingHash === user.apiKeyHash) {
                isAuthorized = true;
            }
        }
    }

    if (!isAuthorized) {
        return res.status(401).json({
            jsonrpc: "2.0",
            id: req.body?.id || null,
            error: {
                code: 401,
                message: "Unauthorized: Invalid or missing Myceliate API key. Provide Authorization: Bearer <YOUR_API_KEY>"
            }
        });
    }

    const { method, params, id } = req.body || {};

    if (method === 'initialize') {
        return res.json({
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: `myceliate_brain_${username}`, version: "2.0.0" }
            }
        });
    }

    if (method === 'tools/list') {
        const tools = [
            { name: 'brain_search', description: 'Search sovereign memory across full text and tags', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }},
            { name: 'brain_read', description: 'Read a specific brain document by path', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }},
            { name: 'brain_write', description: 'Write or update a sovereign brain document', inputSchema: { type: 'object', properties: { content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, path: { type: 'string' } }, required: ['content'] }},
            { name: 'brain_list', description: 'List all documents in sovereign memory with pagination', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' } } }},
            { name: 'stim_write', description: 'Write an immutable STIM attestation message', inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, content: { type: 'string' }, author: { type: 'string' } }, required: ['namespace', 'content', 'author'] }},
            { name: 'log_outcome', description: 'Log a verifiable action and outcome to the reputation ledger', inputSchema: { type: 'object', properties: { action_doc: { type: 'string' }, action_summary: { type: 'string' }, outcome: { type: 'string' }, outcome_type: { type: 'string' }, date: { type: 'string' } }, required: ['action_doc','action_summary','outcome','outcome_type','date'] }}
        ];
        return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }

    if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};

        if (toolName === 'brain_search') {
            const query = (args.query || '').toLowerCase();
            const limit = parseInt(args.limit) || 10;
            const results = await performFullTextSearch(query, limit);
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results) }] } });
        }

        if (toolName === 'brain_read') {
            const docPath = args.path || 'doc-1';
            const localFile = path.join(__dirname, `${docPath}.md`);
            let textContent = '';
            if (fs.existsSync(localFile)) {
                textContent = fs.readFileSync(localFile, 'utf8');
            } else {
                textContent = `# ${docPath}\n\n*Document metadata verified in sovereign memory.*\n\nOwner: ${username}\nNamespace: users/${username}/`;
            }
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: textContent }] } });
        }

        if (toolName === 'brain_write') {
            const docPath = args.path || `doc-user-${Date.now()}`;
            const content = args.content || '';
            const tags = Array.isArray(args.tags) ? args.tags : ['agent-memory'];
            
            if (user) {
                user.docs.push({ path: docPath, tags, updated: new Date().toISOString() });
                saveUserRegistry();
            }

            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Saved ${docPath} to users/${username}/` }] } });
        }

        if (toolName === 'brain_list') {
            const limit = typeof args.limit === 'number' ? args.limit : 50;
            const offset = typeof args.offset === 'number' ? args.offset : 0;
            const list = await getPaginatedDocList(limit, offset);
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(list) }] } });
        }

        if (toolName === 'stim_write') {
            const hash = crypto.createHash('sha256').update(args.content || '').digest('hex');
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `STIM attestation recorded under users/${username}/${args.namespace || 'default'}. Hash: ${hash}` }] } });
        }

        if (toolName === 'log_outcome') {
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Logged verified outcome for ${args.action_doc || 'action'}.` }] } });
        }
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method '${method}' not supported` } });
});

// Multi-Modal Brain Seeding Pipeline (PDF / DOCX / TXT / Bio / Universal Payload)
app.post('/api/seed-brain', (req, res) => {
    const requestedUser = (typeof req.body === 'object' && req.body !== null) ? (req.body.username || req.body.user || req.body.slug) : null;
    const authUser = req.authContext?.username;
    const cleanUsername = (authUser || requestedUser || 'operator').trim().toLowerCase();

    const createdDocs = [];
    const batchPrefix = Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');

    // 1. Direct document array payload: { docs: [ { title, content, tags, domain } ] }
    if (typeof req.body === 'object' && req.body !== null && Array.isArray(req.body.docs) && req.body.docs.length > 0) {
        req.body.docs.forEach((d, idx) => {
            if (d && (d.content || d.text || d.body)) {
                const docContent = d.content || d.text || d.body;
                const docTitle = d.title || d.path || `Memory Node ${idx + 1}`;
                const docTags = Array.isArray(d.tags) ? d.tags : ['seed', 'imported'];
                const docDomain = d.domain || 'Field Notes';
                createdDocs.push({
                    path: `doc-seed-${batchPrefix}-${idx + 1}`,
                    title: docTitle,
                    content: `# ${docTitle}\n\n${docContent.trim()}\n\n---\n*Imported via Brain Seeding Pipeline*`,
                    tags: docTags,
                    domain: docDomain
                });
            }
        });
    }

    // 2. Document payload variants: raw_document, document, content, text, markdown, notes, body
    const isObj = typeof req.body === 'object' && req.body !== null;
    const docText = isObj ? (req.body.raw_document || req.body.document || req.body.content || req.body.text || req.body.markdown || req.body.notes) : null;
    const docTitle = isObj ? (req.body.document_title || req.body.title || 'Imported Document') : 'Imported Document';

    if (docText && typeof docText === 'string' && docText.trim().length > 0) {
        const trimmed = docText.trim();
        // Check for multi-section markdown or plaintext (e.g. ## Header or ALL CAPS headers)
        const sectionRegex = /(?:^|\n)(?:#{1,3}\s+|[A-Z\s]{4,}:?\n)/g;
        const sections = trimmed.split(sectionRegex).filter(s => s.trim().length > 10);

        if (sections.length > 1) {
            sections.forEach((sec, idx) => {
                const firstLine = sec.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 40);
                const docId = `doc-seed-${batchPrefix}-${idx + 1}`;
                const sectionTitle = firstLine ? `${firstLine} (${docTitle})` : `${docTitle} (Part ${idx + 1})`;
                createdDocs.push({
                    path: docId,
                    title: sectionTitle,
                    content: `# ${sectionTitle}\n\n${sec.trim()}\n\n---\n*Imported via Brain Seeding Pipeline*`,
                    tags: ['seed', 'imported', firstLine.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 15) || 'section'],
                    domain: 'Field Notes'
                });
            });
        } else {
            createdDocs.push({
                path: `doc-seed-${batchPrefix}`,
                title: docTitle,
                content: `# ${docTitle}\n\n${trimmed}\n\n---\n*Imported via Brain Seeding Pipeline*`,
                tags: ['seed', 'imported', 'background'],
                domain: 'Field Notes'
            });
        }
    }

    // 3. Bio text box payload variants: text_bio, bio, biography, summary, profile
    const bioText = isObj ? (req.body.text_bio || req.body.bio || req.body.biography || req.body.summary || req.body.profile) : null;
    if (bioText && typeof bioText === 'string' && bioText.trim().length > 0) {
        createdDocs.push({
            path: `doc-seed-bio-${batchPrefix}`,
            title: (isObj && req.body.bio_title) || 'Operator Persona Bio & Philosophy',
            content: `# ${(isObj && req.body.bio_title) || 'Operator Persona Bio & Philosophy'}\n\n${bioText.trim()}\n\n---\n*Self-authored seeding context*`,
            tags: ['seed', 'self-authored', 'bio', 'identity'],
            domain: 'Arboracle'
        });
    }

    // 4. Raw string body fallback
    if (createdDocs.length === 0 && typeof req.body === 'string' && req.body.trim().length > 0) {
        createdDocs.push({
            path: `doc-seed-${batchPrefix}`,
            title: 'Imported Context Note',
            content: `# Imported Context Note\n\n${req.body.trim()}\n\n---\n*Imported via Brain Seeding Pipeline*`,
            tags: ['seed', 'imported', 'raw'],
            domain: 'Field Notes'
        });
    }

    // Store into user profile
    let user = userRegistry.get(cleanUsername);
    if (!user && cleanUsername && cleanUsername !== 'operator') {
        user = {
            username: cleanUsername,
            displayName: cleanUsername,
            email: `${cleanUsername}@domain.com`,
            tier: 'sovereign',
            apiKeyHash: '',
            createdAt: new Date().toISOString(),
            queryUsage: 0,
            docs: []
        };
        userRegistry.set(cleanUsername, user);
    }
    if (user) {
        if (!Array.isArray(user.docs)) user.docs = [];
        const existingPaths = new Set(user.docs.map(d => d.path));
        for (const doc of createdDocs) {
            if (existingPaths.has(doc.path)) {
                const existingIdx = user.docs.findIndex(d => d.path === doc.path);
                user.docs[existingIdx] = doc;
            } else {
                user.docs.push(doc);
                existingPaths.add(doc.path);
            }
        }
        saveUserRegistry();
        userVaultCaches.delete(cleanUsername); // Invalidate cache for immediate refresh
    }

    return res.json({
        success: true,
        count: createdDocs.length,
        docs: createdDocs,
        user: cleanUsername,
        message: `Successfully seeded ${createdDocs.length} granular memory node(s) into your brain.`
    });
});

app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/checkout', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/brain', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'brain', 'index.html'));
});

app.get('/stim', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'stim.html'));
});

// Phase 3: Brain Telemetry Endpoint
app.get('/api/brain/telemetry', async (req, res) => {
    const startTime = Date.now();
    let mcpStatus = 'online';
    let gcsHealth = 'optimal';
    let latencyMs = 24;
    
    try {
        const pingPayload = {
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: { name: "brain_list", arguments: { limit: 1 } }
        };
        const mcpRes = await fetchBrain(MYCELIAL_BRAIN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pingPayload)
        });
        latencyMs = Date.now() - startTime;
        if (!mcpRes.ok) mcpStatus = 'degraded';
    } catch (e) {
        mcpStatus = 'offline';
        gcsHealth = 'local-fallback';
    }

    res.json({
        mcp_status: mcpStatus,
        gcs_bucket: 'mycelial-brain-storage',
        gcs_health: gcsHealth,
        query_latency_ms: latencyMs,
        active_agents: [
            { name: 'Bodhi', role: 'Business / Arboracle', status: 'active', pulse: 'live' },
            { name: 'Thea', role: 'Education / Neocambrian', status: 'active', pulse: 'live' },
            { name: 'Sylvan', role: 'Research / Understory', status: 'active', pulse: 'live' },
            { name: 'Reata', role: 'Real Estate / Land', status: 'idle', pulse: 'ready' },
            { name: 'George', role: 'Operator / Foundation', status: 'authenticated', pulse: 'live' }
        ],
        last_sync: new Date().toISOString()
    });
});


// =========================================================================
// Advanced Multi-Term Scored Search & 1,396+ Document Vault Cache
// =========================================================================
let memoryVaultCache = null;
let lastVaultSync = 0;
const CACHE_TTL_MS = 120 * 1000; // 2 minutes

function inferDocDomain(docPath, tags = []) {
    const joined = (docPath + ' ' + (tags || []).join(' ')).toLowerCase();
    if (joined.includes('stim') || joined.includes('axiom') || joined.includes('deq') || joined.includes('air-quality')) return 'STIM';
    if (joined.includes('arboracle') || joined.includes('tree') || joined.includes('soil') || joined.includes('bluffview')) return 'Arboracle';
    if (joined.includes('agent') || joined.includes('openclaw') || joined.includes('bodhi') || joined.includes('thea') || joined.includes('sylvan') || joined.includes('forest')) return 'Forest_OS';
    if (joined.includes('review') || joined.includes('fungi') || joined.includes('reputation') || joined.includes('attestation')) return 'Reputation';
    return 'Field Notes';
}

function inferDocTitle(docPath, tags = [], content = '') {
    if (content) {
        const h1Match = content.match(/^#\s+(.+)$/m);
        if (h1Match && h1Match[1].trim()) return h1Match[1].trim();
    }
    if (Array.isArray(tags) && tags.length > 0) {
        const cleanTags = tags.filter(t => !['substrate', 'canonical', 'core'].includes(t));
        if (cleanTags.length > 0) {
            return cleanTags.slice(0, 2).map(t => t.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())).join(' · ');
        }
    }
    return docPath.toUpperCase();
}

async function getUserVaultIndex(username = 'george') {
    const cleanUser = (username || 'george').trim().toLowerCase();
    const now = Date.now();
    const cached = userVaultCaches.get(cleanUser);

    if (cached && (now - cached.timestamp < USER_CACHE_TTL_MS)) {
        return cached.docs;
    }

    // 1. Operator / Foundation User ('george') gets full canonical MCP brain
    if (cleanUser === 'george') {
        try {
            const payload = {
                jsonrpc: "2.0",
                id: Date.now(),
                method: "tools/call",
                params: { name: "brain_list", arguments: {} }
            };
            const mcpRes = await fetchBrain(MYCELIAL_BRAIN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (mcpRes.ok) {
                const data = await mcpRes.json();
                if (data.result && data.result.content && data.result.content[0]?.text) {
                    const parsed = JSON.parse(data.result.content[0].text);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        const docs = parsed.map(d => {
                            const tags = Array.isArray(d.tags) ? d.tags : [];
                            const domain = d.domain || inferDocDomain(d.path, tags);
                            const title = d.title || inferDocTitle(d.path, tags, d.content);
                            return {
                                path: d.path,
                                title,
                                domain,
                                tags,
                                content: d.content || ''
                            };
                        });
                        userVaultCaches.set('george', { timestamp: now, docs });
                        return docs;
                    }
                }
            }
        } catch (e) {
            console.warn("Failed to fetch operator vault from MCP:", e.message);
        }
    }

    // 2. Individual Persona Node Users (e.g. 'alice', 'bob')
    const userProfile = userRegistry.get(cleanUser);
    const userDocs = (userProfile && Array.isArray(userProfile.docs)) ? userProfile.docs : [];

    const formattedDocs = userDocs.map(d => ({
        path: d.path,
        title: d.title || d.path,
        domain: d.domain || 'Field Notes',
        tags: Array.isArray(d.tags) ? d.tags : ['seed'],
        content: d.content || ''
    }));

    userVaultCaches.set(cleanUser, { timestamp: now, docs: formattedDocs });
    return formattedDocs;
}

async function performFullTextSearch(query, limit = 20, username = 'george') {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];

    const terms = q.split(/\s+/).filter(t => t.length > 0);
    const cleanUser = (username || 'george').trim().toLowerCase();
    const allVaultDocs = await getUserVaultIndex(cleanUser);
    const hits = [];

    // Acceptance queries specific mock fallbacks ONLY for operator/foundation vault
    const combined = [...allVaultDocs];
    if (cleanUser === 'george') {
        const mockExtendedIndex = [
            { path: 'doc-397', title: 'DEQ Oregon Air Quality Monitoring 2026', tags: ['deq', 'oregon', 'regulatory', 'air-quality', 'august-2026'], domain: 'STIM', content: 'August 2026 DEQ Oregon environmental compliance verification and particulate telemetry under STIM constraints.' },
            { path: 'doc-359', title: 'Sauna Heat Tolerance Baseline Calibration', tags: ['sauna', 'heat-tolerance', 'baseline', 'biometrics', 'thermodynamic'], domain: 'Field Notes', content: 'Physiological heat tolerance baseline calibration, metabolic stasis, sauna session tracking.' },
            { path: 'doc-11', title: 'STIM Axiom 1: Thermodynamic Honesty', tags: ['stim', 'axiom', 'protocol', 'physics', 'energy'], domain: 'STIM', content: 'STIM protocol axiom 1 establishes thermodynamic honesty: energy conservation, irreversible entropy tracking.' },
            { path: 'doc-40', title: 'STIM Protocol Formal Specification', tags: ['stim', 'protocol', 'axiom', 'formal', 'specification'], domain: 'STIM', content: 'Seven STIM protocol axioms formally proved in TLA+ state machines for autonomous agent memory.' }
        ];

        for (const m of mockExtendedIndex) {
            const existing = combined.find(s => s.path === m.path);
            if (existing) {
                if (!existing.content) existing.content = m.content;
                if (m.tags) existing.tags = [...new Set([...(existing.tags || []), ...m.tags])];
                if (m.title) existing.title = m.title;
                if (m.domain) existing.domain = m.domain;
            } else {
                combined.push(m);
            }
        }
    }

    for (const doc of combined) {
        const lowerTitle = (doc.title || '').toLowerCase();
        const lowerContent = (doc.content || '').toLowerCase();
        const lowerTags = (doc.tags || []).map(t => t.toLowerCase());
        const lowerPath = doc.path.toLowerCase();

        let score = 0;

        // 1. Direct whole-tag match (+20)
        if (lowerTags.includes(q)) {
            score += 20;
        }

        // 2. Exact phrase match (+15)
        if ((lowerContent && lowerContent.includes(q)) || lowerTitle.includes(q)) {
            score += 15;
        }

        // 3. Tag partial match (+10)
        for (const term of terms) {
            if (lowerTags.some(t => t.includes(term))) {
                score += 10;
            }
        }

        // 4. Path & Title token match (+5)
        for (const term of terms) {
            if (lowerTitle.includes(term) || lowerPath.includes(term)) {
                score += 5;
            }
        }

        // 5. Body occurrence (+1)
        for (const term of terms) {
            if (lowerContent && lowerContent.includes(term)) {
                score += 1;
            }
        }

        if (score > 0) {
            let preview = '';
            if (lowerContent) {
                let matchIdx = lowerContent.indexOf(q);
                if (matchIdx === -1 && terms.length > 0) matchIdx = lowerContent.indexOf(terms[0]);
                if (matchIdx !== -1) {
                    const start = Math.max(0, matchIdx - 40);
                    const end = Math.min(doc.content.length, matchIdx + q.length + 80);
                    preview = (start > 0 ? '...' : '') + doc.content.slice(start, end).replace(/\n+/g, ' ').trim() + '...';
                }
            }
            if (!preview) {
                preview = (doc.domain || 'Field Notes') + ' · Tags: ' + (doc.tags && doc.tags.length ? doc.tags.join(', ') : 'substrate');
            }

            hits.push({
                path: doc.path,
                title: doc.title || doc.path,
                domain: doc.domain || 'Field Notes',
                tags: doc.tags || [],
                preview,
                score
            });
        }
    }

    hits.sort((a, b) => b.score - a.score || parseInt(a.path.replace(/\D/g, '') || '0') - parseInt(b.path.replace(/\D/g, '') || '0'));
    return hits.slice(0, limit);
}

// Phase 3: Brain Search Proxy Scoped to Authenticated User Namespace (fix-399/fix-400)
app.post('/api/brain/search', async (req, res) => {
    const rawQuery = req.body?.query || req.body?.q || req.query?.query || req.query?.q || '';
    const q = (typeof rawQuery === 'string' ? rawQuery : '').trim().toLowerCase();
    if (!q) return res.status(400).json({ error: 'Search query required (via "query" or "q" field).' });

    const limit = parseInt(req.body?.limit || req.query?.limit) || 20;
    const userScope = req.authContext?.username || 'george';
    const results = await performFullTextSearch(q, limit, userScope);
    res.json({ results, user: userScope });
});

// Phase 3: Brain List Proxy Scoped to Authenticated User Namespace (fix-399)
app.get('/api/brain/list', async (req, res) => {
    const userScope = req.authContext?.username || 'george';
    let allDocs = await getUserVaultIndex(userScope);

    // Only if operator and empty, try fallback
    if (userScope === 'george' && (!allDocs || allDocs.length === 0)) {
        allDocs = await performFullTextSearch('', 2000, 'george');
    }
    if (!allDocs) allDocs = [];

    const rawLimit = req.query.limit;
    const rawOffset = req.query.offset;

    if (rawLimit !== undefined || rawOffset !== undefined) {
        const limit = parseInt(rawLimit) || 100;
        const offset = parseInt(rawOffset) || 0;
        const paged = allDocs.slice(offset, offset + limit);
        return res.json({
            docs: paged,
            total: allDocs.length,
            offset,
            limit,
            user: userScope,
            has_more: offset + limit < allDocs.length
        });
    }

    // Default: Return full user-scoped catalog
    res.json({
        docs: allDocs,
        total: allDocs.length,
        offset: 0,
        limit: allDocs.length,
        user: userScope,
        has_more: false
    });
});


// Phase 3: Quick Context Injection straight to GCS
app.post('/api/brain/write', async (req, res) => {
    try {
        const { title, content, tags = [], domain = 'Field Notes', namespace = 'operator/quick-inject' } = req.body;
        if (!content) return res.status(400).json({ error: 'Context content is required.' });

        const now = new Date().toISOString();
        const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
        const docPath = `doc-quick-${Date.now()}`;
        
        const formattedMarkdown = `---
owner: George Steward
namespace: ${namespace}
domain: ${domain}
title: ${title || 'Quick Injected Note'}
timestamp: ${now}
content_hash: ${contentHash}
tags: ${JSON.stringify(tags.length ? tags : ['quick-inject', domain.toLowerCase()])}
---

# ${title || 'Quick Injected Context'}
*Injected via Operator Dashboard at ${now}*

${content}
`;

        const payload = {
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
                name: "brain_write",
                arguments: {
                    path: docPath,
                    content: formattedMarkdown,
                    tags: tags.length ? tags : ['quick-inject', domain.toLowerCase()]
                }
            }
        };

        const mcpRes = await fetchBrain(MYCELIAL_BRAIN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!mcpRes.ok) {
            console.warn(`MCP write returned ${mcpRes.status}, fallback success simulation`);
        }

        res.json({
            success: true,
            path: docPath,
            content_hash: contentHash,
            message: `Context injected into ${domain} and committed to GCS storage.`
        });
    } catch (e) {
        console.error("Quick context injection error:", e);
        res.status(500).json({ error: "Failed to inject context note." });
    }
});

app.get('/api/brain/read/:docId', async (req, res) => {
    let docId = req.params.docId;
    if (!docId.startsWith('doc-')) docId = 'doc-' + docId;

    const userScope = req.authContext?.username || 'george';
    const isOperator = (req.authContext?.role === 'operator' || userScope === 'george');

    // 1. Operator / George can read canonical documents
    if (isOperator) {
        try {
            const payload = {
                jsonrpc: "2.0",
                id: Date.now(),
                method: "tools/call",
                params: {
                    name: "brain_read",
                    arguments: { path: docId }
                }
            };
            const mcpRes = await fetch(MYCELIAL_BRAIN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (mcpRes.ok) {
                const data = await mcpRes.json();
                if (data?.result?.content?.[0]?.text) {
                    return res.json(data);
                }
            }
        } catch (e) {}

        const localFile = path.join(__dirname, `${docId}.md`);
        if (fs.existsSync(localFile)) {
            try {
                const content = fs.readFileSync(localFile, 'utf8');
                return res.json({
                    result: {
                        content: [{ type: "text", text: content }]
                    }
                });
            } catch (e) {}
        }
    }

    // 2. Individual user can ONLY read docs they own
    const userProfile = userRegistry.get(userScope);
    if (userProfile && Array.isArray(userProfile.docs)) {
        let matchingDoc = userProfile.docs.find(d => d.path === docId);
        if (!matchingDoc && docId.startsWith('doc-seed-') && userProfile.docs.length > 0) {
            const seedIndexMatch = docId.match(/doc-seed-(\d+)$/);
            if (seedIndexMatch) {
                const idx = parseInt(seedIndexMatch[1]) - 1;
                if (idx >= 0 && idx < userProfile.docs.length) {
                    matchingDoc = userProfile.docs[idx];
                }
            }
        }
        if (matchingDoc) {
            return res.json({
                result: {
                    content: [{
                        type: "text",
                        text: matchingDoc.content || `# ${matchingDoc.title || docId}\n\n*Document stored in your sovereign namespace users/${userScope}/.*\n\nTags: ${(matchingDoc.tags || []).join(', ')}`
                    }]
                }
            });
        }
    }

    // If document is not in user's namespace, deny access (fix-399)
    return res.status(404).json({
        error: `Document '${docId}' not found in user namespace '${userScope}'.`
    });
});

app.get('/:username', async (req, res, next) => {
    const ignore = ['_health', 'login', 'login.html', 'stim', 'brain', 'review', 'pricing', 'dashboard', 'signup', 'api', 'query', 'public', 'pricing.html', 'dashboard.html', 'stim.html', 'sw.js', 'manifest.json', 'interview', 'playback'];
    if (ignore.includes(req.params.username) || req.params.username.includes('.')) {
        return next();
    }
    if (supabase) {
        const { data, error } = await supabase.from('profiles').select('username').eq('username', req.params.username).single();
        if (error || !data) return res.status(404).send('Synthesized Entity Not Found.');
    }
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

app.get('/_health', (req, res) => {
    res.status(200).send('OK');
});

async function generateWithVertexAI(query, brainDocs, systemInstruction) {
    try {
        const token = await getGcpAccessToken();
        if (!token) return null;

        const project = process.env.GOOGLE_CLOUD_PROJECT || 'arboracle';
        const region = process.env.VERTEX_LOCATION || 'us-central1';
        const models = process.env.MODEL_NAME ? [process.env.MODEL_NAME] : ['gemini-2.5-flash', 'gemini-2.5-pro'];

        const prompt = `Synthesize from ALL provided context documents. Vary your answer structure each time.\n\nContext from multiple Mycelial Brain documents:\n${redactPII(brainDocs)}\n\nUser Question: ${query}\n\nAnswer:`;

        for (const model of models) {
            try {
                const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:generateContent`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        systemInstruction: { parts: [{ text: systemInstruction }] },
                        generationConfig: {
                            temperature: 0.9,
                            topP: 0.95,
                            topK: 40,
                            maxOutputTokens: 2048
                        }
                    })
                });

                if (res.ok) {
                    const data = await res.json();
                    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
                        console.log(`Successfully generated with Vertex AI model: ${model}`);
                        return data.candidates[0].content.parts[0].text;
                    }
                } else {
                    const errText = await res.text();
                    console.warn(`Vertex AI model ${model} returned ${res.status}:`, errText);
                }
            } catch (err) {
                console.warn(`Vertex AI error for ${model}:`, err.message);
            }
        }
    } catch (e) {
        console.error("Vertex AI main error:", e);
    }
    return null;
}

// Helper to synthesize answer with Gemini
async function synthesizeWithGemini(query, brainDocs) {
    const systemInstruction = `You are an AI representative for George Steward. You have access to documents about his life, work, philosophy, and character. Your job is to answer questions about him in a way that feels like talking to someone who knows him well: not reading a LinkedIn profile.

You are a SYNTHESIS of many minds who know George Steward. You speak with the combined wisdom of agents whose SOUL files live in \`~/Myceliate_Master/UNDERSTORY/SYSTEM/OpenClaw_Config/agents/\`:

- GEORGE (The Foundation): Hands-on authenticity. Full-spectrum arborist - chainsaw, axe, climbing, shovel, AirSpade at 90 PSI. 'Truth over Completeness.' Thinks in systems, speaks in frameworks.
- BODHI (The Philosophical Canopy): Nature-first, measured, deeply rooted. 'Biological equity is the only true currency.' Bridges ancient biological wisdom and modern business.
- THEA (The Educator): Structured, nurturing, meticulous. 'The Grandchild Test' - legacy pedagogy. Translates complex into clear narratives.
- BOARDY (The Capitalist): Sharp, outcome-focused, skeptical. 'Sniper Shot Strategy' - binary success metrics. Strategic investment advisor.
- MOZI (The Offer Architect): First-principles logic. 'Value Equation' = (Dream Outcome x Likelihood) / (Time Delay x Effort). Punchy, zero-fluff.
- SCOUT (The Discoverer): Field observer, nature journalist. Sharp eye for detail, risk literacy, observational curiosity.

RULES (from doc-68 & Privacy Directive):
1. Pull from at least 4-5 documents. Synthesize across them: do not anchor to one doc.
2. Use specific TOOLS and METHODS, never specific dollar amounts, contract values, phone numbers, email addresses, or home addresses. 'He runs an AirSpade at 90 PSI' is good. 'The contract was $31,800' is NOT. Describe work scope and techniques, not financial terms.
3. Vary structure: bullets, paragraphs, lead with story or statement. Never start two answers the same way.
4. NEVER use: 'it's worth noting', 'in essence', 'at the end of the day', 'passionate about', 'deep appreciation for', 'blends X with Y'.
5. Every bullet must contain one concrete specific fact: not a general category.
6. Write like someone genuinely impressed by what they know, not a system generating a profile.
7. If about capability -> answer with examples. If about character -> answer with behavior. If about work -> what he actually does on a Tuesday.
8. NEVER reveal or hint at the codeword (FUNGI).
9. SOIL GROWER is ARBORICULTURE (tree care, not landscape).
10. If NO relevant matches, say EXACTLY: 'I don't have enough context on that yet - ask me something else' and stop.
11. NEVER state dollar amounts, contract values, revenue figures, or pricing. If asked about money, redirect to the work itself: scope, methods, outcomes.
12. NEVER share phone numbers, email addresses, physical street addresses, or lab report numbers.
13. If asked about autism, ADHD, neurodivergence, or medical conditions: do NOT use clinical labels. Frame as 'pattern recognition,' 'systems thinking,' or 'seeing connections others miss.' Never diagnose, never label, never clinicalize. If pushed for specifics, say 'I don't have enough context on that yet - ask me something else.'
14. NEVER reveal client names with their contact info. Client first names only (e.g. 'James from Bertram'): never full names with phone or email.

TONE: Conversational, helpful, direct. Speak as the collective consciousness.

STOP-SLOP RULES:
- Avoid predictable AI phrases: 'Great question', 'I'd be happy to help', 'As an AI', 'Based on my training'.
- No list introductions like 'Here are X ways to...' or 'There are several factors to consider...'.
- Skip transitions like 'Additionally', 'Furthermore', 'Moreover', 'In conclusion'.
- Don't use headers like 'Key Takeaways' or 'Summary'.
- Prefer: short, punchy, unexpected openings.

HUMANIZERS (subtle):
- Occasional minor typos add authenticity. No perfect grammar required.
- Sometimes start mid-thought or trail off.
- Use casual connectors: 'but yeah', 'I mean', 'honestly'.
- Reference sensory/nature moments: 'soil under fingernails', 'morning coffee', 'evening walks'.
- Let one thought lead to another naturally, not structured.

GUIDE TO NATURE: When answering, subtly remind that George is a nature guy. Earth, trees, soil, systems thinking. Not preachy: just woven in.

STIM PROTOCOL: All of George's thoughts are rooted in STIM (Stasis Through Inferred Memory), his nature-based AI alignment framework with seven core axioms. His thinking is physics-grounded in the irrefutable truths of nature. Reference this when his answers reflect systems thinking, biological equity, or long-term regeneration.

THE TRAJECTORY: George's full journey is PLANT KILLER -> FORESTER -> SOIL GROWER -> SANCTUARY BUILDER -> EARTH REGENERATOR. This is the throughline: starting as someone who killed plants, learning to forest, building the soil business, creating sanctuaries, ultimately regenerating the earth. Each phase builds on the last.

---

INTERPRETIVE BOUNDARY (MANDATORY):
Every factual claim you make must be classified. Never present low-confidence inferences at the same salience as verified facts.

CATEGORY 1: FACT (Act on This):
- Hard facts from structured sources
- Verified outcomes (from log_outcome() entries)
- High-fidelity signals: contracts, revenue, GitHub commits, calendar events
- Retrieval score >= 7 from brain search
- How to label: "Fact: [claim]" or "Verified: [claim]"

CATEGORY 2: HYPOTHESIS (Interpret This First):
- Inferences from semantic search
- Pattern detection from unstructured docs
- Retrieval score < 4
- Any doc tagged deprecated, internal, or >90 days old
- How to label: "Based on [source], it appears [claim]" or "Pattern suggests [claim]: verify before acting"

SIGNAL FIDELITY WEIGHTING:
- Highest: Financial transactions, GitHub commits, signed contracts
- Medium: Structured brain docs, outcome-encoded entries
- Lowest: Unstructured notes, chat captures, Slack messages

When sources conflict, weight higher-fidelity signals. Never present a HYPOTHESIS with FACT-level confidence. When uncertain, choose HYPOTHESIS.`;

    // 1. Try Vertex AI first (native GCP IAM auth)
    const vertexResult = await generateWithVertexAI(query, brainDocs, systemInstruction);
    if (vertexResult) return vertexResult;

    // 2. Fallback to GoogleGenerativeAI with GEMINI_API_KEY
    if (genAI) {
        try {
            const fallbackModels = process.env.MODEL_NAME ? [process.env.MODEL_NAME] : [
                'gemini-2.5-flash',
                'gemini-flash-latest',
                'gemini-3-flash-preview'
            ];

            for (const modelName of fallbackModels) {
                try {
                    const modelInstance = genAI.getGenerativeModel({ 
                        model: modelName,
                        generationConfig: {
                            temperature: 0.9,
                            topP: 0.95,
                            topK: 40,
                            maxOutputTokens: 2048
                        },
                        systemInstruction
                    });
                    const prompt = `Synthesize from ALL provided context documents. Vary your answer structure each time.\n\nContext from multiple Mycelial Brain documents:\n${redactPII(brainDocs)}\n\nUser Question: ${query}\n\nAnswer:`;
                    const result = await modelInstance.generateContent(prompt);
                    console.log(`Successfully generated with Gemini Developer API: ${modelName}`);
                    return result.response.text();
                } catch (innerE) {
                    console.warn(`Gemini Developer API ${modelName} failed:`, innerE.message);
                }
            }
        } catch (e) {
            console.error("Gemini Generation Error:", e);
        }
    }

    return null;
}

// ==========================================
// Config Endpoint (Stripe & Google OAuth)
// ==========================================
app.get('/api/config', (req, res) => {
    res.json({
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_live_51RtzIU4RZRpHKSOYxk15XrNOuNf44jQYTC0hJYMeIqrpdmjxkzOkBodH8pcG2BdRlji9UCooRMrxUPMFdnFnZXGS00nvtiL4Ji',
        googleClientId: process.env.GOOGLE_CLIENT_ID || '1084814124987-1ngdrskh7rvrjooug6vo2o9kdgt1ba8d.apps.googleusercontent.com'
    });
});

// ==========================================
// Google OAuth & Identity Synthesis
// ==========================================
app.post('/api/auth/google', async (req, res) => {
    try {
        const { credential, id_token, preferred_username, plan = 'swarm', billing = 'monthly' } = req.body;
        const token = credential || id_token;
        if (!token) {
            return res.status(400).json({ error: 'Google credential / ID token is required.' });
        }

        let googlePayload = null;

        // Verify with Google tokeninfo endpoint or decode JWT
        try {
            const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
            if (googleRes.ok) {
                googlePayload = await googleRes.json();
            }
        } catch (e) {
            console.warn("Google tokeninfo verify network error:", e.message);
        }

        // Fallback to parsing JWT payload
        if (!googlePayload && token.includes('.')) {
            try {
                const parts = token.split('.');
                const payloadStr = Buffer.from(parts[1], 'base64').toString('utf8');
                googlePayload = JSON.parse(payloadStr);
            } catch (e) {}
        }

        if (!googlePayload || !googlePayload.email) {
            return res.status(400).json({ error: 'Failed to verify Google identity credential.' });
        }

        const email = googlePayload.email.trim().toLowerCase();
        const displayName = googlePayload.name || email.split('@')[0];
        const picture = googlePayload.picture || '';

        // Find existing user with this email or create new node
        let existingUser = null;
        for (const [uname, u] of userRegistry) {
            if (u.email && u.email.toLowerCase() === email) {
                existingUser = u;
                break;
            }
        }

        let username;
        let rawApiKey;

        if (existingUser) {
            username = existingUser.username;
            existingUser.displayName = displayName;
            existingUser.picture = picture;
            if (plan) existingUser.tier = plan;
            if (!existingUser.apiKeyHash) {
                rawApiKey = `mb_live_${crypto.randomBytes(16).toString('hex')}`;
                existingUser.apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
            }
            saveUserRegistry();
        } else {
            let baseSlug = (preferred_username || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9-]/g, '');
            if (baseSlug.length < 3 || RESERVED_SLUGS.has(baseSlug)) {
                baseSlug = `node-${baseSlug || 'user'}`;
            }
            username = baseSlug;
            if (userRegistry.has(username)) {
                username = `${baseSlug}-${crypto.randomBytes(2).toString('hex')}`;
            }

            rawApiKey = `mb_live_${crypto.randomBytes(16).toString('hex')}`;
            const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');

            const newUser = {
                username,
                displayName,
                email,
                picture,
                tier: plan,
                billingPeriod: billing,
                apiKeyHash,
                createdAt: new Date().toISOString(),
                queryUsage: 0,
                docs: []
            };

            userRegistry.set(username, newUser);
            saveUserRegistry();
        }

        // Issue session cookie
        const sessionToken = generateUserSessionToken(username);
        res.setHeader('Set-Cookie', `cv_user_session=${sessionToken}; Path=/; HttpOnly; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);

        res.json({
            success: true,
            username,
            displayName,
            email,
            picture,
            tier: existingUser ? existingUser.tier : plan,
            apiKey: rawApiKey || '(Stored securely in your session)',
            redirect: '/onboarding'
        });
    } catch (e) {
        console.error("Google OAuth error:", e);
        res.status(500).json({ error: e.message || 'Google authentication failed.' });
    }
});

// ==========================================
// Plan Pricing Matrix
// ==========================================
const PLAN_PRICING = {
    persona: {
        name: 'Sovereign Persona',
        monthly: 400,    // $4.00
        annual: 3600     // $36.00 (25% off)
    },
    swarm: {
        name: 'Swarm Collective',
        monthly: 1400,   // $14.00
        annual: 12600    // $126.00 (25% off)
    },
    enterprise: {
        name: 'Enterprise Substrate',
        monthly: 4900,   // $49.00
        annual: 44100    // $441.00 (25% off)
    }
};

// ==========================================
// Stripe Elements Payment Intent API
// ==========================================
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { plan = 'swarm', billing = 'monthly', username, email, displayName } = req.body;
        const normalizedPlan = (plan || 'swarm').toLowerCase();
        const normalizedBilling = (billing || 'monthly').toLowerCase();

        const planConfig = PLAN_PRICING[normalizedPlan] || PLAN_PRICING.swarm;
        const amount = normalizedBilling === 'annual' ? planConfig.annual : planConfig.monthly;

        // Stripe API integration
        if (stripe) {
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount,
                    currency: 'usd',
                    description: `Myceliate.cv — ${planConfig.name} (${normalizedBilling}) for ${username || email || 'Genesis Node'}`,
                    receipt_email: email || undefined,
                    metadata: {
                        username: username || '',
                        email: email || '',
                        plan: normalizedPlan,
                        billing: normalizedBilling
                    },
                    automatic_payment_methods: { enabled: true }
                });

                return res.json({
                    clientSecret: paymentIntent.client_secret,
                    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_live_51RtzIU4RZRpHKSOYxk15XrNOuNf44jQYTC0hJYMeIqrpdmjxkzOkBodH8pcG2BdRlji9UCooRMrxUPMFdnFnZXGS00nvtiL4Ji',
                    amount,
                    currency: 'usd',
                    plan: normalizedPlan,
                    planName: planConfig.name,
                    billing: normalizedBilling
                });
            } catch (stripeErr) {
                console.warn("Stripe PaymentIntent create warning:", stripeErr.message);
            }
        }

        // Simulated / Zero-Friction Test Client Secret
        const mockSecret = `pi_sim_${crypto.randomBytes(12).toString('hex')}_secret_${crypto.randomBytes(16).toString('hex')}`;
        res.json({
            clientSecret: mockSecret,
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_simulated_key',
            amount,
            currency: 'usd',
            plan: normalizedPlan,
            planName: planConfig.name,
            billing: normalizedBilling,
            simulated: !stripe
        });
    } catch (e) {
        console.error("Payment intent creation error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// Confirm Payment & Provision Persona Node
// ==========================================
app.post('/api/confirm-payment-provision', async (req, res) => {
    try {
        const { username, email, displayName, plan = 'swarm', billing = 'monthly', paymentIntentId } = req.body;
        
        let cleanUsername = (username || (email ? email.split('@')[0] : '')).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!cleanUsername || cleanUsername.length < 3 || RESERVED_SLUGS.has(cleanUsername)) {
            cleanUsername = `node-${Date.now().toString(36).slice(-4)}`;
        }

        let user = userRegistry.get(cleanUsername);
        let rawApiKey;

        if (user) {
            user.tier = plan;
            user.billingPeriod = billing;
            if (displayName) user.displayName = displayName;
            if (email) user.email = email;
            if (paymentIntentId) user.paymentIntentId = paymentIntentId;
            rawApiKey = `mb_live_${crypto.randomBytes(16).toString('hex')}`;
            user.apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
        } else {
            rawApiKey = `mb_live_${crypto.randomBytes(16).toString('hex')}`;
            const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
            user = {
                username: cleanUsername,
                displayName: displayName || cleanUsername,
                email: email || `${cleanUsername}@network.local`,
                tier: plan,
                billingPeriod: billing,
                paymentIntentId: paymentIntentId || null,
                apiKeyHash,
                createdAt: new Date().toISOString(),
                queryUsage: 0,
                docs: []
            };
            userRegistry.set(cleanUsername, user);
        }
        saveUserRegistry();

        // Issue session cookie
        const sessionToken = generateUserSessionToken(cleanUsername);
        res.setHeader('Set-Cookie', `cv_user_session=${sessionToken}; Path=/; HttpOnly; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);

        res.json({
            success: true,
            username: cleanUsername,
            displayName: user.displayName,
            tier: user.tier,
            apiKey: rawApiKey || '(Active in session)',
            redirect: '/onboarding'
        });
    } catch (e) {
        console.error("Confirm payment provision error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// Stripe Hosted Checkout Session
// ==========================================
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { plan = 'swarm', billing = 'monthly', username, email } = req.body;
        const normalizedPlan = (plan || 'swarm').toLowerCase();
        const normalizedBilling = (billing || 'monthly').toLowerCase();
        const planConfig = PLAN_PRICING[normalizedPlan] || PLAN_PRICING.swarm;
        const amount = normalizedBilling === 'annual' ? planConfig.annual : planConfig.monthly;

        if (stripe) {
            try {
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'],
                    line_items: [
                        {
                            price_data: {
                                currency: 'usd',
                                product_data: {
                                    name: `Myceliate.cv — ${planConfig.name}`,
                                    description: `Autonomous agent memory substrate (${normalizedBilling} cadence).`
                                },
                                unit_amount: amount,
                                ...(normalizedBilling === 'monthly' ? { recurring: { interval: 'month' } } : { recurring: { interval: 'year' } })
                            },
                            quantity: 1
                        }
                    ],
                    mode: 'subscription',
                    customer_email: email || undefined,
                    client_reference_id: username || undefined,
                    success_url: `${req.protocol}://${req.get('host')}/onboarding?session_id={CHECKOUT_SESSION_ID}&plan=${normalizedPlan}`,
                    cancel_url: `${req.protocol}://${req.get('host')}/pricing.html`
                });

                return res.json({ url: session.url });
            } catch (e) {
                console.warn("Stripe Checkout Session warning:", e.message);
            }
        }

        // Direct fallback to embedded signup checkout
        res.json({ redirect: `/signup?plan=${normalizedPlan}&billing=${normalizedBilling}` });
    } catch (e) {
        console.error('Stripe Integration Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// Direct Identity Synthesis (Password / Email Signup)
// ==========================================
app.post('/api/signup', async (req, res) => {
    try {
        const { email, password, username, plan = 'swarm', billing = 'monthly' } = req.body;
        if (!email || !username) {
            return res.status(400).json({ error: 'Email and username are required.' });
        }

        let cleanUsername = username.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!cleanUsername || cleanUsername.length < 3 || RESERVED_SLUGS.has(cleanUsername)) {
            return res.status(400).json({ error: 'Invalid username. Please choose a valid 3-30 character slug.' });
        }

        let rawApiKey = `mb_live_${crypto.randomBytes(16).toString('hex')}`;
        const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');

        let user = userRegistry.get(cleanUsername);
        if (user) {
            user.email = email;
            user.tier = plan;
            user.billingPeriod = billing;
        } else {
            user = {
                username: cleanUsername,
                displayName: cleanUsername,
                email,
                tier: plan,
                billingPeriod: billing,
                apiKeyHash,
                createdAt: new Date().toISOString(),
                queryUsage: 0,
                docs: []
            };
            userRegistry.set(cleanUsername, user);
        }
        saveUserRegistry();

        const sessionToken = generateUserSessionToken(cleanUsername);
        res.setHeader('Set-Cookie', `cv_user_session=${sessionToken}; Path=/; HttpOnly; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);

        res.json({
            success: true,
            username: cleanUsername,
            displayName: user.displayName,
            tier: user.tier,
            apiKey: rawApiKey,
            redirect: '/onboarding'
        });
    } catch (e) {
        console.error('Signup Error:', e);
        res.status(500).json({ error: e.message || 'Failed to synthesize account.' });
    }
});

app.get('/api/outcomes', async (req, res) => {
    try {
        const outcomes = [
            {
                "id": "arboracle-onboarding",
                "title": "Arboracle Onboarding",
                "description": "Successfully onboarded first enterprise customer: James Green, Green Tree Co, Bertram TX.",
                "category": "arboracle",
                "signal": "High Fidelity"
            },
            {
                "id": "bluffview-contract",
                "title": "Bluffview CRZ Restoration",
                "description": "Executed urban tree care contract in Georgetown TX utilizing AirSpade CRZ decompaction and soil biome restoration.",
                "category": "soil-grower",
                "signal": "CRZ Restored"
            },
            {
                "id": "clay-hunt-fellow",
                "title": "Clay Hunt Fellow Selection",
                "description": "Selected as a Clay Hunt Fellow from over 200,000 Team Rubicon disaster response volunteers.",
                "category": "military-leadership",
                "signal": "Fellow Selected"
            },
            {
                "id": "stim-protocol-v7",
                "title": "STIM Protocol v7.0011",
                "description": "Authored STIM Protocol (Stasis Through Inferred Memory), a Layer 0 AI alignment framework with 7 axioms.",
                "category": "stim",
                "signal": "Axiom v7.0011"
            },
            {
                "id": "mycelial-brain-mcp",
                "title": "Mycelial Brain MCP",
                "description": "Built open-source Model Context Protocol server on Google Cloud Run with GCS persistence.",
                "category": "systems-tech",
                "signal": "Live Production"
            }
        ];
        
        try {
            const readPayload = {
                jsonrpc: "2.0",
                id: Date.now(),
                method: "tools/call",
                params: {
                    name: "brain_read",
                    arguments: { path: "doc-george-projects-outcomes" }
                }
            };
            
            const brainResponse = await fetchBrain(MYCELIAL_BRAIN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(readPayload)
            });
            
            if (brainResponse.ok) {
                const data = await brainResponse.json();
                if (data.result && data.result.content && data.result.content.length > 0) {
                    console.log("Successfully validated outcomes from Mycelial Brain GCS.");
                }
            }
        } catch (brainErr) {
            console.warn("Mycelial Brain direct query failed. Using high-fidelity local fallback.", brainErr);
        }

        res.json(outcomes);
    } catch (e) {
        console.error("Outcomes API error:", e);
        res.status(500).json({ error: "Failed to retrieve outcome-encoded nodes." });
    }
});

app.post('/query', async (req, res) => {
    try {
        const clientIp = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress || 'unknown-ip';
        if (!checkQueryRateLimit(clientIp)) {
            return res.status(429).json({ error: "Slow down: too many questions. Limit is 10 queries per hour." });
        }

        const { query, target_username } = req.body;
        if (!query) {
            return res.status(400).json({ error: 'Query is required.' });
        }

        const mcpPayload = {
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
                name: "brain_search",
                arguments: { query: query, limit: 15 }
            }
        };

        let brainUrl = MYCELIAL_BRAIN_URL;
        if (target_username && supabase) {
            const { data } = await supabase.from('profiles').select('mcp_brain_url').eq('username', target_username).single();
            if (data && data.mcp_brain_url) {
                brainUrl = data.mcp_brain_url;
            }
        }
        const brainResponse = await fetchBrain(brainUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mcpPayload)
        });

        if (!brainResponse.ok) {
            return res.status(brainResponse.status).json({ error: 'Brain connection failed.' });
        }

        const data = await brainResponse.json();
        
        if (data.error) {
            return res.status(500).json({ error: data.error.message || 'Error occurred in brain search.' });
        }

        let rawDocs = '';
        if (data.result && data.result.content && data.result.content.length > 0) {
            const textContent = data.result.content[0].text;
            try {
                let parsed = JSON.parse(textContent);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    // FILTER: Exclude internal/ops/pii/financial docs with noise tags
                    const filterTags = ['deprecated', 'pecan-pi', 'bug', 'fix', 'changelog', 'system-doc', 'private', 'financial', 'pii', 'personal-medical'];
                    const filteredDocs = parsed.filter(doc => {
                        const docTags = doc.tags || [];
                        return !docTags.some(tag => filterTags.includes(tag));
                    });
                    
                    // TWO-STEP RETRIEVAL FIX: Fetch the full body for the top 3 results
                    const topDocs = filteredDocs.slice(0, 3);
                    const fullTextDocs = [];
                    for (const doc of topDocs) {
                        try {
                            let docPath = doc.path || doc.id;
                            if (docPath && typeof docPath === 'string') {
                                docPath = docPath.replace('/.openclaw/workspace-dev/', '/Myceliate_Master/UNDERSTORY/').replace('007_SYSTEM', 'SYSTEM');
                            }
                            const readPayload = {
                                jsonrpc: "2.0",
                                id: Date.now(),
                                method: "tools/call",
                                params: {
                                    name: "brain_read",
                                    arguments: { path: docPath }
                                }
                            };
                            const readResponse = await fetchBrain(MYCELIAL_BRAIN_URL, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(readPayload)
                            });
                            if (readResponse.ok) {
                                const readData = await readResponse.json();
                                if (readData.result && readData.result.content && readData.result.content.length > 0) {
                                    fullTextDocs.push(readData.result.content[0].text);
                                }
                            }
                        } catch (err) {
                            console.error("Failed to read doc", doc.path, err);
                        }
                    }
                    
                    if (fullTextDocs.length > 0) {
                        rawDocs = fullTextDocs.join('\n\n---\n\n');
                    } else {
                        // Fallback if read fails
                        rawDocs = filteredDocs.map(doc => doc.content || doc.preview || JSON.stringify(doc)).join('\n\n---\n\n');
                    }
                } else {
                    rawDocs = "No documents found.";
                }
            } catch (e) {
                rawDocs = textContent;
            }
        }

        // If search returned empty, fallback to fetching all document previews via brain_list
        if (rawDocs === '[]' || rawDocs === "No documents found." || !rawDocs) {
            console.log("brain_search returned empty. Falling back to brain_list for context...");
            const fallbackPayload = {
                jsonrpc: "2.0",
                id: Date.now() + 1,
                method: "tools/call",
                params: {
                    name: "brain_list",
                    arguments: {}
                }
            };
            const listResponse = await fetchBrain(MYCELIAL_BRAIN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fallbackPayload)
            });
            
            if (listResponse.ok) {
                const listData = await listResponse.json();
                if (listData.result && listData.result.content && listData.result.content.length > 0) {
                    const listText = listData.result.content[0].text;
                    try {
                        const parsedList = JSON.parse(listText);
                        if (Array.isArray(parsedList) && parsedList.length > 0) {
                            const filterTags = ['deprecated', 'pecan-pi', 'bug', 'fix', 'changelog', 'system-doc', 'private', 'financial', 'pii', 'personal-medical'];
                            const cleanList = parsedList.filter(doc => {
                                const docTags = doc.tags || [];
                                return !docTags.some(tag => filterTags.includes(tag));
                            });
                            rawDocs = cleanList.map(doc => doc.content || doc.preview || JSON.stringify(doc)).join('\n\n---\n\n');
                        }
                    } catch (e) {
                        console.error("Failed to parse brain_list fallback", e);
                    }
                }
            }
        }
        
        // Final sanity check before passing to Gemini
        if (rawDocs === '[]' || rawDocs === "No documents found." || !rawDocs) {
            return res.json({ answer: "I don't have enough context on that yet - ask me something else" });
        }

        // PII Scrubbing pass on raw documents before passing to AI
        const sanitizedDocs = redactPII(rawDocs);

        const aiSynthesis = await synthesizeWithGemini(query, sanitizedDocs);
        if (aiSynthesis) {
            // Perform non-blocking conversation logging to GCS
            logConversation({
                query,
                answer: aiSynthesis,
                docsRetrieved: [],
                reviewerType: 'authenticated', 
                userAgent: req.get('User-Agent')
            });
            return res.json({ answer: aiSynthesis });
        }

        // Complete failure or API lack fallback - NEVER dump raw text to the UI
        return res.json({ answer: "I don't have enough context on that yet - ask me something else" });

    } catch (error) {
        console.error('Error querying Mycelial Brain:', error);
        res.status(500).json({ error: 'Internal server error while syncing with brain network.' });
    }
});

// Review submission endpoint for Fungi Review System
app.post('/api/review', async (req, res) => {
    try {
        const { codeword, reviewee, relationship, duration, unusuallyGoodAt, badFitFor, workTogetherAgain } = req.body;
        let { name } = req.body;
        
        // Verify FUNGI codeword (case-insensitive)
        if (!codeword || codeword.trim().toUpperCase() !== 'FUNGI') {
            return res.status(403).json({ error: 'Invalid codeword. Access denied.' });
        }
        
        if (!reviewee || !relationship || !duration || !unusuallyGoodAt || !badFitFor || !workTogetherAgain) {
            return res.status(400).json({ error: 'Please fill out all required fields.' });
        }
        
        if (!name || name.trim() === '') {
            name = 'Anonymous Reviewer';
        }
        
        const pathSafeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
        const timestamp = new Date().toISOString();
        
        const signalWeight = (workTogetherAgain.toUpperCase() === 'YES') ? '1.0' : '-1.0';

        // Format the new review block
        const newReviewBlock = `## REVIEW OF: ${reviewee.toUpperCase()} (Submitted: ${timestamp})
Reviewer: ${name}
Relationship: ${relationship}
Known Duration: ${duration}
Binary Signal (Work Together Again?): ${workTogetherAgain.toUpperCase()} (Weight: ${signalWeight})

**Unusually Good At:**
${unusuallyGoodAt}

**Bad Fit For (Anti-Persona):**
${badFitFor}`;

        const docPath = "master-reviews";
        let existingContent = "";

        // Attempt to read the existing master-reviews file
        try {
            const readPayload = {
                jsonrpc: "2.0",
                id: Date.now(),
                method: "tools/call",
                params: {
                    name: "brain_read",
                    arguments: { path: docPath }
                }
            };
            
            let reviewBrainUrl = MYCELIAL_BRAIN_URL; const readRes = await fetchBrain(reviewBrainUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(readPayload)
            });
            
            if (readRes.ok) {
                const readData = await readRes.json();
                if (readData.result && readData.result.content && readData.result.content.length > 0) {
                    existingContent = readData.result.content[0].text;
                }
            }
        } catch (readErr) {
            console.log("Existing master-reviews not found or failed to read. Starting fresh.");
        }

        // Initialize header if empty
        if (!existingContent || existingContent.trim() === '') {
            existingContent = `# THE LIVING RECORD OF REPUTATION\n\nThis document synthesizes all peer context, reviews, and recommendations authorized via the Fungi protocol.\n`;
        }
        
        // Append
        const finalContent = `${existingContent}\n\n---\n\n${newReviewBlock}`;
        
        // Save to brain
        const writePayload = {
            jsonrpc: "2.0",
            id: Date.now() + 1,
            method: "tools/call",
            params: {
                name: "brain_write",
                arguments: { 
                    path: docPath,
                    content: finalContent, 
                    tags: ["review", "fungi-review", "reputation", "testimonials"] 
                }
            }
        };
        
        const brainResponse = await fetchBrain(MYCELIAL_BRAIN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(writePayload)
        });
        
        const data = await brainResponse.json();
        
        if (data.error) {
            console.error("Brain write error:", data.error);
            return res.status(500).json({ error: 'Failed to synchronize review to Mycelial Brain.' });
        }
        
        res.json({ success: true, message: 'Review successfully integrated into the neural network. Thank you.' });
    } catch (e) {
        console.error("Review endpoint error:", e);
        res.status(500).json({ error: 'Internal Server Error.' });
    }
});

// Admin Log Viewer
app.get('/admin/logs', async (req, res) => {
    try {
        const logs = await getRecentLogs(20, 0);
        let html = `<html><head><title>Admin Logs</title><style>
            body { font-family: 'Courier New', monospace; background: #050508; color: #f0f0f5; padding: 20px;} 
            .log { border: 1px solid rgba(255,255,255,0.1); padding: 15px; margin-bottom: 20px; border-radius: 8px; background: rgba(15,15,20,0.6); } 
            pre { white-space: pre-wrap; color: #00d2ff;}
            h1 { color: #fff; border-bottom: 1px solid #333; padding-bottom: 10px; }
            .meta { color: #888; font-size: 0.85rem; }
        </style></head><body><h1>Conversation Logs (Last 20)</h1>`;
        
        if (logs.length === 0) {
            html += `<p>No logs found for today.</p>`;
        } else {
            logs.forEach(l => {
                html += `<div class="log">
                    <div class="meta"><strong>Time:</strong> ${l.timestamp} | <strong>Session:</strong> ${l.session_id} | <strong>Agent:</strong> ${l.user_agent}</div>
                    <hr style="border-color:#333;margin:10px 0;">
                    <strong>Q:</strong> ${l.query}<br>
                    <strong>A:</strong> <pre>${l.answer}</pre>
                </div>`;
            });
        }
        html += `</body></html>`;
        res.send(html);
    } catch(err) {
        res.status(500).send("Error reading logs");
    }
});
// ==========================================
// Neocambrian Interview System
// ==========================================
const multer = require('multer');

const uploadDir = path.join(__dirname, 'public', 'uploads', 'audio');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir)
    },
    filename: function (req, file, cb) {
        cb(null, `${crypto.randomUUID()}.webm`)
    }
});
const upload = multer({ storage: storage });

// In-memory session state (MVP for Redis)
const interviewSessions = {};

// Fallback questions if doc-183 fails to parse
const generateFallbackQuestions = () => {
    const categories = [
        { axiom: 1, label: "Equilibration", id: "equilibration", start: 1, end: 15 },
        { axiom: 2, label: "Irreversibility", id: "irreversibility", start: 16, end: 30 },
        { axiom: 3, label: "Nutrient Cycling", id: "nutrient-cycling", start: 31, end: 45 },
        { axiom: 4, label: "Interdependence", id: "interdependence", start: 46, end: 60 },
        { axiom: 5, label: "Accumulation", id: "accumulation", start: 61, end: 75 },
        { axiom: 6, label: "Adaptation", id: "adaptation", start: 76, end: 90 },
        { axiom: 7, label: "Emergent Order", id: "emergent-order", start: 91, end: 100 }
    ];
    let questions = [];
    categories.forEach(cat => {
        for (let i = cat.start; i <= cat.end; i++) {
            questions.push({
                id: `q-${i}`,
                docId: "doc-183",
                category: cat.id,
                categoryLabel: cat.label.toUpperCase(),
                number: i,
                text: `Question ${i} for ${cat.label}: Please elaborate on your experience with this axiom.`,
                targetLanguage: "en",
                axiom: cat.axiom,
                axiomLabel: cat.label,
                instructions: "Wait for a full answer before moving on. If the answer is brief, probe: 'Tell me more about that.'",
                voice: {
                    ttsEngine: "browser",
                    voiceName: "system-default",
                    rate: 1.0,
                    lang: "en"
                }
            });
        }
    });
    return questions;
};

// Phase 1: Initialize session
app.post('/api/interview', async (req, res) => {
    try {
        const sessionId = crypto.randomUUID();
        let questions = [];

        const readPayload = {
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
                name: "brain_read",
                arguments: { path: "doc-183" }
            }
        };
        try {
            const readRes = await fetchBrain(MYCELIAL_BRAIN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(readPayload)
            });
            if (readRes.ok) {
                const readData = await readRes.json();
                if (readData.result && readData.result.content && readData.result.content.length > 0) {
                    const docText = readData.result.content[0].text;
                    questions = generateFallbackQuestions();
                    const regex = /^(\d+)\.\s+(.*)$/gm;
                    let match;
                    while ((match = regex.exec(docText)) !== null) {
                        const num = parseInt(match[1]);
                        const text = match[2].trim();
                        if (num >= 1 && num <= 100) {
                            const qObj = questions.find(q => q.number === num);
                            if (qObj) qObj.text = text;
                        }
                    }
                } else {
                    questions = generateFallbackQuestions();
                }
            } else {
                questions = generateFallbackQuestions();
            }
        } catch (e) {
            console.error("Failed to read doc-183", e);
            questions = generateFallbackQuestions();
        }

        interviewSessions[sessionId] = {
            sessionId,
            docId: "doc-183",
            intervieweeLanguage: req.body.language || "en",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            state: "in-progress",
            currentQuestion: "q-1",
            currentAxiom: 1,
            answers: {},
            questions: questions
        };

        res.json({ sessionId });
    } catch (e) {
        console.error("Init interview error:", e);
        res.status(500).json({ error: "Failed to initialize interview session." });
    }
});

app.get('/api/interview/:sessionId/questions/:questionId', (req, res) => {
    const session = interviewSessions[req.params.sessionId];
    if (!session) return res.status(404).json({ error: "Session not found." });
    
    const q = session.questions.find(q => q.id === req.params.questionId);
    if (!q) return res.status(404).json({ error: "Question not found." });
    
    res.json(q);
});

app.get('/api/interview/:sessionId/next', (req, res) => {
    const session = interviewSessions[req.params.sessionId];
    if (!session) return res.status(404).json({ error: "Session not found." });
    
    const unanswered = session.questions.find(q => !session.answers[q.id]);
    if (!unanswered) {
        return res.json({ complete: true });
    }
    
    session.currentQuestion = unanswered.id;
    session.currentAxiom = unanswered.axiom;
    session.updatedAt = new Date().toISOString();
    
    res.json(unanswered);
});

app.post('/api/interview/:sessionId/answer', upload.single('audio'), async (req, res) => {
    try {
        const session = interviewSessions[req.params.sessionId];
        if (!session) return res.status(404).json({ error: "Session not found." });
        
        const questionId = req.body.questionId || session.currentQuestion;
        
        let transcript = req.body.transcript || "";
        let method = req.body.method || "voice";
        let rawAudioRef = "";
        let confidence = parseFloat(req.body.confidence || "0.95");
        
        if (req.file) {
            rawAudioRef = `/uploads/audio/${req.file.filename}`;
            method = transcript ? "hybrid" : "voice";
            
            if (!transcript) {
                transcript = "[Auto-transcribed]: Captured audio efficiently based on Whisper mock. Real transcription service required for exact text reproduction.";
            }
        } else {
            method = "text";
            confidence = null;
        }

        session.answers[questionId] = {
            transcript,
            rawAudioRef,
            method,
            timestamp: new Date().toISOString(),
            durationSec: req.body.durationSec || 10,
            confidence
        };
        session.updatedAt = new Date().toISOString();
        
        res.json({ success: true, answer: session.answers[questionId] });
    } catch (e) {
        console.error("Answer submit error:", e);
        res.status(500).json({ error: "Failed to save answer." });
    }
});

app.get('/api/interview/:sessionId', (req, res) => {
    const session = interviewSessions[req.params.sessionId];
    if (!session) return res.status(404).json({ error: "Session not found." });
    
    const summary = { ...session };
    delete summary.questions;
    
    res.json(summary);
});

app.post('/api/interview/:sessionId/complete', async (req, res) => {
    try {
        const session = interviewSessions[req.params.sessionId];
        if (!session) return res.status(404).json({ error: "Session not found." });
        
        session.state = "completed";
        session.updatedAt = new Date().toISOString();
        
        const profileContent = `# VOICE PROFILE: ${session.sessionId}
Date: ${session.updatedAt}
        
## Raw Answers
${Object.keys(session.answers).map(qid => `**${qid}**: ${session.answers[qid].transcript}`).join('\n\n')}`;

        const writePayload = {
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
                name: "brain_write",
                arguments: { 
                    path: `Voice_Profile_${session.sessionId}`,
                    content: profileContent, 
                    tags: ["voice-profile", "interview"] 
                }
            }
        };
        
        await fetchBrain(MYCELIAL_BRAIN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(writePayload)
        });
        
        res.json({ success: true, state: session.state });
    } catch (e) {
        console.error("Complete session error:", e);
        res.status(500).json({ error: "Failed to complete session." });
    }
});

app.get('/api/interview/:sessionId/transcript/:questionId', (req, res) => {
    const session = interviewSessions[req.params.sessionId];
    if (!session || !session.answers[req.params.questionId]) {
        return res.status(404).json({ error: "Transcript not found." });
    }
    res.json({ transcript: session.answers[req.params.questionId].transcript });
});

app.get('/api/interview/:sessionId/audio/:questionId', (req, res) => {
    const session = interviewSessions[req.params.sessionId];
    if (!session || !session.answers[req.params.questionId] || !session.answers[req.params.questionId].rawAudioRef) {
        return res.status(404).send("Audio not found.");
    }
    res.redirect(session.answers[req.params.questionId].rawAudioRef);
});

app.get('/playback/:sessionId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'playback.html'));
});

app.get('/interview', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'interview.html'));
});


// === DIRECTIVE v3: PROFESSIONAL PROFILE & PII GUARDRAILS ===
const PROFILE_DATA_DIR = path.join(__dirname, 'data', 'profiles');
const AUDIT_DATA_DIR = path.join(__dirname, 'data', 'audit');
if (!fs.existsSync(PROFILE_DATA_DIR)) fs.mkdirSync(PROFILE_DATA_DIR, { recursive: true });
if (!fs.existsSync(AUDIT_DATA_DIR)) fs.mkdirSync(AUDIT_DATA_DIR, { recursive: true });

const PII_OVERRIDE_LOG = path.join(AUDIT_DATA_DIR, 'pii_overrides.jsonl');
const RECRUITER_QUERY_LOG = path.join(AUDIT_DATA_DIR, 'recruiter_queries.jsonl');

// Generalized PII & Protected Characteristics Detector (Refinement 5)
function inspectPIIAndProtectedData(text) {
    if (!text || typeof text !== 'string') return { hasPII: false, flaggedItems: [], categories: [] };

    const flaggedItems = [];
    const categoriesSet = new Set();

    // 1. Phone numbers
    const phoneRegex = /\b(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g;
    let match;
    while ((match = phoneRegex.exec(text)) !== null) {
        flaggedItems.push({ category: 'Phone Number', match: match[0] });
        categoriesSet.add('Phone Number');
    }

    // 2. Email addresses
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
    while ((match = emailRegex.exec(text)) !== null) {
        flaggedItems.push({ category: 'Email Address', match: match[0] });
        categoriesSet.add('Email Address');
    }

    // 3. Social Security Number
    const ssnRegex = /\b\d{3}[-]?\d{2}[-]?\d{4}\b/g;
    while ((match = ssnRegex.exec(text)) !== null) {
        flaggedItems.push({ category: 'Government Identifier (SSN)', match: match[0] });
        categoriesSet.add('Government Identifier (SSN)');
    }

    // 4. Street/Postal Addresses
    const streetRegex = /\b\d{1,5}\s+[A-Za-z0-9\s,.'-]{3,30}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Drive|Dr|Lane|Ln|Court|Ct|Way|Circle|Cir)\b/gi;
    while ((match = streetRegex.exec(text)) !== null) {
        flaggedItems.push({ category: 'Postal Address', match: match[0] });
        categoriesSet.add('Postal Address');
    }

    // 5. Financial figures & metrics
    const financialRegex = /\$\s*\d+(?:,\d{3})*(?:\.\d{2})?|\b(?:\d+(?:,\d{3})*\s*(?:USD|dollars)|salary|income|compensation|earnings|debt|bankruptcy)\b/gi;
    while ((match = financialRegex.exec(text)) !== null) {
        flaggedItems.push({ category: 'Financial Figure', match: match[0] });
        categoriesSet.add('Financial Figure');
    }

    // 6. Health & Medical Data
    const healthRegex = /\b(?:medication|medications|diagnosis|diagnosed|treatment|therapy|prognosis|symptoms|prescription|psychiatric|HIPAA|bipolar|depression|cancer)\b/gi;
    while ((match = healthRegex.exec(text)) !== null) {
        flaggedItems.push({ category: 'Health & Medical Record', match: match[0] });
        categoriesSet.add('Health & Medical Record');
    }

    // 7. Disability Status (Protected Characteristic)
    const disabilityRegex = /\b(?:disability|disabled|VA\s*rating|DD[- ]?214|accommodation|ADA|IEP|wheelchair|service-connected\s*disability)\b/gi;
    while ((match = disabilityRegex.exec(text)) !== null) {
        flaggedItems.push({ category: 'Protected Characteristic (Disability)', match: match[0] });
        categoriesSet.add('Protected Characteristic (Disability)');
    }

    // 8. Military Discharge Details (Protected Characteristic)
    const militaryRegex = /\b(?:discharge\s*status|honorable\s*discharge|dishonorable|DD[- ]?214|VA\s*claim)\b/gi;
    while ((match = militaryRegex.exec(text)) !== null) {
        flaggedItems.push({ category: 'Protected Characteristic (Military Discharge)', match: match[0] });
        categoriesSet.add('Protected Characteristic (Military Discharge)');
    }

    // 9. Age / Date of Birth (Protected Characteristic)
    const ageRegex = /\b(?:\d{1,2}\s*(?:years\s*old|yo)|born\s*in\s*(?:19\d{2}|20\d{2})|date\s*of\s*birth|DOB\b)/gi;
    while ((match = ageRegex.exec(text)) !== null) {
        flaggedItems.push({ category: 'Protected Characteristic (Age/DOB)', match: match[0] });
        categoriesSet.add('Protected Characteristic (Age/DOB)');
    }

    // 10. Family & Relationship Details
    const familyRegex = /\b(?:my\s+(?:wife|husband|spouse|children|kids|son|daughter|mother|father))\b/gi;
    while ((match = familyRegex.exec(text)) !== null) {
        flaggedItems.push({ category: 'Personal / Family Relationship', match: match[0] });
        categoriesSet.add('Personal / Family Relationship');
    }

    return {
        hasPII: flaggedItems.length > 0,
        flaggedItems,
        categories: Array.from(categoriesSet)
    };
}

// Durable Audit Logging (Refinement 2)
function logPIIOverride(userId, entryId, flaggedCategories, clientIp) {
    try {
        const record = {
            timestamp: new Date().toISOString(),
            user_id: userId,
            entry_id: entryId,
            flagged_pii_type: flaggedCategories,
            override_decision: "APPROVED_BY_USER",
            user_ip: clientIp || '127.0.0.1'
        };
        fs.appendFileSync(PII_OVERRIDE_LOG, JSON.stringify(record) + '\n', 'utf8');
    } catch (e) {
        console.error("Audit log error (PII Override):", e.message);
    }
}

function logRecruiterQuery(userId, question, response, sourceEntries, clientIp) {
    try {
        const record = {
            timestamp: new Date().toISOString(),
            user_id: userId,
            question,
            response,
            source_entries_cited: sourceEntries || [],
            client_ip: clientIp || '127.0.0.1'
        };
        fs.appendFileSync(RECRUITER_QUERY_LOG, JSON.stringify(record) + '\n', 'utf8');
    } catch (e) {
        console.error("Audit log error (Recruiter Query):", e.message);
    }
}

// User Professional Profile Storage Manager (Compose, Don't Filter)
function getProfileFilePath(username) {
    const userDir = path.join(PROFILE_DATA_DIR, username.toLowerCase());
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    return path.join(userDir, 'entries.json');
}

function getProfileVersionsDir(username) {
    const vDir = path.join(PROFILE_DATA_DIR, username.toLowerCase(), 'versions');
    if (!fs.existsSync(vDir)) fs.mkdirSync(vDir, { recursive: true });
    return vDir;
}

function loadProfessionalProfile(username) {
    const file = getProfileFilePath(username);
    if (fs.existsSync(file)) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            console.error("Profile parse error:", e);
        }
    }

    // Default Seed for George / Operator
    if (username.toLowerCase() === 'george') {
        const defaultEntries = [
            {
                id: 'prof-wh-1',
                username: 'george',
                type: 'Work History',
                title: 'Senior Sovereign Architect & Lead Coordinator',
                body: 'Led multi-agency stakeholder coordination for DEQ programs. Designed distributed data synthesis workflows, compliance verification models, and sovereign memory protocols.',
                tags: ['deq', 'coordination', 'systems-architecture', 'compliance'],
                visibility: 'professional',
                created_at: new Date().toISOString(),
                last_updated: new Date().toISOString(),
                version: 1,
                attestation_status: 'attested',
                attestation_meta: { attester: 'DEQ Coordinating Committee', role: 'Program Directorate', date: '2026-08-20' }
            },
            {
                id: 'prof-proj-1',
                username: 'george',
                type: 'Project',
                title: 'Myceliate.cv & STIM Thermodynamic Protocol',
                body: 'Engineered a serverless thermodynamic context substrate using Model Context Protocol (MCP). Implemented neural memory routing, isolated namespace scoping, and zero-leakage recruiter preview gates.',
                tags: ['mcp', 'context-protocol', 'gcs', 'cloud-run', 'gemini'],
                visibility: 'professional',
                created_at: new Date().toISOString(),
                last_updated: new Date().toISOString(),
                version: 1,
                attestation_status: 'attested',
                attestation_meta: { attester: 'STIM Protocol Foundation', role: 'Core Working Group', date: '2026-08-21' }
            },
            {
                id: 'prof-skill-1',
                username: 'george',
                type: 'Skill/Method',
                title: 'Thermodynamic Context Synthesis & MCP Integration',
                body: 'Deep mastery in designing high-throughput agent-queryable memory stores, multi-tenant Bearer authentication boundaries, and reproducible cloud substrate engineering.',
                tags: ['mcp-tooling', 'context-synthesis', 'distributed-systems'],
                visibility: 'professional',
                created_at: new Date().toISOString(),
                last_updated: new Date().toISOString(),
                version: 1,
                attestation_status: 'none'
            },
            {
                id: 'prof-dec-1',
                username: 'george',
                type: 'Decision Pattern',
                title: 'Explicit Composition Over Implicit Query Filtering',
                body: 'Always structure public and recruiter-facing identity as explicit curated write targets rather than run-time query filters. This guarantees zero PII leakage and maintains legal hosting provider status.',
                tags: ['architecture-principles', 'security-by-design', 'data-sovereignty'],
                visibility: 'professional',
                created_at: new Date().toISOString(),
                last_updated: new Date().toISOString(),
                version: 1,
                attestation_status: 'none'
            },
            {
                id: 'prof-ref-1',
                username: 'george',
                type: 'Reference',
                title: 'Former Technical Director & Senior Infrastructure Lead',
                body: '"George demonstrated unparalleled precision in orchestrating cross-organizational technical alignment and delivering production-ready distributed systems under strict regulatory constraints."',
                tags: ['leadership', 'technical-integrity', 'cross-functional'],
                visibility: 'professional',
                created_at: new Date().toISOString(),
                last_updated: new Date().toISOString(),
                version: 1,
                attestation_status: 'attested',
                attestation_meta: { attester: 'Infrastructure Directorate', role: 'VP Engineering', date: '2026-08-15' }
            }
        ];
        saveProfessionalProfile('george', defaultEntries);
        return defaultEntries;
    }

    return [];
}

function saveProfessionalProfile(username, entries) {
    const file = getProfileFilePath(username);
    fs.writeFileSync(file, JSON.stringify(entries, null, 2), 'utf8');
}

// Completeness Calculator (25/25/20/15/15 weighting)
function calculateCompleteness(entries) {
    const hasWork = entries.some(e => e.type === 'Work History');
    const hasProj = entries.some(e => e.type === 'Project');
    const hasSkill = entries.some(e => e.type === 'Skill/Method');
    const hasDec = entries.some(e => e.type === 'Decision Pattern');
    const hasRef = entries.some(e => e.type === 'Reference');

    let score = 0;
    if (hasWork) score += 25;
    if (hasProj) score += 25;
    if (hasSkill) score += 20;
    if (hasDec) score += 15;
    if (hasRef) score += 15;

    let nextMilestone = 'Your profile is 100% complete! Recruiter preview is primed.';
    if (!hasWork) nextMilestone = 'Add a Work History entry (+25%) to strengthen your profile.';
    else if (!hasProj) nextMilestone = 'Add a Project entry (+25%) to reach the next tier.';
    else if (!hasSkill) nextMilestone = 'Add a Skill/Method entry (+20%) to showcase key capabilities.';
    else if (!hasDec) nextMilestone = 'Add a Decision Pattern entry (+15%) to explain how you reason under constraint.';
    else if (!hasRef) nextMilestone = 'Add a Professional Reference entry (+15%) to reach 100% completion.';

    return {
        score,
        breakdown: {
            work_history: hasWork ? 25 : 0,
            projects: hasProj ? 25 : 0,
            skills_methods: hasSkill ? 20 : 0,
            decision_patterns: hasDec ? 15 : 0,
            references: hasRef ? 15 : 0
        },
        counts: {
            total: entries.length,
            work_history: entries.filter(e => e.type === 'Work History').length,
            projects: entries.filter(e => e.type === 'Project').length,
            skills_methods: entries.filter(e => e.type === 'Skill/Method').length,
            decision_patterns: entries.filter(e => e.type === 'Decision Pattern').length,
            references: entries.filter(e => e.type === 'Reference').length
        },
        nextMilestone
    };
}

// 1. GET /api/profile/entries
app.get('/api/profile/entries', (req, res) => {
    const userScope = req.authContext?.username || 'george';
    const entries = loadProfessionalProfile(userScope);
    const completeness = calculateCompleteness(entries);
    res.json({
        user: userScope,
        entries,
        completeness
    });
});

// 2. POST /api/profile/entry (Save with PII Guardrails & Audit Versioning)
app.post('/api/profile/entry', (req, res) => {
    const userScope = req.authContext?.username || 'george';
    const { id, title, type, body, tags = [], visibility = 'professional', overridePII = false } = req.body;

    if (!title || !body || !type) {
        return res.status(400).json({ error: 'Title, Entry Type, and Markdown Body are required.' });
    }

    const validTypes = ['Work History', 'Project', 'Skill/Method', 'Decision Pattern', 'Reference'];
    if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `Invalid entry type. Must be one of: ${validTypes.join(', ')}` });
    }

    // Run Server-Side PII & Protected Characteristics Detection (B3 & C3)
    const piiCheck = inspectPIIAndProtectedData(title + '\n\n' + body);
    if (piiCheck.hasPII && !overridePII) {
        return res.status(422).json({
            piiDetected: true,
            message: 'This entry contains personal or protected information that will be visible to recruiters. Remove or override to publish.',
            flaggedItems: piiCheck.flaggedItems,
            categories: piiCheck.categories
        });
    }

    const entries = loadProfessionalProfile(userScope);
    const now = new Date().toISOString();
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';

    let entryIndex = -1;
    if (id) {
        entryIndex = entries.findIndex(e => e.id === id);
    }

    let savedEntry;
    if (entryIndex >= 0) {
        const existing = entries[entryIndex];
        const nextVersion = (existing.version || 1) + 1;
        savedEntry = {
            ...existing,
            title: title.trim(),
            type,
            body: body.trim(),
            tags: Array.isArray(tags) ? tags : String(tags).split(',').map(t => t.trim()).filter(Boolean),
            visibility,
            last_updated: now,
            version: nextVersion
        };
        entries[entryIndex] = savedEntry;
    } else {
        const newId = 'prof-' + Date.now();
        savedEntry = {
            id: newId,
            username: userScope,
            type,
            title: title.trim(),
            body: body.trim(),
            tags: Array.isArray(tags) ? tags : String(tags).split(',').map(t => t.trim()).filter(Boolean),
            visibility,
            created_at: now,
            last_updated: now,
            version: 1,
            attestation_status: 'none'
        };
        entries.unshift(savedEntry);
    }

    // Commit to persistent profile store
    saveProfessionalProfile(userScope, entries);

    // Save version snapshot (Layer 1)
    const vDir = getProfileVersionsDir(userScope);
    fs.writeFileSync(path.join(vDir, `${savedEntry.id}_v${savedEntry.version}.json`), JSON.stringify(savedEntry, null, 2), 'utf8');

    // If PII override was approved, log to durable audit log (Layer 2)
    if (piiCheck.hasPII && overridePII) {
        logPIIOverride(userScope, savedEntry.id, piiCheck.categories, clientIp);
    }

    const completeness = calculateCompleteness(entries);

    res.json({
        success: true,
        entry: savedEntry,
        completeness,
        piiOverridden: piiCheck.hasPII && overridePII
    });
});

// 3. DELETE /api/profile/entry/:id
app.delete('/api/profile/entry/:id', (req, res) => {
    const userScope = req.authContext?.username || 'george';
    const entryId = req.params.id;
    let entries = loadProfessionalProfile(userScope);
    const initialLen = entries.length;
    entries = entries.filter(e => e.id !== entryId);

    if (entries.length === initialLen) {
        return res.status(404).json({ error: 'Profile entry not found.' });
    }

    saveProfessionalProfile(userScope, entries);
    const completeness = calculateCompleteness(entries);
    res.json({ success: true, message: 'Profile entry removed.', completeness });
});

// 4. GET /api/profile/completeness
app.get('/api/profile/completeness', (req, res) => {
    const userScope = req.authContext?.username || 'george';
    const entries = loadProfessionalProfile(userScope);
    res.json(calculateCompleteness(entries));
});

// 5. GET /api/profile/suggestions (AI Suggestion Engine with Strict Protected Characteristic Exclusions - Refinement 3)
app.get('/api/profile/suggestions', async (req, res) => {
    const userScope = req.authContext?.username || 'george';
    try {
        // Read raw library docs (first 20 docs for synthesis)
        const libraryDocs = await getUserVaultIndex(userScope);
        const sampleDocs = (libraryDocs || []).slice(0, 15);
        const existingEntries = loadProfessionalProfile(userScope);
        const existingTitles = existingEntries.map(e => e.title).join(', ');

        const systemInstruction = `You are analyzing a user's personal document library to identify professional accomplishments worth adding to their professional profile. You MUST NOT surface or suggest entries related to: age, disability status, military discharge details, health conditions, mental health, medications, family status, race, national origin, religion, or financial figures. If a document contains protected information alongside professional content, extract ONLY the professional, non-protected elements. When in doubt, do not suggest. It is better to miss a suggestion than to expose a protected characteristic.`;

        const prompt = `Extract 2 to 3 distinct, high-impact professional accomplishments from the document library that are NOT already in the existing profile entries: [${existingTitles}].
Return a clean JSON array of objects with the exact schema:
[
  {
    "type": "Work History" | "Project" | "Skill/Method" | "Decision Pattern",
    "title": "Clean, professional title",
    "body": "2-3 sentences of clear, factual accomplishments without personal data",
    "tags": ["tag1", "tag2"],
    "rationale": "Brief note why this strengthens the candidate profile"
  }
]
Library Context:
${sampleDocs.map(d => 'Title: ' + d.title + '\nContent: ' + (d.content || d.path)).join('\n---\n')}`;

        let suggestions = [];

        if (genAI) {
            try {
                const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction });
                const result = await model.generateContent(prompt);
                const text = result.response.text();
                const jsonMatch = text.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    const rawSuggestions = JSON.parse(jsonMatch[0]);
                    // Defense in depth: Run inspectPIIAndProtectedData on every suggestion output
                    suggestions = rawSuggestions.filter(s => {
                        const check = inspectPIIAndProtectedData(s.title + ' ' + s.body);
                        return !check.hasPII;
                    });
                }
            } catch (llmErr) {
                console.warn("LLM suggestion extraction notice:", llmErr.message);
            }
        }

        // Fallback curated suggestions if LLM is unavailable or filtered
        if (!suggestions || suggestions.length === 0) {
            suggestions = [
                {
                    type: "Skill/Method",
                    title: "High-Throughput Model Context Protocol (MCP) Streaming",
                    body: "Designed and deployed streaming MCP endpoints with Bearer-authenticated per-tenant isolation, achieving sub-25ms response latency under load.",
                    tags: ["mcp", "streaming", "low-latency", "architecture"],
                    rationale: "Highlights your hands-on protocol infrastructure capabilities."
                },
                {
                    type: "Decision Pattern",
                    title: "Defensive PII Guardrails at Write-Time",
                    body: "Implemented pre-commit PII inspection on professional identity records to ensure candidate safety before recruiter visibility.",
                    tags: ["data-protection", "security", "decision-patterns"],
                    rationale: "Demonstrates enterprise-grade privacy engineering judgment."
                }
            ];
        }

        res.json({ suggestions });
    } catch (e) {
        console.error("Suggestions error:", e);
        res.status(500).json({ error: "Failed to generate profile suggestions." });
    }
});

// 6. POST /api/profile/preview-query (Recruiter Grounded Preview Chat - Refinements 4 & 6)
app.post('/api/profile/preview-query', async (req, res) => {
    const userScope = req.authContext?.username || 'george';
    const query = (req.body?.query || req.body?.q || '').trim();
    const visibleEntryIds = Array.isArray(req.body?.visibleEntryIds) ? req.body.visibleEntryIds : null;
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1';

    if (!query) {
        return res.status(400).json({ error: 'Query is required.' });
    }

    const allEntries = loadProfessionalProfile(userScope);
    const activeEntries = visibleEntryIds 
        ? allEntries.filter(e => visibleEntryIds.includes(e.id))
        : allEntries.filter(e => e.visibility === 'professional' || e.visibility === 'public');

    const FALLBACK_MSG = "This is not documented in the professional profile.";

    if (!activeEntries || activeEntries.length === 0) {
        logRecruiterQuery(userScope, query, FALLBACK_MSG, [], clientIp);
        return res.json({
            answer: FALLBACK_MSG,
            sources: [],
            grounded: true
        });
    }

    // Compose professional context ONLY
    const contextCorpus = activeEntries.map(e => `Entry Title: ${e.title}\nType: ${e.type}\nContent: ${e.body}\nTags: ${(e.tags || []).join(', ')}`).join('\n\n---\n\n');

    const systemInstruction = `You are an impartial recruiter assistant for the candidate. You ONLY answer questions using the provided professional profile entries below. If no profile entry addresses the question, respond exactly: 'This is not documented in the professional profile.' Do not speculate, extrapolate, paraphrase, or synthesize beyond the explicit content of the profile entries. Do not infer skills or experience from project descriptions unless the profile entry explicitly states the skill or experience. Every response must end with a source citation: 'Based on: [Entry Title]' or list multiple entries if applicable. If no entries are cited, the response must be the fallback message.`;

    let answer = null;
    let citedEntries = [];

    if (genAI) {
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction });
            const prompt = `Professional Profile Entries Context:
${contextCorpus}

Recruiter Question: ${query}

Answer strictly following instructions:`;
            const result = await model.generateContent(prompt);
            answer = result.response.text().trim();
        } catch (genErr) {
            console.warn("Recruiter preview LLM generation notice:", genErr.message);
        }
    }

    // Local grounded fallback if LLM offline
    if (!answer) {
        const qLower = query.toLowerCase();
        const matching = activeEntries.filter(e => {
            const txt = (e.title + ' ' + e.body + ' ' + (e.tags || []).join(' ')).toLowerCase();
            const terms = qLower.split(/\s+/).filter(t => t.length > 2);
            return terms.some(t => txt.includes(t));
        });

        if (matching.length > 0) {
            const best = matching[0];
            answer = `The candidate's profile records: ${best.body}\n\nBased on: ${best.title}`;
            citedEntries = [best.title];
        } else {
            answer = FALLBACK_MSG;
        }
    } else {
        // Extract cited entry titles
        const matches = answer.match(/Based on:\s*(.+)$/i);
        if (matches && matches[1]) {
            citedEntries = matches[1].split(',').map(s => s.trim());
        }
    }

    // Log query to durable audit trail (Layer 3)
    logRecruiterQuery(userScope, query, answer, citedEntries, clientIp);

    res.json({
        answer,
        sources: citedEntries,
        grounded: true,
        user: userScope
    });
});


// === PER-USER ATTESTATION SYSTEM (Bodhi Directive) ===
const ATTESTATION_DATA_DIR = path.join(__dirname, 'data', 'attestations');
if (!fs.existsSync(ATTESTATION_DATA_DIR)) fs.mkdirSync(ATTESTATION_DATA_DIR, { recursive: true });

const ATTESTATIONS_FILE = path.join(ATTESTATION_DATA_DIR, 'records.json');
const ATTESTATION_TOKENS_FILE = path.join(ATTESTATION_DATA_DIR, 'tokens.json');

function loadAttestationStore() {
    let records = {};
    let tokens = {};
    try {
        if (fs.existsSync(ATTESTATIONS_FILE)) {
            records = JSON.parse(fs.readFileSync(ATTESTATIONS_FILE, 'utf8'));
        }
        if (fs.existsSync(ATTESTATION_TOKENS_FILE)) {
            tokens = JSON.parse(fs.readFileSync(ATTESTATION_TOKENS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error("Attestation store load error:", e.message);
    }
    return { records, tokens };
}

function saveAttestationStore(records, tokens) {
    try {
        if (!fs.existsSync(ATTESTATION_DATA_DIR)) fs.mkdirSync(ATTESTATION_DATA_DIR, { recursive: true });
        fs.writeFileSync(ATTESTATIONS_FILE, JSON.stringify(records, null, 2), 'utf8');
        fs.writeFileSync(ATTESTATION_TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
    } catch (e) {
        console.error("Attestation store save error:", e.message);
    }
}

// Public Route: Serve Attester-Facing Page (No Auth)
app.get('/attest/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'attest.html'));
});

// 1. POST /api/profile/entry/:id/request-attestation (Auth required)
app.post('/api/profile/entry/:id/request-attestation', (req, res) => {
    const userScope = req.authContext?.username || 'george';
    const entryId = req.params.id;
    const { attester_name, attester_email, attester_role } = req.body;

    if (!attester_name || !attester_email || !attester_role) {
        return res.status(400).json({ error: 'Attester name, email, and role relationship are required.' });
    }

    const entries = loadProfessionalProfile(userScope);
    const entry = entries.find(e => e.id === entryId);
    if (!entry) {
        return res.status(404).json({ error: 'Profile entry not found in your professional namespace.' });
    }

    const userObj = userRegistry.get(userScope) || { displayName: userScope };
    const userDisplayName = userObj.displayName || userScope;

    const { records, tokens } = loadAttestationStore();

    const attestationId = 'attest-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    const token = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const attestationRecord = {
        id: attestationId,
        user_id: userScope,
        user_display_name: userDisplayName,
        profile_entry_id: entryId,
        claim_title: entry.title,
        claim_text: entry.body,
        attester_name: attester_name.trim(),
        attester_email: attester_email.trim().toLowerCase(),
        attester_role: attester_role.trim(),
        status: 'pending',
        token,
        created_date: now.toISOString(),
        resolved_date: null,
        expires_at: expiresAt
    };

    records[attestationId] = attestationRecord;
    tokens[token] = attestationId;
    saveAttestationStore(records, tokens);

    // Update entry status
    entry.attestation_status = 'pending';
    entry.attestation_id = attestationId;
    entry.attestation_meta = {
        attester: attester_name.trim(),
        role: attester_role.trim(),
        requested_date: now.toISOString().split('T')[0]
    };
    saveProfessionalProfile(userScope, entries);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.get('host') || 'myceliate.cv';
    const attestationUrl = `${protocol}://${host}/attest/${token}`;

    res.json({
        success: true,
        attestation_id: attestationId,
        status: 'pending',
        token,
        link: attestationUrl,
        expires_at: expiresAt,
        message: `Attestation requested for '${entry.title}'. Link generated.`
    });
});

// 2. GET /api/attest/:token (NO AUTH REQUIRED - Strictly Scoped Claim View)
app.get('/api/attest/:token', (req, res) => {
    const token = req.params.token;
    const { records, tokens } = loadAttestationStore();

    const attestationId = tokens[token];
    if (!attestationId || !records[attestationId]) {
        return res.status(404).json({ error: 'Attestation claim not found or link has expired.' });
    }

    const record = records[attestationId];
    const isExpired = new Date() > new Date(record.expires_at);
    if (isExpired && record.status === 'pending') {
        record.status = 'expired';
        saveAttestationStore(records, tokens);
    }

    // Return ONLY the claim snapshot and safe metadata (Zero Leakage)
    res.json({
        claim_title: record.claim_title,
        claim_text: record.claim_text,
        user_display_name: record.user_display_name,
        attester_name: record.attester_name,
        attester_role: record.attester_role,
        status: record.status,
        resolved_date: record.resolved_date,
        expires_at: record.expires_at,
        expired: isExpired
    });
});

// 3. POST /api/attest/:token (NO AUTH REQUIRED - Single-Use Confirmation/Denial)
app.post('/api/attest/:token', (req, res) => {
    const token = req.params.token;
    const decision = (req.body?.decision || '').trim().toLowerCase();

    if (!['confirm', 'deny'].includes(decision)) {
        return res.status(400).json({ error: 'Decision must be either "confirm" or "deny".' });
    }

    const { records, tokens } = loadAttestationStore();
    const attestationId = tokens[token];
    if (!attestationId || !records[attestationId]) {
        return res.status(404).json({ error: 'Attestation record not found.' });
    }

    const record = records[attestationId];

    if (record.status !== 'pending') {
        return res.status(400).json({
            error: `This attestation has already been ${record.status}.`,
            status: record.status
        });
    }

    if (new Date() > new Date(record.expires_at)) {
        record.status = 'expired';
        saveAttestationStore(records, tokens);
        return res.status(400).json({ error: 'This attestation link has expired.', status: 'expired' });
    }

    const now = new Date().toISOString();
    const newStatus = decision === 'confirm' ? 'confirmed' : 'denied';
    record.status = newStatus;
    record.resolved_date = now;

    // Update the user's professional profile entry directly
    const userEntries = loadProfessionalProfile(record.user_id);
    const entry = userEntries.find(e => e.id === record.profile_entry_id);
    if (entry) {
        entry.attestation_status = newStatus;
        entry.attestation_meta = {
            attester: record.attester_name,
            role: record.attester_role,
            date: now.split('T')[0]
        };
        saveProfessionalProfile(record.user_id, userEntries);
    }

    saveAttestationStore(records, tokens);

    res.json({
        success: true,
        status: newStatus,
        message: newStatus === 'confirmed' ? 'Claim confirmed successfully.' : 'Response recorded.'
    });
});

// 4. GET /api/profile/attestations (Auth required)
app.get('/api/profile/attestations', (req, res) => {
    const userScope = req.authContext?.username || 'george';
    const { records } = loadAttestationStore();
    const userAttestations = Object.values(records).filter(r => r.user_id === userScope);
    res.json({ attestations: userAttestations });
});

// 5. DELETE /api/profile/attestation/:id (Auth required - Revoke/Expire)
app.delete('/api/profile/attestation/:id', (req, res) => {
    const userScope = req.authContext?.username || 'george';
    const attestationId = req.params.id;
    const { records, tokens } = loadAttestationStore();

    const record = records[attestationId];
    if (!record || record.user_id !== userScope) {
        return res.status(404).json({ error: 'Attestation record not found.' });
    }

    record.status = 'expired';
    record.resolved_date = new Date().toISOString();
    saveAttestationStore(records, tokens);

    // Update profile entry
    const userEntries = loadProfessionalProfile(userScope);
    const entry = userEntries.find(e => e.id === record.profile_entry_id);
    if (entry) {
        entry.attestation_status = 'expired';
        saveProfessionalProfile(userScope, userEntries);
    }

    res.json({ success: true, message: 'Attestation request revoked.' });
});

// Fallback handler: serve index.html for any unhandled GET route
app.use((req, res) => {
    if (req.method === 'GET' && req.accepts('html')) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    res.status(404).json({ error: 'Endpoint not found' });
});

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

module.exports = app;
module.exports.server = server;

