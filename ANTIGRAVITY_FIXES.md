ANTIGRAVITY FIX LIST for myceliate.cv frontend:

1. RAW LEAK FIX: All queries including followups MUST go through LLM synthesis. Do NOT return brain_search raw results directly to UI. Even on click of "tell me more" - must synthesize.

2. ANSWERS TOO SAFE: Prompt tuning needed. Current LLM retreats to therapy-speak/generic when unsure. FIX: Update system instruction - give explicit permission to be specific and direct. Use EXACT stories from docs. NO hedged/safe language. Trust source material.

3. CONFIDENCE THRESHOLD: If search returns no high-confidence matches, respond with "I don't have enough context on that yet - ask me something else" NOT improvise.

4. REMOVE [RAW NEURAL QUERY] from displaying in UI at all costs.

Code fixes needed in app.js review handling.