const { Storage } = require('@google-cloud/storage');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const app = express();

const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET_NAME || 'mycelial-brain-storage';
const PREFIX = 'brain/doc-';
const VAULT_PATH = process.env.VAULT_PATH;

app.use(express.json());

function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) return {};
  const parts = content.split('---');
  if (parts.length < 3) return {};
  const yamlText = parts[1];
  const metadata = {};
  const lines = yamlText.split('\n');
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx !== -1) {
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      metadata[key] = val;
    }
  }
  return metadata;
}

function parseHeaders(req) {
  const h = req.headers || {};
  const out = {};
  if (h['x-brain-owner']) out.owner = h['x-brain-owner'].toString();
  if (h['x-brain-namespace']) out.namespace = h['x-brain-namespace'].toString();
  if (h['x-brain-author']) out.author = h['x-brain-author'].toString();
  if (h['x-brain-tags']) {
    try { out.tags = JSON.parse(h['x-brain-tags'].toString()); } catch (e) { out.tags = String(h['x-brain-tags']).split(',').map(s => s.trim()).filter(Boolean); }
  }
  return out;
}

async function readDoc(docPath) {
  if (VAULT_PATH) {
    try {
      const fullPath = path.join(VAULT_PATH, docPath + '.json');
      const contents = await fsPromises.readFile(fullPath, 'utf8');
      return JSON.parse(contents);
    } catch (e) {
      try {
        const [contents] = await storage.bucket(BUCKET).file('brain/' + docPath + '.json').download();
        return JSON.parse(contents);
      } catch (innerE) {
        const [contents] = await storage.bucket(BUCKET).file(docPath + '.json').download();
        return JSON.parse(contents);
      }
    }
  } else {
    try {
      const [contents] = await storage.bucket(BUCKET).file('brain/' + docPath + '.json').download();
      return JSON.parse(contents);
    } catch (e) {
      const [contents] = await storage.bucket(BUCKET).file(docPath + '.json').download();
      return JSON.parse(contents);
    }
  }
}

async function getNextDocPath() {
  const [files] = await storage.bucket(BUCKET).getFiles({ prefix: PREFIX });
  const nums = files.map(f => parseInt(f.name.replace(PREFIX, '').replace('.json', ''))).filter(n => !isNaN(n));
  return 'doc-' + (Math.max(...nums, 0) + 1);
}

async function writeDoc(docPath, content, tags) {
  if (VAULT_PATH) {
    const fullPath = path.join(VAULT_PATH, docPath + '.json');
    await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
    await fsPromises.writeFile(fullPath, JSON.stringify({ path: docPath, content, tags, updated: new Date().toISOString() }));
  } else {
    const file = storage.bucket(BUCKET).file(docPath + '.json');
    await file.save(JSON.stringify({ path: docPath, content, tags, updated: new Date().toISOString() }), { contentType: 'application/json' });
  }
}

async function searchDocs(query, limit) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return [];

  const terms = q.split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];
  
  const [files] = await storage.bucket(BUCKET).getFiles({ prefix: PREFIX });
  const scored = [];
  
  for (const file of files) {
    try {
      const [contents] = await file.download();
      const doc = JSON.parse(contents.toString());
      const docText = (doc.content || '').toLowerCase();
      const docTags = Array.isArray(doc.tags) ? doc.tags.map(t => t.toLowerCase()) : [];
      const docPath = (doc.path || '').toLowerCase();
      
      let score = 0;
      
      // Exact phrase match: 10x
      if (docText.includes(q)) score += 10;

      // Path & Title match: 5x
      for (const term of terms) {
        if (docPath.includes(term)) score += 5;
      }

      // Tag match: 3x
      for (const term of terms) {
        if (docTags.some(t => t.includes(term))) score += 3;
      }

      // Body term occurrence: 1x
      for (const term of terms) {
        if (docText.includes(term)) score += 1;
      }
      
      if (score > 0) {
        let matchIdx = docText.indexOf(q);
        if (matchIdx === -1) matchIdx = docText.indexOf(terms[0]);
        const start = Math.max(0, matchIdx - 40);
        const end = Math.min(doc.content.length, matchIdx + q.length + 80);
        const preview = (start > 0 ? '...' : '') + doc.content.slice(start, end).replace(/\n+/g, ' ').trim() + '...';

        scored.push({ path: doc.path, tags: doc.tags, preview, score });
      }
    } catch (e) { console.error('Error in search:', e.message); }
  }
  
  const sorted = scored.sort((a, b) => b.score - a.score || parseInt(a.path.replace(/\D/g, '') || '0') - parseInt(b.path.replace(/\D/g, '') || '0'));
  return limit ? sorted.slice(0, limit) : sorted;
}

app.get('/', (_, res) => res.json({ name: 'mycelial-brain', version: '2.0' }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.post('/mcp', async (req, res) => {
  const { method, params, id } = req.body || {};
  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "mycelial_brain", version: "2.0.0" }
        }
      });
    }
    if (method === 'tools/list') {
      const tools = [
        { name: 'brain_search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }},
        { name: 'brain_read', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }},
        { name: 'brain_write', inputSchema: { type: 'object', properties: { content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, path: { type: 'string' }, owner: { type: 'string' }, namespace: { type: 'string' } }, required: ['content'] }},
        { name: 'brain_list', inputSchema: { type: 'object', properties: {}}},
        { name: 'stim_write', inputSchema: { type: 'object', properties: { namespace: { type: 'string' }, content: { type: 'string' }, author: { type: 'string' } }, required: ['namespace', 'content', 'author'] }},
        { name: 'log_outcome', inputSchema: { type: 'object', properties: { action_doc: { type: 'string' }, action_summary: { type: 'string' }, outcome: { type: 'string' }, outcome_type: { type: 'string' }, date: { type: 'string' }, context: { type: 'string' }, owner: { type: 'string' }, namespace: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['action_doc','action_summary','outcome','outcome_type','date'] }}
      ];
      return res.json({ jsonrpc: '2.0', id, result: { tools: tools }});
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params;
            if (name === 'stim_write') {
        const { namespace, content, author } = args;
        const headerMeta = parseHeaders(req);
        
        // RBAC check for namespace ownership
        if ((namespace || headerMeta.namespace || '').toLowerCase().startsWith('bodhi')) {
          const effectiveAuthor = author || headerMeta.author;
          if (!effectiveAuthor || !effectiveAuthor.toLowerCase().includes('bodhi')) {
            return res.json({
              jsonrpc: '2.0',
              id,
              error: {
                code: 403,
                message: `Forbidden: Writes to bodhi/ namespace are restricted to bodhi owner. Request author: ${effectiveAuthor || 'unknown'}`
              }
            });
          }
        }
        
        const timestamp = new Date().toISOString();
        const content_hash = crypto.createHash('sha256').update(content).digest('hex');
        const previous_hash = "GENESIS";
        const parent_doc = crypto.randomUUID();
        
        const effectiveNamespace = namespace || headerMeta.namespace || 'default';
        const effectiveAuthor = author || headerMeta.author || 'unknown';
        
        const yamlHeader = `---
owner: George Steward
namespace: ${effectiveNamespace}
author: ${effectiveAuthor}
timestamp: ${timestamp}
content_hash: ${content_hash}
previous_hash: ${previous_hash}
parent_doc: ${parent_doc}
---

`;
        const fullContent = yamlHeader + content;
        
        let savePath = "";
        if (VAULT_PATH) {
          savePath = path.join(VAULT_PATH, 'ARBORETUM', 'Active', effectiveNamespace, `${content_hash}.md`);
          await fsPromises.mkdir(path.dirname(savePath), { recursive: true });
          await fsPromises.writeFile(savePath, fullContent);
        } else {
          savePath = `ARBORETUM/Active/${effectiveNamespace}/${content_hash}.md`;
          const file = storage.bucket(BUCKET).file(savePath);
          await file.save(fullContent, { contentType: 'text/markdown' });
        }
        
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Saved STIM document to ${savePath}. Hash: ${content_hash}` }]}});
      }
if (name === 'brain_write') {
        const docPath = args.path || await getNextDocPath();
        const incomingMeta = parseFrontmatter(args.content);
        const incomingOwner = (args.owner || incomingMeta.owner || '').toString().trim();
        const incomingNamespace = (args.namespace || incomingMeta.namespace || '').toString().trim();
        
        // RBAC checks
        const protectedDocs = ['doc-141', 'doc-142', 'doc-176', 'doc-177', 'doc-181', 'doc-215', 'doc-217'];
        const isProtectedPath = protectedDocs.includes(docPath) || docPath.startsWith('bodhi/');
        
        let isExistingBodhiOwned = false;
        try {
          const existingDoc = await readDoc(docPath);
          if (existingDoc) {
            const existingMeta = parseFrontmatter(existingDoc.content);
            if (existingMeta.owner === 'bodhi' || existingMeta.namespace === 'bodhi') {
              isExistingBodhiOwned = true;
            }
          }
        } catch (e) {
          // ignore error if file not found
        }
        
        if (isProtectedPath || isExistingBodhiOwned) {
          if (incomingOwner !== 'bodhi') {
            return res.json({
              jsonrpc: '2.0',
              id,
              error: {
                code: 403,
                message: `Forbidden: Namespace ownership violation. Path '${docPath}' is owned by bodhi. Request owner: ${incomingOwner || 'unknown'}`
              }
            });
          }
        }
        
        const content = args.content || '';
        const enriched = incomingOwner && !incomingMeta.owner
          ? `---\nowner: ${incomingOwner}\nnamespace: ${incomingNamespace || 'unknown'}\nauthor: ${incomingOwner}\ntimestamp: ${new Date().toISOString()}\ncontent_hash: ${crypto.createHash('sha256').update(content).digest('hex')}\nprevious_hash: GENESIS\nparent_doc: ${crypto.randomUUID()}\n---\n\n${content}`
          : content;
        await writeDoc(docPath, enriched, args.tags || []);
        
        // Extract entities for graph layer (fire-and-forget)
        if (VAULT_PATH) {
          const entityScript = path.join(VAULT_PATH, '.hermes', 'skills', 'mcp', 'extract-entities.py');
          const docJsonPath = path.join(VAULT_PATH, docPath + '.json');
          execFile('python3', [entityScript, docJsonPath, VAULT_PATH], { timeout: 5000 }).catch(() => {});
        }
        
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Saved ' + docPath }]}});
      }
      if (name === 'brain_search') {
        const results = await searchDocs(args.query, args.limit);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results) }]}});
      }
      if (name === 'brain_read') {
        const doc = await readDoc(args.path);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: doc.content }]}});
      }
      if (name === 'log_outcome') {
        const actionDoc = args.action_doc;
        let existing = null;
        try { existing = await readDoc(actionDoc); } catch (e) { /* new doc */ }
        const now = new Date().toISOString();
        if (!existing) {
          const placeholder = `---\nowner: ${args.owner || 'unknown'}\nnamespace: ${args.namespace || 'unknown'}\nauthor: ${args.owner || 'unknown'}\ntimestamp: ${now}\ncontent_hash: ${crypto.createHash('sha256').update('').digest('hex')}\nprevious_hash: GENESIS\nparent_doc: ${crypto.randomUUID()}\n---\n\n# ${actionDoc}\nAuto-created placeholder for outcome logging.\n`;
          await writeDoc(actionDoc, placeholder, Array.isArray(args.tags) ? args.tags : []);
          existing = { content: placeholder, tags: Array.isArray(args.tags) ? args.tags : [] };
        }
        const appended = (existing.content || '') + `\n\n## Outcome - ${args.date || now}\n- Summary: ${args.action_summary}\n- Outcome: ${args.outcome}\n- Type: ${args.outcome_type}\n${args.context ? '- Context: ' + args.context : ''}\n`;
        await writeDoc(actionDoc, appended, existing.tags || []);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Appended outcome to ' + actionDoc }]}});
      }
      if (name === 'brain_list') {
        const [files1] = await storage.bucket(BUCKET).getFiles({ prefix: 'brain/doc-' });
        const [files2] = await storage.bucket(BUCKET).getFiles({ prefix: 'doc-' });
        const allFiles = [...files1, ...files2];
        const seen = new Set();
        const uniqueFiles = [];
        for (const f of allFiles) {
          const baseName = path.basename(f.name, '.json');
          if (baseName.startsWith('doc-') && !seen.has(baseName)) {
            seen.add(baseName);
            uniqueFiles.push(f);
          }
        }
        
        // Sort numerically to have stable pagination output
        uniqueFiles.sort((a, b) => {
          const na = parseInt(path.basename(a.name, '.json').replace('doc-', ''));
          const nb = parseInt(path.basename(b.name, '.json').replace('doc-', ''));
          if (isNaN(na)) return 1;
          if (isNaN(nb)) return -1;
          return na - nb;
        });

        const limit = (args && typeof args.limit === 'number') ? args.limit : null;
        const offset = (args && typeof args.offset === 'number') ? args.offset : 0;
        const paginatedFiles = limit ? uniqueFiles.slice(offset, offset + limit) : uniqueFiles.slice(offset);

        const docs = await Promise.all(paginatedFiles.map(async f => {
          try {
            const [c] = await f.download();
            return JSON.parse(c.toString());
          } catch (e) {
            console.error('Error downloading/parsing', f.name, e.message);
            return null;
          }
        }));

        const validDocs = docs.filter(d => d !== null);
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify(validDocs.map(d => ({ path: d.path, tags: d.tags })))
            }]
          }
        });
      }
    }
    res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' }});
  } catch (e) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message }});
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log('Mycelial Brain v2.0 ready'));
