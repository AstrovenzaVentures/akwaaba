const $ = (s) => document.querySelector(s);
const ref = new URLSearchParams(location.search).get('reference') || new URLSearchParams(location.search).get('trxref');

async function check(attempt = 0) {
  if (!ref) { $('#title').textContent = 'No payment found'; $('#body').textContent = 'Open this page from the Paystack checkout.'; return; }
  try {
    const res = await fetch(`/api/payments/verify?reference=${encodeURIComponent(ref)}`);
    const out = await res.json();
    if (out.status === 'paid') {
      $('#title').textContent = 'Subscription paid';
      $('#body').textContent = 'Your Akwaaba subscription is active for another 30 days. You will receive pickups for your vehicle.';
      return;
    }
    if (out.status === 'pending' && attempt < 6) { setTimeout(() => check(attempt + 1), 2500); return; }
    $('#title').textContent = out.status === 'pending' ? 'Payment not confirmed yet' : 'Payment needs checking';
    $('#body').textContent = out.status === 'pending'
      ? 'Paystack has not confirmed your payment yet. If money left your account, refresh this page in a minute.'
      : 'Something did not match on this payment. Contact astrovenzav@gmail.com with your payment reference: ' + ref;
  } catch {
    $('#title').textContent = 'Could not check your payment';
    $('#body').textContent = 'Check your connection and refresh this page.';
  }
}
check();
