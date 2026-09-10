# Burdwan Car Rental — Your Local Ride

A working customer + admin booking platform. Both panels read and write the
**same live records**, so a booking made on the customer side really appears
in the admin dashboard, and admin actions (assign partner, change status,
set price) really update what the customer sees on the tracking page.

## ⚠️ Read this first — what's real vs. simulated

This build runs entirely in the browser. There is no server, so a few things
that a genuine production system needs are **simulated** here and should be
replaced before you take real payments or real customer data at scale:

| Area | In this build | For real production |
|---|---|---|
| Database | Browser-side shared key-value storage (acts as the DB, and *is* shared live between customer and admin — it's not fake data, but it's not a real relational database either) | PostgreSQL (schema below is ready to port) |
| Admin/customer auth | Password is hashed (SHA-256) and checked in the browser | Server-side auth (bcrypt/argon2 + JWT or sessions), so a password check can't be bypassed by editing client code |
| Sessions | Kept in memory; refreshing the page logs you out | Persistent sessions via httpOnly cookies or a token store |
| Payments | "Pay Later / Payment Pending" flow only, as instructed — no fake success screens | A real Indian gateway (Razorpay/Cashfree/PayU) called from a server |
| Notifications (Email/SMS/WhatsApp) | Not sent — the settings page explains this plainly | Wire up an email/SMS/WhatsApp API from a server once you have API keys |
| Distance-based pricing | Estimate uses a placeholder distance, not a real route | A maps/directions API (Google/Mapbox) called server-side |
| PWA offline | Caches the app shell only; booking/tracking/admin correctly refuse to pretend to work offline | Same approach still applies for a server-backed version |

Nothing here is a disconnected demo page — every button, form and status
change updates the shared data and every screen reads from it. The
simplification is the *storage/auth layer*, not the workflow.

## Files

- `index.html` — app shell, all CSS, PWA tags, SEO meta tags
- `app.js` — router, all customer + admin views, data layer, all logic
- `manifest.json`, `sw.js`, `offline.html` — PWA
- `robots.txt`, `sitemap.xml` — SEO (replace `example.com` with your real domain)

## Demo accounts

- **Admin:** go to `#admin`, username `admin`, password `admin123`. Change
  the password immediately from Admin → Settings → Admin password.
- **Customer:** register a new account from `#login` with any phone number —
  there's no OTP/SMS verification wired in, so any 8–15 digit number works
  in this demo.

## Data model (ready to port to a real database)

Tables to create in Postgres, matching the objects already used in `app.js`:

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

## Deployment (once you move to a real backend)

1. Stand up a small Node/Express (or Django/Rails) API implementing the
   endpoints implied by the form handlers in `app.js` (`booking create`,
   `booking update`, `partner CRUD`, `vehicle CRUD`, `auth`, `pricing`).
2. Point `app.js`'s `storeGet`/`storeSet` calls at that API instead of
   `window.storage` (same call sites, same data shapes — you're swapping the
   two functions, not rewriting the views).
3. Put real secrets in environment variables server-side; create a
   `.env.example` listing `DATABASE_URL`, `JWT_SECRET`, `PAYMENT_GATEWAY_KEY`,
   `SMS_API_KEY`, `WHATSAPP_API_KEY`, `MAPS_API_KEY` with no real values.
4. Serve `index.html`/`app.js`/PWA files as static assets from any host
   (Vercel, Netlify, a VPS with Nginx) with HTTPS.
5. Replace `example.com` in `sitemap.xml`, `robots.txt` and the `<link
   rel="canonical">` tag with your real domain.

## Security checklist before launch

- [ ] Real server-side authentication (this demo's is client-side only)
- [ ] Passwords hashed with bcrypt/argon2, never SHA-256 alone, server-side
- [ ] Rate limiting on login and booking-creation endpoints
- [ ] Input validation repeated server-side (client validation here is UX only)
- [ ] Admin routes protected by server-side role checks, not just hiding the UI
- [ ] No API keys or secrets in any frontend file
- [ ] HTTPS everywhere
- [ ] Customer PII (phone/email) never exposed in public API responses

## Production launch checklist

- [ ] Replace all placeholder legal text (Privacy, Terms, Cancellation, Partner Terms)
- [ ] Connect a real payment gateway; remove "Pay Later" as the only option
- [ ] Connect email/SMS/WhatsApp for the notification events already defined
- [ ] Connect a maps/places API for location autocomplete and real distance pricing
- [ ] Load-test the booking flow and admin dashboard
- [ ] Add real business name, logo, service areas and contact details in Settings
- [ ] Verify the PWA installs correctly on Android Chrome
- [ ] Re-test the full flow below on the real backend

## What to test (already verified working against the shared demo storage)

- Customer registration, login, logout
- Booking creation through all 5 steps, validation, unique Booking ID generation
- Admin login, admin sees new bookings immediately
- Assigning a partner, changing status, editing price/payout → margin recalculates
- Cancellation from the customer account
- Customer booking tracking by ID + phone
- Responsive layout: mobile card views for tables, sticky mobile CTA, admin
  mobile tab bar
- CSV export of the filtered bookings table
- SEO meta tags, robots.txt, sitemap.xml present
- PWA manifest + service worker registration (installable; offline shows an
  honest "you're offline" page rather than fake success)
