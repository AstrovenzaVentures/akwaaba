export const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

export async function readJson(request, maxBytes = 10_000) {
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Logs the real error for you, returns a generic message to the caller (no stack traces or database errors).
export async function handle(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error('[akwaaba]', err?.message || err);
    return json(500, { error: 'Something went wrong on our side. Please try again.' });
  }
}

export function appUrl() {
  const u = process.env.APP_URL || '';
  if (!/^https:\/\//.test(u)) throw new Error('APP_URL must be an https address');
  return u.replace(/\/$/, '');
}
