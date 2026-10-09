// Privacy notice version and protection of traveller details before they reach the database.
import { encryptField, blindIndex } from './pii-crypto.js';

// Must match "**Version:**" in docs/privacy-policy.md (the build and the tests check this).
// Raise it whenever the policy changes in a way travellers or drivers need to know about.
export const PRIVACY_NOTICE_VERSION = '1.0';

// Encrypted columns, bound to their column name so a value cannot be moved to another column.
export function protectBooking({ name, phone, email, address }) {
  return {
    passenger_name_enc: encryptField(name, 'bookings.passenger_name'),
    passenger_phone_enc: encryptField(phone, 'bookings.passenger_phone'),
    passenger_email_enc: encryptField(email, 'bookings.passenger_email'),
    dest_address_enc: encryptField(address, 'bookings.dest_address'),
    passenger_phone_hash: blindIndex(phone)
  };
}

// consent_events and abuse_flags identify people by this hash, never by their phone number.
export const subjectHash = (phone) => blindIndex(phone);
