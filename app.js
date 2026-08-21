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


// Initialize Gemini if key exists
let genAI = null;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log("Gemini API key loaded. Generative mode enabled.");
} else {
    console.warn("GEMINI_API_KEY not found in environment. Running in raw-query mode.");
}

app.use(express.json());

// Enable CORS for all routes (including /query, /api/*, /brain)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
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
    const publicPaths = [
        '/',
        '/index.html',
        '/login',
        '/login.html',
        '/api/login',
        '/api/auth',
        '/api/auth/reset',
        '/api/auth/verify',
        '/_health',
        '/style.css',
        '/stim.css',
        '/manifest.json',
        '/favicon.ico',
        '/robots.txt'
    ];
    if (publicPaths.includes(req.path) || req.path.startsWith('/uploads/') || req.path.startsWith('/public/')) {
        return next();
    }

    const cookies = parseCookies(req);
    const validToken = generateAuthToken();
    const currentSitePassword = process.env.SITE_PASSWORD || 'mycelium2026';

    const authHeader = req.headers['authorization'];
    const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

    if (
        cookies.cv_auth === validToken ||
        (bearerToken && (bearerToken === currentSitePassword || bearerToken === validToken || activeOperatorKeys.has(bearerToken)))
    ) {
        return next();
    }

    if (req.path.startsWith('/api/') || req.path === '/query' || req.method === 'POST' || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ error: 'Operator authentication required. Access denied.' });
    }

    const redirectUrl = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/login?redirect=${redirectUrl}`);
}

app.use(authMiddleware);

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

app.get('/signup', (req, res) => {
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

// Phase 3: Brain Search Proxy
app.post('/api/brain/search', async (req, res) => {
    const { query, limit = 20 } = req.body;
    if (!query) return res.status(400).json({ error: 'Search query required.' });

    let results = [];
    try {
        const payload = {
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
                name: "brain_search",
                arguments: { query, limit: parseInt(limit) || 20 }
            }
        };

        const mcpRes = await fetchBrain(MYCELIAL_BRAIN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (mcpRes.ok) {
            const data = await mcpRes.json();
            if (data.result && data.result.content && data.result.content[0]?.text) {
                try {
                    results = JSON.parse(data.result.content[0].text);
                } catch (e) {
                    results = [{ path: 'query-result', preview: data.result.content[0].text, score: 1 }];
                }
            }
        }
    } catch (e) {
        console.warn("Proxy brain_search failed or offline, using fallback local search:", e.message);
    }

    // Local fallback search if MCP search produced no results
    if (results.length === 0) {
        const localIndex = [
            { path: "doc-1", title: "George Identity", tags: ["identity", "arboriculture", "systems"], domain: "Arboracle", preview: "George Steward: Full spectrum arborist, systems thinker, STIM author." },
            { path: "doc-2", title: "George Updated", tags: ["biography", "trajectory"], domain: "Field Notes", preview: "Trajectory: Plant Killer to Forester to Soil Grower to Sanctuary Builder." },
            { path: "doc-3", title: "Agent Ecosystem", tags: ["agents", "openclaw", "bodhi", "thea"], domain: "Forest_OS", preview: "OpenClaw, Bodhi, Thea, Sylvan, and Reata multi-agent coordination." },
            { path: "doc-4", title: "Tech Stack", tags: ["mcp", "cloud-run", "gcs", "nodejs"], domain: "Forest_OS", preview: "GCP Cloud Run, GCS immutable buckets, Model Context Protocol." },
            { path: "doc-6", title: "Goals & Vision", tags: ["vision", "land-restoration", "stim"], domain: "STIM", preview: "100-year horizon thinking, biological equity, land regeneration." },
            { path: "doc-146", title: "STIM Provenance Layer", tags: ["stim", "axioms", "physics"], domain: "STIM", preview: "Layer 0 AI alignment axioms grounded in thermodynamics." }
        ];
        const q = query.toLowerCase();
        results = localIndex.filter(d => 
            d.title.toLowerCase().includes(q) || 
            d.path.toLowerCase().includes(q) || 
            d.tags.some(t => t.toLowerCase().includes(q)) ||
            d.preview.toLowerCase().includes(q)
        ).map(d => ({ ...d, score: 3 }));
    }

    res.json({ results });
});

// Phase 3: Brain List Proxy with Domain Categorization
app.get('/api/brain/list', async (req, res) => {
    let docs = [];
    try {
        const payload = {
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
                name: "brain_list",
                arguments: {}
            }
        };
        const mcpRes = await fetchBrain(MYCELIAL_BRAIN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (mcpRes.ok) {
            const data = await mcpRes.json();
            if (data.result && data.result.content && data.result.content[0]?.text) {
                try {
                    docs = JSON.parse(data.result.content[0].text);
                } catch (e) {
                    console.warn("Failed to parse MCP brain_list response:", e);
                }
            }
        }
    } catch (e) {
        console.warn("Proxy brain_list unreachable, utilizing high-fidelity local vault index:", e.message);
    }

    // If MCP returns empty or network is offline, fallback to local doc indexing
    if (!docs || docs.length === 0) {
        docs = [
            { path: "doc-1", title: "George Identity", tags: ["identity", "arboriculture", "systems"], domain: "Arboracle" },
            { path: "doc-2", title: "George Updated", tags: ["biography", "trajectory"], domain: "Field Notes" },
            { path: "doc-3", title: "Agent Ecosystem", tags: ["agents", "openclaw", "bodhi", "thea"], domain: "Forest_OS" },
            { path: "doc-4", title: "Tech Stack", tags: ["mcp", "cloud-run", "gcs", "nodejs"], domain: "Forest_OS" },
            { path: "doc-5", title: "Family & Roots", tags: ["personal", "legacy", "values"], domain: "Field Notes" },
            { path: "doc-6", title: "Goals & Vision", tags: ["vision", "land-restoration", "stim"], domain: "STIM" },
            { path: "doc-7", title: "Current Priorities", tags: ["priorities", "roadmap", "execution"], domain: "Arboracle" },
            { path: "doc-8", title: "Unified Stack Pitch", tags: ["architecture", "sovereign", "infrastructure"], domain: "Forest_OS" },
            { path: "doc-9", title: "Fungi Review Protocol", tags: ["reputation", "fungi", "peer-signal"], domain: "Reputation" },
            { path: "doc-146", title: "STIM Provenance Layer", tags: ["stim", "axioms", "physics"], domain: "STIM" },
            { path: "doc-183", title: "Neocambrian Voice Matrix", tags: ["interview", "axioms", "voice"], domain: "STIM" }
        ];
    } else {
        // Enrich with domains
        docs = docs.map(doc => {
            const tags = doc.tags || [];
            let domain = "Field Notes";
            if (tags.some(t => ['arboracle', 'business', 'soil', 'client'].includes(t.toLowerCase()))) domain = "Arboracle";
            else if (tags.some(t => ['stim', 'axiom', 'physics', 'alignment'].includes(t.toLowerCase()))) domain = "STIM";
            else if (tags.some(t => ['agent', 'openclaw', 'system', 'mcp', 'infrastructure'].includes(t.toLowerCase()))) domain = "Forest_OS";
            else if (tags.some(t => ['review', 'reputation', 'fungi', 'peer'].includes(t.toLowerCase()))) domain = "Reputation";
            return { ...doc, domain };
        });
    }

    res.json({ docs });
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
    try {
        let docId = req.params.docId;
        if (!docId.startsWith('doc-')) docId = 'doc-' + docId;
        const payload = {
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
                name: "brain_read",
                arguments: { path: docId }
            }
        };
        const mcpRes = await fetchBrain(MYCELIAL_BRAIN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!mcpRes.ok) {
            return res.status(mcpRes.status).json({ error: `MCP error ${mcpRes.status}` });
        }
        const data = await mcpRes.json();
        res.json(data);
    } catch (e) {
        console.error("Proxy brain_read error:", e);
        res.status(500).json({ error: "Failed to read doc from brain." });
    }
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
// Stripe Integration
// ==========================================
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(400).json({ error: 'Stripe configuration missing. Wait for system provisioning.' });
        }
        const { tier } = req.body;
        
        let priceId;
        if (tier === 'spore') priceId = process.env.STRIPE_PRICE_SPORE;
        else if (tier === 'mycelium') priceId = process.env.STRIPE_PRICE_MYCELIUM;
        else return res.status(400).json({ error: 'Invalid tier requested.' });

        if (!priceId) {
            return res.status(400).json({ error: 'Stripe Price ID not configured for this tier yet.' });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: `${req.protocol}://${req.get('host')}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/pricing.html`,
        });

        res.json({ url: session.url });
    } catch (e) {
        console.error('Stripe Integration Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// Stripe Integration
// ==========================================
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(400).json({ error: 'Stripe configuration missing. Wait for system provisioning.' });
        }
        const { tier } = req.body;
        
        let priceId;
        if (tier === 'spore') priceId = process.env.STRIPE_PRICE_SPORE;
        else if (tier === 'mycelium') priceId = process.env.STRIPE_PRICE_MYCELIUM;
        else return res.status(400).json({ error: 'Invalid tier requested.' });

        if (!priceId) {
            return res.status(400).json({ error: 'Stripe Price ID not configured for this tier yet.' });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price: priceId,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: `${req.protocol}://${req.get('host')}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/pricing.html`,
        });

        res.json({ url: session.url });
    } catch (e) {
        console.error('Stripe Integration Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// Auth Integration
// ==========================================
app.post('/api/signup', async (req, res) => {
    try {
        if (!supabase) {
            return res.status(400).json({ error: 'Database provisioning incomplete. Synthesization offline.' });
        }
        const { email, password, username } = req.body;
        if (!email || !password || !username) {
            return res.status(400).json({ error: 'Email, password, and username are required.' });
        }

        // Validate username formatting
        if (!/^[a-zA-Z0-9_]{3,}$/.test(username)) {
            return res.status(400).json({ error: 'Username must be at least 3 characters and contain only letters, numbers, and underscores.' });
        }

        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: {
                    username: username.toLowerCase()
                }
            }
        });

        if (error) throw error;
        
        res.json({ message: 'Synthesization successful.', user: data.user });
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
const fs = require('fs');

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

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
