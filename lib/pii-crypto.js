// lib/pii-crypto.js : field-level encryption and blind indexes for personal data.
// AES-256-GCM with a key version prefix, so keys can be rotated without re-encrypting everything at once.
import crypto from 'node:crypto';

function loadKeys() {
  // PII_ENC_KEYS="v2:<base64 32 bytes>,v1:<base64 32 bytes>"  (first = current key for new writes)
  const raw = process.env.PII_ENC_KEYS || '';
  const keys = new Map();
  let current = null;
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id, b64] = part.split(':');
    const key = Buffer.from(b64 || '', 'base64');
    if (!/^v\d+$/.test(id) || key.length !== 32) throw new Error('PII_ENC_KEYS is malformed');
    keys.set(id, key);
    if (!current) current = id;
  }
  if (!current) throw new Error('PII_ENC_KEYS is missing');
  return { keys, current };
}

function indexKey() {
  const key = Buffer.from(process.env.PII_INDEX_KEY || '', 'base64');
  if (key.length !== 32) throw new Error('PII_INDEX_KEY is missing or malformed');
  return key;
}

// "v1:<iv b64>:<tag b64>:<ciphertext b64>". The aad binds the value to its column, so values cannot be swapped between fields.
export function encryptField(plaintext, aad) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const { keys, current } = loadKeys();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keys.get(current), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [current, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptField(value, aad) {
  if (!value) return null;
  const [id, iv, tag, ct] = value.split(':');
  const { keys } = loadKeys();
  const key = keys.get(id);
  if (!key) throw new Error(`No key for ${id}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

// Blind index: same input always gives the same hash, so the database can match phone numbers without seeing them.
// Normalise first, so "024 411 2087" and "+233244112087" match.
export function blindIndex(value, purpose = 'phone') {
  if (!value) return null;
  return crypto.createHmac('sha256', indexKey()).update(`${purpose}:${String(value).trim().toLowerCase()}`).digest('hex');
}

// Re-encrypt an old value under the current key (used by the key rotation job).
export function needsRotation(value) {
  return !!value && value.split(':')[0] !== loadKeys().current;
}
