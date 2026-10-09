// GET /api/config
// Public settings the browser pages need. Only the publishable (anon) key may be sent: row level security limits it.
// A secret or service-role key here would give anyone full database access, so it is refused, never sent.
import { json } from '../lib/http.js';

export function isSecretKey(key) {
  if (!key) return false;
  if (/^sb_secret_/.test(key)) return true;
  try { return JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString('utf8')).role === 'service_role'; }
  catch { return false; }
}

export function GET() {
  const key = process.env.SUPABASE_ANON_KEY || '';
  if (isSecretKey(key)) {
    console.error('[akwaaba] SUPABASE_ANON_KEY holds a secret key; refusing to send it. Put the publishable/anon key there.');
    return json(500, { error: 'Akwaaba is being set up. Please try again shortly.' });
  }
  return json(200, { supabaseUrl: process.env.SUPABASE_URL || '', supabaseAnonKey: key });
}
