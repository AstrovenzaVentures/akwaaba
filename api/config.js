// GET /api/config
// Public settings the browser pages need. The Supabase anon key is browser-safe: row level security limits it.
import { json } from '../lib/http.js';

export function GET() {
  return json(200, {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
  });
}
