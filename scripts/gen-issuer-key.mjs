#!/usr/bin/env node
// Creates the credential issuer's ECDSA P-256 signing key and stores it in .env.local.
//   node scripts/gen-issuer-key.mjs        (npm run keys)
// Does nothing if ISSUER_PRIVATE_JWK is already set. Prints only the public key fingerprint.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ENV_PATH = resolve(ROOT, '.env.local');
export const DEFAULT_KEY_ID = 'industryproof-live-2026';

// KEY=VALUE lines; values may contain '=' and JSON. Later lines win.
export function parseEnv(text) {
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

// Public JWK in the order the prototype uses: { kty, crv, x, y }.
export function publicJwkOf(privateJwk) {
  const pub = createPublicKey(createPrivateKey({ key: privateJwk, format: 'jwk' })).export({ format: 'jwk' });
  return { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y };
}

// First 16 hex of SHA-256 over the raw public point (04 || x || y), same as the prototype's ISSUER_FP.
export function fingerprintOf(publicJwk) {
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(publicJwk.x, 'base64url'), Buffer.from(publicJwk.y, 'base64url')]);
  return createHash('sha256').update(point).digest('hex').slice(0, 16);
}

// Makes sure .env.local holds an issuer key. Returns { created, kid, fingerprint }.
export function ensureIssuerKey({ envPath = DEFAULT_ENV_PATH } = {}) {
  const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const env = parseEnv(text);

  if (env.ISSUER_PRIVATE_JWK) {
    const pub = publicJwkOf(JSON.parse(env.ISSUER_PRIVATE_JWK));
    return { created: false, kid: env.ISSUER_KEY_ID || DEFAULT_KEY_ID, fingerprint: fingerprintOf(pub) };
  }

  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const kid = env.ISSUER_KEY_ID || DEFAULT_KEY_ID;

  let add = `ISSUER_PRIVATE_JWK=${JSON.stringify(jwk)}\n`;
  if (!env.ISSUER_KEY_ID) add += `ISSUER_KEY_ID=${kid}\n`;
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  writeFileSync(envPath, text + sep + add, { mode: 0o600 });
  chmodSync(envPath, 0o600);

  return { created: true, kid, fingerprint: fingerprintOf(publicJwkOf(jwk)) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    const { created, kid, fingerprint } = ensureIssuerKey();
    console.log(created ? 'Created issuer key in .env.local' : 'Issuer key already in .env.local (unchanged)');
    console.log(`  key id:      ${kid}`);
    console.log(`  fingerprint: ${fingerprint}`);
  } catch (err) {
    console.error(`Could not set up the issuer key: ${err.message}`);
    process.exit(1);
  }
}
