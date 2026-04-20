// --- UI & Chat Logic ---
const questionInput = document.getElementById('questionInput');
const askBtn = document.getElementById('ask-btn');
const messagesArea = document.getElementById('messages-area');

function appendMessage(text, isUser = false) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${isUser ? 'user-message' : 'ai-message'}`;
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    if (isUser || !window.marked) {
        contentDiv.textContent = text;
    } else {
        // Parse markdown for AI responses to handle **bold** and formatting beautifully
        contentDiv.innerHTML = marked.parse(text);
        
        // Remove bottom margin on last paragraphs
        const lastP = contentDiv.querySelector('p:last-child');
        if (lastP) lastP.style.marginBottom = '0';
    }
    
    msgDiv.appendChild(contentDiv);
    messagesArea.appendChild(msgDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;
}

function appendLoader() {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message ai-message loader-msg';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content loading-dots';
    contentDiv.innerHTML = '<span></span><span></span><span></span>';
    msgDiv.appendChild(contentDiv);
    messagesArea.appendChild(msgDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;
    return msgDiv;
}

async function askQuestion() {
    const question = questionInput.value.trim();
    if (!question) return;

    questionInput.value = '';
    appendMessage(question, true);
    
    // Animate camera zooming forward through the 'starfield' / network
    targetCameraZ -= 400; // zoom in deeply
    isInteracting = true;

    const loader = appendLoader();

    try {
        const response = await fetch('/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: question })
        });

        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        
        const data = await response.json();
        loader.remove();
        
        let answerText = data.answer;
        if (!answerText || answerText === '') {
            answerText = "I couldn't find a specific answer to that in George's Brain.";
        }
        appendMessage(answerText);
    } catch (error) {
        console.error('Error fetching data:', error);
        loader.remove();
        appendMessage(`System glitch... connection to brain failed. (${error.message})`);
    }

    setTimeout(() => { isInteracting = false; }, 2000);
}

askBtn.addEventListener('click', askQuestion);
questionInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') askQuestion();
});


// --- Three.js Enhanced Mycelial/Starfield Network ---
const canvas = document.getElementById('mycelium-canvas');
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x050508, 0.0008); // denser fog

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 6000);
camera.position.z = 1000;
let targetCameraZ = 1000;
let isInteracting = false;

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

// Create geometry
const particleCount = 600; // denser network
const particles = new THREE.BufferGeometry();
const particlePositions = new Float32Array(particleCount * 3);
const particleVelocities = [];

for (let i = 0; i < particleCount; i++) {
    particlePositions[i * 3] = (Math.random() - 0.5) * 4000;
    particlePositions[i * 3 + 1] = (Math.random() - 0.5) * 4000;
    particlePositions[i * 3 + 2] = (Math.random() - 0.5) * 4000;

    particleVelocities.push({
        x: (Math.random() - 0.5) * 0.8,
        y: (Math.random() - 0.5) * 0.8,
        z: (Math.random() - 0.5) * 0.8
    });
}

particles.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));

// Particle Materials
// Create a glowing sprite for the nodes using Canvas
function createCanvasMaterial(color, size) {
    const matCanvas = document.createElement('canvas');
    matCanvas.width = 128;
    matCanvas.height = 128;
    const context = matCanvas.getContext('2d');
    
    // radial gradient
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.2, color);
    gradient.addColorStop(0.4, 'rgba(0,10,30,0.5)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    
    const texture = new THREE.CanvasTexture(matCanvas);
    
    return new THREE.PointsMaterial({
        size: size,
        map: texture,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.9
    });
}

const pMaterial = createCanvasMaterial('rgba(0, 210, 255, 1)', 60);
const particleSystem = new THREE.Points(particles, pMaterial);
scene.add(particleSystem);

// Lines connecting nodes
const linesGeometry = new THREE.BufferGeometry();
const linesMaterial = new THREE.LineBasicMaterial({
    color: 0x3a7bd5,
    transparent: true,
    opacity: 0.25,
    blending: THREE.AdditiveBlending,
    linewidth: 1
});
let linesMesh = new THREE.LineSegments(linesGeometry, linesMaterial);
scene.add(linesMesh);

// Mouse interaction
let mouseX = 0;
let mouseY = 0;
let targetX = 0;
let targetY = 0;
const windowHalfX = window.innerWidth / 2;
const windowHalfY = window.innerHeight / 2;

document.addEventListener('mousemove', (event) => {
    mouseX = (event.clientX - windowHalfX);
    mouseY = (event.clientY - windowHalfY);
});

// Subtle automatic forward movement (starfield effect)
let autoZMovement = 0.5;

function animate() {
    requestAnimationFrame(animate);

    // Camera targets based on mouse
    targetX = mouseX * 0.8;
    targetY = mouseY * 0.8;

    camera.position.x += (targetX - camera.position.x) * 0.05;
    camera.position.y += (-targetY - camera.position.y) * 0.05;

    // Zooming logic
    if (!isInteracting) {
        targetCameraZ -= autoZMovement;
    }
    
    // Wrap camera Z to loop infinitely through the field
    if (camera.position.z < -2000) {
        camera.position.z = 2000;
        targetCameraZ = 2000;
    }

    camera.position.z += (targetCameraZ - camera.position.z) * 0.05;
    camera.lookAt(camera.position.x, camera.position.y, camera.position.z - 500); // look forward slightly offset

    const positions = particleSystem.geometry.attributes.position.array;
    const vertexCount = particleCount;
    
    // Network drift
    particleSystem.rotation.x += 0.0003;
    particleSystem.rotation.y += 0.0005;

    for (let i = 0; i < vertexCount; i++) {
        positions[i * 3] += particleVelocities[i].x;
        positions[i * 3 + 1] += particleVelocities[i].y;
        positions[i * 3 + 2] += particleVelocities[i].z;

        // Wrap around boundary box
        if (positions[i * 3] > 2000 || positions[i * 3] < -2000) particleVelocities[i].x *= -1;
        if (positions[i * 3 + 1] > 2000 || positions[i * 3 + 1] < -2000) particleVelocities[i].y *= -1;
        if (positions[i * 3 + 2] > 2000 || positions[i * 3 + 2] < -2000) particleVelocities[i].z *= -1;
    }
    particleSystem.geometry.attributes.position.needsUpdate = true;

    // Draw localized connecting lines (Mycelium effect)
    const linePositions = [];
    // Dynamic connection distance based on interaction
    const connectDistance = isInteracting ? 300 : 250;

    for (let i = 0; i < vertexCount; i++) {
        // Optimization: don't compute all N^2 pairs, just nearby subset roughly
        // To keep 60fps with 600 nodes
        for (let j = i + 1; j < vertexCount; j++) {
            const dx = positions[i * 3] - positions[j * 3];
            const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
            const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
            
            // Fast culling
            if (Math.abs(dx) > connectDistance || Math.abs(dy) > connectDistance || Math.abs(dz) > connectDistance) continue;
            
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

            if (dist < connectDistance) {
                linePositions.push(
                    positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2],
                    positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2]
                );
            }
        }
    }

    linesMesh.geometry.dispose();
    linesMesh.geometry = new THREE.BufferGeometry();
    linesMesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    
    // Node pulse effect when interacting
    if(isInteracting) {
        pMaterial.opacity = 1;
        pMaterial.size = 80;
    } else {
        pMaterial.opacity = 0.8;
        pMaterial.size = 60;
    }

    renderer.render(scene, camera);
}

// Handle resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Scroll interaction to manual zoom
window.addEventListener('wheel', (e) => {
    targetCameraZ += e.deltaY * 0.5;
});

// Start animation
animate();
