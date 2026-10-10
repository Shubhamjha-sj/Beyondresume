#!/usr/bin/env node
// Demo server: static files for the repo plus the credential API. Zero dependencies.
//   npm start                (PORT=5173, BIND_HOST=127.0.0.1 by default)
// Routes and credential format: docs/INTEGRATION.md.

import http from 'node:http';
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(ROOT, '.env.local');
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT, 'data'); // override for tests
const STORE_PATH = join(DATA_DIR, 'credentials.json');
const LIB_DIR = process.env.SAMPLES_LIB_DIR ? resolve(process.env.SAMPLES_LIB_DIR) : join(ROOT, 'prototype/lib'); // override for tests
const SAMPLES_PATH = join(LIB_DIR, 'samples.js');
const ASSESSMENT_PATH = join(LIB_DIR, 'assessment.js');

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.BIND_HOST || '127.0.0.1'; // not HOST: some shells export that as the machine name
const MAX_BODY = 256 * 1024;

// ---------- .env.local ----------

const ORIGINAL_ENV = new Set(Object.keys(process.env));

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.at(-1) === q) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

// Real environment variables win over the file. Re-run to pick up keys added later (e.g. ELEVENLABS_AGENT_ID).
function loadEnvFile() {
  if (!existsSync(ENV_PATH)) return;
  const env = parseEnv(readFileSync(ENV_PATH, 'utf8'));
  for (const [k, v] of Object.entries(env)) if (!ORIGINAL_ENV.has(k)) process.env[k] = v;
}

// ---------- Issuer key ----------

const DEMO_KEY_ID = 'industryproof-demo-2026';
// Public half of the prototype's original demo key, so its embedded sample credentials still verify.
const DEMO_PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: 'siDxqq3CkkuX7jCoP407VMvLW-ES5Fx8e3CPiH2nGm0', y: 'tu6t-AVRZdAUJ4RydNzRWnJSNYP5YImA8F0LX2qYGe8' };

const issuer = { kid: '', privateKey: null, publicJwk: null, fingerprint: '' };

function fingerprintOf(jwk) {
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return createHash('sha256').update(point).digest('hex').slice(0, 16);
}

async function loadIssuerKey() {
  if (!process.env.ISSUER_PRIVATE_JWK) {
    const { ensureIssuerKey } = await import('./scripts/gen-issuer-key.mjs');
    const { created } = ensureIssuerKey({ envPath: ENV_PATH });
    if (created) console.warn('[keys] No ISSUER_PRIVATE_JWK found; created one in .env.local');
    loadEnvFile();
  }
  const privateKey = createPrivateKey({ key: JSON.parse(process.env.ISSUER_PRIVATE_JWK), format: 'jwk' });
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('ISSUER_PRIVATE_JWK must be an EC P-256 key');
  }
  const pub = createPublicKey(privateKey).export({ format: 'jwk' });
  issuer.kid = process.env.ISSUER_KEY_ID || 'industryproof-live-2026';
  issuer.privateKey = privateKey;
  issuer.publicJwk = { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y };
  issuer.fingerprint = fingerprintOf(issuer.publicJwk);
}

function publishedKeys() {
  const keys = { [issuer.kid]: issuer.publicJwk };
  if (!keys[DEMO_KEY_ID]) keys[DEMO_KEY_ID] = DEMO_PUBLIC_JWK;
  return keys;
}

// ECDSA P-256 / SHA-256 over the UTF-8 bytes of JSON.stringify(record); raw r||s, base64url.
function signRecord(record) {
  const data = Buffer.from(JSON.stringify(record), 'utf8');
  return sign('sha256', data, { key: issuer.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

function verifyCredential(c) {
  const jwk = publishedKeys()[c.key];
  if (!jwk) return false;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(JSON.stringify(c.record), 'utf8');
    return verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(c.signature, 'base64url'));
  } catch {
    return false;
  }
}

// ---------- Record validation ----------

const RECORD_FIELDS = ['issuer', 'assessment', 'scenario_id', 'company', 'rubric_version', 'rubric_approved_by',
  'candidate', 'role', 'assessed_at', 'status', 'score', 'max_score', 'auto_fail', 'items', 'signals', 'evidence_digest'];
const STRING_FIELDS = ['issuer', 'assessment', 'scenario_id', 'company', 'rubric_version', 'rubric_approved_by',
  'candidate', 'role', 'assessed_at', 'status'];
const SIGNAL_FIELDS = ['tone_drift', 'speech_rate_delta_pct', 'hesitation_score', 'deescalation_latency_s', 'composure'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Returns an error message, or null when the record is acceptable.
function validateRecord(r) {
  if (!isObj(r)) return 'record must be an object';
  const missing = RECORD_FIELDS.filter(f => !(f in r));
  if (missing.length) return `record is missing: ${missing.join(', ')}`;
  for (const f of STRING_FIELDS) {
    if (typeof r[f] !== 'string' || !r[f].trim()) return `record.${f} must be a non-empty string`;
  }
  if (Number.isNaN(Date.parse(r.assessed_at))) return 'record.assessed_at must be an ISO date';
  for (const f of ['score', 'max_score']) {
    if (typeof r[f] !== 'number' || !Number.isFinite(r[f])) return `record.${f} must be a number`;
  }
  if (typeof r.auto_fail !== 'boolean') return 'record.auto_fail must be true or false';
  if (!isObj(r.items)) return 'record.items must be an object';
  for (const [k, v] of Object.entries(r.items)) {
    if (typeof v !== 'boolean') return `record.items.${k} must be true or false`;
  }
  if (!isObj(r.signals)) return 'record.signals must be an object';
  for (const f of SIGNAL_FIELDS) {
    const v = r.signals[f];
    if (v !== undefined && v !== null && typeof v !== 'number' && typeof v !== 'string') {
      return `record.signals.${f} must be a number, string or null`;
    }
  }
  if (typeof r.evidence_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(r.evidence_digest)) {
    return 'record.evidence_digest must be "sha256:" followed by 64 lowercase hex characters';
  }
  return null;
}

// ---------- Credential store (data/credentials.json) ----------

// id -> { id, record, signature, key, issued_at, sample }
const store = new Map();
let writeChain = Promise.resolve();

async function loadStore() {
  let text;
  try {
    text = await readFile(STORE_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  try {
    const data = JSON.parse(text);
    for (const c of Object.values(data.credentials || {})) {
      if (c && typeof c.id === 'string' && isObj(c.record) && typeof c.signature === 'string') store.set(c.id, c);
    }
  } catch {
    const backup = `${STORE_PATH}.corrupt-${Date.now()}`;
    await rename(STORE_PATH, backup);
    console.warn(`[store] credentials.json was unreadable; moved it to ${backup} and started empty`);
  }
}

// Atomic write (temp file + rename), serialised so concurrent POSTs don't interleave.
function saveStore() {
  writeChain = writeChain.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = `${STORE_PATH}.${process.pid}.tmp`;
    const body = JSON.stringify({ version: 1, credentials: Object.fromEntries(store) }, null, 2);
    await writeFile(tmp, body + '\n', { mode: 0o600 });
    await rename(tmp, STORE_PATH);
  }).catch(err => console.error(`[store] write failed: ${err.message}`));
  return writeChain;
}

const publicView = c => ({ id: c.id, record: c.record, signature: c.signature, key: c.key });

function issue(record, { id, sample = null } = {}) {
  const c = {
    id: id || `cred_${randomBytes(6).toString('hex')}`,
    record,
    signature: signRecord(record),
    key: issuer.kid,
    issued_at: new Date().toISOString(),
    sample,
  };
  store.set(c.id, c);
  return c;
}

// Anything that no longer verifies with a published key (e.g. after a key change) is re-signed with the live key.
function resignStale() {
  let n = 0;
  for (const c of store.values()) {
    if (!verifyCredential(c)) {
      c.signature = signRecord(c.record);
      c.key = issuer.kid;
      n++;
    }
  }
  return n;
}

// ---------- Sample candidates ----------

// Stable id per candidate + scenario, so sample links survive restarts.
const sampleId = (name, scenarioId) => 'cred_' + createHash('sha256').update(`${name}|${scenarioId}`).digest('hex').slice(0, 12);

const samples = { ok: false, lastTry: 0, stamp: '', ids: {} };

async function fileStamp() {
  const [a, b] = await Promise.all([SAMPLES_PATH, ASSESSMENT_PATH].map(p => stat(p).then(s => s.mtimeMs, () => 0)));
  return `${a}-${b}`;
}

function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);
}

// Re-signs SAMPLE_CANDIDATES with the live key. Never throws: on failure the server runs without samples.
async function seedSamples() {
  samples.lastTry = Date.now();
  const stamp = await fileStamp();
  samples.stamp = stamp;
  try {
    const bust = `?v=${encodeURIComponent(stamp)}`;
    const [samplesMod, assessmentMod] = await withTimeout(Promise.all([
      import(pathToFileURL(SAMPLES_PATH).href + bust),
      import(pathToFileURL(ASSESSMENT_PATH).href + bust),
    ]), 5000, 'loading sample modules');
    const all = samplesMod.SAMPLE_CANDIDATES;
    const toRecord = assessmentMod.toCredentialRecord;
    if (!isObj(all)) throw new Error('prototype/lib/samples.js does not export SAMPLE_CANDIDATES');
    if (typeof toRecord !== 'function') throw new Error('prototype/lib/assessment.js does not export toCredentialRecord');

    // One bad sample doesn't block the others.
    const ids = {};
    for (const [key, result] of Object.entries(all)) {
      try {
        const name = result?.candidate?.name;
        const scenarioId = result?.scenario?.id;
        if (!name || !scenarioId) throw new Error('no candidate.name or scenario.id');
        const record = await withTimeout(Promise.resolve(toRecord(result, { sample: true })), 5000, 'toCredentialRecord');
        const bad = validateRecord(record);
        if (bad) throw new Error(bad);
        ids[key] = issue(record, { id: sampleId(name, scenarioId), sample: key }).id;
      } catch (err) {
        console.warn(`[samples] "${key}" skipped: ${err.message}`);
      }
    }
    // Drop sample entries that left SAMPLE_CANDIDATES or whose id changed (renamed candidate).
    for (const c of [...store.values()]) {
      if (c.sample && (!(c.sample in all) || (ids[c.sample] && ids[c.sample] !== c.id))) store.delete(c.id);
    }
    await saveStore();
    samples.ok = true; // modules loaded; a file change triggers the next re-seed
    samples.ids = ids;
    console.log(`[samples] signed ${Object.entries(ids).map(([k, id]) => `${k}=${id}`).join(', ') || 'none'}`);
  } catch (err) {
    samples.ok = false;
    console.warn(`[samples] skipped: ${err.message}`);
  }
}

// Called before credential reads: retries after a failure, or re-seeds when the sample files change.
let seeding = null;
async function refreshSamples() {
  if (seeding) return seeding;
  if (Date.now() - samples.lastTry < 5000) return;
  samples.lastTry = Date.now();
  seeding = (async () => {
    if (!samples.ok || (await fileStamp()) !== samples.stamp) await seedSamples();
  })().finally(() => { seeding = null; });
  return seeding;
}

// ---------- HTTP helpers ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.spz': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
};
const NO_STORE = new Set(['.html', '.js', '.mjs', '.css', '.json']);
// Never served: anything under these top-level folders (dot-folders and dotfiles are always refused).
const BLOCKED_TOP = new Set(['data', 'node_modules']);

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : text);
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : text);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BODY) return reject(new HttpError(413, 'Body is larger than 256 KB'));
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        done = true;
        reject(new HttpError(413, 'Body is larger than 256 KB'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolveBody(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', err => { if (!done) { done = true; reject(err); } });
  });
}

// ---------- API ----------

async function handleApi(req, res, pathname) {
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  if (pathname === '/api/config') {
    if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
    loadEnvFile();
    return sendJson(res, 200, {
      agentId: process.env.ELEVENLABS_AGENT_ID || null,
      issuerKeyId: issuer.kid,
      issuerFingerprint: issuer.fingerprint,
    });
  }

  if (pathname === '/api/issuer-keys') {
    if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
    const keys = publishedKeys();
    const fingerprints = Object.fromEntries(Object.entries(keys).map(([kid, jwk]) => [kid, fingerprintOf(jwk)]));
    return sendJson(res, 200, { keys, fingerprints });
  }

  if (pathname === '/api/credentials') {
    if (method === 'GET') {
      await refreshSamples();
      const list = [...store.values()]
        .map(c => ({
          id: c.id,
          candidate: c.record.candidate,
          assessed_at: c.record.assessed_at,
          status: c.record.status,
          score: c.record.score,
          max_score: c.record.max_score,
          scenario_id: c.record.scenario_id,
          sample: c.sample || null,
        }))
        .sort((a, b) => String(b.assessed_at).localeCompare(String(a.assessed_at)));
      return sendJson(res, 200, list);
    }
    if (method === 'POST') {
      const text = await readBody(req);
      let body;
      try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Body must be JSON: { "record": { ... } }'); }
      if (!isObj(body) || !('record' in body)) throw new HttpError(400, 'Body must be { "record": { ... } }');
      const bad = validateRecord(body.record);
      if (bad) throw new HttpError(400, bad);
      const c = issue(body.record);
      await saveStore();
      console.log(`[credentials] issued ${c.id} for ${JSON.stringify(c.record.candidate)} (${c.record.status} ${c.record.score}/${c.record.max_score})`);
      return sendJson(res, 201, publicView(c), { Location: `/api/credentials/${c.id}` });
    }
    return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
  }

  const m = pathname.match(/^\/api\/credentials\/([^/]+)$/);
  if (m) {
    if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
    await refreshSamples();
    const c = /^cred_[0-9a-f]{12}$/.test(m[1]) ? store.get(m[1]) : null;
    if (!c) return sendJson(res, 404, { error: 'Unknown credential' });
    return sendJson(res, 200, publicView(c));
  }

  return sendJson(res, 404, { error: 'Unknown API route' });
}

// ---------- Static files ----------

let realRoot = ROOT;

// Maps a URL path to a file inside ROOT, or null if it must not be served.
function safePath(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  if (p.includes('\0') || p.includes('\\')) return null;
  const segs = p.split('/').filter(Boolean);
  if (segs.some(s => s.startsWith('.'))) return null; // .., .env.local, .git, ...
  if (segs.length && BLOCKED_TOP.has(segs[0].toLowerCase())) return null; // macOS paths are case-insensitive
  const abs = resolve(ROOT, ...segs);
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;
  return abs;
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

  let file = safePath(url.pathname);
  if (!file) return sendText(res, 404, 'Not found');

  let st;
  try {
    // Follow symlinks only if they stay inside the repo.
    const real = await realpath(file);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return sendText(res, 404, 'Not found');
    st = await stat(real);
    file = real;
  } catch {
    return sendText(res, 404, 'Not found');
  }

  if (st.isDirectory()) {
    if (!url.pathname.endsWith('/')) {
      return sendText(res, 301, 'Moved', { Location: url.pathname + '/' + url.search });
    }
    file = join(file, 'index.html');
    try { st = await stat(file); } catch { return sendText(res, 404, 'Not found'); }
    if (!st.isFile()) return sendText(res, 404, 'Not found');
  } else if (!st.isFile()) {
    return sendText(res, 404, 'Not found');
  }

  const ext = extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'X-Content-Type-Options': 'nosniff',
  };
  if (NO_STORE.has(ext)) {
    headers['Cache-Control'] = 'no-store';
  } else {
    // Large assets (fab.spz is ~35 MB): revalidate cheaply with an ETag instead of re-downloading.
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    headers['Cache-Control'] = 'no-cache';
    headers.ETag = etag;
    headers['Last-Modified'] = st.mtime.toUTCString();
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ---------- Server ----------

async function handle(req, res) {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
  if (isApi) res.on('finish', () => console.log(`[api] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
  try {
    if (isApi) await handleApi(req, res, url.pathname);
    else await serveStatic(req, res, url);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(`[server] ${req.method} ${url.pathname}: ${err.stack || err}`);
    if (!res.headersSent) {
      if (isApi) sendJson(res, status, { error: status === 500 ? 'Server error' : err.message }, status === 413 ? { Connection: 'close' } : {});
      else sendText(res, status, status === 500 ? 'Server error' : err.message);
    } else {
      res.destroy();
    }
  }
}

async function main() {
  loadEnvFile();
  await loadIssuerKey();
  realRoot = await realpath(ROOT);
  await loadStore();
  await seedSamples();
  const resigned = resignStale();
  if (resigned) {
    await saveStore();
    console.log(`[store] re-signed ${resigned} credential(s) with ${issuer.kid}`);
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Stop the other server or run with PORT=<n>.`);
    else console.error(`Server error: ${err.message}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const base = `http://${HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
    console.log(`IndustryProof demo server on ${base}`);
    console.log(`  shell:   ${base}/prototype/`);
    console.log(`  twin:    ${base}/`);
    console.log(`  issuer:  ${issuer.kid} (fingerprint ${issuer.fingerprint})`);
    console.log(`  agent:   ELEVENLABS_AGENT_ID ${process.env.ELEVENLABS_AGENT_ID ? 'set' : 'not set (run npm run agent)'}`);
    console.log(`  store:   ${store.size} credential(s) in data/credentials.json`);
  });

  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(err => {
  console.error(`Could not start the server: ${err.message}`);
  process.exit(1);
});
