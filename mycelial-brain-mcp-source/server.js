const { Storage } = require('@google-cloud/storage');
const express = require('express');
const crypto = require('crypto');

const app = express();
const storage = new Storage();
const BUCKET = process.env.GCS_BUCKET_NAME || 'mycelial-brain-storage';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';
const PROTOCOL_VERSION = '2024-11-05';
const COUNTER_FILE = '_sequence.counter';
const COUNTER_INIT = 405;

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Brain-Owner, X-Brain-Namespace, X-Brain-Author, X-Guardian-Source, Accept');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

// In-memory doc cache
let docCache = null; // Map<path, DocEntry>
let cacheBuiltAt = 0;
let rebuildPromise = null;
let lastRebuildMs = 0;
const pendingWrites = new Map();

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const FETCH_CONCURRENCY = 50;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'how', 'does', 'do', 'what',
  'and', 'to', 'of', 'in', 'for', 'with', 'on', 'at', 'by', 'this', 'that',
  'it', 'he', 'she', 'they'
]);

function extractTitleAndTimestamp(content) {
  let title = '';
  let timestamp = '';
  if (!content) return { title, timestamp };

  if (content.startsWith('---')) {
    const parts = content.split('---');
    if (parts.length >= 3) {
      const yaml = parts[1];
      const lines = yaml.split('\n');
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx !== -1) {
          const key = line.slice(0, idx).trim().toLowerCase();
          const val = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
          if (key === 'title') title = val;
          if (key === 'timestamp' || key === 'date') timestamp = val;
        }
      }
    }
  }

  if (!title) {
    const m = content.match(/^#\s+(.+)$/m);
    if (m) title = m[1].trim();
  }

  return { title, timestamp };
}

function makeEntry(doc, fileName) {
  const docPath = doc.path || (fileName ? fileName.replace(/\.json$/, '') : '');
  const content = doc.content || '';
  const tags = Array.isArray(doc.tags) ? doc.tags : [];
  const meta = extractTitleAndTimestamp(content);

  const title = doc.title || meta.title || '';
  const timestamp = doc.timestamp || doc.updated || meta.timestamp || '';
  const updated = doc.updated || doc.timestamp || meta.timestamp || '';

  let timestampMs = 0;
  if (timestamp) {
    const parsed = new Date(timestamp).getTime();
    if (!isNaN(parsed)) timestampMs = parsed;
  }

  return {
    path: docPath,
    content: content,
    tags: tags,
    title: title,
    timestamp: timestamp,
    timestampMs: timestampMs,
    updated: updated,
    textLower: content.toLowerCase(),
    tagsLower: tags.join(' ').toLowerCase(),
    pathLower: docPath.toLowerCase(),
    titleLower: title.toLowerCase()
  };
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function rebuildCache() {
  const started = Date.now();
  const [files] = await storage.bucket(BUCKET).getFiles();
  const jsonFiles = files.filter(f => f.name.endsWith('.json') && !f.name.startsWith('_'));

  const entries = await mapLimit(jsonFiles, FETCH_CONCURRENCY, async file => {
    try {
      const [contents] = await file.download();
      const doc = JSON.parse(contents.toString());
      if (!doc) return null;
      return makeEntry(doc, file.name);
    } catch (e) {
      console.error('Skip file:', file.name, e.message);
      return null;
    }
  });

  const next = new Map();
  for (const e of entries) {
    if (e && e.path) next.set(e.path, e);
  }

  // Preserve concurrent writes during cache rebuild
  for (const [p, e] of pendingWrites) {
    next.set(p, e);
  }
  pendingWrites.clear();

  docCache = next;
  cacheBuiltAt = Date.now();
  lastRebuildMs = cacheBuiltAt - started;
  console.log(`Cache rebuilt: ${next.size} docs in ${lastRebuildMs}ms (${jsonFiles.length} objects scanned)`);
  return docCache;
}

async function getDocIndex() {
  const fresh = docCache && (Date.now() - cacheBuiltAt) < CACHE_TTL_MS;
  if (fresh) return docCache;

  if (docCache) {
    if (!rebuildPromise) {
      rebuildPromise = rebuildCache()
        .catch(e => {
          console.error('Background rebuild failed:', e.message);
          return docCache;
        })
        .finally(() => { rebuildPromise = null; });
    }
    return docCache;
  }

  if (!rebuildPromise) {
    rebuildPromise = rebuildCache().finally(() => { rebuildPromise = null; });
  }
  return rebuildPromise;
}

function upsertCache(path, content, tags, updated) {
  const now = updated || new Date().toISOString();
  const entry = makeEntry({ path, content, tags: tags || [], updated: now });
  if (docCache) {
    docCache.set(path, entry);
  }
  pendingWrites.set(path, entry);
}

// Auth middleware
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token === AUTH_TOKEN) return next();
  return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
}

// Atomic sequential ID allocator
async function brain_allocate() {
  const counterFile = storage.bucket(BUCKET).file(COUNTER_FILE);
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const [contents, meta] = await counterFile.download();
      const rawCurrent = parseInt(contents.toString()) || 0;
      const current = Math.max(rawCurrent, COUNTER_INIT);
      const next = current + 1;
      const opts = { contentType: 'text/plain' };
      const gen = meta && meta.metadata ? meta.metadata.generation : undefined;
      if (gen) opts.ifGenerationMatch = gen;
      await counterFile.save(next.toString(), opts);
      return `doc-${next}`;
    } catch (e) {
      if (e.code === 404) {
        await counterFile.save(COUNTER_INIT.toString(), { contentType: 'text/plain' });
        return `doc-${COUNTER_INIT + 1}`;
      }
      if (e.code === 412 && attempt < MAX_RETRIES - 1) continue;
      throw e;
    }
  }

  const docs = await getDocIndex();
  const nums = Array.from(docs.keys())
    .map(p => {
      const m = /^doc-(\d+)$/.exec(p);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter(n => !isNaN(n));
  const maxNum = Math.max(COUNTER_INIT, ...nums, 0);
  return `doc-${maxNum + 1}`;
}

async function writeDoc(docPath, content, tags) {
  const file = storage.bucket(BUCKET).file(docPath + '.json');
  const now = new Date().toISOString();
  await file.save(JSON.stringify({ path: docPath, content, tags, updated: now }), { contentType: 'application/json' });
  upsertCache(docPath, content, tags, now);
}

async function readDoc(docPath) {
  try {
    const [contents] = await storage.bucket(BUCKET).file(docPath + '.json').download();
    return JSON.parse(contents);
  } catch (e) {
    try {
      const [contents] = await storage.bucket(BUCKET).file('brain/' + docPath + '.json').download();
      return JSON.parse(contents);
    } catch (e2) {
      throw new Error(`Document not found: ${docPath}`);
    }
  }
}

// Tokenized Case-Insensitive Search with Recency Weighting
async function searchDocs(query, limit) {
  const q = (query || '').trim();
  const docsMap = await getDocIndex();
  const docs = Array.from(docsMap.values());
  const now = Date.now();

  // Test 4: Empty query or "*" returns most recent docs
  if (!q || q === '*') {
    const sorted = [...docs].sort((a, b) => (b.timestampMs - a.timestampMs) || b.path.localeCompare(a.path));
    const effectiveLimit = limit || 20;
    return sorted.slice(0, effectiveLimit).map(d => ({
      path: d.path,
      tags: d.tags,
      title: d.title,
      preview: dContentPreview(docPreviewContent(d)),
      score: 1.0,
      updated: d.updated || d.timestamp
    }));
  }

  const terms = q.toLowerCase().split(/\s+/).filter(t => !STOP_WORDS.has(t) && t.length > 1);
  if (terms.length === 0) {
    const sorted = [...docs].sort((a, b) => (b.timestampMs - a.timestampMs) || b.path.localeCompare(a.path));
    return sorted.slice(0, limit || 20).map(d => ({
      path: d.path,
      tags: d.tags,
      title: d.title,
      preview: dContentPreview(docPreviewContent(d)),
      score: 1.0,
      updated: d.updated || d.timestamp
    }));
  }

  const scored = [];
  for (const doc of docs) {
    let score = 0;
    for (const term of terms) {
      if (doc.textLower.includes(term)) score += 1;
      if (doc.tagsLower.includes(term)) score += 2;
      if (doc.pathLower.includes(term) || doc.titleLower.includes(term)) score += 1;
    }
    if (score > 0) {
      if (doc.timestampMs > 0) {
        const ageDays = (now - doc.timestampMs) / 86400000;
        if (ageDays >= 0) {
          if (ageDays < 30) score += 0.5;
          if (ageDays < 7) score += 0.5;
        }
      }
      scored.push({
        path: doc.path,
        tags: doc.tags,
        title: doc.title,
        preview: dContentPreview(doc.content),
        score: Math.round(score * 10) / 10
      });
    }
  }

  const seqNum = p => {
    const m = /^doc-(\d+)$/.exec(p);
    return m ? +m[1] : 0;
  };

  scored.sort((a, b) => b.score - a.score || (b.timestampMs - a.timestampMs) || (seqNum(b.path) - seqNum(a.path)));
  return limit ? scored.slice(0, limit) : scored;
}

function docPreviewContent(d) {
  return d.content || '';
}

function dContentPreview(content) {
  if (!content) return '';
  const clean = content.replace(/\n+/g, ' ').trim();
  return clean.slice(0, 150) + (clean.length > 150 ? '...' : '');
}

// Additive Paginated brain_list
async function listDocs(args) {
  const docsMap = await getDocIndex();
  let all = Array.from(docsMap.values());

  if (args && args.prefix) {
    const prefix = args.prefix.toLowerCase();
    all = all.filter(d => d.pathLower.startsWith(prefix));
  }

  const seqNum = p => {
    const m = /^doc-(\d+)$/.exec(p);
    return m ? +m[1] : Number.MAX_SAFE_INTEGER;
  };

  all.sort((a, b) => {
    const na = seqNum(a.path);
    const nb = seqNum(b.path);
    if (na !== nb) return na - nb;
    return a.path.localeCompare(b.path);
  });

  const total_count = all.length;
  const offset = Math.max(0, (args && typeof args.offset === 'number') ? args.offset : 0);
  const requestedLimit = (args && typeof args.limit === 'number') ? args.limit : 50;
  const limit = Math.min(Math.max(1, requestedLimit), 500);

  const slice = all.slice(offset, offset + limit);
  const has_more = (offset + slice.length) < total_count;

  return {
    docs: slice.map(d => ({ path: d.path, tags: d.tags })),
    total_count,
    has_more,
    offset,
    limit
  };
}

// Routes
app.get('/', (_, res) => res.json({ name: 'mycelial-brain', version: '3.2.0', protocol: PROTOCOL_VERSION, status: 'ready' }));

app.get('/mcp', (_, res) => res.json({
  name: 'mycelial-brain',
  version: '3.2.0',
  protocol: PROTOCOL_VERSION,
  status: 'ready',
  transport: 'http',
  endpoint: '/mcp'
}));

app.get('/health', (_, res) => res.json({
  status: 'ok',
  cacheSize: docCache ? docCache.size : 0,
  cacheAgeMs: docCache ? Date.now() - cacheBuiltAt : null,
  lastRebuildMs,
  rebuildInFlight: !!rebuildPromise
}));

app.post('/mcp', authMiddleware, async (req, res) => {
  const { method, params, id } = req.body || {};
  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: 'mycelial_brain', version: '3.2.0' },
          capabilities: {
            tools: { listChanged: false }
          }
        }
      });
    }

    if (method === 'tools/list') {
      const tools = [
        {
          name: 'brain_search',
          description: 'Search the mycelial brain by keywords with tokenized scoring and recency weighting',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search keywords or phrase' },
              limit: { type: 'number', description: 'Max number of results to return' }
            },
            required: ['query']
          }
        },
        {
          name: 'brain_read',
          description: 'Read a specific brain document by path',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path of the document to read (e.g. doc-397)' }
            },
            required: ['path']
          }
        },
        {
          name: 'brain_write',
          description: 'Write a document to the brain with optional tags and namespace',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              path: { type: 'string' },
              owner: { type: 'string' },
              namespace: { type: 'string' }
            },
            required: ['content']
          }
        },
        {
          name: 'brain_list',
          description: 'List brain documents with pagination support',
          inputSchema: {
            type: 'object',
            properties: {
              limit: { type: 'number', description: 'Number of documents to return (default 50, max 500)' },
              offset: { type: 'number', description: 'Pagination offset (default 0)' },
              prefix: { type: 'string', description: 'Optional prefix filter' }
            }
          }
        },
        {
          name: 'stim_write',
          description: 'Write a STIM nugget to the brain',
          inputSchema: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              namespace: { type: 'string' },
              author: { type: 'string' }
            },
            required: ['content', 'namespace', 'author']
          }
        },
        {
          name: 'log_outcome',
          description: 'Log a verifiable action and outcome to the reputation ledger',
          inputSchema: {
            type: 'object',
            properties: {
              action_doc: { type: 'string' },
              action_summary: { type: 'string' },
              outcome: { type: 'string' },
              outcome_type: { type: 'string' },
              date: { type: 'string' },
              context: { type: 'string' },
              owner: { type: 'string' },
              namespace: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['action_doc', 'action_summary', 'outcome', 'outcome_type', 'date']
          }
        },
        {
          name: 'brain_vault_write',
          description: 'Write a guardian-synced vault document',
          inputSchema: {
            type: 'object',
            properties: {
              vault: { type: 'string' },
              path: { type: 'string' },
              content: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['vault', 'path', 'content']
          }
        }
      ];
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;

      if (name === 'brain_write') {
        const allowedNs = ['hermes/', 'bodhi/', 'm-agent/', 'kai/', 'sylvan/', 'arbor/', 'sequoia/', 'quercus/'];
        if (args.path) {
          if (args.path.startsWith('vault/')) {
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: reserved namespace. Use brain_vault_write for vault paths.' }] } });
          }
          if (args.path.startsWith('doc-') && args.path.includes('/')) {
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: sequential docs must be flat doc-N, no subpaths.' }] } });
          }
          const hasNs = allowedNs.some(ns => args.path.startsWith(ns));
          if (!hasNs && args.path.includes('/')) {
            return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: unknown namespace prefix. Allowed: ' + allowedNs.join(', ') + ', or flat doc-N without slash.' }] } });
          }
        }

        const path = args.path || await brain_allocate();
        await writeDoc(path, args.content, args.tags || []);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Saved ' + path }] } });
      }

      if (name === 'brain_search') {
        const results = await searchDocs(args.query, args.limit);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(results) }] } });
      }

      if (name === 'brain_read') {
        const doc = await readDoc(args.path);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: doc.content }] } });
      }

      if (name === 'brain_list') {
        const listResult = await listDocs(args);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(listResult) }] } });
      }

      if (name === 'stim_write') {
        const path = await brain_allocate();
        const tags = ['stim', args.namespace || 'general', args.author || 'unknown'];
        await writeDoc(path, args.content, tags);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'STIM saved ' + path }] } });
      }

      if (name === 'log_outcome') {
        const actionDoc = args.action_doc;
        let existing = null;
        try { existing = await readDoc(actionDoc); } catch (e) { /* create new placeholder */ }
        const now = new Date().toISOString();
        if (!existing) {
          const placeholder = `---\nowner: ${args.owner || 'unknown'}\nnamespace: ${args.namespace || 'unknown'}\nauthor: ${args.owner || 'unknown'}\ntimestamp: ${now}\ncontent_hash: ${crypto.createHash('sha256').update('').digest('hex')}\nprevious_hash: GENESIS\nparent_doc: ${crypto.randomUUID()}\n---\n\n# ${actionDoc}\nAuto-created placeholder for outcome logging.\n`;
          await writeDoc(actionDoc, placeholder, Array.isArray(args.tags) ? args.tags : []);
          existing = { content: placeholder, tags: Array.isArray(args.tags) ? args.tags : [] };
        }
        const appended = (existing.content || '') + `\n\n## Outcome - ${args.date || now}\n- Summary: ${args.action_summary}\n- Outcome: ${args.outcome}\n- Type: ${args.outcome_type}\n${args.context ? '- Context: ' + args.context : ''}\n`;
        await writeDoc(actionDoc, appended, existing.tags || []);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Appended outcome to ' + actionDoc }] } });
      }

      if (name === 'brain_vault_write') {
        const vault = args.vault;
        const path = args.path;
        const allowedVaults = ['FOREST', 'ARBORETUM', 'UNDERSTORY', 'SEED_BANK', 'COMPOST', 'LIBRARY'];
        if (!allowedVaults.includes(vault)) {
          return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: invalid vault name. Allowed: ' + allowedVaults.join(', ') }] } });
        }
        const guardianHeader = req.headers['x-guardian-source'];
        if (!guardianHeader) {
          return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ERROR: X-Guardian-Source header required for vault writes' }] } });
        }
        const docPath = `vault/${vault}/${path}`.replace(/\.md$/, '');
        await writeDoc(docPath, args.content, args.tags || [vault.toLowerCase(), 'guardian-sync']);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Saved ' + docPath }] } });
      }
    }

    res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (e) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mycelial Brain v3.2.0 ready (MCP ${PROTOCOL_VERSION})`);
  getDocIndex().catch(e => console.error('Warmup failed:', e.message));
});
