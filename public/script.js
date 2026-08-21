// --- UI & Chat Logic ---
const questionInput = document.getElementById("questionInput");
const askBtn = document.getElementById("ask-btn");
const messagesArea = document.getElementById("messages-area");

// Default Verified Outcomes Fallback
const DEFAULT_VERIFIED_OUTCOMES = [
    {
        title: "Soil Grower Arboriculture Operation",
        description: "Primary contractor and operator for Bluffview estate arboriculture and ecological management.",
        category: "soil-grower",
        signal: "VERIFIED LEDGER"
    },
    {
        title: "Arboracle Context Infrastructure",
        description: "Decentralized tree inventory system deployed across Dallas residential and commercial estates.",
        category: "arboracle",
        signal: "CRYPTOGRAPHIC PROOF"
    },
    {
        title: "STIM Protocol: Thermodynamic Alignment",
        description: "Proof-of-computation substrate ensuring autonomous AI agents operate under thermodynamic grounding.",
        category: "stim",
        signal: "PROTOCOL SPEC"
    },
    {
        title: "Clay Hunt Fellowship",
        description: "Selected fellow for veteran leadership in environmental resilience and public crisis management.",
        category: "military-leadership",
        signal: "ORGANIZATIONAL RECORD"
    },
    {
        title: "Mycelial Brain MCP Substrate",
        description: "Serverless Model Context Protocol store coordinating persistent multi-agent memory over Google Cloud Storage.",
        category: "openclaw",
        signal: "CODE PROVENANCE"
    }
];

// Initialize chat history from sessionStorage
let chatHistory = JSON.parse(sessionStorage.getItem("myceliateChatHistory")) || [];

// Global animation state
let targetCameraZ = 1000;
let isInteracting = false;

function appendMessage(text, isUser = false, saveToHistory = true) {
    if (!messagesArea) return;
    const msgDiv = document.createElement("div");
    msgDiv.className = "message " + (isUser ? "user-message" : "ai-message");
    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content";
    
    if (isUser || !window.marked) {
        contentDiv.textContent = text;
    } else {
        contentDiv.innerHTML = window.marked.parse(text);
        const lastP = contentDiv.querySelector("p:last-child");
        if (lastP) lastP.style.marginBottom = "0";
    }
    
    msgDiv.appendChild(contentDiv);
    messagesArea.appendChild(msgDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;

    if (saveToHistory) {
        chatHistory.push({ text, isUser });
        sessionStorage.setItem("myceliateChatHistory", JSON.stringify(chatHistory));
    }
}

// Restore chat history on load
if (chatHistory.length > 0) {
    chatHistory.forEach(msg => appendMessage(msg.text, msg.isUser, false));
}

function appendLoader() {
    if (!messagesArea) return null;
    const msgDiv = document.createElement("div");
    msgDiv.className = "message ai-message loader-msg";
    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content loading-dots";
    contentDiv.innerHTML = "<span style='color:var(--accent-gold);'>Synthesizing response from neural memory...</span>";
    msgDiv.appendChild(contentDiv);
    messagesArea.appendChild(msgDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;
    return msgDiv;
}

async function askQuestion() {
    if (!questionInput) return;
    const question = questionInput.value.trim();
    if (!question) return;

    questionInput.value = "";
    appendMessage(question, true);
    
    targetCameraZ -= 300;
    isInteracting = true;

    const loader = appendLoader();

    try {
        const usernameRoute = window.location.pathname.replace(/^\//, "") || "george";
        const response = await fetch("/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: question, target_username: usernameRoute })
        });

        if (loader) loader.remove();

        if (!response.ok) {
            appendMessage("Unable to retrieve neural synthesis: Server returned " + response.status);
            return;
        }
        
        const data = await response.json();
        let answerText = data.answer;
        if (!answerText || answerText === "") {
            answerText = "I could not find a specific record for that in the sovereign brain ledger.";
        }
        appendMessage(answerText);
    } catch (error) {
        if (loader) loader.remove();
        appendMessage("Neural connection interrupted. Please try again: " + error.message);
    }

    setTimeout(() => { isInteracting = false; }, 2000);
}

if (askBtn) askBtn.addEventListener("click", askQuestion);
if (questionInput) {
    questionInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") askQuestion();
    });
}

function renderOutcomeCards(outcomes) {
    const outcomesContainer = document.getElementById("outcomes-container");
    if (!outcomesContainer) return;
    outcomesContainer.innerHTML = "";

    outcomes.forEach(out => {
        const card = document.createElement("div");
        card.className = "outcome-card";
        card.setAttribute("data-category", out.category || "general");
        
        card.innerHTML = 
            "<div class='outcome-title'>" + (out.title || "Verified Signal") + "</div>" +
            "<div class='outcome-desc'>" + (out.description || "") + "</div>" +
            "<div class='outcome-meta'>" +
                "<span class='outcome-category'>" + (out.category ? out.category.replace(/-/g, " ") : "SIGNAL") + "</span>" +
                "<span class='outcome-signal'>" + (out.signal || "VERIFIED") + "</span>" +
            "</div>";
        
        card.addEventListener("click", () => {
            let query = "Tell me more about " + (out.title || "this project") + " and verified outcomes.";
            if (out.category === "soil-grower") {
                query = "What is the Bluffview contract and the Soil Grower business?";
            } else if (out.category === "arboracle") {
                query = "Explain the Arboracle estate inventory and customer onboarding.";
            } else if (out.category === "stim") {
                query = "Explain the STIM Protocol and autonomous agent coordination.";
            } else if (out.category === "military-leadership") {
                query = "How did George get selected as a Clay Hunt Fellow?";
            }
            
            if (questionInput) {
                questionInput.value = query;
                askQuestion();
            }
        });
        
        outcomesContainer.appendChild(card);
    });
}

// --- Load Verifiable Outcomes with Resilient Fallback ---
async function loadOutcomes() {
    try {
        const response = await fetch("/api/outcomes");
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
                renderOutcomeCards(data);
                return;
            }
        }
    } catch (err) {
        console.warn("Using verified outcome fallback:", err);
    }
    renderOutcomeCards(DEFAULT_VERIFIED_OUTCOMES);
}

document.addEventListener("DOMContentLoaded", loadOutcomes);

// --- Three.js Enhanced Mycelial/Starfield Network ---
const canvas = document.getElementById("mycelium-canvas");
if (canvas && typeof THREE !== "undefined") {
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x080E0A, 0.0008); 

    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 6000);
    camera.position.z = 1000;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);

    const particleCount = 400; 
    const particles = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);

    const colorGold = new THREE.Color(0xE5A93C);
    const colorGreen = new THREE.Color(0x5A8A62);

    for (let i = 0; i < particleCount; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 2000;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 2000;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 3000;

        const mixed = Math.random() > 0.4 ? colorGold : colorGreen;
        colors[i * 3] = mixed.r;
        colors[i * 3 + 1] = mixed.g;
        colors[i * 3 + 2] = mixed.b;
    }

    particles.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    particles.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    const pMaterial = new THREE.PointsMaterial({
        size: 4,
        vertexColors: true,
        transparent: true,
        opacity: 0.75
    });

    const particleSystem = new THREE.Points(particles, pMaterial);
    scene.add(particleSystem);

    function animate() {
        requestAnimationFrame(animate);
        particleSystem.rotation.y += 0.0004;
        particleSystem.rotation.x += 0.0002;

        if (isInteracting) {
            camera.position.z += (targetCameraZ - camera.position.z) * 0.05;
        }

        renderer.render(scene, camera);
    }

    animate();

    window.addEventListener("resize", () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

function clearChat() {
    chatHistory = [];
    sessionStorage.removeItem("myceliateChatHistory");
    if (messagesArea) {
        messagesArea.innerHTML = `
            <div class="message ai-message">
                <div class="message-content">
                    <p>I am the neural synthesis of George Steward verified memory, grounded in truth. Ask me specific questions about active projects, background, technical architecture, or values.</p>
                    <div class="suggestion-chips">
                        <button class="chip" onclick="setQuery('What is your background and experience?')">Background & Experience</button>
                        <button class="chip" onclick="setQuery('What are you building with Mycelial Brain and MCP?')">Mycelial Brain MCP</button>
                        <button class="chip" onclick="setQuery('Explain the STIM Protocol and autonomous agent coordination.')">STIM Protocol</button>
                        <button class="chip" onclick="setQuery('What is the Soil Grower contract and arboriculture work?')">Soil Grower</button>
                    </div>
                </div>
            </div>
        `;
    }
}
window.clearChat = clearChat;
