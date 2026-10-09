// Shared helpers for the Akwaaba pages.
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
