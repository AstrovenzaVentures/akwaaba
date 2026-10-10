// Shared helpers for the Woezor pages.
export async function loadConfig() {
  const res = await fetch('/api/config');
  return res.json();
}

export const ghs = (n) => 'GHS ' + Number(n).toLocaleString('en-GH', { maximumFractionDigits: 0 });
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// WhatsApp chat link with a ready-written message. Phone in +233... form.
export function waLink(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
export const telLink = (phone) => `tel:${String(phone || '').replace(/[^\d+]/g, '')}`;

// Subscription state from the paid-until date. "soon" = 3 days or fewer left.
export const SUB_WARN_DAYS = 3;
export function subStatus(subUntil, now = Date.now()) {
  if (!subUntil) return { state: 'never', days: 0, until: null };
  const until = new Date(subUntil);
  const ms = until.getTime() - now;
  if (ms <= 0) return { state: 'expired', days: 0, until };
  const days = Math.ceil(ms / 864e5);
  return { state: days <= SUB_WARN_DAYS ? 'soon' : 'active', days, until };
}
export const fmtDay = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const fmtWhen = (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
