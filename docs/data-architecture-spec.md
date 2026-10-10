# Woezor Data Management and Security Architecture Specification

**Owner:** Astrovenza Ventures (data controller)
**Audience:** developers and operators of the Woezor codebase (`akwaaba-backend`)
**Companion document:** `docs/privacy-policy.md`. Every behaviour described in the policy must be true in the code. When one changes, update the other.

**Status legend used throughout**

| Tag | Meaning |
|---|---|
| **[BUILT]** | Already in the codebase |
| **[READY]** | Code written and tested in this repo (`supabase/migrations/002_privacy.sql`, `lib/pii-crypto.js`), but not yet wired into the endpoints |
| **[LAUNCH]** | Required before taking real bookings |
| **[PHASE 2]** | Required only when the matching feature is built: live GPS, ID-verification API, masked calls, native apps |

---

## 1. Regulatory map

| Requirement | Source | What it means for this codebase |
|---|---|---|
| Register with the DPC before processing; renew every 2 years | Act 843 s.47, s.50, s.53 | **[LAUNCH]** Operational task. The app must not go live before the registration number is in the privacy policy |
| Collect only what is necessary, relevant and not excessive | Act 843 s.19; GDPR Art. 5(1)(c) | Schema review in §3. No live GPS, no ID images, no payment tokens |
| Collect directly from the person; tell them the s.27(2) particulars before collection | Act 843 s.21, s.27 | Just-in-time notice on forms (§6.1) |
| Lawful basis per purpose | Act 843 s.20; GDPR Art. 6 | Purpose and basis table in the privacy policy §5 |
| Special personal data (children, criminal behaviour, health) | Act 843 s.37 | Police clearance results: consent-gated (§8). No child identities collected |
| Marketing only with prior written consent | Act 843 s.40 | Unticked opt-in box plus consent ledger (§6) |
| Retention no longer than necessary, then destroy or de-identify | Act 843 s.24; GDPR Art. 5(1)(e) | Purge jobs (§5) |
| Security safeguards; written contracts with processors | Act 843 s.28, s.30; GDPR Art. 28, 32 | §4, §9, §10, §13 |
| Breach notice to DPC and data subjects "as soon as reasonably practicable" | Act 843 s.31 | Runbook (§11). Internal SLA 72 hours |
| Breach notice to supervisory authority within 72 hours | GDPR / UK GDPR Art. 33 | Same runbook |
| Access within 40 days; reply to objections within 21 days | Act 843 s.35(10), s.39(2) | DSAR register with a 30-day due date (§12) |
| Foreign data subjects: process per their home law | Act 843 s.18(2); GDPR Art. 3(2) | Apply GDPR-grade controls to everyone; one standard is simpler than two |
| EU/UK representative if offering services to people there | GDPR / UK GDPR Art. 27 | **[LAUNCH]** Decide and document: appoint, or record why the Art. 27(2) exemption applies |
| Payment services need a Bank of Ghana licence | Act 987 | Woezor does **not** provide payment services. Fares go traveller to driver; subscriptions are collected through Paystack (BoG PSP Enhanced licence). Keep it that way: never hold or route fares |
| Critical Information Infrastructure duties (24-hour incident reporting) | Act 1038; CSA CII Directive (2021) | Applies only if Woezor is designated as CII, which is unlikely at this scale. Report incidents to CERT-GH voluntarily (§11) |

---

## 2. Current-state assessment (CISO review of the codebase)

### 2.1 Data inventory

| Table.column | Class (§3.1) | Purpose | Today | Target |
|---|---|---|---|---|
| `bookings.passenger_name` | P2 | Name sign | Plaintext | Encrypted (`passenger_name_enc`); purged at 90 days |
| `bookings.passenger_phone` | P2 | Driver contact; clash check | Plaintext | Encrypted plus blind index (`passenger_phone_hash`); purged at 90 days |
| `bookings.passenger_email` | P2 | Optional receipt | Plaintext | Encrypted; purged at 90 days |
| `bookings.dest_address` | P2 | Driver destination | Plaintext | Encrypted; purged at 90 days |
| `bookings.flight, arrival_*` | P3 | Dispatch | Plaintext | Keep (not identifying once name and phone are purged) |
| `bookings.area, zone, fare_*, status, *_at` | P3 | Operations, statistics | Plaintext | Keep (anonymous after purge) |
| `drivers.name, phone, email, plate` | P2 | Account, contact | Plaintext | Phone stays plaintext (Supabase Auth needs it); email encrypted |
| `payments.*` | P3 | Subscription accounting | Plaintext | Keep 6 years; contains no card data |
| `audit_log.*` | P3 | Accountability | Plaintext | 2-year purge |
| Vercel and Supabase logs | P3 | Security | Provider default | ≤ 90 days; no PII in log lines |

### 2.2 Findings

| # | Severity | Finding | Fix | Status |
|---|---|---|---|---|
| F1 | **High** | **Driver phone numbers can be harvested.** `POST /api/bookings/initialize` is unauthenticated and returns the assigned driver's phone number. A script can create fake bookings and collect every driver's number, and each fake booking also blocks a driver for 3 hours | Verify the traveller's phone by one-time SMS code before confirming a booking, and only then reveal the driver's contact. Rate-limit by IP and by phone hash. Long-term: contact masking (§10) | **[LAUNCH]** |
| F2 | **High** | Passenger PII is stored in plaintext and kept forever | Field encryption and the 90-day purge job | **[READY]** |
| F3 | Medium | Every page load sends visitors' IP addresses to Google Fonts and jsDelivr. These are third-party transfers that aren't needed (German courts have treated remotely loaded Google Fonts as a GDPR breach) | Self-host the fonts and `supabase.js` under `/public` (§9.3) | **[LAUNCH]** |
| F4 | Medium | The Vercel functions region is not set, so the provider default applies (US East for new projects), while the database is planned for the EU. PII crosses the Atlantic on every request | Pin functions to the database region (§9.4) | **[LAUNCH]** |
| F5 | Medium | No consent capture, no notice version stored, no marketing opt-in record | Consent ledger and form changes (§6) | **[READY]** schema; UI **[LAUNCH]** |
| F6 | Medium | No process or tooling for access and erasure requests | DSAR register and `erase_traveller()` (§12) | **[READY]** |
| F7 | Low | Error logging uses `err.message`. Postgres errors can echo values (for example `Key (plate)=(GR 1234-22)`) | Log redaction (§9.2) | **[LAUNCH]** |
| F8 | Low | No rate limits on `/api/quote` or `/api/bookings/initialize` | Vercel Firewall rate-limit rules (§9.1) | **[LAUNCH]** |
| F9 | Info | Driver vetting is done offline with no structured record | `driver_vetting` table (§8) | **[READY]** |

---

## 3. Data model

### 3.1 Classification

| Class | Examples | Rules |
|---|---|---|
| **P0 Secret** | API keys, `PII_ENC_KEYS`, `PII_INDEX_KEY`, Supabase service role key | Vercel environment variables marked Sensitive only. Never in code, logs or client |
| **P1 Sensitive** | Police clearance result, ID document numbers, ▣ location trails | Store results or hashes only; access logged; strictest retention |
| **P2 Personal** | Names, phone numbers, emails, addresses | Encrypted at field level; minimum-necessary display; retention-bound |
| **P3 Operational** | Flight, area, fare, statuses, payment references | Normal access control |
| **P4 Public** | Airports, zones, fares | No restriction |

### 3.2 Migration `supabase/migrations/002_privacy.sql` **[READY]**

The migration is tested (`npm run test:privacy`, 17 checks) and can be re-run safely. It adds:

| Object | Purpose |
|---|---|
| `bookings.*_enc` columns | AES-256-GCM ciphertext for name, phone, email and address |
| `bookings.passenger_phone_hash` + index | HMAC blind index for matching without plaintext (one-airport rule, erasure lookups, abuse checks) |
| `bookings.privacy_notice_version`, `pii_purged_at` | Evidence of which notice applied; purge marker |
| `consent_events` (append-only, enforced by trigger) and the `consent_current` view | Consent ledger |
| `dsar_requests` | Register of data subject requests with a 30-day due date |
| `abuse_flags` | No-show and blocked-booking history kept as hashes, 12 months |
| `driver_vetting` | Vetting results with no document images; `doc_last4` cannot hold a full number |
| `purge_expired_booking_pii()`, `purge_expired_abuse_flags()`, `purge_old_audit_log()`, `purge_old_consent_events()`, `erase_traveller()` | Retention and erasure. The booking purge and erasure write to `audit_log`; the consent purge is the only code allowed to delete from the consent ledger |
| RLS enabled on all new tables, with no policies | Only the backend's service role can read them |

### 3.3 Soft delete versus erasure

A `deleted_at` flag is **not** erasure under Act 843 s.24 or GDPR Art. 17: the data is still there. The design rules are:

1. **Booking PII is overwritten with `NULL`** (purge or erasure), and the anonymous trip facts stay for statistics. That counts as de-identification "in a manner that prevents its reconstruction in an intelligible form" (s.24).
2. **Driver accounts:** when a driver leaves, set `drivers.status = 'suspended'` immediately to stop dispatch. After 2 years, delete the `auth.users` row; the cascade removes the `drivers` and `driver_vetting` rows. Before deleting, re-point the driver's past bookings to a single placeholder "former driver" row, or make `bookings.driver_id` nullable, so trip statistics remain.
3. **Backups** keep deleted data until they rotate. State the backup window in the privacy policy (§9 there: [● 30] days) and do not restore deleted personal data from a backup. After any restore, re-run the purge and erasure jobs.

### 3.4 Cut-over steps for encrypted fields **[BUILT]** (steps 3 to 5 are in the code; do steps 1, 2 and 6)

1. Generate keys once, on a trusted machine:
   ```bash
   node -e "console.log('v1:' + require('crypto').randomBytes(32).toString('base64'))"   # PII_ENC_KEYS
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"           # PII_INDEX_KEY
   ```
   Add both to Vercel as Sensitive variables. Store an offline copy in a password manager that two directors can access. **If the keys are lost, the encrypted data is gone.**
2. Apply `002_privacy.sql`.
3. In `api/bookings/initialize.js`, write the `*_enc` fields with `encryptField(value, 'bookings.<column>')` and `passenger_phone_hash` with `blindIndex(phone)`. Stop sending the plaintext columns.
4. In `create_booking()`, change the one-airport check to compare hashes:
   ```sql
   -- replace:  where b.passenger_phone = p->>'passenger_phone'
   where b.passenger_phone_hash = p->>'passenger_phone_hash'
   ```
   and insert `passenger_phone_hash`, the `*_enc` columns and `privacy_notice_version` in place of the plaintext columns.
5. In `api/drivers/trips.js`, select the `*_enc` columns and decrypt them server-side, **only for the signed-in driver's own trips** (the existing `.eq('driver_id', driver.id)` filter). Never send ciphertext or keys to the browser.
6. Backfill existing rows with a one-off script (read the plaintext, write ciphertext and hash, set the plaintext to `NULL`). Then add `check (passenger_phone is null)` constraints so plaintext cannot come back.

What **not** to encrypt: columns used by RLS policies, joins or range queries (`driver_id`, `arrival_date`, `status`, `airport`). Use blind indexes for equality lookups on encrypted values.

### 3.5 Field-level encryption module `lib/pii-crypto.js` **[READY]**

- AES-256-GCM, 96-bit random IV, authentication tag checked on every decrypt.
- **Associated data = column name.** A ciphertext copied into another column fails to decrypt, so a bug or an attacker cannot swap an address into a name field.
- **Key versioning:** values are stored as `v1:<iv>:<tag>:<ciphertext>`. Set `PII_ENC_KEYS="v2:...,v1:..."` to rotate. New writes use the first key; old values stay readable. `needsRotation()` lets a background job re-encrypt old values.
- **Blind index:** HMAC-SHA256 with a separate key (`PII_INDEX_KEY`) and a purpose prefix, so phone and email hashes never match each other. Normalise phone numbers to `+233...` with `normalPhone()` before hashing.
- Tests: `test/pii-crypto.test.js`, covering round trip, tamper detection, column binding, rotation and malformed keys.

```js
import { encryptField, decryptField, blindIndex } from '../lib/pii-crypto.js';
const phone = normalPhone(input);                        // '+233244112087'
row.passenger_phone_enc  = encryptField(phone, 'bookings.passenger_phone');
row.passenger_phone_hash = blindIndex(phone);            // for matching only
// later, server-side, for the assigned driver only:
const shown = decryptField(row.passenger_phone_enc, 'bookings.passenger_phone');
```

### 3.6 ▣ Location telemetry isolation **[PHASE 2]**

Keep location data in a separate schema with no personal columns, joined only by trip id:

```sql
create schema if not exists telemetry;
create table telemetry.trip_points (
  booking_id  uuid not null,            -- no name or phone here
  driver_id   uuid not null,
  recorded_at timestamptz not null,
  lat         numeric(8,5) not null,    -- 5 decimals = about 1 m; do not store more precision than needed
  lng         numeric(8,5) not null,
  accuracy_m  smallint,
  primary key (booking_id, recorded_at)
);
alter table telemetry.trip_points enable row level security;
-- A traveller sees only the latest point of their own active trip, through a server endpoint, never this table directly.
-- Retention: 30 days.
select cron.schedule('purge-trip-points', '30 2 * * *',
  $$delete from telemetry.trip_points where recorded_at < now() - interval '30 days'$$);
```

---

## 4. Access control

| Actor | Can read | Can change | Enforced by |
|---|---|---|---|
| Traveller (no account) | Only what their own booking response returns | Create a booking | Server endpoint; no direct database access |
| Driver | Own profile; own trips (decrypted passenger fields server-side) | Own trip status, one step forward | `requireDriver()`, `.eq('driver_id', ...)`, RLS policies **[BUILT]** |
| Operator (staff) | Bookings and drivers needed for support | Driver approval, fares, DSAR handling | Password plus authenticator (`aal2`), `requireStaff()` **[BUILT]**, `audit_log` |
| Admin (staff) | Everything above, plus keys | Key rotation, erasure | Two directors only |
| Backend service role | Everything | Everything | Never exposed to a browser **[BUILT]** |

Rules:
- Staff lookups of a traveller's details are logged in `audit_log` with the reason. **[LAUNCH]**
- No shared staff accounts; each person has their own authenticator. **[BUILT]**
- Review staff access every quarter and remove leavers the same day.

---

## 5. Retention schedule (implementation)

| Data | Rule | Mechanism |
|---|---|---|
| Booking PII (name, phone, email, address, hashes) | Null out 90 days after `arrival_date`, for closed trips | `purge_expired_booking_pii(90)` daily |
| Open trips past their date (stuck `assigned` etc.) | Staff close them as `cancelled` or `no_show` within 7 days, then the purge picks them up | Weekly staff report **[LAUNCH]** |
| Abuse flags | 12 months | `purge_expired_abuse_flags()` daily |
| Audit log | 2 years (purge records kept) | `purge_old_audit_log()` monthly |
| Consent records | Current choice kept while it applies; superseded records after 2 years; everything 2 years after a withdrawal | `purge_old_consent_events()` monthly |
| Subscription payments | 6 years from the end of the year (Act 915) | Yearly review; delete rows older than 6 full years |
| Driver accounts | 2 years after leaving | Manual quarterly review, §3.3 |
| Vercel and Supabase logs | ≤ 90 days | Provider settings; check the plan's log retention |
| ▣ Trip points | 30 days | §3.6 |

Schedule with `pg_cron` (enable it in Supabase: Database > Extensions > `pg_cron`):

```sql
select cron.schedule('purge-booking-pii', '15 2 * * *', $$select purge_expired_booking_pii(90)$$);
select cron.schedule('purge-abuse-flags', '20 2 * * *', $$select purge_expired_abuse_flags()$$);
select cron.schedule('purge-audit-log',   '0 3 1 * *',  $$select purge_old_audit_log()$$);
select cron.schedule('purge-consents',    '10 3 1 * *', $$select purge_old_consent_events()$$);
```

Check `audit_log` for a `retention_purge` row every day. If one is missing, the job did not run.

---

## 6. Consent architecture

### 6.1 Traveller booking form **[BUILT]**

Consent is **not** the legal basis for the booking itself; that is the contract (privacy policy §5). Don't make people "consent" to what the service needs. Show a notice, and ask for consent only for optional extras.

Put this directly above the **Book pickup** button:

> We use your name, phone number and trip details to arrange your pickup. Your driver will see your name, phone number and drop-off address. We keep these details for 90 days after your trip. [Privacy policy](/privacy)
>
> ☐ I am 18 or over. *(required)*
>
> ☐ Send me occasional offers from Woezor by email or SMS. *(optional, unticked)*

Implementation:
- Store `privacy_notice_version` (for example `'1.0'`) on the booking.
- If the marketing box is ticked, insert `consent_events(subject_type='traveller', subject_hash=blindIndex(phone), purpose='marketing', granted=true, notice_version, source='booking_form')`. If it is not ticked, store nothing. Absence means no consent.
- Every marketing message carries an unsubscribe link, which inserts a `granted=false` event. Read the current state from `consent_current` before every send.
- Never pre-tick the box, never bundle it with the booking, and never make the booking depend on it (Act 843 s.40 "prior written consent"; GDPR Art. 7).

### 6.2 Driver onboarding **[BUILT]** in the driver app (withdrawal is by email for now)

The onboarding form shows three separate, unticked items:

1. **Privacy notice acknowledgement** (`purpose='privacy_notice'`). Required to continue.
2. **Vetting consent** (`purpose='driver_vetting'`): "I agree that Woezor may check my Ghana Card, driver's licence, DVLA registration and police clearance, and keep the results (not copies of the documents) while I drive with Woezor and for 2 years after." Required for approval, because police clearance is special personal data under s.37. Link the event's id from each `driver_vetting` row.
3. **Marketing** (`purpose='marketing'`). Optional.

Withdrawal: a driver can withdraw vetting consent at any time. The system then sets `status='suspended'`, because the driver can no longer be approved, and tells the driver in plain words before they confirm.

### 6.3 Push notifications **[PHASE 2]**

- Ask for browser or OS notification permission **only after a related action**, for example after a driver taps "Notify me of new pickups". Never ask on page load.
- Record `consent_events(purpose='push_notifications')`. Store the push subscription encrypted.
- Trip notifications are service messages; marketing pushes need the separate marketing consent.

### 6.4 Consent receipt

After any consent change, show what was recorded and when: "Marketing messages: off, since 9 Oct 2026". The `consent_events` row is the audit evidence; the table cannot be edited or deleted (trigger in `002_privacy.sql`).

---

## 7. Geolocation permission lifecycle

### 7.1 Current build **[BUILT]**

- The app collects **no** location from anyone. The page's `Permissions-Policy` header sets `geolocation=()`, which blocks location access completely.
- Travellers send their drop-off location to the driver themselves, through WhatsApp. That data never reaches Woezor.

### 7.2 ▣ When live driver location is built **[PHASE 2]**

| | Traveller | Driver |
|---|---|---|
| Collected | Nothing | Position during an active trip only |
| Starts | n/a | When the trip moves to `assigned`, on the trip day, and the driver taps **Start sharing location** |
| Stops | n/a | Automatically at `done`, `no_show` or `cancelled`, or when the driver taps **Stop** |
| Frequency | n/a | Every 10 s while moving, every 60 s when stationary; never while off-trip |
| Precision | n/a | 5 decimal places (about 1 m) stored; shown to the traveller only while the driver is heading to the pickup |
| Retention | n/a | 30 days (§3.6) |

Platform rules:
- **Web app (current):** the browser Geolocation API works only while the page is open and in the foreground. Use `watchPosition` from the **Start sharing** button and `clearWatch` on trip end. Change `Permissions-Policy` to `geolocation=(self)` only on `/driver`.
- **Android (native, if built):** request `ACCESS_FINE_LOCATION` when the driver starts a trip. Avoid `ACCESS_BACKGROUND_LOCATION`; use a **foreground service of type `location`** with a persistent notification ("Woezor is sharing your location for trip WZR-7Q3K"). That keeps working when the screen is off, without the background permission, and passes Play Store review more easily.
- **iOS (native, if built):** request **When In Use** only, with `NSLocationWhenInUseUsageDescription` naming the purpose. Enable background location updates for active trips; iOS then shows the blue location indicator, which is the right transparency for drivers. Do not request **Always**.
- **Revocation:** if the driver revokes permission mid-trip, the trip continues without location; the app shows "Location sharing is off", and dispatch never penalises the driver for it.
- **Travellers:** never request a traveller's location.

---

## 8. Driver verification data handling **[LAUNCH]** manual, **[PHASE 2]** API

### 8.1 Principle

Store **the result of a check**, not **copies of documents**. A copy of a Ghana Card is a high-value target and adds nothing once the check is done.

### 8.2 Manual flow (launch)

1. The driver records vetting consent (§6.2).
2. A staff member meets the driver and checks the **originals**: Ghana Card, driver's licence, DVLA ride-hailing sticker or registration, vehicle documents, and a police clearance report issued in the last 6 months.
3. Staff record one `driver_vetting` row per check:
   - `result`: `pass` / `fail` / `expired` / `manual_review`
   - `provider`: `'staff_visual_check'`
   - `doc_number_hash`: `blindIndex(docNumber, 'ghana_card')`, to detect the same card on two accounts
   - `doc_last4`: last 4 characters only (the database rejects anything longer)
   - `expires_on`: the document's expiry date
   - `checked_by`: the staff user id
4. **No photos, scans or photocopies** are taken or stored. If a scan is unavoidable (for example a regulator requires one), see §8.4.
5. Approve the driver (`status='approved'`) only when every required check has a `pass` row.
6. A monthly job lists documents that expire within 30 days; staff ask the driver to renew, and suspend if they don't.

### 8.3 ▣ API flow (Phase 2)

1. The driver enters their Ghana Card number and takes a live selfie in the app.
2. **Our server** sends them to an NIA-authorised verification provider over TLS. The browser never calls the provider directly, so the provider credentials stay on the server.
3. Keep only `result`, `provider`, `provider_ref` (the provider's transaction id), `doc_number_hash`, `doc_last4` and `checked_at`.
4. Hold the selfie and card number in memory only. Never write them to disk, logs or the database. Wrap the call so that error logs cannot include the request body.
5. The provider contract (Act 843 s.30) must state the provider's own retention period for the images, and that they are not used for any other purpose.

### 8.4 If document images must be kept

- Use a **private** Supabase Storage bucket with no public URLs, readable only by the service role.
- Encrypt each file with `encryptField` before upload (or a per-file key wrapped by `PII_ENC_KEYS`).
- Access only through a staff endpoint that writes to `audit_log`, using signed URLs valid for 60 seconds.
- Delete automatically 30 days after the vetting decision.

---

## 9. Platform hardening

### 9.1 Rate limits **[LAUNCH]**

Vercel Firewall rules (or Upstash rate-limit middleware):
- `/api/quote`: 30 requests a minute per IP.
- `/api/bookings/initialize`: 5 an hour per IP, and 3 open bookings per phone hash.
- Driver SMS sign-in: Supabase Auth rate limits (keep the defaults or tighten them).

### 9.2 Logging rules **[LAUNCH]**

- Log ids, references and outcomes, never names, phone numbers, emails, addresses, codes or tokens.
- Wrap `console.error` in `lib/http.js` with a redactor:
  ```js
  const redact = (s) => String(s)
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[phone]')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/Key \(.*?\)=\(.*?\)/g, 'Key ([redacted])');
  console.error('[woezor]', redact(err?.message || err));
  ```
- Set log retention to ≤ 90 days in Vercel and Supabase.

### 9.3 Third-party requests **[LAUNCH]**

- Download the three font families (Barlow Condensed, IBM Plex Sans, IBM Plex Mono; all SIL Open Font Licence) as `.woff2` into `public/fonts/` and declare them with `@font-face` in `styles.css`. Remove the `fonts.googleapis.com` links.
- Copy `@supabase/supabase-js/dist/umd/supabase.js` into `public/vendor/` and load it from there.
- Then tighten the content security policy in `vercel.json` to `font-src 'self'`, `style-src 'self' 'unsafe-inline'`, `script-src 'self'`.

### 9.4 Data residency **[LAUNCH]**

- Choose the Supabase region once, at project creation; it cannot be changed later. EU (Ireland or Frankfurt) suits both Ghanaian latency and GDPR.
- Pin Vercel functions to the same area. In `vercel.json`: `"regions": ["fra1"]` for Frankfurt (or `dub1` for Dublin), matching the database.
- Record both regions in the privacy policy §8 and in the DPC registration.

### 9.5 Existing controls **[BUILT]**

Server-side pricing; Paystack webhook signature, amount and currency checks; one-time payment application; RLS on every table; staff password plus authenticator; HSTS, CSP, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`; no card data stored.

---

## 10. Contact masking protocol

### 10.1 Today **[BUILT]**

Real phone numbers are exchanged: the traveller receives the driver's WhatsApp number and the driver sees the traveller's number. This is disclosed in privacy policy §6, but it is the largest remaining privacy exposure (finding F1).

### 10.2 Interim control **[LAUNCH]**

1. **Verify the traveller's phone first.** Send a 6-digit SMS code before confirming the booking (a short-lived record holding a code hash and attempt counter; 5 attempts; code valid 10 minutes). This stops anonymous harvesting of driver numbers.
2. **Reveal the driver's number only from 24 hours before landing.** Until then, the confirmation shows the driver's name, car and plate. The number appears on a page opened with the booking code plus the verified phone.
3. **Expiry message:** the booking page stops showing the number 2 hours after the trip ends.

### 10.3 ▣ Masked calls and messages **[PHASE 2]**

| Option | How it works | Pros | Cons |
|---|---|---|---|
| **A. Virtual numbers** (programmable-voice provider with Ghana numbers) | Each trip gets a temporary number pair; calls and SMS are bridged, so neither side sees the real number | Works on any phone, no app needed | Per-minute and number rental costs; confirm Ghana number availability with the provider |
| **B. In-app calling and chat** (WebRTC, for example a hosted real-time voice SDK) | Calls and messages run inside the Woezor app; no phone numbers exchanged | Lowest cost per call; full control | Needs data on both sides (arriving travellers often have no local data plan yet) |
| **C. Both** | B by default, with A as fallback when there's no data | Best experience | Most build effort |

**Recommended: C**, starting with A for the airport pickup itself, because travellers often have no local data on landing.

Session lifecycle (A or B):

```
assigned ──(24 h before landing)──▶ session_open ──(trip done/no_show/cancelled + 2 h)──▶ session_closed
```

- Map `booking_id → (masked number or room id, traveller real number, driver real number)` in a `contact_sessions` table. Encrypt the real numbers (§3.5).
- Calls are **not recorded**. Keep call metadata only (time, duration, which side called) for 90 days.
- **Location sharing:** once option B is built, add a one-time **Share drop-off pin** in the app. It sends a single coordinate, which the driver sees only for that trip and which is deleted 30 days after the trip. It replaces the WhatsApp step.

---

## 11. Breach and incident response runbook

### 11.1 Roles

| Role | Who | Duty |
|---|---|---|
| Incident lead | [● director] | Decides severity, owns the timeline, signs off on notices |
| Technical lead | [● developer] | Contains, investigates, preserves evidence |
| Communications | [● director] | Drafts notices to people, regulators and drivers |
| Legal adviser | [● Ghana counsel] | Advises on notification duties |

### 11.2 Timeline (T = when Woezor becomes aware)

| When | Action |
|---|---|
| T + 1 h | Open an incident record (what, when, how found). Contain: rotate exposed keys (Paystack, Supabase service role, `PII_*` keys), revoke sessions, block attackers' IPs, disable affected endpoints |
| T + 24 h | Scope: which tables and rows, how many people, which countries (UK/EU people mean GDPR duties). Preserve logs. Report cyber incidents to **CERT-GH** (Cyber Security Authority): report@csa.gov.gh, SMS **292**, or https://csa.gov.gh/report. If Woezor has been designated CII, this report is mandatory within 24 hours |
| T + 72 h (target) | Notify the **Data Protection Commission** (Act 843 s.31: "as soon as reasonably practicable"). Where GDPR or UK GDPR applies: notify the **ICO** or the relevant EU authority **within 72 hours** (Art. 33), unless the breach is unlikely to result in risk. Notify **affected people** (Act 843 s.31 in all cases; GDPR Art. 34 where the risk is high) |
| T + 30 days | Post-incident review: root cause, fixes, policy and spec updates |

Notify affected people by SMS or email, or on the website or in the media if contact details are missing (the methods s.31 allows). Delay telling them only if the DPC or a security agency asks, for a criminal investigation.

### 11.3 Notice template (people affected)

> **Subject: Important: your Woezor data**
> On [date] we discovered that [what happened, in one sentence]. The information involved was [list]. [Payment card or mobile money details were not involved, because Woezor does not hold them.] We have [what we did]. To protect yourself, [specific steps, for example: be cautious of calls claiming to be from Woezor asking for money]. If we know who obtained the data, we will tell you. Questions: privacy@[●]. You can also complain to the Data Protection Commission (dataprotection.org.gh).

### 11.4 Processors

Contracts must require Supabase, Vercel, Paystack and the SMS, verification and telephony providers to tell Woezor of any breach affecting our data **without undue delay**, and in any case within 48 hours, so we can meet our own 72-hour target.

---

## 12. Data subject request handling **[READY]** schema, **[LAUNCH]** process

1. A request arrives by email. Log it in `dsar_requests` with `subject_hash = blindIndex(phone)`. `due_at` defaults to 30 days.
2. **Verify identity** (Act 843 s.32): send a one-time code by SMS to the phone number on the booking or account, and set `identity_verified_at`. Don't verify by asking for ID documents. Don't send data to a different phone or email from the one we hold.
3. Fulfil it:
   - **Access / portability:** export every row matching the hash (decrypted server-side) as JSON, with the purposes, recipients and retention from the privacy policy.
   - **Correction:** update the field; log it in `audit_log`.
   - **Erasure:** `select erase_traveller('<hash>')`. Open trips cannot be erased until they close. Payment records (drivers) stay for 6 years under Act 915; tell the person this. Keep any marketing opt-out record in the consent ledger (it holds only a hash), so the person is never messaged again; tell them this too.
   - **Objection (s.39):** reply in writing **within 21 days**.
   - **Marketing opt-out:** insert a `consent_events` row with `granted=false` straight away.
   - **Automated decision review (s.41):** a staff member reviews the assignment or block and replies.
4. Record `completed_at`, `outcome` and `handled_by`. Keep the register for 2 years.

---

## 13. Processor register **[LAUNCH]**

| Processor | Role | Data | Location | Contract / DPA | Transfer tool (GDPR) |
|---|---|---|---|---|---|
| Supabase Inc. | Database, auth, storage | All | [● region] + US support | Sign Supabase DPA | SCCs / DPF as applicable |
| Vercel Inc. | Hosting, functions, logs | Technical; PII in transit | [● fra1] + US | Accept Vercel DPA | SCCs / DPF as applicable |
| Paystack Payments Ltd | Subscription payments | Driver name, email, payment | Ghana / [●] | Merchant agreement and data terms | n/a (drivers in Ghana) |
| [● SMS provider] | Driver sign-in codes, ▣ traveller verification | Phone numbers | [●] | DPA | SCCs if outside UK/EU |
| [● email provider] | Booking emails | Name, email | [●] | DPA | SCCs if outside UK/EU |
| ▣ [● ID verification provider] | Ghana Card checks | ID number, selfie | [●] | DPA with image retention terms | n/a |
| ▣ [● telephony provider] | Masked calls | Phone numbers, call metadata | [●] | DPA | SCCs |

Each contract must cover (Act 843 s.30; GDPR Art. 28): acting only on our instructions, confidentiality, security measures, breach notice within 48 hours, sub-processor approval, deletion or return of data at the end, and audit cooperation.

---

## 14. Pre-launch checklist

**Legal and registration**
- [ ] Register Astrovenza Ventures with the DPC; put the number in the privacy policy (s.47, s.53). Diary renewal every 2 years (s.50).
- [ ] Optional but recommended: appoint a certified Data Protection Supervisor (s.58).
- [ ] Decide on UK/EU Art. 27 representatives, and document the decision.
- [ ] Ghana counsel review of the privacy policy. (Publishing at `/privacy` is built: `npm run build`.)
- [ ] Sign the processor DPAs (§13).

**Code**
- [ ] F1: traveller phone verification and delayed reveal of the driver's number (§10.2).
- [x] F2 code: encrypted bookings (`003_encrypted_bookings.sql`, `lib/privacy.js`, endpoints) and purge schedule (`004_retention_schedule.sql`). **To do:** run 002 to 004 in Supabase and add the two keys to Vercel.
- [x] F3: fonts and `supabase.js` self-hosted by `npm run build`; CSP allows this site only.
- [x] F4: Vercel functions pinned to `lhr1` (London), the same region as the Supabase database (`eu-west-2`).
- [x] F5: booking-form notice, 18-or-over confirmation and marketing opt-in; driver acknowledgement and vetting consent in the driver app (§6).
- [ ] F7: log redaction. F8: rate limits.
- [x] `npm test`, `npm run test:db`, `npm run test:privacy` all pass.

**Operations**
- [ ] Staff trained on the vetting procedure (§8.2) and DSAR handling (§12).
- [ ] Breach runbook roles filled in (§11.1); the contact list printed and stored offline.
- [ ] Quarterly access review in the calendar.
