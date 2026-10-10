import { loadConfig, esc, subStatus, fmtDay, fmtWhen } from '/common.js';

const $ = (s) => document.querySelector(s);
const showErr = (el, msg) => { $(el).textContent = msg || ''; $(el).hidden = !msg; };
const CHECKS = [
  ['ghana_card', 'Ghana Card matches the name'],
  ['drivers_licence', "Driver's licence valid"],
  ['dvla_ride_hailing', 'DVLA ride-hailing registration'],
  ['police_clearance', 'Police clearance report: clear'],
  ['vehicle_roadworthy', 'Vehicle papers, insurance and roadworthy']
];
const AIRPORT = { ACC: 'Accra', KMS: 'Kumasi' };
let sb, factorId;

async function token() { const { data } = await sb.auth.getSession(); return data.session?.access_token; }
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}

// ---------- Sign in: password, then authenticator (aal2) ----------
$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#password').value });
  if (error) return showErr('#signErr', 'Email or password is not right.');
  showErr('#signErr', '');
  await secondStep();
});

async function secondStep() {
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal.currentLevel === 'aal2') return start();
  const { data: f } = await sb.auth.mfa.listFactors();
  const verified = f.totp.find((x) => x.status === 'verified');
  $('#pwForm').hidden = true;
  if (verified) {
    factorId = verified.id;
  } else {
    // Remove half-finished enrolments, then enrol a new authenticator.
    for (const x of f.all.filter((x) => x.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: x.id });
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Akwaaba staff' });
    if (error) return showErr('#signErr', 'Could not set up the authenticator. Check that TOTP is enabled in Supabase.');
    factorId = data.id;
    $('#qr').src = data.totp.qr_code;
    $('#secret').textContent = data.totp.secret;
    $('#enrol').hidden = false;
  }
  $('#mfaForm').hidden = false; $('#totp').focus();
}

$('#mfaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: $('#totp').value.trim() });
  if (error) return showErr('#signErr', 'That code is not right. Use the current code from your authenticator app.');
  start();
});

// ---------- Applications ----------
function card(d, kind) {
  const st = subStatus(d.sub_until);
  const left = st.days === 1 ? '1 day' : `${st.days} days`;
  const sub = `<span class="sub-state ${st.state}">${{
    active: `Active · expires in ${left} (${st.until && fmtDay(st.until)})`,
    soon: `Expires in ${left} (${st.until && fmtDay(st.until)})`,
    expired: `Expired on ${st.until && fmtDay(st.until)} · no new pickups`,
    never: 'Never paid · no pickups'
  }[st.state]}</span>${history(d.payments || [])}`;
  const head = `<div class="row"><strong>${esc(d.name)}</strong><span class="pill">${esc(AIRPORT[d.base_airport] || d.base_airport)}</span></div>
    <span class="hint">${esc(d.vehicle_model || '')} · ${esc(d.vehicle_type)} · <span style="font-family:var(--mono)">${esc(d.plate)}</span></span>
    <span class="hint">${esc(d.phone)} · ${esc(d.email)} · applied ${new Date(d.created_at).toLocaleDateString('en-GB')}</span>`;
  if (kind === 'pending') {
    return `<div class="trip" style="cursor:default" data-id="${d.id}">${head}
      <div style="display:grid;gap:6px">${CHECKS.map(([k, label]) => `<label class="check"><input type="checkbox" value="${k}"> ${label}</label>`).join('')}</div>
      <div class="actions"><button class="btn btn-sign" data-act="approve" type="button">Approve</button><button class="btn btn-ghost" data-act="suspend" type="button">Decline</button></div></div>`;
  }
  return `<div class="trip" style="cursor:default" data-id="${d.id}">${head}<div style="display:grid;gap:6px;font-size:14px">${sub}</div>
    <div class="actions">${kind === 'approved' ? '<button class="btn btn-ghost" data-act="suspend" type="button">Suspend</button>' : '<button class="btn btn-ghost" data-act="reinstate" type="button">Reinstate</button>'}</div></div>`;
}

const METHOD = { mtn: 'MTN MoMo', telecel: 'Telecel Cash', airteltigo: 'AirtelTigo Money', bank: 'Bank transfer' };
function paymentCard(p) {
  return `<div class="trip" style="cursor:default" data-ref="${esc(p.reference)}">
    <div class="row"><strong>${esc(p.driver_name)}</strong><span class="pill">${esc(METHOD[p.method] || p.method)}</span></div>
    <span class="hint"><span style="font-family:var(--mono)">${esc(p.driver_plate)}</span> · ${esc(p.driver_phone)} · sent ${new Date(p.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
    <span>Amount expected: <strong>GHS ${(p.amount_pesewas / 100).toFixed(2)}</strong></span>
    <span>Transaction ID: <strong style="font-family:var(--mono);user-select:all">${esc(p.manual_txn_id)}</strong></span>
    <span>Paid from: <strong style="font-family:var(--mono);user-select:all">${esc(p.payer_account)}</strong></span>
    ${p.proof_url ? `<a href="${esc(p.proof_url)}" target="_blank" rel="noopener noreferrer"><img src="${esc(p.proof_url)}" alt="Payment screenshot" style="max-width:260px;max-height:420px;border-radius:8px;border:1px solid var(--line,#ddd)"></a>` : '<span class="hint">No screenshot.</span>'}
    <div class="actions"><button class="btn btn-sign" data-pay="confirm_payment" type="button">Confirm: found on statement</button><button class="btn btn-ghost" data-pay="reject_payment" type="button">Reject</button></div></div>`;
}

const STATUS = { success: 'Paid', rejected: 'Rejected', flagged: 'Flagged (wrong amount)' };
function history(list) {
  if (!list.length) return '';
  const rows = list.map((p) => {
    const via = p.method === 'paystack' ? 'Paystack' : (METHOD[p.method] || p.method);
    const who = p.method === 'paystack' ? 'Automatic' : p.reviewed_by ? `${esc(p.reviewed_by)}${p.reviewed_at ? `, ${fmtWhen(p.reviewed_at)}` : ''}` : '';
    const note = p.status === 'rejected' ? esc(p.reject_reason || '') : p.manual_txn_id ? `ID <span style="font-family:var(--mono)">${esc(p.manual_txn_id)}</span>` : '';
    return `<tr><td>${fmtDay(p.paid_at || p.created_at)}</td><td>${esc(via)}</td><td>${STATUS[p.status] || esc(p.status)} · GHS ${(p.amount_pesewas / 100).toFixed(0)}</td><td>${who}</td><td>${note}</td></tr>`;
  }).join('');
  const paid = list.filter((p) => p.status === 'success').length;
  return `<details class="history"><summary>Payment history: ${paid} paid${list.length > paid ? `, ${list.length - paid} other` : ''}</summary>
    <div class="hist-wrap"><table class="hist"><thead><tr><th>Date</th><th>Method</th><th>Result</th><th>Confirmed by</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

async function load() {
  const out = await api('/api/staff/drivers');
  $('#who').textContent = `Signed in as ${out.staff.email} (${out.staff.role})`;
  $('#nPayments').textContent = out.payments.length;
  $('#payments').innerHTML = out.payments.length ? out.payments.map(paymentCard).join('') : '<p class="hint">None.</p>';
  for (const kind of ['pending', 'approved', 'suspended']) {
    const status = kind === 'pending' ? 'pending_review' : kind;
    const list = out.drivers.filter((d) => d.status === status);
    $(`#n${kind[0].toUpperCase() + kind.slice(1)}`).textContent = list.length;
    $(`#${kind}`).innerHTML = list.length ? list.map((d) => card(d, kind)).join('') : '<p class="hint">None.</p>';
  }
}

$('#appArea').addEventListener('click', async (e) => {
  const pay = e.target.closest('button[data-pay]');
  if (pay) {
    const ref = pay.closest('[data-ref]').dataset.ref;
    const action = pay.dataset.pay;
    let note = '';
    if (action === 'confirm_payment') {
      if (!confirm('Confirm only if you have found this exact transaction ID and GHS 100 on your own statement. Switch on the subscription for 30 days?')) return;
    } else {
      note = prompt('Reason the driver will see (e.g. "No payment with this ID on our statement"):');
      if (!note) return;
    }
    pay.disabled = true;
    try { await api('/api/staff/drivers', { method: 'POST', body: JSON.stringify({ payment_reference: ref, action, note }) }); showErr('#appErr', ''); await load(); }
    catch (err) { showErr('#appErr', err.message); pay.disabled = false; }
    return;
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const box = btn.closest('[data-id]');
  const action = btn.dataset.act;
  const checks = [...box.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
  if (action === 'approve' && checks.length < CHECKS.length) return showErr('#appErr', 'Tick all five checks after seeing the original documents.');
  let note = '';
  if (action !== 'approve') { note = prompt(`Reason (${action === 'reinstate' ? 'reinstating' : 'declining or suspending'}), kept in the audit log:`) ?? null; if (note === null) return; }
  btn.disabled = true;
  try { await api('/api/staff/drivers', { method: 'POST', body: JSON.stringify({ driver_id: box.dataset.id, action, checks, note }) }); showErr('#appErr', ''); await load(); }
  catch (err) { showErr('#appErr', err.message); btn.disabled = false; }
});

async function start() {
  $('#signIn').hidden = true; $('#appArea').hidden = false;
  try { await load(); } catch (err) { showErr('#appErr', err.message); }
}
$('#refresh').addEventListener('click', () => load().catch((err) => showErr('#appErr', err.message)));
$('#signOut').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });

// Sign out after 15 minutes without activity.
let idle;
const resetIdle = () => { clearTimeout(idle); idle = setTimeout(async () => { await sb.auth.signOut(); location.reload(); }, 15 * 60 * 1000); };
['click', 'keydown', 'touchstart'].forEach((ev) => addEventListener(ev, resetIdle));
resetIdle();

(async () => {
  const cfg = await loadConfig();
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await sb.auth.getSession();
  if (data.session) {
    // A driver or applicant signed in on this browser has no authenticator: sign them out here and ask for staff details.
    const { data: f } = await sb.auth.mfa.listFactors();
    if (!f?.totp?.some((x) => x.status === 'verified')) await sb.auth.signOut();
    if ((await sb.auth.getSession()).data.session) { $('#pwForm').hidden = true; $('#signIn').hidden = false; await secondStep(); return; }
  }
  $('#signIn').hidden = false;
})();
