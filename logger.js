const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

let s3Client = null;
function getS3Client() {
    if (!s3Client) {
        // Cloudflare R2 / S3 Configuration stub
        s3Client = new S3Client({
            region: process.env.R2_REGION || 'auto',
            endpoint: process.env.R2_ENDPOINT || 'https://stub.r2.cloudflarestorage.com',
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID || 'stub_access_key',
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || 'stub_secret_key',
            },
        });
    }
    return s3Client;
}

const BUCKET_NAME = process.env.LOG_BUCKET_NAME || 'myceliate-cv-logs';

async function logConversation({ query, answer, docsRetrieved, reviewerType, userAgent }) {
    try {
        const client = getS3Client();
        const date = new Date().toISOString().split('T')[0];
        const fileName = `conversations/${date}.jsonl`;

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
        let existingContents = '';
        
        try {
            await client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: fileName }));
            const getRes = await client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: fileName }));
            existingContents = await getRes.Body.transformToString('utf8');
        } catch (e) {
            if (e.name !== 'NotFound') {
                console.error('S3 Head/Get Error (File may be new):', e.message);
            }
        }

        const newContents = existingContents + jsonlData;

        await client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: fileName,
            Body: newContents,
            ContentType: 'application/x-ndjson'
        }));
        
    } catch (err) {
        console.error('Failed to log conversation to S3/R2:', err);
    }
}

async function getRecentLogs(limit = 100, offset = 0) {
    try {
        const client = getS3Client();
        const date = new Date().toISOString().split('T')[0];
        const fileName = `conversations/${date}.jsonl`;
        
        let contents = '';
        try {
            const getRes = await client.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: fileName }));
            contents = await getRes.Body.transformToString('utf8');
        } catch (e) {
            return []; // File probably doesn't exist yet
        }

        const lines = contents.trim().split('\n');
        
        return lines
            .reverse() // Newest first
            .slice(offset, offset + limit)
            .map(line => {
                try { return JSON.parse(line); } catch(e) { return null; }
            })
            .filter(entry => entry !== null);
    } catch (err) {
        console.error('Failed to retrieve logs from S3/R2:', err);
        return [];
    }
}

module.exports = { logConversation, getRecentLogs };
