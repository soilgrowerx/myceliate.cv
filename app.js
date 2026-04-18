const express = require('express');
const path = require('path');
const fetch = require('node-fetch'); // For making HTTP requests

const app = express();
const PORT = process.env.PORT || 8080;

// Mycelial Brain URL from SPEC.md
const MYCELIAL_BRAIN_URL = 'https://mycelial-brain-mcp-1084814124987.us-central1.run.app/mcp';

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/_health', (req, res) => {
    res.status(200).send('OK');
});

// API endpoint to query the Mycelial Brain
app.post('/query', async (req, res) => {
    const { query } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'Query is required.' });
    }

    try {
        // Make a POST request to the Mycelial Brain
        const brainResponse = await fetch(MYCELIAL_BRAIN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Add any necessary authorization headers here if the brain requires it
            },
            body: JSON.stringify({ query: query })
        });

        if (!brainResponse.ok) {
            const errorText = await brainResponse.text();
            console.error(`Mycelial Brain error: ${brainResponse.status} - ${errorText}`);
            return res.status(brainResponse.status).json({ error: `Mycelial Brain responded with an error: ${errorText}` });
        }

        const brainData = await brainResponse.json();
        // The brain_search tool expects a 'query' field, and its response will likely have an 'answer' field.
        // Adjust this based on the actual Mycelial Brain API response format.
        res.json({ answer: brainData.answer || 'No specific answer found from brain.' });

    } catch (error) {
        console.error('Error querying Mycelial Brain:', error);
        res.status(500).json({ error: 'Internal server error while querying the brain.' });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
