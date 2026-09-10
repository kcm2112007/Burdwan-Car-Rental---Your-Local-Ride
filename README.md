# Burdwan Car Rental — Your Local Ride

A working customer + admin booking platform. Both panels read and write the
**same live records** in a real Supabase (Postgres) database, so a booking
made on the customer side really appears in the admin dashboard, and admin
actions (assign partner, change status, set price) really update what the
customer sees on the tracking page — and it's genuinely saved, not just held
in the browser tab.

## ⚠️ Setup required before this works

The app needs a Supabase project connected before anything saves. Do this
once:

1. Create a free project at **supabase.com** (see full walkthrough below).
2. Run `supabase-setup.sql` in Supabase → SQL Editor once, to create the
   `app_data` table.
3. Open `app.js`, find these two lines near the top, and fill them in from
   Supabase → Project Settings → API:
   ```js
   const SUPABASE_URL = 'PASTE_YOUR_SUPABASE_PROJECT_URL_HERE';
   const SUPABASE_ANON_KEY = 'PASTE_YOUR_SUPABASE_ANON_KEY_HERE';
   ```
4. Re-upload `app.js` to your repo.

Until step 3 is done, the site still runs (so you can click around and test
the flow) but nothing is actually saved — a banner-free but visible "Not
saved — Supabase is not configured yet" toast appears on every save attempt,
and a warning is logged to the browser console.

## What's real vs. simulated now

| Area | Status |
|---|---|
| Database | **Real** — Postgres via Supabase, persists across devices and browsers |
| Admin/customer auth | Still client-side (password hashed with SHA-256, checked in the browser) — fine for a small operation, but see the security checklist below before scaling up |
| Sessions | Still in-memory; refreshing the page logs you out |
| Payments | "Pay Later / Payment Pending" flow only, as instructed — no fake success screens |
| Notifications (Email/SMS/WhatsApp) | Not sent — the settings page explains this plainly |
| Distance-based pricing | Estimate uses a placeholder distance, not a real route |


## Files

- `index.html` — app shell, all CSS, PWA tags, SEO meta tags, loads the Supabase JS client from a CDN
- `app.js` — router, all customer + admin views, data layer, all logic
- `supabase-setup.sql` — run once in Supabase → SQL Editor to create the `app_data` table
- `manifest.json`, `sw.js`, `offline.html` — PWA
- `robots.txt`, `sitemap.xml` — SEO (replace `example.com` with your real domain)

## Demo accounts

- **Admin:** go to `#admin`, username `kalicharanmurmu23199@gmail.com`,
  password `kalicharanmurmu23199@gmail.com`. Change either from
  Admin → Settings → Admin login (leave the password field blank there to
  keep the current password while only changing the username, or vice versa).
- **Customer:** register a new account from `#login` with any phone number —
  there's no OTP/SMS verification wired in, so any 8–15 digit number works
  in this demo.

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

## Production launch checklist

- [ ] Replace all placeholder legal text (Privacy, Terms, Cancellation, Partner Terms)
- [ ] Connect a real payment gateway; remove "Pay Later" as the only option
- [ ] Connect email/SMS/WhatsApp for the notification events already defined
- [ ] Connect a maps/places API for location autocomplete and real distance pricing
- [ ] Load-test the booking flow and admin dashboard
- [ ] Add real business name, logo, service areas and contact details in Settings
- [ ] Verify the PWA installs correctly on Android Chrome
- [ ] Re-test the full flow below now that Supabase is live

## What to test

- Supabase connected: open the browser console on your live site — no
  "Supabase is not configured" warning
- Customer registration, login, logout
- Booking creation through all 5 steps, validation, unique Booking ID generation
- Admin login with your real credentials, admin sees new bookings immediately
- Assigning a partner, changing status (including Cancel), editing
  price/payout → margin recalculates
- Deleting a partner/vehicle, closing a modal with the ✕ button
- Cancellation from the customer account
- Customer booking tracking by ID + phone
- **Cross-device check:** create a booking on your phone, open the site on
  a different device/browser, confirm the admin dashboard shows it too —
  this is the real test that Supabase is working
- Responsive layout: mobile card views for tables, sticky mobile CTA, admin
  mobile tab bar
- CSV export of the filtered bookings table
- SEO meta tags, robots.txt, sitemap.xml present
- PWA manifest + service worker registration (installable; offline shows an
  honest "you're offline" page rather than fake success)
