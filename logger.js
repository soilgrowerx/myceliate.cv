const { Storage } = require('@google-cloud/storage');
const crypto = require('crypto');

let storage = null;
function getStorage() {
    if (!storage) storage = new Storage();
    return storage;
}

// Fallback to myceliate-cv-logs if env var isn't set
const BUCKET_NAME = process.env.LOG_BUCKET_NAME || 'myceliate-cv-logs';

async function logConversation({ query, answer, docsRetrieved, reviewerType, userAgent }) {
    try {
        const bucket = getStorage().bucket(BUCKET_NAME);
        const date = new Date().toISOString().split('T')[0];
        const fileName = `conversations/${date}.jsonl`;
        const file = bucket.file(fileName);

        const logEntry = {
            timestamp: new Date().toISOString(),
            session_id: crypto.randomUUID(),
            query,
            answer,
            docs_retrieved: docsRetrieved,
            reviewer_type: reviewerType || 'anonymous',
            user_agent: userAgent || 'unknown'
        };

        const jsonlData = JSON.stringify(logEntry) + '\n';

        // Check if file exists to append, or create new
        const [exists] = await file.exists();
        if (exists) {
            // Native GCS append isn't supported without composition or writing to a stream.
            // Since Cloud Run may scale concurrently, we should fetch current contents, append, and rewrite.
            const [contents] = await file.download();
            await file.save(contents.toString('utf8') + jsonlData, { resumable: false });
        } else {
            await file.save(jsonlData, { resumable: false });
        }
        
    } catch (err) {
        console.error('Failed to log conversation to GCS:', err);
    }
}

async function getRecentLogs(limit = 100, offset = 0) {
    try {
        const bucket = getStorage().bucket(BUCKET_NAME);
        const date = new Date().toISOString().split('T')[0];
        const fileName = `conversations/${date}.jsonl`;
        const file = bucket.file(fileName);
        
        const [exists] = await file.exists();
        if (!exists) return [];

        const [contents] = await file.download();
        const lines = contents.toString('utf8').trim().split('\n');
        
        return lines
            .reverse() // Newest first
            .slice(offset, offset + limit)
            .map(line => {
                try { return JSON.parse(line); } catch(e) { return null; }
            })
            .filter(entry => entry !== null);
    } catch (err) {
        console.error('Failed to retrieve logs:', err);
        return [];
    }
}

module.exports = { logConversation, getRecentLogs };
