import { db } from './db.js';

function bearer(request) {
  const m = /^Bearer\s+(.+)$/.exec(request.headers.get('authorization') || '');
  return m ? m[1] : null;
}

function tokenClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

// Validates the Supabase session token with Supabase itself before trusting any claim in it.
async function currentUser(request) {
  const token = bearer(request);
  if (!token) return null;
  const { data, error } = await db().auth.getUser(token);
  if (error || !data?.user) return null;
  return { user: data.user, aal: tokenClaims(token).aal };
}

// Any signed-in person (used by the driver application, before a driver profile exists).
export async function signedInUser(request) {
  const u = await currentUser(request);
  return u ? u.user : null;
}

export async function requireDriver(request) {
  const u = await currentUser(request);
  if (!u) return null;
  const { data } = await db().from('drivers').select('*').eq('id', u.user.id).maybeSingle();
  return data || null;
}

// Staff must have passed both steps (password, then authenticator code): Supabase marks that as aal2.
export async function requireStaff(request) {
  const u = await currentUser(request);
  if (!u || u.aal !== 'aal2') return null;
  const { data } = await db().from('staff').select('user_id, role').eq('user_id', u.user.id).maybeSingle();
  return data ? { ...data, email: u.user.email } : null;
}
