// Thin wrapper around the Paystack REST API. Server side only.
import crypto from 'node:crypto';

const BASE = 'https://api.paystack.co';

function secretKey() {
  const k = process.env.PAYSTACK_SECRET_KEY;
  if (!k || !/^sk_(test|live)_[A-Za-z0-9]+$/.test(k)) {
    throw new Error('PAYSTACK_SECRET_KEY is missing or malformed');
  }
  return k;
}

export const isLiveMode = () => (process.env.PAYSTACK_SECRET_KEY || '').startsWith('sk_live_');

export async function paystack(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${secretKey()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status !== true) {
    const err = new Error(`Paystack ${method} ${path} failed: ${data.message || res.status}`);
    err.status = res.status;
    throw err;
  }
  return data.data;
}

// Paystack signs every webhook with HMAC SHA512 of the raw body using your secret key.
export function validSignature(rawBody, signature, secret = process.env.PAYSTACK_SECRET_KEY) {
  if (!signature || !secret || typeof rawBody !== 'string') return false;
  const expected = Buffer.from(crypto.createHmac('sha512', secret).update(rawBody).digest('hex'), 'hex');
  let given;
  try { given = Buffer.from(signature, 'hex'); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// References are generated on the server so a client can never reuse or guess one.
export function newReference(kind) {
  return `WZR_${kind}_${crypto.randomUUID().replace(/-/g, '')}`;
}
