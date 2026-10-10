import { ghs, esc, waLink } from '/common.js';

const $ = (s) => document.querySelector(s);

$('#pax').innerHTML = [1, 2, 3, 4, 5, 6, 7].map((n) => `<option>${n}</option>`).join('');
$('#pax').value = '2';
$('#arrivalDate').min = new Date().toISOString().slice(0, 10);
$('#againBtn').addEventListener('click', () => location.reload());

const airportCode = () => document.querySelector('input[name=airport]:checked').value;

function trip() {
  return {
    airport: airportCode(),
    area: $('#area').value,
    vehicle: document.querySelector('input[name=vehicle]:checked').value,
    extras: [...document.querySelectorAll('input[name=extra]:checked')].map((i) => i.value),
    arrival_time: $('#arrivalTime').value || undefined,
    pax: Number($('#pax').value), bags: Number($('#bags').value || 0)
  };
}

function showErr(msg) { $('#err').textContent = msg || ''; $('#err').hidden = !msg; }

// Drop-off areas for the chosen airport, grouped by zone.
let airports = [];
let privacyVersion = null; // version of the privacy notice shown on this page, sent with the booking
function fillAreas() {
  const a = airports.find((x) => x.code === airportCode());
  if (!a) { $('#area').innerHTML = '<option value="">No areas for this airport yet</option>'; return; }
  $('#area').innerHTML = `<option value="">Choose your area in ${esc(a.city)}</option>` + a.zones.map((z) =>
    `<optgroup label="${esc(z.label)}">${[...z.areas].sort().map((x) => `<option>${esc(x)}</option>`).join('')}</optgroup>`).join('');
  // Changing airport clears the old fare.
  $('#quote').innerHTML = '';
  $('#bookBtn').disabled = true;
  const board = $('#tripBoard');
  board.outerHTML = `<div id="tripBoard" class="note">Choose your drop-off area in ${esc(a.city)} to see the fare.</div>`;
}
(async () => {
  try {
    ({ airports, privacy_version: privacyVersion } = await (await fetch('/api/areas')).json());
    fillAreas();
  } catch {
    $('#area').innerHTML = '<option value="">Could not load areas. Refresh the page.</option>';
  }
})();
document.querySelectorAll('input[name=airport]').forEach((el) => el.addEventListener('change', fillAreas));

let quoteSeq = 0;
async function refreshQuote() {
  if (!$('#area').value) return;
  const seq = ++quoteSeq;
  $('#bookBtn').disabled = true;
  try {
    const res = await fetch('/api/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(trip()) });
    const q = await res.json();
    if (seq !== quoteSeq) return; // a newer request is on its way
    if (!res.ok) { $('#quote').innerHTML = ''; showErr(q.error); return; }
    showErr('');
    $('#tripBoard').outerHTML = `<div id="tripBoard" class="board">
      <div><span class="k">From</span><span class="v">${esc(q.airport)}</span></div>
      <div><span class="k">To</span><span class="v">${esc(q.area)}</span></div>
      <div><span class="k">Zone</span><span class="v">${esc(q.zone)}</span></div></div>`;
    $('#quote').innerHTML = q.lines.map((l) => `<div class="qline"><span>${esc(l.label)}</span><span>${ghs(l.ghs)}</span></div>`).join('') +
      `<div class="qtotal"><span>Total</span><span>${ghs(q.total_ghs)}</span></div>` +
      `<p class="hint">Pay this to your driver when you meet, in cash or by mobile money.</p>`;
    $('#bookBtn').disabled = false;
    $('#bookBtn').textContent = 'Book pickup, pay driver on arrival';
  } catch {
    showErr('We could not reach Woezor. Check your connection and try again.');
  }
}

let t;
const debounced = () => { clearTimeout(t); t = setTimeout(refreshQuote, 200); };
document.querySelectorAll('#area, input[name=vehicle], input[name=extra], #arrivalTime, #pax, #bags')
  .forEach((el) => el.addEventListener('change', debounced));

$('#bookBtn').addEventListener('click', async () => {
  const body = {
    ...trip(),
    flight: $('#flight').value, arrival_date: $('#arrivalDate').value, dest_address: $('#address').value,
    passenger_name: $('#name').value, passenger_phone: $('#phone').value, passenger_email: $('#email').value,
    confirm_adult: $('#adult').checked, marketing_opt_in: $('#marketing').checked, privacy_version: privacyVersion
  };
  if (!body.confirm_adult) { showErr('Please confirm you are 18 or over. Bookings must be made by an adult.'); return; }
  $('#bookBtn').disabled = true;
  showErr('');
  try {
    const res = await fetch('/api/bookings/initialize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json();
    if (!res.ok) { showErr(out.error); return; }
    const d = out.driver;
    const msg = `Hello ${d.name}, this is ${body.passenger_name} (Woezor booking ${out.booking_code}, flight ${body.flight.toUpperCase()} into ${out.fare.airport_name}). ` +
      `My drop-off is ${body.dest_address}, ${out.fare.area}. I am sending my exact location now.`;
    $('#bookingArea').hidden = true;
    $('#doneArea').hidden = false;
    $('#doneCode').textContent = out.booking_code;
    $('#doneText').innerHTML = `
      <p>Your driver is <strong>${esc(d.name)}</strong>${d.vehicle ? `, ${esc(d.vehicle)}` : ''} <span style="font-family:var(--mono)">${esc(d.plate)}</span>.</p>
      <p>Pay <strong>${ghs(out.fare.total_ghs)}</strong> to your driver when you meet, in cash or by mobile money.</p>
      <p><strong>Where to meet, ${esc(out.fare.airport_name)}:</strong> ${esc(out.fare.pickup_note)}</p>
      <div class="note" style="display:grid;gap:10px">
        <strong>Send your exact drop-off location to your driver on WhatsApp</strong>
        <span>Driver's WhatsApp: <span style="font-family:var(--mono);user-select:all">${esc(d.phone)}</span></span>
        <a class="btn btn-sign" href="${waLink(d.phone, msg)}" target="_blank" rel="noopener">Open WhatsApp chat with your driver</a>
        <span>In the chat, tap the attach button, choose <strong>Location</strong>, then send your drop-off point. Or share it from Google Maps: open the place, tap <strong>Share</strong>, and pick WhatsApp.</span>
      </div>
      <p class="hint">Keep your booking code. Your driver will hold a sign with your name at the arrivals exit.</p>`;
  } catch {
    showErr('We could not reach Woezor. Check your connection and try again.');
  } finally {
    $('#bookBtn').disabled = false;
  }
});
