import { loadConfig, ghs, esc, waLink, telLink } from '/common.js';

const $ = (s) => document.querySelector(s);
const STEPS = {
  assigned: { next: 'waiting', button: 'I am at the meeting point', pill: 'Assigned' },
  waiting: { next: 'met', button: 'Passenger met', pill: 'At airport' },
  met: { next: 'enroute', button: 'Start trip', pill: 'Passenger met' },
  enroute: { next: 'done', button: 'Complete trip', pill: 'On the way' },
  done: { next: null, button: null, pill: 'Completed' },
  no_show: { next: null, button: null, pill: 'No-show' }
};
const EXTRA_NAMES = { meet: 'Meet inside arrivals hall', child: 'Child seat', stop: 'Extra stop' };
// Airport arrivals, for the driver's own navigation app.
const AIRPORT_NAV = {
  ACC: 'https://www.google.com/maps/dir/?api=1&destination=Kotoka+International+Airport+Terminal+3+Arrivals&travelmode=driving',
  KMS: 'https://www.google.com/maps/dir/?api=1&destination=Prempeh+I+International+Airport+Kumasi&travelmode=driving'
};
const AIRPORT_NAME = { ACC: 'Kotoka, Accra', KMS: 'Prempeh I, Kumasi' };

let sb, session, data, selected;
// Plain-words reason for a failed code request, with Supabase's own message for diagnosis.
function codeError(error) {
  const m = error?.message || '';
  if (/rate|seconds|too many/i.test(m)) return 'Please wait a minute before asking for another code.';
  if (/signups? (not allowed|disabled)/i.test(m)) return 'New sign-ups are switched off. Contact astrovenzav@gmail.com.';
  if (/sending|smtp|email.*(send|deliver)/i.test(m)) return `We could not send the email right now. Please try again shortly. (${m})`;
  return `We could not send a code to that address. Check it and try again. (${m})`;
}


const showErr = (el, msg) => { $(el).textContent = msg || ''; $(el).hidden = !msg; };
function normPhone(p) {
  const d = p.replace(/[\s\-()]/g, '');
  if (/^0\d{9}$/.test(d)) return '+233' + d.slice(1);
  return /^\+\d{10,15}$/.test(d) ? d : null;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, ...(opts.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}

// ---------- Sign in with phone and SMS code ----------
// Drivers sign in with a one-time code sent to their email (free). Phone numbers also work once an SMS provider is set up in Supabase.
let pending = null;
$('#phoneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('#phone').value.trim();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw) ? raw.toLowerCase() : null;
  const phone = email ? null : normPhone(raw);
  if (!email && !phone) return showErr('#signErr', 'Enter the email address you registered with, for example kwame@gmail.com.');
  const { error } = await sb.auth.signInWithOtp(email
    ? { email, options: { shouldCreateUser: false } }
    : { phone, options: { shouldCreateUser: false } });
  if (error) return showErr('#signErr', codeError(error));
  pending = email ? { email, type: 'email' } : { phone, type: 'sms' };
  $('#codeLabel').textContent = email ? `6-digit code sent to ${email}` : '6-digit code sent by SMS';
  showErr('#signErr', '');
  $('#phoneForm').hidden = true; $('#codeForm').hidden = false; $('#code').focus();
});
$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { data: d, error } = await sb.auth.verifyOtp({ ...pending, token: $('#code').value.trim() });
  if (error) return showErr('#signErr', 'That code is not right or has expired. Request a new one.');
  session = d.session;
  start();
});
$('#signOut').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });

// ---------- Main ----------
async function load() {
  data = await api('/api/drivers/trips');
  // Pickups stay hidden until the driver has acknowledged the current privacy notice and vetting consent.
  const needAck = !data.privacy.acknowledged;
  $('#privacyCard').hidden = !needAck;
  $('#appArea').hidden = needAck;
  if (needAck) return;
  renderSub();
  renderTrips();
  if (selected) selectTrip(selected.code);
}

function renderSub() {
  const d = data.driver;
  const until = d.sub_until ? new Date(d.sub_until) : null;
  const active = d.subscription_active;
  $('#subCard').className = 'sub' + (active ? '' : ' expired');
  $('#subCard').innerHTML = `<div style="display:grid;gap:2px">
      <span class="label">Monthly subscription · GHS 100</span>
      <strong style="font-family:var(--display);font-size:22px;text-transform:uppercase">${active ? 'Active' : 'Not active'}</strong>
      <span class="hint">${active ? `Paid until ${until.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. You keep 100% of every fare.`
        : 'You will not receive pickups until you pay.'}${d.status === 'pending_review'
        ? ' Your application is waiting for approval. Contact astrovenzav@gmail.com to arrange your document check; you can pay once approved.'
        : d.status === 'suspended' ? ' Your account is suspended. Contact astrovenzav@gmail.com.' : ''}</span>
    </div>
    <button class="btn ${active ? 'btn-ghost' : 'btn-sign'}" id="payBtn" type="button" ${d.status !== 'approved' ? 'disabled' : ''}>${active ? 'Pay next month' : 'Pay GHS 100'}</button>`;
  $('#payBtn').addEventListener('click', async () => {
    try { const r = await api('/api/subscriptions/initialize', { method: 'POST' }); location.href = r.authorization_url; }
    catch (err) { showErr('#appErr', err.message); }
  });
}

function renderTrips() {
  if (!data.trips.length) {
    $('#trips').innerHTML = `<p class="hint">${data.driver.subscription_active ? 'No pickups yet. New bookings for your vehicle appear here.' : 'Pay your subscription to start receiving pickups.'}</p>`;
    return;
  }
  $('#trips').innerHTML = data.trips.map((t) => `
    <button class="trip" type="button" data-code="${esc(t.code)}" aria-current="${selected?.code === t.code}">
      <div class="row"><strong style="font-family:var(--mono)">${esc(t.code)}</strong><span class="pill ${t.status === 'done' ? 'ok' : t.status === 'no_show' ? 'bad' : ''}">${STEPS[t.status].pill}</span></div>
      <div class="row"><span>${esc(t.flight)} · ${esc(t.airport)} · lands ${esc(t.arrival_date)} ${esc(t.arrival_time)}</span><span class="money">${ghs(t.fare_ghs)}</span></div>
      <span class="hint">${esc(t.area)} · ${esc(t.dest_address)}</span>
    </button>`).join('');
  document.querySelectorAll('.trip').forEach((b) => b.addEventListener('click', () => selectTrip(b.dataset.code)));
}

function selectTrip(code) {
  selected = data.trips.find((t) => t.code === code);
  if (!selected) return;
  renderTrips();
  const t = selected;
  const hello = `Hello ${t.passenger_name}, this is ${data.driver.name}, your Akwaaba driver for booking ${t.code} (flight ${t.flight}). ` +
    `Please send me your exact drop-off location here on WhatsApp.`;
  $('#tripTitle').textContent = `Pickup · ${t.code}`;
  $('#tripDetail').innerHTML = `
    <div><strong>Pickup:</strong> ${esc(AIRPORT_NAME[t.airport] || t.airport)} arrivals</div>
    <div><strong>Name sign:</strong> ${esc(t.passenger_name)} · ${t.pax} passenger(s), ${t.bags} bag(s)</div>
    <div><strong>Phone:</strong> <span style="user-select:all">${esc(t.passenger_phone)}</span></div>
    <div><strong>Drop-off:</strong> ${esc(t.dest_address)}, ${esc(t.area)}</div>
    <div><strong>Extras:</strong> ${t.extras.length ? t.extras.map((x) => esc(EXTRA_NAMES[x] || x)).join(', ') : 'None'}</div>
    <div><strong>Collect from passenger:</strong> ${ghs(t.fare_ghs)} (cash or mobile money)</div>`;

  const step = STEPS[t.status];
  const live = !!step.next;
  $('#tripActions').innerHTML =
    (live ? `<a class="btn btn-ghost" href="${waLink(t.passenger_phone, hello)}" target="_blank" rel="noopener">WhatsApp passenger</a>
             <a class="btn btn-ghost" href="${telLink(t.passenger_phone)}">Call passenger</a>` : '') +
    (['assigned', 'waiting'].includes(t.status) ? `<a class="btn btn-ghost" href="${AIRPORT_NAV[t.airport] || AIRPORT_NAV.ACC}" target="_blank" rel="noopener">Navigate to airport</a>` : '') +
    (live ? `<button class="btn btn-sign" id="stepBtn" type="button">${step.button}</button>` : '') +
    (t.status === 'waiting' ? `<button class="btn btn-ghost" id="noShowBtn" type="button">Passenger did not show</button>` : '');

  const move = (to) => async () => {
    try {
      await api('/api/drivers/trip-status', { method: 'POST', body: JSON.stringify({ booking_code: t.code, to }) });
      await load();
    } catch (err) { showErr('#appErr', err.message); }
  };
  $('#stepBtn')?.addEventListener('click', move(step.next));
  $('#noShowBtn')?.addEventListener('click', move('no_show'));
}

$('#ackBtn').addEventListener('click', async () => {
  if (!$('#ackNotice').checked || !$('#ackVetting').checked) {
    return showErr('#ackErr', 'Tick both required boxes to receive pickups.');
  }
  $('#ackBtn').disabled = true;
  try {
    await api('/api/drivers/trips', { method: 'POST', body: JSON.stringify({
      privacy_version: data.privacy.version, privacy_notice: true, vetting: true, marketing: $('#ackMarketing').checked
    }) });
    showErr('#ackErr', '');
    await load();
    const next = data.trips.find((t) => !['done', 'no_show'].includes(t.status)) || data.trips[0];
    if (next) selectTrip(next.code);
  } catch (err) { showErr('#ackErr', err.message); }
  finally { $('#ackBtn').disabled = false; }
});

async function start() {
  $('#signIn').hidden = true;
  $('#appArea').hidden = false;
  try { await load(); }
  catch (err) { showErr('#appErr', err.message === 'Sign in as a driver.' ? 'This email is not registered as an Akwaaba driver yet. Apply at akwaabaaapp.vercel.app/apply.' : err.message); return; }
  const next = data.privacy.acknowledged && (data.trips.find((t) => !['done', 'no_show'].includes(t.status)) || data.trips[0]);
  if (next) selectTrip(next.code);
  setInterval(() => load().catch(() => {}), 60000); // pick up new pickups every minute
}

(async () => {
  const cfg = await loadConfig();
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  sb.auth.onAuthStateChange((_e, s) => { if (s) session = s; });
  const { data: d } = await sb.auth.getSession();
  session = d.session;
  if (session) start(); else $('#signIn').hidden = false;
})();
