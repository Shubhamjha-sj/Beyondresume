// Credential client for the IndustryProof shell (format: docs/INTEGRATION.md).
// Issues credentials (POST /api/credentials), looks them up by id, lists them, and checks
// signatures in the browser against the issuer's published P-256 keys (/api/issuer-keys).
// The page never holds a private key: signing happens on the server.

const API = '/api';
const ID_RE = /^cred_[0-9a-f]{12}$/;

// The prototype's original demo key, so records signed before the live server still verify
// when the server can't be reached. The server publishes it too.
const LEGACY_KEYS = {
  'industryproof-demo-2026': { kty: 'EC', crv: 'P-256', x: 'siDxqq3CkkuX7jCoP407VMvLW-ES5Fx8e3CPiH2nGm0', y: 'tu6t-AVRZdAUJ4RydNzRWnJSNYP5YImA8F0LX2qYGe8' },
};
const LEGACY_FP = { 'industryproof-demo-2026': '9a9b6e3d094b1e54' };

const enc = new TextEncoder();
let keysP = null;
let configP = null;
const imported = new Map(); // kid -> Promise<CryptoKey>

export const isCredentialId = (s) => ID_RE.test(String(s || '').trim());

async function getJson(url, { timeoutMs = 8000, ...init } = {}) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
  try {
    const res = await fetch(url, { cache: 'no-store', ...init, signal: ctl?.signal });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// { agentId, issuerKeyId, issuerFingerprint } or null if the server can't be reached.
export function fetchConfig({ refresh = false } = {}) {
  if (refresh || !configP) {
    configP = getJson(`${API}/config`, { timeoutMs: 5000 })
      .then((r) => (r.ok && r.body ? r.body : null))
      .catch(() => null)
      .then((c) => {
        if (!c) configP = null; // retry next time
        return c;
      });
  }
  return configP;
}

// Published keys, merged with the legacy demo key. { keys, fingerprints, offline }
export function issuerKeys({ refresh = false } = {}) {
  if (refresh || !keysP) {
    keysP = getJson(`${API}/issuer-keys`)
      .then((r) => {
        if (!r.ok || !r.body || typeof r.body.keys !== 'object') throw new Error('no keys');
        return {
          keys: { ...LEGACY_KEYS, ...r.body.keys },
          fingerprints: { ...LEGACY_FP, ...(r.body.fingerprints || {}) },
          offline: false,
        };
      })
      .catch(() => {
        keysP = null; // try the server again next time
        return { keys: { ...LEGACY_KEYS }, fingerprints: { ...LEGACY_FP }, offline: true };
      });
  }
  return keysP;
}

// Fingerprint of the live issuer key (first 16 hex of SHA-256 over 04||x||y), or null.
export async function liveFingerprint() {
  const cfg = await fetchConfig();
  if (cfg?.issuerFingerprint) return cfg.issuerFingerprint;
  const { fingerprints } = await issuerKeys();
  return (cfg && fingerprints[cfg.issuerKeyId]) || null;
}

// [{ id, candidate, assessed_at, status, score?, max_score?, scenario_id?, sample? }], or [] offline.
export async function listCredentials() {
  try {
    const r = await getJson(`${API}/credentials`);
    return r.ok && Array.isArray(r.body) ? r.body : [];
  } catch {
    return [];
  }
}

// { id, record, signature, key } for a stored credential, or null if the id is unknown.
// Throws when the server can't be reached.
export async function lookupCredential(id) {
  const clean = String(id || '').trim();
  if (!isCredentialId(clean)) return null;
  const r = await getJson(`${API}/credentials/${clean}`);
  if (r.status === 404) return null;
  if (!r.ok || !r.body) throw new Error(r.body?.error || `Lookup failed (${r.status})`);
  return r.body;
}

// Signs and stores a record. Returns { id, record, signature, key }. Throws with the server's reason.
export async function issueCredential(record) {
  const r = await getJson(`${API}/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record }),
    timeoutMs: 10000,
  });
  if (!r.ok || !r.body?.id) throw new Error(r.body?.error || `The credential server answered ${r.status}`);
  return r.body;
}

function b64urlToBytes(s) {
  const str = String(s);
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
}

function importKey(kid, jwk) {
  if (!imported.has(kid)) {
    const p = crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    p.catch(() => imported.delete(kid));
    imported.set(kid, p);
  }
  return imported.get(kid);
}

// Checks a credential ({ id, record, signature, key }, as an object or JSON text).
// Returns { state: 'valid' | 'changed' | 'broken', msg?, cred?, kid?, fingerprint? }.
// 'changed' = well formed, but the signature doesn't match the record (tampered).
export async function verifyCredential(input) {
  let c = input;
  if (typeof input === 'string') {
    try {
      c = JSON.parse(input);
    } catch {
      return { state: 'broken', msg: 'This isn’t a complete credential record. Check that you copied all of it, including the first and last braces.' };
    }
  }
  if (!c || typeof c !== 'object' || !c.record || typeof c.record !== 'object' || !c.signature) {
    return { state: 'broken', msg: 'This record is missing its signature or contents, so it can’t be checked.' };
  }
  if (!(globalThis.crypto && crypto.subtle)) {
    return { state: 'broken', msg: 'This page can’t run the signature check here. Open it on localhost or https in a current browser.' };
  }
  const { keys, fingerprints, offline } = await issuerKeys();
  const kid = String(c.key || '');
  const jwk = keys[kid];
  if (!jwk) {
    return {
      state: 'broken',
      cred: c,
      msg: offline
        ? 'The issuer’s keys can’t be fetched right now, so this record can’t be checked. Try again in a moment.'
        : `This record names a signing key (${kid || 'none'}) that IndustryProof has not published.`,
    };
  }
  let ok = false;
  try {
    const key = await importKey(kid, jwk);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlToBytes(c.signature), enc.encode(JSON.stringify(c.record)));
  } catch {
    ok = false;
  }
  return { state: ok ? 'valid' : 'changed', cred: c, kid, fingerprint: fingerprints[kid] || null };
}
