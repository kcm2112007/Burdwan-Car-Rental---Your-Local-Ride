# Burdwan Car Rental — Your Local Ride

A working customer + admin booking platform. Both panels read and write the
**same live records** in a real Supabase (Postgres) database, so a booking
made on the customer side really appears in the admin dashboard, and admin
actions (assign partner, change status, set price) really update what the
customer sees on the tracking page — and it's genuinely saved, not just held
in the browser tab.

## ⚠️ Setup required before this works

1. Create a free project at **supabase.com** and run `supabase-setup.sql`
   in Supabase → SQL Editor (creates the `app_data` table AND the storage
   policies for documents).
2. In Supabase → **Storage**, create a new bucket named exactly
   `booking-documents`, set to **Private**. (This step is a dashboard click,
   not SQL — see the comment in `supabase-setup.sql`.)
3. Open `app.js`, fill in your Project URL and anon/publishable key near the
   top (`SUPABASE_URL` / `SUPABASE_ANON_KEY`).
4. In Admin → Pricing → **UPI payment**, enter your UPI ID to turn on "Pay
   Now". Leave it blank to keep only "Pay Later" available.
5. In Admin → Pricing → **Service areas**, review/add the coverage circles
   (center point + radius) that decide which pickup/drop locations are
   bookable. A few are pre-filled for Burdwan, Durgapur, Asansol and Kolkata.
6. Re-upload `index.html`, `app.js` and `supabase-setup.sql`.

Until steps 1–3 are done, the site still runs (so you can click around) but
nothing saves — a "Not saved — Supabase is not configured yet" toast appears
on save attempts.

## Pricing engine upgrade (latest)

- **Vehicle categories changed** to exactly 4: Hatchback, Sedan, SUV, Premium
  SUV (was 5, including "Premium" and "7-Seater"). Existing vehicles,
  partners and bookings using the old names are automatically remapped —
  "Premium" → "Premium SUV", "7-Seater" → "SUV" — the first time the site
  loads after this update.
- **Real pricing profiles per trip type**, each independently editable from
  Admin → Pricing (now tabbed: Local / Outstation / Airport / Routes /
  Night / Waiting / Extra Stop / Vehicles / Platform Margin / Additional):
  - **Local Rental** — 3 fixed packages per category (4hr/40km, 8hr/80km,
    12hr/120km) plus extra-km/extra-hour rates. Overage is billed by admin
    after the trip (it can't be known in advance), so it's shown as
    reference info on the booking, not added to the upfront estimate.
  - **Outstation** — per-km rate with a real minimum-billing floor
    (`max(actual km, minKmPerDay × days)`) plus a daily driver allowance.
    Also used as the fallback for One Way / Round Trip / Corporate / Airport
    Transfer whenever no fixed route matches.
  - **Airport** and **Routes** — admin-configured fixed fares. A booking's
    pickup/drop text is matched against these zone names (simple
    case-insensitive "contains" match — see limitations below); if matched,
    the fixed fare wins over per-km pricing. One-way and round-trip are
    configured separately.
  - **Night charge** — configurable start/end hour (wraps past midnight) and
    per-category surcharge, applied wherever it's relevant.
  - **Waiting** and **Extra Stop** — waiting rates are reference-only info
    (same reasoning as local overage — actual waiting time isn't known until
    the trip happens); extra stop is a flat charge added automatically when
    the customer named an additional stop.
- **Toll / parking / permits are never silently included.** Each fare
  breakdown shows them explicitly as "Included" or "Excluded — payable at
  actual," driven by admin settings (airport routes have their own
  toll/parking flags; outstation has a shared Included/Excluded toggle).
- **Gross platform margin**, not "profit."
  `gross_platform_margin = customer_fare − partner_payout − direct_platform_cost`,
  plus a margin % shown alongside it. Admin sets a target margin (5–30%,
  default 15%) as a reference figure — it's not auto-enforced on every
  booking, since real payouts vary by partner.
- **Price snapshot per booking.** The exact breakdown used at booking time
  is frozen onto that booking (`priceBreakdown`, `priceSource`). Changing
  pricing later never changes old bookings' fares.
- **Audit log for manual overrides.** Editing customer price, partner
  payout, additional charges, refund, or direct cost on a booking records
  old value → new value, who, when, and an optional reason, shown right on
  the booking detail page.
- **Homepage "Transparent Pricing" section** — shows real "starting from"
  figures pulled live from your configured rates (never invented), and
  falls back to "Contact us for a quote" for airport transfers if no route
  is configured yet.

**Known limitation, said plainly:** matching a booking to a fixed
route/airport fare is done by checking whether the pickup/drop address text
*contains* the configured zone name (e.g. "Burdwan") — not a proper
zone/geofence lookup. This is a reasonable approximation for a small set of
well-known routes, but it means a pickup address that happens to mention a
zone name for an unrelated reason could match unintentionally. A more
precise version would use the map's lat/lng against drawn zone boundaries
instead of text matching — a good next step if you add many overlapping
routes.

## What's new in this upgrade

- **Map-based location picking** — free OpenStreetMap map + search (via
  Nominatim, no API key needed) for pickup/drop, with a pin you can drag,
  a "use my location" button, and an approximate distance/time estimate.
  Nominatim's usage policy caps free search at roughly 1 request/second —
  fine for a small business site; if you outgrow it, switch to Google/Mapbox
  geocoding (paid) using the same `geocodeSearch()`/`reverseGeocode()`
  functions in `app.js` as the swap point.
- **Service-area validation** — pickup/drop are checked against admin-configured
  circles (not true district polygons — see "What's simplified" below). Out-of-area
  requests show a real "unavailable, request a custom quote" flow instead of
  silently failing.
- **Document/KYC upload** — dynamic per service mode (Chauffeur vs Self-Drive),
  admin-configurable in Pricing → Document requirements. Files go to a
  private Supabase Storage bucket; admins verify/reject with a reason;
  customers see live status.
- **Real UPI payment** — a genuine UPI deep-link QR (scannable by any UPI
  app) generated from your configured UPI ID and the booking amount. This is
  **not** a payment-gateway integration — there's no automatic webhook
  verification. The customer self-reports "I've paid," the booking shows
  "Payment Pending," and an admin manually confirms it against their bank/UPI
  app before marking it Paid. That's a deliberate, honest choice: a real
  auto-verifying gateway (Razorpay/Cashfree/PayU) needs your own merchant
  account and is a good next step once you have one.
- **Expanded status pipeline** — the full REQUEST_RECEIVED → ... →
  TRIP_COMPLETED flow plus cancellation-request/refund/failed branches, shown
  as "Booking Status Tracking" (not "real-time tracking," since there's no
  GPS).
- **Partner portal** (`#partner`) — partners log in with phone + a password
  you set from Partner Management, see bookings awaiting their acceptance,
  accept/reject, and move an accepted trip through Driver Assigned → On The
  Way → Arrived → Started → Completed. Only their own bookings are visible.
- **Vehicle document expiry alerts** — insurance/PUC/permit/fitness expiry
  dates on each vehicle, flagged on the admin dashboard when expired or due
  within 21 days.
- **Reviews** — customers can only review a booking of theirs marked Trip
  Completed, one review per booking.

## What's simplified or deferred (said plainly, not hidden)

- **Service areas are circles, not real district boundaries.** Good enough
  to genuinely gate bookings; a real polygon-based service area would need a
  GIS layer, which is a bigger addition than this pass covers.
- **No automatic payment verification.** As above — this needs a real
  payment gateway merchant account, which only you can set up.
- **No SMS/email/WhatsApp sending.** Same as before — the architecture
  (event list in Admin → Settings) is there, sending isn't.
- **Partner document upload isn't a file-upload UI** — Partner Management
  records verification status and text fields, but doesn't have the same
  drag-and-drop upload flow as customer booking documents. Easy to add later
  using the same `uploadBookingDocument` pattern.
- **"Download Booking Receipt" uses the browser's print dialog** (print to
  PDF works fine on Android Chrome), not a generated PDF file — kept simple
  since a real PDF generator is a meaningfully bigger addition.
- **No admin-side centralized "document verification queue" page** — a
  document with the status "Pending" is reviewed by opening that specific
  booking, not from one combined list across all bookings.

## Files

- `index.html` — app shell, all CSS, PWA tags, SEO meta tags, loads the
  Supabase JS client, Leaflet (maps) and a QR code library from CDNs
- `app.js` — router, all customer + admin + partner views, data layer, all logic
- `supabase-setup.sql` — run once in Supabase → SQL Editor: creates the
  `app_data` table and the storage policies for the documents bucket
- `manifest.json`, `sw.js`, `offline.html` — PWA
- `robots.txt`, `sitemap.xml` — SEO (replace `example.com` with your real domain)

## Demo accounts

- **Admin:** go to `#admin`, username `kalicharanmurmu23199@gmail.com`,
  password `kalicharanmurmu23199@gmail.com`. Change either from
  Admin → Settings → Admin login (leave the password field blank there to
  keep the current password while only changing the username, or vice versa).
- **Customer:** register a new account from `#login` with any phone number —
  there's no OTP/SMS verification wired in, so any 8–15 digit number works.
- **Partner:** set a password for a partner from Admin → Partner Management
  → edit a partner → "Partner portal password", then sign in at `#partner`
  with that partner's phone number.

## How the database works right now

Everything is stored in one Supabase table, `app_data(key text primary key,
value jsonb)`. There's one row per collection — `rl-settings`, `rl-bookings`,
`rl-partners`, `rl-vehicles`, `rl-customers`, `rl-reviews`, `rl-support`,
`rl-counter` — each holding that collection as a JSON array/object. This
mirrors the shape `app.js` already works with internally, so the only code
that talks to Supabase is `storeGet`/`storeSet` near the top of `app.js` —
every view, form, and button is unchanged.

You can see your live data anytime in Supabase → **Table Editor** →
`app_data` — open a row's `value` column to see the raw JSON.

## Optional: a real relational schema later

The `app_data` JSON-blob table above is the fast path to get a genuinely
working, shared, persistent database with minimal code changes. If you later
want proper SQL querying, reporting, or multiple people editing
simultaneously without conflicts, this is the normalized schema to migrate
to — it matches the objects already used in `app.js` one-to-one, so the
views wouldn't need to change, only `storeGet`/`storeSet` and the form
handlers that currently push into arrays:

```
customers(id, name, phone UNIQUE, email, password_hash, created_at)
admins(id, username, password_hash)
partners(id, name, phone, email, service_area, vehicle_categories[], vehicle_details,
         driver_name, driver_phone, reg_number, payment_details, documents_status,
         notes, verified, active, completed_trips, cancellations, created_at)
vehicles(id, category, make_model, reg_number, seating, luggage, partner_id FK,
         service_area, availability, verified)
bookings(id, status, trip_type, pickup, drop, pickup_date, pickup_time, return_date,
         return_time, passengers, luggage, vehicle_category, customer_name,
         customer_phone, customer_email, alt_phone, instructions, customer_price,
         partner_payout, additional_charges, refund, final_amount, payment_status,
         partner_id FK, driver_name, driver_phone, vehicle_reg, created_at, updated_at)
booking_status_history(id, booking_id FK, event, timestamp)
pricing_rules(id, base_fare, per_km, per_hour, airport_surcharge, night_surcharge,
              extra_passenger_charge, driver_allowance, commission_percent)
payments(id, booking_id FK, amount, status, method, created_at)
payouts(id, partner_id FK, booking_id FK, amount, status, paid_at)
notifications(id, booking_id FK, channel, event, status, sent_at)
reviews(id, booking_id FK, customer_name, rating, text, hidden, featured, created_at)
support_messages(id, name, message, booking_id FK NULLABLE, resolved, created_at)
settings(key, value)
```

Roles today: `CUSTOMER`, `ADMIN`. The partner fields and a `partners` table
already exist so a `PARTNER` role/login can be added later without
restructuring bookings or vehicles.

## Deployment

1. Finish the Supabase setup above (steps 1–4 at the top of this file).
2. Re-upload `index.html` and `app.js` to GitHub.
3. Turn on GitHub Pages (Settings → Pages → branch `main` / root) if you
   haven't already.
4. Replace `example.com` in `sitemap.xml`, `robots.txt` and the `<link
   rel="canonical">` tag with your real GitHub Pages URL (already set to
   `https://kcm2112007.github.io/Burdwan-Car-Rental---Your-Local-Ride/`
   unless you've moved it).

For a fuller production backend later (real server-side auth, a payment
gateway, SMS/WhatsApp), you'd add a small server that talks to the same
Supabase project using Supabase's server-side (service role) key, and move
the sensitive checks (admin login, payment confirmation) there instead of
the browser. Supabase also supports its own Auth and Edge Functions if you'd
rather build that on Supabase directly instead of a separate server.

## Security checklist before launch

- [ ] Real server-side authentication (this demo's is client-side only —
      Supabase Auth is a natural fit here since you're already on Supabase)
- [ ] Passwords hashed with bcrypt/argon2, never SHA-256 alone, server-side
- [ ] Rate limiting on login and booking-creation
- [ ] Input validation repeated server-side (client validation here is UX only)
- [ ] Tighten the `app_data` RLS policies beyond "anyone can read/write"
      once real auth exists (e.g. scope by authenticated role)
- [ ] No service-role/secret Supabase key ever placed in `app.js` — only the
      anon public key belongs in frontend code
- [ ] HTTPS everywhere (GitHub Pages does this automatically)
- [ ] Customer PII (phone/email) never exposed in public API responses
- [ ] Tighten the `booking-documents` storage policies once real auth exists
      — right now anyone with your publishable key can read any uploaded
      document by guessing/observing a path; not exploitable by casual
      visitors, but not access-controlled either

## Production launch checklist

- [ ] Replace all placeholder legal text (Privacy, Terms, Cancellation, Partner Terms)
- [ ] Connect a real payment gateway for automatic verification; UPI QR + manual
      confirmation works but doesn't scale well past a handful of daily bookings
- [ ] Connect email/SMS/WhatsApp for the notification events already defined
- [ ] Consider a paid geocoder (Google/Mapbox) if booking volume exceeds
      Nominatim's fair-use rate limit
- [ ] Load-test the booking flow and admin dashboard
- [ ] Add real business name, logo, service areas and contact details in Settings
- [ ] Verify the PWA installs correctly on Android Chrome
- [ ] Re-test the full flow below now that Supabase is live

## What to test

- Supabase connected: open the browser console on your live site — no
  "Supabase is not configured" warning
- Customer registration, login, logout
- Booking creation through all 7 steps: trip+mode, map location (search,
  drag pin, "use my location"), vehicle, details, documents (upload/
  preview), review, payment (both Pay Now QR and Pay Later)
- Out-of-service-area pickup/drop shows the custom-quote message instead of
  silently failing or silently succeeding
- Admin login with your real credentials, admin sees new bookings immediately
- Admin verifying/rejecting an uploaded document (with a reason)
- Assigning a partner → booking moves to "Awaiting Partner Acceptance"
- Partner portal: sign in, accept/reject a booking, move an accepted trip
  through Driver Assigned → ... → Trip Completed
- Customer requesting cancellation → admin approving/keeping it
- Editing price/payout → margin recalculates; marking Pay Now as Paid only
  after you actually see the UPI transaction
- Deleting a partner/vehicle, closing a modal with the ✕ button
- Customer booking tracking by ID + phone, timeline matches payment method
- Leaving a review after a booking is marked Trip Completed
- Vehicle expiry alert appears on the dashboard when a date is set in the past
- **Cross-device check:** create a booking on your phone, open the site on
  a different device/browser, confirm the admin dashboard shows it too —
  this is the real test that Supabase is working
- Responsive layout: mobile card views for tables, sticky mobile CTA, admin
  mobile tab bar
- CSV export of the filtered bookings table
- SEO meta tags, robots.txt, sitemap.xml present
- PWA manifest + service worker registration (installable; offline shows an
  honest "you're offline" page rather than fake success)
