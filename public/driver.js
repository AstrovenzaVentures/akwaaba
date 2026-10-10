import { loadConfig, ghs, esc, waLink, telLink, subStatus, fmtDay } from '/common.js';

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
  $('#codeLabel').textContent = email ? `Code sent to ${email}` : 'Code sent by SMS';
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

const METHOD_NAME = { mtn: 'MTN MoMo', telecel: 'Telecel Cash', airteltigo: 'AirtelTigo Money', bank: 'Bank transfer' };
const fmtDate = (v) => new Date(v).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function claimNote(c) {
  if (!c) return '';
  if (c.status === 'submitted') {
    return `<div class="note"><strong>Payment being checked.</strong> ${esc(METHOD_NAME[c.method] || c.method)}, transaction ID <span style="font-family:var(--mono)">${esc(c.manual_txn_id)}</span>, sent ${fmtDate(c.created_at)}. We switch on your subscription as soon as we confirm it on our statement.</div>`;
  }
  if (c.status === 'rejected' && Date.now() - new Date(c.reviewed_at).getTime() < 14 * 864e5) {
    return `<div class="note" style="border-color:var(--bad,#b3261e)"><strong>We could not confirm your ${esc(METHOD_NAME[c.method] || c.method)} payment</strong> (ID <span style="font-family:var(--mono)">${esc(c.manual_txn_id)}</span>): ${esc(c.reject_reason || '')}. Contact astrovenzav@gmail.com if you think this is wrong, or send the details again.</div>`;
  }
  return '';
}

function accountBox(a) {
  const lines = a.method === 'bank'
    ? [['Bank', a.bank_name], ['Branch', a.branch], ['Account name', a.account_name], ['Account number', a.account_number]]
    : [['Name', a.account_name], [/[A-Za-z]/.test(a.account_number) || a.account_number.replace(/\D/g, '').length < 9 ? 'Merchant ID' : 'Number', a.account_number]];
  return `<label class="choice" style="text-align:left"><input type="radio" name="payMethod" value="${esc(a.method)}"><b>${esc(a.label)}</b>
    ${lines.map(([k, v]) => `<small>${k}: <span style="font-family:var(--mono);user-select:all">${esc(v || '')}</span></small>`).join('')}
    ${a.instructions ? `<small>${esc(a.instructions)}</small>` : ''}</label>`;
}

function renderSub() {
  const d = data.driver;
  const st = subStatus(d.sub_until);
  const pay = data.payment || { accounts: [], last_claim: null };
  const waiting = pay.last_claim?.status === 'submitted';
  const canPay = d.status === 'approved';
  const left = st.days === 1 ? '1 day left' : `${st.days} days left`;
  const headline = { active: `Active · ${left}`, soon: `Ends soon · ${left}`, expired: 'Expired', never: 'Not active' }[st.state];
  const detail = {
    active: `Paid until ${fmtDay(st.until)}. You keep 100% of every fare.`,
    soon: `Your subscription ends on ${fmtDay(st.until)}. Renew now so your pickups do not stop. Paying early adds 30 days on top of the days you have left.`,
    expired: `Your subscription ended on ${st.until ? fmtDay(st.until) : ''}. You will not receive new pickups until you pay again. Pickups already booked for you stay.`,
    never: 'You will not receive pickups until you pay.'
  }[st.state];
  $('#subCard').className = 'sub ' + (st.state === 'never' ? 'expired' : st.state);
  $('#subCard').innerHTML = `<div style="display:grid;gap:2px">
      <span class="label">Monthly subscription · GHS 100 for 30 days</span>
      <strong style="font-family:var(--display);font-size:22px;text-transform:uppercase">${headline}</strong>
      <span class="hint">${detail}${d.status === 'pending_review'
        ? ' Your application is waiting for approval. Contact astrovenzav@gmail.com to arrange your document check; you can pay once approved.'
        : d.status === 'suspended' ? ' Your account is suspended. Contact astrovenzav@gmail.com.' : ''}</span>
    </div>
    <div style="display:grid;gap:8px">
      <button class="btn ${st.state === 'active' ? 'btn-ghost' : 'btn-sign'}" id="payBtn" type="button" ${canPay ? '' : 'disabled'}>${st.state === 'active' ? 'Pay next month' : st.state === 'soon' ? 'Renew now' : 'Pay GHS 100'} with Paystack</button>
      ${canPay && pay.accounts.length && !waiting ? '<button class="btn btn-ghost" id="directBtn" type="button">Pay directly by MoMo or bank</button>' : ''}
    </div>`;
  $('#claimNote').innerHTML = claimNote(pay.last_claim);
  $('#payBtn').addEventListener('click', async () => {
    try { const r = await api('/api/subscriptions/initialize', { method: 'POST' }); location.href = r.authorization_url; }
    catch (err) { showErr('#appErr', err.message); }
  });
  $('#directBtn')?.addEventListener('click', () => {
    $('#directAccounts').innerHTML = pay.accounts.map(accountBox).join('');
    $('#directPanel').hidden = false;
    $('#directPanel').scrollIntoView({ behavior: 'smooth' });
  });
  if (waiting) $('#directPanel').hidden = true;
}

// Shrinks a phone screenshot to a JPEG of at most 1600 px on the long side before upload.
async function shrink(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.8);
  return { type: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
}

$('#directForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const method = document.querySelector('input[name=payMethod]:checked')?.value;
  const file = $('#proof').files[0];
  if (!method) return showErr('#directErr', 'Choose the account you paid into.');
  if (!$('#txnId').value.trim()) return showErr('#directErr', 'Enter the transaction ID from your payment message.');
  if (!$('#payer').value.trim()) return showErr('#directErr', 'Enter the number or account you paid from.');
  if (!file) return showErr('#directErr', 'Add a screenshot of your payment.');
  const btn = $('#directSend'); btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const proof = await shrink(file).catch(() => { throw new Error('Could not read that picture. Use a screenshot (JPG or PNG).'); });
    await api('/api/subscriptions/initialize', { method: 'POST', body: JSON.stringify({ method, txn_id: $('#txnId').value.trim(), payer_account: $('#payer').value.trim(), proof }) });
    showErr('#directErr', '');
    $('#directForm').reset(); $('#directPanel').hidden = true;
    await load();
  } catch (err) { showErr('#directErr', err.message); }
  finally { btn.disabled = false; btn.textContent = 'Send for checking'; }
});
$('#directCancel').addEventListener('click', () => { $('#directPanel').hidden = true; });

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
  const hello = `Hello ${t.passenger_name}, this is ${data.driver.name}, your Woezor driver for booking ${t.code} (flight ${t.flight}). ` +
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
  catch (err) { showErr('#appErr', err.message === 'Sign in as a driver.' ? 'This email is not registered as a Woezor driver yet. Apply at akwaabaaapp.vercel.app/apply.' : err.message); return; }
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
