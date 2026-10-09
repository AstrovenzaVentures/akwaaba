import { loadConfig, esc } from '/common.js';

const $ = (s) => document.querySelector(s);
let sb, session, privacyVersion;
// Plain-words reason for a failed code request, with Supabase's own message for diagnosis.
function codeError(error) {
  const m = error?.message || '';
  if (/rate|seconds|too many/i.test(m)) return 'Please wait a minute before asking for another code.';
  if (/signups? (not allowed|disabled)/i.test(m)) return 'New sign-ups are switched off. Contact astrovenzav@gmail.com.';
  if (/sending|smtp|email.*(send|deliver)/i.test(m)) return `We could not send the email right now. Please try again shortly. (${m})`;
  return `We could not send a code to that address. Check it and try again. (${m})`;
}

const showErr = (msg) => { $('#err').textContent = msg || ''; $('#err').hidden = !msg; };
const step = (id) => { for (const s of ['#emailForm', '#codeForm', '#applyForm', '#done']) $(s).hidden = s !== id; showErr(''); };

async function showForm() {
  // Someone who already has a driver profile goes to the driver app instead.
  const res = await fetch('/api/drivers/trips', { headers: { Authorization: `Bearer ${session.access_token}` } });
  if (res.ok) { step('#done'); $('#done h2').textContent = 'You already have an Akwaaba driver account'; $('#done p').textContent = 'Open the driver app to see your status.'; return; }
  $('#signedAs').textContent = `Signed in as ${session.user.email}`;
  step('#applyForm');
}

let pendingEmail;
$('#emailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#email').value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return showErr('Enter a valid email address.');
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) return showErr(codeError(error));
  pendingEmail = email;
  $('#codeLabel').textContent = `Code sent to ${email} (check spam too)`;
  step('#codeForm'); $('#code').focus();
});

$('#codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { data, error } = await sb.auth.verifyOtp({ email: pendingEmail, token: $('#code').value.trim(), type: 'email' });
  if (error) return showErr('That code is not right or has expired. Go back and request a new one.');
  session = data.session;
  showForm();
});

$('#applyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$('#adult').checked || !$('#ackNotice').checked || !$('#ackVetting').checked) return showErr('Tick the three required boxes to apply.');
  const airport = document.querySelector('input[name=airport]:checked');
  if (!airport) return showErr('Choose the airport you will work from.');
  $('#applyBtn').disabled = true;
  try {
    const { data: { session: s } } = await sb.auth.getSession();
    const res = await fetch('/api/drivers/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(s || session).access_token}` },
      body: JSON.stringify({
        name: $('#name').value, phone: $('#phone').value,
        vehicle_type: document.querySelector('input[name=vehicle]:checked').value,
        vehicle_model: $('#model').value, plate: $('#plate').value, base_airport: airport.value,
        adult: true, privacy_notice: true, vetting: true, marketing: $('#ackMarketing').checked,
        privacy_version: privacyVersion
      })
    });
    const out = await res.json();
    if (!res.ok) return showErr(out.error);
    step('#done');
  } catch {
    showErr('We could not reach Akwaaba. Check your connection and try again.');
  } finally { $('#applyBtn').disabled = false; }
});

(async () => {
  const [cfg, areas] = await Promise.all([loadConfig(), fetch('/api/areas').then((r) => r.json())]);
  privacyVersion = areas.privacy_version;
  $('#airports').innerHTML = areas.airports.map((a) =>
    `<label class="choice"><input type="radio" name="airport" value="${esc(a.code)}"><b>${esc(a.city)}</b><small>${esc(a.name)} (${esc(a.code)})</small></label>`).join('');
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await sb.auth.getSession();
  session = data.session;
  if (session) showForm();
})();
