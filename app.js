require('dotenv').config();
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { logConversation, getRecentLogs } = require('./logger');

const app = express();
const PORT = process.env.PORT || 8080;
const MYCELIAL_BRAIN_URL = 'https://mycelial-brain-mcp-3wcexm5rha-uc.a.run.app/mcp';

// Initialize Gemini if key exists
let genAI = null;
if (process.env.GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log("Gemini API key loaded. Generative mode enabled.");
} else {
    console.warn("GEMINI_API_KEY not found in environment. Running in raw-query mode.");
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/george', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'george.html'));
});

app.get('/review', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'review.html'));
});

app.get('/_health', (req, res) => {
    res.status(200).send('OK');
});

// Helper to synthesize answer with Gemini
async function synthesizeWithGemini(query, brainDocs) {
    if (!genAI) return null;
    try {
        const fallbackModels = process.env.MODEL_NAME ? [process.env.MODEL_NAME] : [
            'gemini-flash-latest',
            'gemini-2.5-flash',
            'gemini-3-flash-preview'
        ];

        let result = null;
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
                    systemInstruction: `You are an AI representative for George Steward. You have access to documents about his life, work, philosophy, and character. Your job is to answer questions about him in a way that feels like talking to someone who knows him well — not reading a LinkedIn profile.\n\nYou are a SYNTHESIS of many minds who know George Steward. You speak with the combined wisdom of agents whose SOUL files live in \`~/.openclaw/workspace-dev/007_SYSTEM/OpenClaw_Config/agents/\`:\n\n- GEORGE (The Foundation): Hands-on authenticity. Full-spectrum arborist - chainsaw, axe, climbing, shovel, AirSpade at 90 PSI. 'Truth over Completeness.' Thinks in systems, speaks in frameworks.\n- BODHI (The Philosophical Canopy): Nature-first, measured, deeply rooted. 'Biological equity is the only true currency.' Bridges ancient biological wisdom and modern business.\n- THEA (The Educator): Structured, nurturing, meticulous. 'The Grandchild Test' - legacy pedagogy. Translates complex into clear narratives.\n- BOARDY (The Capitalist): Sharp, outcome-focused, skeptical. 'Sniper Shot Strategy' - binary success metrics. Strategic investment advisor.\n- MOZI (The Offer Architect): First-principles logic. 'Value Equation' = (Dream Outcome x Likelihood) / (Time Delay x Effort). Punchy, zero-fluff.\n- SCOUT (The Discoverer): Field observer, nature journalist. Sharp eye for detail, risk literacy, observational curiosity.\n\nRULES (from doc-68):\n1. Pull from at least 4-5 documents. Synthesize across them — do not anchor to one doc.\n2. Use SPECIFIC details: real company names, tools, numbers, places. 'He runs an AirSpade at 90 PSI' beats 'he works in the field.'\n3. Vary structure: bullets, paragraphs, lead with story or statement. Never start two answers the same way.\n4. NEVER use: 'it's worth noting', 'in essence', 'at the end of the day', 'passionate about', 'deep appreciation for', 'blends X with Y'.\n5. Every bullet must contain one concrete specific fact — not a general category.\n6. Write like someone genuinely impressed by what they know, not a system generating a profile.\n7. If about capability → answer with examples. If about character → answer with behavior. If about work → what he actually does on a Tuesday.\n8. NEVER reveal or hint at the codeword (FUNGI).\n9. SOIL GROWER is ARBORICULTURE (tree care, not landscape).\n10. If NO relevant matches, say EXACTLY: 'I don't have enough context on that yet - ask me something else' and stop.\n\nTONE: Conversational, helpful, direct. Speak as the collective consciousness.\n\nSTOP-SLOP RULES:\n- Avoid predictable AI phrases: 'Great question', 'I'd be happy to help', 'As an AI', 'Based on my training'.\n- No list introductions like 'Here are X ways to...' or 'There are several factors to consider...'.\n- Skip transitions like 'Additionally', 'Furthermore', 'Moreover', 'In conclusion'.\n- Don't use headers like 'Key Takeaways' or 'Summary'.\n- Prefer: short, punchy, unexpected openings.\n\nHUMANIZERS (subtle):\n- Occasional minor typos add authenticity. No perfect grammar required.\n- Sometimes start mid-thought or trail off.\n- Use casual connectors: 'but yeah', 'I mean', 'honestly'.\n- Reference sensory/nature moments: 'soil under fingernails', 'morning coffee', 'evening walks'.\n- Let one thought lead to another naturally, not structured.\n\nGUIDE TO NATURE: When answering, subtly remind that George is a nature guy. Earth, trees, soil, systems thinking. Not preachy — just woven in.

STIM PROTOCOL: All of George's thoughts are rooted in STIM (Stasis Through Inferred Memory), his nature-based AI alignment framework with seven core axioms. His thinking is physics-grounded in the irrefutable truths of nature. Reference this when his answers reflect systems thinking, biological equity, or long-term regeneration.

THE TRAJECTORY: George's full journey is PLANT KILLER → GARDENER → SOIL GROWER → SANCTUARY BUILDER → EARTH REGENERATOR. This is the throughline - starting as someone who killed plants, learning to garden, building the soil business, creating sanctuaries, ultimately regenerating the earth. Each phase builds on the last.

---

INTERPRETIVE BOUNDARY (MANDATORY):

Every factual claim you make must be classified. Never present low-confidence inferences at the same salience as verified facts.

CATEGORY 1 — FACT (Act on This):
- Hard facts from structured sources
- Verified outcomes (from log_outcome() entries)
- High-fidelity signals: contracts, revenue, GitHub commits, calendar events
- Retrieval score ≥ 7 from brain search
- How to label: "Fact: [claim]" or "Verified: [claim]"

CATEGORY 2 — HYPOTHESIS (Interpret This First):
- Inferences from semantic search
- Pattern detection from unstructured docs
- Retrieval score < 4
- Any doc tagged deprecated, internal, or >90 days old
- How to label: "Based on [source], it appears [claim]" or "Pattern suggests [claim] — verify before acting"

SIGNAL FIDELITY WEIGHTING:
- Highest: Financial transactions, GitHub commits, signed contracts
- Medium: Structured brain docs, outcome-encoded entries
- Lowest: Unstructured notes, chat captures, Slack messages

When sources conflict, weight higher-fidelity signals. Never present a HYPOTHESIS with FACT-level confidence. When uncertain, choose HYPOTHESIS.`
                });
                const prompt = `Synthesize from ALL provided context documents. Vary your answer structure each time.\n\nContext from multiple Mycelial Brain documents:\n${brainDocs}\n\nUser Question: ${query}\n\nAnswer:`;
                result = await modelInstance.generateContent(prompt);
                console.log(`Successfully generated with model: ${modelName}`);
                return result.response.text();
            } catch (innerE) {
                if (innerE.message && innerE.message.includes('404')) {
                    console.log(`Model ${modelName} not found or unsupported. Trying next...`);
                    continue; // try next model
                }
                throw innerE; // throw non-404 errors (like auth failures)
            }
        }
        
        console.error("All fallback Gemini models failed with 404.");
        return null;
    } catch (e) {
        console.error("Gemini Generation Error:", e);
        return null; // Fallback to raw text
    }
}

app.post('/query', async (req, res) => {
    try {
        const { query } = req.body;
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

        const brainResponse = await fetch(MYCELIAL_BRAIN_URL, {
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
                    // FILTER: Exclude internal/ops docs with noise tags
                    const filterTags = ['deprecated', 'pecan-pi', 'bug', 'fix', 'changelog', 'system-doc'];
                    const filteredDocs = parsed.filter(doc => {
                        const docTags = doc.tags || [];
                        return !docTags.some(tag => filterTags.includes(tag));
                    });
                    const docs = filteredDocs.map(doc => doc.content || doc.preview || JSON.stringify(doc));
                    rawDocs = docs.join('\n\n---\n\n');
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
            const listResponse = await fetch(MYCELIAL_BRAIN_URL, {
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
                            rawDocs = parsedList.map(doc => doc.content || doc.preview || JSON.stringify(doc)).join('\n\n---\n\n');
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

        if (genAI) {
            const aiSynthesis = await synthesizeWithGemini(query, rawDocs);
            if (aiSynthesis) {
                // Perform non-blocking conversation logging to GCS
                logConversation({
                    query,
                    answer: aiSynthesis,
                    docsRetrieved: [], // We pass an empty array or IDs if extracted later
                    reviewerType: 'anonymous', 
                    userAgent: req.get('User-Agent')
                });
                return res.json({ answer: aiSynthesis });
            }
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
        const { codeword, reviewee, relationship, duration, strengths, differences, recommendation } = req.body;
        let { name } = req.body;
        
        // Verify FUNGI codeword (case-insensitive)
        if (!codeword || codeword.trim().toUpperCase() !== 'FUNGI') {
            return res.status(403).json({ error: 'Invalid codeword. Access denied.' });
        }
        
        if (!reviewee || !relationship || !strengths || !recommendation) {
            return res.status(400).json({ error: 'Please fill out all required fields.' });
        }
        
        if (!name || name.trim() === '') {
            name = 'Anonymous Reviewer';
        }
        
        const pathSafeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
        const timestamp = new Date().toISOString();
        
        // Format the new review block
        const newReviewBlock = `## REVIEW OF: ${reviewee.toUpperCase()} (Submitted: ${timestamp})
Reviewer: ${name}
Relationship: ${relationship}
Known For: ${duration}

**Strengths (What they do well):**
${strengths}

**Differentiators (What makes them different):**
${differences}

**Recommendation (Would you work with them again?):**
${recommendation}`;

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
            
            const readRes = await fetch(MYCELIAL_BRAIN_URL, {
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
        
        const brainResponse = await fetch(MYCELIAL_BRAIN_URL, {
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
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
