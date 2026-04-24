const fs = require('fs');

// 1. Update script.js
let scriptJs = fs.readFileSync('public/script.js', 'utf8');
scriptJs = scriptJs.replace(
    'body: JSON.stringify({ query: userInput })',
    'body: JSON.stringify({ query: userInput, target_username: window.location.pathname.replace("/", "") })'
);
fs.writeFileSync('public/script.js', scriptJs);

// 2. Update app.js
let appJs = fs.readFileSync('app.js', 'utf8');

// A. Insert Supabase import
if (!appJs.includes('@supabase/supabase-js')) {
    appJs = appJs.replace(
        "const stripeAPI = require('stripe');",
        "const { createClient } = require('@supabase/supabase-js');\nconst supabase = process.env.SUPABASE_URL && process.env.SUPABASE_KEY ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY) : null;\nconst stripeAPI = require('stripe');"
    );
}

// B. Remove app.get('/george') and insert app.get('/:username')
appJs = appJs.replace(
    /app\.get\('\/george', \(req, res\) => \{\s+res\.sendFile\(path\.join\(__dirname, 'public', 'george\.html'\)\);\s+\}\);/,
    ''
);

const dynamicRoute = `
app.get('/:username', async (req, res, next) => {
    const ignore = ['_health', 'review', 'api', 'query', 'public', 'pricing.html', 'dashboard.html', 'sw.js', 'manifest.json'];
    if (ignore.includes(req.params.username) || req.params.username.includes('.')) {
        return next();
    }
    if (supabase) {
        const { data, error } = await supabase.from('profiles').select('username').eq('username', req.params.username).single();
        if (error || !data) return res.status(404).send('Synthesized Entity Not Found.');
    }
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});
`;

if (!appJs.includes("app.get('/:username'")) {
    appJs = appJs.replace(
        "app.get('/_health', (req, res) => {",
        dynamicRoute + "\napp.get('/_health', (req, res) => {"
    );
}

// C. Make /query endpoint aware of target_username
if (!appJs.includes("let brainUrl = MYCELIAL_BRAIN_URL;")) {
    appJs = appJs.replace(
        "const { query } = req.body;",
        "const { query, target_username } = req.body;"
    );
    appJs = appJs.replace(
        "const brainResponse = await fetch(MYCELIAL_BRAIN_URL, {",
        `let brainUrl = MYCELIAL_BRAIN_URL;
        if (target_username && supabase) {
            const { data } = await supabase.from('profiles').select('mcp_brain_url').eq('username', target_username).single();
            if (data && data.mcp_brain_url) {
                brainUrl = data.mcp_brain_url;
            }
        }
        const brainResponse = await fetch(brainUrl, {`
    );
}

// D. Also replace MYCELIAL_BRAIN_URL in the other fetch contexts (like /api/review)
if (!appJs.includes("let reviewBrainUrl = MYCELIAL_BRAIN_URL;")) {
    appJs = appJs.replace(
        "const readRes = await fetch(MYCELIAL_BRAIN_URL, {",
        "let reviewBrainUrl = MYCELIAL_BRAIN_URL; const readRes = await fetch(reviewBrainUrl, {"
    );
    appJs = appJs.replace(
        "const writeRes = await fetch(MYCELIAL_BRAIN_URL, {",
        "const writeRes = await fetch(reviewBrainUrl, {"
    );
}

fs.writeFileSync('app.js', appJs);
console.log('Update successful');
