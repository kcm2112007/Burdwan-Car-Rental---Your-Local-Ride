/* =========================================================================
   RouteLine Cabs — booking platform
   -------------------------------------------------------------------------
   Data layer: uses the artifact persistent storage API (window.storage) with
   shared:true so the customer panel and admin panel read/write the SAME
   records. That storage layer is standing in for a real database — see
   README.md for exactly what to swap in for a genuine production backend
   (Postgres + a server-side API + real auth), which this sandbox can't host.
   ========================================================================= */

const KEYS = {
  settings: 'rl-settings',
  bookings: 'rl-bookings',
  partners: 'rl-partners',
  vehicles: 'rl-vehicles',
  customers: 'rl-customers',
  reviews: 'rl-reviews',
  support: 'rl-support',
  counter: 'rl-counter'
};

let DB = { settings:null, bookings:[], partners:[], vehicles:[], customers:[], reviews:[], support:[], counter:{} };
let SESSION = null; // { type:'customer'|'admin', id, name, phone } — in-memory only, cleared on reload (see README)
let ROUTE = { path: 'home', params: {} };
let UI = {}; // scratch state per view (booking step, filters, pagination, editing ids)

/* ---------- storage helpers ---------- */
async function storeGet(key, fallback){
  try{
    const r = await window.storage.get(key, true);
    return r ? JSON.parse(r.value) : fallback;
  }catch(e){ return fallback; }
}
async function storeSet(key, value){
  try{ await window.storage.set(key, JSON.stringify(value), true); return true; }
  catch(e){ console.error('storage set failed', key, e); showToast('Could not save — check connection'); return false; }
}
async function sha256(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

/* ---------- defaults / seed ---------- */
function defaultSettings(){
  return {
    businessName: 'Burdwan Car Rental',
    phone: '+91 90000 00000',
    email: 'support@routelinecabs.example',
    whatsapp: '',
    address: 'Add your registered business address here',
    serviceAreas: ['Kolkata','Durgapur','Asansol','Bardhaman'],
    bookingPrefix: 'CR',
    cancellationRules: 'Free cancellation up to 4 hours before pickup. Cancellations after that, or no-shows, may be charged a fee once a partner has been assigned.',
    advanceBookingHours: 2,
    minNoticeHours: 2,
    pricing: {
      baseFare: 250, perKm: 13, perHour: 120,
      airportSurcharge: 100, nightSurcharge: 150,
      extraPassengerCharge: 50, driverAllowance: 300,
      commissionPercent: 18
    },
    adminPasswordHash: null // set on first boot to sha256('admin123')
  };
}
async function seedIfEmpty(){
  let settings = await storeGet(KEYS.settings, null);
  if(!settings){
    settings = defaultSettings();
    settings.adminPasswordHash = await sha256('admin123');
    await storeSet(KEYS.settings, settings);
  }
  DB.settings = settings;

  DB.bookings = await storeGet(KEYS.bookings, []);
  DB.customers = await storeGet(KEYS.customers, []);
  DB.reviews = await storeGet(KEYS.reviews, []);
  DB.support = await storeGet(KEYS.support, []);
  DB.counter = await storeGet(KEYS.counter, {});

  let partners = await storeGet(KEYS.partners, null);
  if(!partners){
    partners = [
      { id:'PTR-001', name:'Add your first verified partner', phone:'', email:'', serviceArea:'Kolkata', vehicleCategories:['Sedan','SUV'], vehicleDetails:'', regNumber:'', driverName:'', driverPhone:'', documentsStatus:'Pending', paymentDetails:'', notes:'Example record — edit or delete from Partner Management.', verified:false, active:true, completedTrips:0, cancellations:0 }
    ];
    await storeSet(KEYS.partners, partners);
  }
  DB.partners = partners;

  let vehicles = await storeGet(KEYS.vehicles, null);
  if(!vehicles){
    vehicles = [
      { id:'VEH-001', category:'Sedan', makeModel:'Add make & model', regNumber:'', seating:4, luggage:2, partnerId:'PTR-001', serviceArea:'Kolkata', availability:'Available', verified:false }
    ];
    await storeSet(KEYS.vehicles, vehicles);
  }
  DB.vehicles = vehicles;
}

/* ---------- id / number helpers ---------- */
function todayStamp(){
  const d = new Date();
  return d.getFullYear().toString() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
}
async function nextBookingId(){
  const stamp = todayStamp();
  const count = (DB.counter[stamp] || 0) + 1;
  DB.counter[stamp] = count;
  await storeSet(KEYS.counter, DB.counter);
  return `${DB.settings.bookingPrefix}-${stamp}-${String(count).padStart(3,'0')}`;
}
function money(n){
  n = Number(n)||0;
  return '₹' + n.toLocaleString('en-IN', {maximumFractionDigits:0});
}
function fmtDate(s){ if(!s) return '—'; const d=new Date(s); return isNaN(d) ? s : d.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function fmtDateTime(s){ if(!s) return '—'; const d=new Date(s); return isNaN(d) ? s : d.toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); }
function uid(prefix){ return prefix + '-' + Math.random().toString(36).slice(2,9); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function statusClass(s){ return 'status-' + String(s).replace(/[\s/]/g,'-'); }

const STATUS_FLOW = ['Request Received','Searching for Vehicle','Partner Assigned','Awaiting Confirmation','Confirmed','Driver/Vehicle Assigned','Trip Started','Completed'];

/* ---------- toast / modal ---------- */
let toastTimer=null;
function showToast(msg){
  const root = document.getElementById('toast-root');
  root.innerHTML = `<div class="toast show">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ const t=root.querySelector('.toast'); if(t) t.classList.remove('show'); }, 2600);
}
function openModal(html){
  document.getElementById('modal-root').innerHTML = `<div class="modal-bg" data-act="modal-bg-close"><div class="modal" onclick="event.stopPropagation()">${html}</div></div>`;
}
function closeModal(){ document.getElementById('modal-root').innerHTML=''; }

/* ---------- router ---------- */
function go(path){ location.hash = path; }
window.addEventListener('hashchange', route);

function route(){
  const raw = location.hash.replace(/^#\/?/, '') || 'home';
  const [path, qs] = raw.split('?');
  ROUTE.path = path || 'home';
  ROUTE.params = Object.fromEntries(new URLSearchParams(qs||''));
  window.scrollTo(0,0);
  render();
}

/* ---------- render dispatch ---------- */
function render(){
  const p = ROUTE.path;
  if(p==='home') return renderHome();
  if(p==='book') return renderBooking();
  if(p==='track') return renderTrack();
  if(p==='login') return renderCustomerAuth();
  if(p==='account') return renderAccount();
  if(p==='privacy') return renderLegal('privacy');
  if(p==='terms') return renderLegal('terms');
  if(p==='cancellation') return renderLegal('cancellation');
  if(p==='partner-terms') return renderLegal('partner-terms');
  if(p==='contact') return renderContact();
  if(p.startsWith('admin')) return renderAdmin(p);
  return renderHome();
}

/* ---------- delegated events ---------- */
document.addEventListener('click', (e)=>{
  const el = e.target.closest('[data-act]');
  if(!el) return;
  const act = el.getAttribute('data-act');
  if(act==='modal-bg-close'){ closeModal(); return; }
  if(act==='go'){ go(el.getAttribute('data-path')); return; }
  handleAction(act, el, e);
});
document.addEventListener('submit', (e)=>{
  const form = e.target.closest('[data-form]');
  if(!form) return;
  e.preventDefault();
  handleForm(form.getAttribute('data-form'), form, e);
});
document.addEventListener('input', (e)=>{
  const el = e.target.closest('[data-live]');
  if(!el) return;
  handleLive(el.getAttribute('data-live'), el);
});

/* =========================================================================
   NAV / LAYOUT
   ========================================================================= */
function siteHeader(active){
  const s = DB.settings;
  return `
  <header class="topbar">
    <div class="wrap">
      <div class="brand" data-act="go" data-path="home" style="cursor:pointer">${logoSvg()} ${esc(s.businessName)}</div>
      <nav class="nav-links hide-mobile">
        <a data-act="go" data-path="home">Home</a>
        <a data-act="go" data-path="book">Book a Ride</a>
        <a data-act="go" data-path="track">Track Booking</a>
        <a data-act="go" data-path="contact">Contact</a>
      </nav>
      <div class="topbar-actions">
        ${SESSION && SESSION.type==='customer'
          ? `<button class="btn btn-outline btn-sm" data-act="go" data-path="account">My Account</button>`
          : `<button class="btn btn-outline btn-sm hide-mobile" data-act="go" data-path="login">Sign in</button>`}
        <button class="btn btn-accent btn-sm" data-act="go" data-path="book">Book Now</button>
      </div>
    </div>
  </header>`;
}
function logoSvg(){
  return `<svg width="26" height="26" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="14" fill="#1C1F22"/><path d="M14 40l4-12a6 6 0 0 1 5.7-4h16.6a6 6 0 0 1 5.7 4l4 12" stroke="#D98B1E" stroke-width="3.5" fill="none" stroke-linecap="round"/><circle cx="22" cy="42" r="4.5" fill="#D98B1E"/><circle cx="42" cy="42" r="4.5" fill="#D98B1E"/></svg>`;
}
function siteFooter(){
  const s = DB.settings;
  return `
  <footer>
    <div class="wrap">
      <div>
        <div class="brand" style="color:#fff">${logoSvg()} ${esc(s.businessName)}</div>
        <p style="opacity:.7;font-size:13.5px;max-width:38ch;margin-top:10px">Request a ride online — our team confirms a verified partner for every trip.</p>
      </div>
      <div>
        <h4>Company</h4>
        <a data-act="go" data-path="contact">Contact</a>
        <a data-act="go" data-path="track">Track a booking</a>
      </div>
      <div>
        <h4>Legal</h4>
        <a data-act="go" data-path="terms">Terms &amp; Conditions</a>
        <a data-act="go" data-path="privacy">Privacy Policy</a>
        <a data-act="go" data-path="cancellation">Cancellation &amp; Refunds</a>
        <a data-act="go" data-path="partner-terms">Partner Terms</a>
      </div>
      <div>
        <h4>Get in touch</h4>
        <a>${esc(s.phone)}</a>
        <a>${esc(s.email)}</a>
        <a data-act="go" data-path="admin">Partner / Admin login</a>
      </div>
    </div>
    <div class="wrap foot-bottom">
      <span>© ${new Date().getFullYear()} ${esc(s.businessName)}. All rights reserved.</span>
      <span>Prices are estimates until confirmed.</span>
    </div>
  </footer>`;
}
function mount(html){ document.getElementById('app').innerHTML = html; }

/* =========================================================================
   HOME PAGE
   ========================================================================= */
function renderHome(){
  const s = DB.settings;
  const routes = [
    ['Kolkata → Durgapur','Outstation'],['Kolkata Airport → City','Airport Transfer'],
    ['Durgapur → Asansol','One Way'],['City Local (8 hrs / 80 km)','Local Rental']
  ];
  const reviews = DB.reviews.filter(r=>!r.hidden).slice(0,3);
  mount(`
  ${siteHeader('home')}
  <section class="hero">
    <div class="wrap">
      <div>
        <div class="eyebrow-route"><span class="dot"></span><span class="dash"></span><span>Pickup to drop, sorted</span></div>
        <h1>Book a cab in minutes. A person confirms it, not a robot.</h1>
        <p class="lead">Local rentals, airport transfers, one-way and outstation trips. Submit a request and our team assigns a verified partner for your route.</p>
        <div class="hero-cta-row">
          <button class="btn btn-primary" data-act="go" data-path="book">Book Your Ride</button>
          <button class="btn btn-outline" data-act="go" data-path="track">Track a booking</button>
        </div>
        <div class="hero-stats">
          <div><b>${DB.bookings.filter(b=>b.status==='Completed').length}</b><span>Trips completed</span></div>
          <div><b>${DB.partners.filter(p=>p.verified && p.active).length}</b><span>Verified partners</span></div>
          <div><b>${s.serviceAreas.length}</b><span>Service areas</span></div>
        </div>
      </div>
      <div class="route-card">
        <svg class="route-svg" viewBox="0 0 340 160">
          <circle cx="26" cy="120" r="7" fill="#D98B1E"/>
          <path d="M26 120 C 90 60, 220 140, 314 40" stroke="#E3E1DA" stroke-width="3" fill="none" stroke-dasharray="2 10" stroke-linecap="round"/>
          <circle cx="314" cy="40" r="7" fill="#1C1F22"/>
          <text x="10" y="145" font-family="Inter" font-size="11" fill="#4A4F55">Pickup</text>
          <text x="278" y="26" font-family="Inter" font-size="11" fill="#4A4F55">Drop</text>
        </svg>
        <div class="trip-grid">
          ${['Local Rental','Airport Transfer','One Way','Round Trip','Outstation','Corporate'].map(t=>`<div class="trip-chip" data-act="go" data-path="book?trip=${encodeURIComponent(t)}">${t}</div>`).join('')}
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <div class="section-head"><h2>Popular routes</h2><p>Frequently booked pickups and drops on our network.</p></div>
      <div class="card route-list">
        ${routes.map(r=>`<a data-act="go" data-path="book"><span>${r[0]}</span><span class="pill">${r[1]}</span></a>`).join('')}
      </div>
    </div>
  </section>

  <section style="background:#fff;border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
    <div class="wrap">
      <div class="section-head"><h2>Why book with us</h2></div>
      <div class="grid grid-3">
        <div class="card"><div class="icon-badge">✓</div><h3 style="font-size:17px">Verified partners</h3><p style="color:var(--ink-soft);font-size:14.5px">Every trip is assigned to a partner reviewed by our team before dispatch.</p></div>
        <div class="card"><div class="icon-badge">₹</div><h3 style="font-size:17px">Clear pricing</h3><p style="color:var(--ink-soft);font-size:14.5px">See an estimate upfront; the final price is confirmed before your trip starts.</p></div>
        <div class="card"><div class="icon-badge">◷</div><h3 style="font-size:17px">Real-time tracking</h3><p style="color:var(--ink-soft);font-size:14.5px">Follow your booking status from request through to completion.</p></div>
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <div class="section-head"><h2>How it works</h2></div>
      <div class="step-row"><div><div class="step-num">1</div><div class="step-line"></div></div><div style="padding-bottom:22px"><h3 style="font-size:16px">Submit a request</h3><p style="color:var(--ink-soft);font-size:14.5px;margin:4px 0 0">Tell us your pickup, drop, date and vehicle preference.</p></div></div>
      <div class="step-row"><div><div class="step-num">2</div><div class="step-line"></div></div><div style="padding-bottom:22px"><h3 style="font-size:16px">We assign a partner</h3><p style="color:var(--ink-soft);font-size:14.5px;margin:4px 0 0">Our team matches your trip to a verified partner in your area.</p></div></div>
      <div class="step-row"><div><div class="step-num">3</div></div><div><h3 style="font-size:16px">Ride, then relax</h3><p style="color:var(--ink-soft);font-size:14.5px;margin:4px 0 0">Get confirmation details and track your trip until it's complete.</p></div></div>
    </div>
  </section>

  <section style="background:#fff;border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
    <div class="wrap">
      <div class="section-head"><h2>Vehicle categories</h2></div>
      <div class="grid grid-4">
        ${['Hatchback','Sedan','SUV','Premium','7-Seater'].map(v=>`<div class="card" style="text-align:center"><div style="font-size:26px;margin-bottom:6px">🚗</div><b style="font-size:14px">${v}</b></div>`).join('')}
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <div class="section-head"><h2>What customers say</h2></div>
      ${reviews.length ? `<div class="grid grid-3">${reviews.map(r=>`
        <div class="card review-card"><div class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5-r.rating)}</div><p>${esc(r.text)}</p><b style="font-size:13.5px">${esc(r.name)}</b></div>
      `).join('')}</div>` : `<div class="empty-state"><div class="icon-badge" style="margin:0 auto">★</div>No reviews yet — they'll appear here once customers complete trips and leave feedback.</div>`}
    </div>
  </section>

  <section style="background:#fff;border-top:1px solid var(--line)">
    <div class="wrap narrow">
      <div class="section-head"><h2>Frequently asked questions</h2></div>
      ${faqItem('How is my final price decided?','You get an estimate when booking. Our team confirms the final price — including any surcharges — before your trip starts.')}
      ${faqItem('Can I cancel a booking?',esc(DB.settings.cancellationRules))}
      ${faqItem('How do I check my booking status?','Use "Track Booking" with your Booking ID and the phone number you booked with.')}
      ${faqItem('Do you offer outstation trips?','Yes — select Outstation as your trip type when booking and tell us your route.')}
    </div>
  </section>

  <section id="contact-section">
    <div class="wrap grid grid-2">
      <div>
        <div class="section-head"><h2>Get in touch</h2><p>Questions about a booking or a route we don't list? Reach out.</p></div>
        <p style="font-size:14.5px"><b>Phone:</b> ${esc(s.phone)}</p>
        <p style="font-size:14.5px"><b>Email:</b> ${esc(s.email)}</p>
        ${s.whatsapp ? `<a class="btn btn-accent btn-sm" style="margin-top:10px" href="https://wa.me/${esc(s.whatsapp.replace(/\D/g,''))}" target="_blank" rel="noopener">Message on WhatsApp</a>` : ''}
      </div>
      <div class="card">
        <form data-form="contact">
          <div class="field"><label>Name</label><input required name="name"></div>
          <div class="field"><label>Message</label><textarea required name="message" rows="3"></textarea></div>
          <button class="btn btn-primary btn-block" type="submit">Send message</button>
        </form>
      </div>
    </div>
  </section>
  ${siteFooter()}
  <div class="sticky-cta"><button class="btn btn-accent btn-block" data-act="go" data-path="book">Book Your Ride</button></div>
  `);
}
function faqItem(q,a){
  return `<div class="faq-item"><button class="faq-q" data-act="toggle-faq">${esc(q)}<span>+</span></button><div class="faq-a"><p>${a}</p></div></div>`;
}

/* =========================================================================
   BOOKING FLOW (multi-step)
   ========================================================================= */
function freshDraft(){
  return {
    tripType:'', pickup:'', drop:'', pickupDate:'', pickupTime:'', returnDate:'', returnTime:'',
    passengers:1, luggage:0, vehicleCategory:'',
    customerName:'', customerPhone:'', customerEmail:'', altPhone:'', instructions:''
  };
}
function renderBooking(){
  if(!UI.booking) UI.booking = { step:1, draft: freshDraft(), createdId:null };
  const qTrip = ROUTE.params.trip;
  if(qTrip && !UI.booking.draft.tripType && UI.booking.step===1) UI.booking.draft.tripType = qTrip;
  const b = UI.booking;
  mount(`
  ${siteHeader()}
  <div class="booking-shell">
    <h2 style="margin-bottom:4px">Book your ride</h2>
    <p style="color:var(--ink-soft);font-size:14px;margin-bottom:20px">Step ${Math.min(b.step,5)} of 5</p>
    <div class="progress-track">${[1,2,3,4,5].map(i=>`<span class="${b.step>=i?'done':''}"></span>`).join('')}</div>
    <div id="booking-step">${bookingStepHtml()}</div>
  </div>
  ${siteFooter()}
  `);
}
function bookingStepHtml(){
  const b = UI.booking, d = b.draft;
  if(b.step===1){
    const trips = [
      ['One Way','Single pickup to drop'],['Round Trip','Return on a later date'],
      ['Local Rental','Hourly / package based'],['Airport Transfer','To or from the airport'],
      ['Outstation','Longer intercity trips']
    ];
    return `
    <div>${trips.map(t=>`<div class="trip-option ${d.tripType===t[0]?'selected':''}" data-act="pick-trip" data-val="${t[0]}"><div><b>${t[0]}</b><span>${t[1]}</span></div><span>${d.tripType===t[0]?'✓':''}</span></div>`).join('')}</div>
    <div class="step-actions"><button class="btn btn-primary btn-block" data-act="step-next" ${!d.tripType?'disabled':''}>Continue</button></div>`;
  }
  if(b.step===2){
    const showReturn = d.tripType==='Round Trip';
    return `
    <form data-form="step2">
      <div class="field"><label>Pickup location</label><input name="pickup" required value="${esc(d.pickup)}" placeholder="Area, city"></div>
      <div class="field"><label>Drop location</label><input name="drop" required value="${esc(d.drop)}" placeholder="Area, city"></div>
      <p class="hint" style="margin:-8px 0 14px">Location autocomplete turns on automatically once a maps/places API key is configured in Admin → Settings.</p>
      <div class="field-row two">
        <div class="field"><label>Pickup date</label><input type="date" name="pickupDate" required value="${d.pickupDate}"></div>
        <div class="field"><label>Pickup time</label><input type="time" name="pickupTime" required value="${d.pickupTime}"></div>
      </div>
      ${showReturn?`<div class="field-row two"><div class="field"><label>Return date</label><input type="date" name="returnDate" value="${d.returnDate}"></div><div class="field"><label>Return time</label><input type="time" name="returnTime" value="${d.returnTime}"></div></div>`:''}
      <div class="step-actions"><button type="button" class="btn btn-outline" data-act="step-back">Back</button><button class="btn btn-primary btn-block" type="submit">Continue</button></div>
    </form>`;
  }
  if(b.step===3){
    const vehicles = [
      ['Hatchback','4 seats · budget friendly'],['Sedan','4 seats · comfort'],['SUV','6-7 seats · more space'],
      ['Premium','4 seats · high-end'],['7-Seater','Large groups & luggage']
    ];
    return `
    <form data-form="step3">
      <div class="field-row two">
        <div class="field"><label>Passengers</label><input type="number" min="1" max="20" name="passengers" required value="${d.passengers}"></div>
        <div class="field"><label>Luggage (bags)</label><input type="number" min="0" max="20" name="luggage" value="${d.luggage}"></div>
      </div>
      <label style="display:block;font-size:13px;font-weight:600;margin:6px 0 8px">Preferred vehicle category</label>
      ${vehicles.map(v=>`<div class="vehicle-option ${d.vehicleCategory===v[0]?'selected':''}" data-act="pick-vehicle" data-val="${v[0]}"><div><b style="font-size:14.5px">${v[0]}</b><div style="font-size:12.5px;color:var(--ink-soft)">${v[1]}</div></div><span>${d.vehicleCategory===v[0]?'✓':''}</span></div>`).join('')}
      <p class="hint">The exact vehicle is confirmed once our team assigns a partner.</p>
      <div class="step-actions"><button type="button" class="btn btn-outline" data-act="step-back">Back</button><button class="btn btn-primary btn-block" type="submit" ${!d.vehicleCategory?'disabled':''}>Continue</button></div>
    </form>`;
  }
  if(b.step===4){
    return `
    <form data-form="step4">
      <div class="field"><label>Full name</label><input name="customerName" required value="${esc(d.customerName)}"></div>
      <div class="field"><label>Mobile number</label><input name="customerPhone" required pattern="[0-9+ ]{8,15}" value="${esc(d.customerPhone)}" placeholder="10-digit mobile"></div>
      <div class="field"><label>Email</label><input type="email" name="customerEmail" value="${esc(d.customerEmail)}"></div>
      <div class="field"><label>Alternate phone (optional)</label><input name="altPhone" value="${esc(d.altPhone)}"></div>
      <div class="field"><label>Special instructions (optional)</label><textarea name="instructions" rows="2">${esc(d.instructions)}</textarea></div>
      <div class="step-actions"><button type="button" class="btn btn-outline" data-act="step-back">Back</button><button class="btn btn-primary btn-block" type="submit">Review booking</button></div>
    </form>`;
  }
  if(b.step===5){
    const est = estimatePrice(d);
    return `
    <div class="card">
      ${summaryRow('Trip type', d.tripType)}
      ${summaryRow('Pickup', d.pickup)}
      ${summaryRow('Drop', d.drop)}
      ${summaryRow('Date & time', fmtDate(d.pickupDate)+' · '+d.pickupTime)}
      ${d.tripType==='Round Trip'?summaryRow('Return', fmtDate(d.returnDate)+' · '+(d.returnTime||'—')):''}
      ${summaryRow('Passengers', d.passengers+' · '+d.luggage+' bag(s)')}
      ${summaryRow('Vehicle category', d.vehicleCategory)}
      ${summaryRow('Estimated price', money(est)+' (confirmed by our team)')}
    </div>
    <p class="hint" style="margin:12px 0">${esc(DB.settings.cancellationRules)}</p>
    <div class="step-actions"><button type="button" class="btn btn-outline" data-act="step-back">Back</button><button class="btn btn-primary btn-block" data-act="submit-booking">Request Booking</button></div>
    `;
  }
  if(b.step===6){
    const bk = DB.bookings.find(x=>x.id===b.createdId);
    if(!bk) return `<p>Booking not found.</p>`;
    return `
    <div class="card" style="text-align:center;padding:32px 20px">
      <div class="icon-badge" style="margin:0 auto 12px;background:var(--success-bg);color:var(--success);width:48px;height:48px;font-size:22px">✓</div>
      <h2>Booking Request Received</h2>
      <p style="color:var(--ink-soft);font-size:14.5px">We'll confirm your partner shortly.</p>
      <div class="mono" style="font-size:18px;margin:14px 0;background:var(--paper);padding:10px;border-radius:8px">${bk.id}</div>
      <div style="text-align:left;margin-top:10px">
        ${summaryRow('Name', bk.customerName)}
        ${summaryRow('Trip', bk.tripType+' · '+bk.pickup+' → '+bk.drop)}
        ${summaryRow('Status', `<span class="badge ${statusClass(bk.status)}">${bk.status}</span>`)}
      </div>
      <div class="step-actions" style="flex-direction:column">
        <button class="btn btn-primary btn-block" data-act="go" data-path="track?id=${bk.id}&phone=${encodeURIComponent(bk.customerPhone)}">Track this booking</button>
        <button class="btn btn-outline btn-block" data-act="go" data-path="contact">Contact support</button>
        ${DB.settings.whatsapp?`<a class="btn btn-accent btn-block" href="https://wa.me/${DB.settings.whatsapp.replace(/\D/g,'')}?text=${encodeURIComponent('Hi, my booking ID is '+bk.id)}" target="_blank" rel="noopener">Message on WhatsApp</a>`:''}
      </div>
    </div>`;
  }
}
function summaryRow(label, val){ return `<div class="summary-row"><span>${esc(label)}</span><b>${val}</b></div>`; }
function estimatePrice(d){
  const p = DB.settings.pricing;
  const vehicleMult = {Hatchback:1, Sedan:1.15, SUV:1.4, Premium:1.8, '7-Seater':1.5}[d.vehicleCategory] || 1;
  let base = p.baseFare + p.perKm * 20; // rough placeholder distance since no maps API is wired in
  if(d.tripType==='Airport Transfer') base += p.airportSurcharge;
  if(d.tripType==='Round Trip') base *= 1.8;
  if(d.tripType==='Outstation') base *= 2.2;
  base += Math.max(0,(Number(d.passengers)||1)-4) * p.extraPassengerCharge;
  return Math.round(base * vehicleMult);
}

/* =========================================================================
   TRACKING
   ========================================================================= */
function renderTrack(){
  const presetId = ROUTE.params.id||''; const presetPhone = ROUTE.params.phone||'';
  const found = UI.trackResult;
  mount(`
  ${siteHeader()}
  <div class="booking-shell">
    <h2>Track your booking</h2>
    <p style="color:var(--ink-soft);font-size:14.5px;margin-bottom:20px">Enter your Booking ID and the mobile number used to book.</p>
    <form data-form="track" class="card">
      <div class="field"><label>Booking ID</label><input name="id" required value="${esc(presetId)}" placeholder="CR-20260909-001"></div>
      <div class="field"><label>Mobile number</label><input name="phone" required value="${esc(presetPhone)}"></div>
      <button class="btn btn-primary btn-block" type="submit">Track booking</button>
    </form>
    <div style="margin-top:22px">${found===undefined?'':found===null?trackNotFound():trackResultHtml(found)}</div>
  </div>
  ${siteFooter()}
  `);
  if(presetId && presetPhone && found===undefined){
    UI.trackResult = DB.bookings.find(b=>b.id===presetId && b.customerPhone===presetPhone) || null;
    renderTrack();
  }
}
function trackNotFound(){
  return `<div class="empty-state"><div class="icon-badge" style="margin:0 auto">?</div>No booking found for that ID and phone number. Double-check both fields.</div>`;
}
function trackResultHtml(bk){
  const idx = STATUS_FLOW.indexOf(bk.status);
  const cancelled = bk.status==='Cancelled';
  return `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <b class="mono">${bk.id}</b><span class="badge ${statusClass(bk.status)}">${bk.status}</span>
    </div>
    ${summaryRow('Trip', bk.tripType+' · '+bk.pickup+' → '+bk.drop)}
    ${summaryRow('Date & time', fmtDate(bk.pickupDate)+' · '+bk.pickupTime)}
    ${summaryRow('Vehicle category', bk.vehicleCategory)}
    ${bk.partnerId?summaryRow('Partner assigned', partnerName(bk.partnerId)):''}
    ${bk.driverPhone?summaryRow('Driver contact', bk.driverPhone):''}
    <h3 style="font-size:15px;margin:20px 0 10px">Status timeline</h3>
    <ul class="timeline">
      ${cancelled ? `<li class="active"><b>Cancelled</b><time>${fmtDateTime(bk.updatedAt)}</time></li>` :
      STATUS_FLOW.map((s,i)=>`<li class="${i<idx?'past':i===idx?'active':''}"><b>${s}</b>${i<=idx?`<time>${timelineTime(bk,s)}</time>`:''}</li>`).join('')}
    </ul>
  </div>`;
}
function timelineTime(bk,label){
  const t = (bk.timeline||[]).find(x=>x.event===label);
  return t ? fmtDateTime(t.timestamp) : '';
}
function partnerName(id){ const p = DB.partners.find(x=>x.id===id); return p?p.name:'—'; }

/* =========================================================================
   CUSTOMER AUTH + ACCOUNT
   ========================================================================= */
function renderCustomerAuth(){
  if(!UI.authMode) UI.authMode = 'login';
  mount(`
  ${siteHeader()}
  <div class="auth-shell">
    <div class="auth-card">
      <h2 style="margin-bottom:16px">${UI.authMode==='login'?'Sign in':'Create your account'}</h2>
      <form data-form="${UI.authMode==='login'?'customer-login':'customer-register'}">
        ${UI.authMode==='register'?`<div class="field"><label>Full name</label><input name="name" required></div>`:''}
        <div class="field"><label>Mobile number</label><input name="phone" required></div>
        <div class="field"><label>Password</label><input name="password" type="password" required minlength="4"></div>
        <button class="btn btn-primary btn-block" type="submit">${UI.authMode==='login'?'Sign in':'Register'}</button>
      </form>
      <div class="auth-switch">
        ${UI.authMode==='login'
          ? `No account? <button data-act="auth-switch" data-val="register">Register</button>`
          : `Already have an account? <button data-act="auth-switch" data-val="login">Sign in</button>`}
      </div>
    </div>
    <p class="hint" style="text-align:center;margin-top:14px">This demo keeps you signed in only for this browser session — see README for adding persistent, server-verified sessions.</p>
  </div>
  ${siteFooter()}
  `);
}
function renderAccount(){
  if(!SESSION || SESSION.type!=='customer'){ go('login'); return; }
  const mine = DB.bookings.filter(b=>b.customerPhone===SESSION.phone).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  const upcoming = mine.filter(b=>!['Completed','Cancelled'].includes(b.status));
  const past = mine.filter(b=>['Completed','Cancelled'].includes(b.status));
  mount(`
  ${siteHeader()}
  <div class="wrap" style="padding:32px 20px 60px;max-width:760px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:22px">
      <div><h2 style="margin-bottom:2px">Hi, ${esc(SESSION.name)}</h2><p style="color:var(--ink-soft);font-size:13.5px">${esc(SESSION.phone)}</p></div>
      <button class="btn btn-outline btn-sm" data-act="logout">Log out</button>
    </div>
    <div class="panel"><div class="panel-head"><h3>Upcoming bookings</h3></div><div class="panel-body">
      ${upcoming.length?upcoming.map(accountBookingRow).join(''):`<p style="color:var(--ink-soft);font-size:14px">No upcoming bookings. <a data-act="go" data-path="book" style="text-decoration:underline;cursor:pointer">Book a ride</a>.</p>`}
    </div></div>
    <div class="panel"><div class="panel-head"><h3>Past bookings</h3></div><div class="panel-body">
      ${past.length?past.map(accountBookingRow).join(''):`<p style="color:var(--ink-soft);font-size:14px">Nothing here yet.</p>`}
    </div></div>
  </div>
  ${siteFooter()}
  `);
}
function accountBookingRow(bk){
  const cancellable = ['Request Received','Searching for Vehicle'].includes(bk.status);
  return `<div class="bcard" style="margin-bottom:10px">
    <div class="bcard-top"><b class="mono">${bk.id}</b><span class="badge ${statusClass(bk.status)}">${bk.status}</span></div>
    <div class="meta">${bk.tripType} · ${esc(bk.pickup)} → ${esc(bk.drop)}</div>
    <div class="meta">${fmtDate(bk.pickupDate)} · ${bk.pickupTime}</div>
    <div class="row-actions" style="margin-top:10px">
      <button class="btn btn-ghost btn-sm" data-act="go" data-path="track?id=${bk.id}&phone=${encodeURIComponent(bk.customerPhone)}">View / track</button>
      ${cancellable?`<button class="btn btn-danger btn-sm" data-act="customer-cancel" data-id="${bk.id}">Cancel</button>`:''}
    </div>
  </div>`;
}

/* =========================================================================
   LEGAL + CONTACT
   ========================================================================= */
function renderLegal(kind){
  const s = DB.settings;
  const content = {
    privacy: `<h2>What we collect</h2><p>We collect only what's needed to fulfil a booking: name, phone, email, pickup/drop details and trip preferences. We don't sell customer data.</p><h2>How it's used</h2><p>Used to create and manage your booking, assign a partner, and contact you about your trip.</p><h2>Your choices</h2><p>Contact us at ${esc(s.email)} to request a copy of your data or ask us to delete your account. <em>[Placeholder — replace with your finalized privacy policy before launch.]</em></p>`,
    terms: `<h2>Using this platform</h2><p>By booking through ${esc(s.businessName)}, you agree to provide accurate trip and contact details. Bookings are requests until confirmed by our team.</p><h2>Liability</h2><p>Trips are carried out by independent verified partners. <em>[Placeholder — have this reviewed by a lawyer before launch.]</em></p>`,
    cancellation: `<h2>Cancellation policy</h2><p>${esc(s.cancellationRules)}</p><h2>Refunds</h2><p>Approved refunds are processed to the original payment method within a reasonable timeframe. <em>[Placeholder — confirm your exact refund timeline before launch.]</em></p>`,
    'partner-terms': `<h2>Partner terms</h2><p>Partners must maintain valid documentation, keep vehicle and driver details current, and honor confirmed trip assignments. <em>[Placeholder — replace with your finalized partner agreement.]</em></p>`
  };
  const titles = {privacy:'Privacy Policy',terms:'Terms & Conditions',cancellation:'Cancellation & Refund Policy','partner-terms':'Partner Terms'};
  mount(`${siteHeader()}
  <div class="wrap narrow legal-body" style="padding:36px 20px 60px">
    <div class="notice-box">This page contains placeholder legal text. Have it reviewed and finalized before launch.</div>
    <h1>${titles[kind]}</h1>
    ${content[kind]}
  </div>
  ${siteFooter()}`);
}
function renderContact(){ ROUTE.path='home'; renderHome(); setTimeout(()=>document.getElementById('contact-section')?.scrollIntoView(),0); }

/* =========================================================================
   ADMIN PANEL
   ========================================================================= */
function renderAdmin(path){
  if(!SESSION || SESSION.type!=='admin'){ return renderAdminLogin(); }
  const sub = path.split('/')[1] || 'dashboard';
  if(!UI.admin) UI.admin = { bookingFilters:{status:'',vehicle:'',partner:'',from:'',to:'',q:''}, bookingPage:1, pageSize:10 };
  mount(`
  <div class="dash-shell">
    <aside class="dash-side">
      <div class="brand">${logoSvg()} Admin</div>
      <nav class="dash-nav">${adminNavLinks(sub)}</nav>
      <button class="btn btn-outline btn-sm btn-block" style="margin-top:16px;border-color:#444;color:#eee" data-act="logout">Log out</button>
    </aside>
    <div class="dash-main">
      <div class="dash-topbar">
        <b style="font-family:'Fraunces',serif;font-size:16px">${adminTitle(sub)}</b>
        <div style="display:flex;gap:8px;align-items:center"><span style="font-size:13px;color:var(--ink-soft)">${esc(SESSION.name||'Admin')}</span><button class="btn btn-ghost btn-sm hide-mobile" data-act="go" data-path="home">View site</button></div>
      </div>
      <div class="dash-mobile-tabs">${adminNavLinks(sub,true)}</div>
      <div class="dash-body">${adminBody(sub)}</div>
    </div>
  </div>`);
}
function adminNavLinks(sub, mobile){
  const items = [
    ['dashboard','Dashboard'],['bookings','Bookings'],['partners','Partners'],['vehicles','Vehicles'],
    ['customers','Customers'],['pricing','Pricing'],['reviews','Reviews'],['support','Support'],['settings','Settings']
  ];
  return items.map(([k,label])=> mobile
    ? `<a class="${sub===k?'active':''}" data-act="go" data-path="admin/${k}">${label}</a>`
    : `<a class="${sub===k?'active':''}" data-act="go" data-path="admin/${k}">${label}</a>`
  ).join('');
}
function adminTitle(sub){ return {dashboard:'Dashboard',bookings:'Booking Management',partners:'Partner Management',vehicles:'Vehicle Management',customers:'Customers',pricing:'Pricing Settings',reviews:'Reviews',support:'Support Requests',settings:'Business Settings'}[sub]||'Dashboard'; }

function renderAdminLogin(){
  mount(`
  <div class="auth-shell">
    <div class="auth-card">
      <div class="brand" style="margin-bottom:16px">${logoSvg()} Admin sign in</div>
      <form data-form="admin-login">
        <div class="field"><label>Admin username</label><input name="username" required value="admin"></div>
        <div class="field"><label>Password</label><input name="password" type="password" required></div>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
      </form>
      <p class="hint" style="margin-top:10px">Default demo password: <b>admin123</b> — change it from Settings after first login. This is a client-side demo login; see README before using real credentials.</p>
    </div>
    <p style="text-align:center;margin-top:16px"><a data-act="go" data-path="home" style="cursor:pointer;color:var(--ink-soft);font-size:13.5px">← Back to site</a></p>
  </div>`);
}

function adminBody(sub){
  if(sub==='dashboard') return adminDashboard();
  if(sub==='bookings') return adminBookings();
  if(sub==='partners') return adminPartners();
  if(sub==='vehicles') return adminVehicles();
  if(sub==='customers') return adminCustomers();
  if(sub==='pricing') return adminPricing();
  if(sub==='reviews') return adminReviews();
  if(sub==='support') return adminSupport();
  if(sub==='settings') return adminSettings();
  return '';
}

/* ---- Dashboard ---- */
function adminDashboard(){
  const b = DB.bookings;
  const today = todayStamp();
  const isToday = d => d && d.createdAt && d.createdAt.slice(0,10).replace(/-/g,'')===today;
  const sum = (arr,f) => arr.reduce((a,x)=>a+(Number(f(x))||0),0);
  const completed = b.filter(x=>x.status==='Completed');
  const totalValue = sum(completed, x=>x.finalAmount||x.customerPrice);
  const totalPayout = sum(completed, x=>x.partnerPayout);
  const margin = totalValue - totalPayout;
  const monthKey = new Date().toISOString().slice(0,7);
  const monthCompleted = completed.filter(x=>(x.createdAt||'').slice(0,7)===monthKey);
  const monthRevenue = sum(monthCompleted, x=>x.finalAmount||x.customerPrice);
  const monthMargin = monthRevenue - sum(monthCompleted, x=>x.partnerPayout);
  const activeCustomers = new Set(b.map(x=>x.customerPhone)).size;
  const activePartners = DB.partners.filter(p=>p.active).length;

  const cards = [
    ['Total bookings', b.length],
    ["Today's bookings", b.filter(isToday).length],
    ['Pending', b.filter(x=>['Request Received','Searching for Vehicle','Awaiting Confirmation'].includes(x.status)).length],
    ['Confirmed', b.filter(x=>['Confirmed','Driver/Vehicle Assigned','Trip Started','Partner Assigned'].includes(x.status)).length],
    ['Completed', completed.length],
    ['Cancelled', b.filter(x=>x.status==='Cancelled').length],
    ['Total booking value', money(totalValue)],
    ['Partner payout', money(totalPayout)],
    ['Gross margin', money(margin)],
    ['Monthly revenue', money(monthRevenue)],
    ['Monthly margin', money(monthMargin)],
    ['Active customers', activeCustomers],
    ['Active partners', activePartners]
  ];
  const routeCounts = {};
  b.forEach(x=>{ const k = `${x.pickup} → ${x.drop}`; routeCounts[k]=(routeCounts[k]||0)+1; });
  const topRoutes = Object.entries(routeCounts).sort((a,z)=>z[1]-a[1]).slice(0,5);
  const vehicleCounts = {};
  b.forEach(x=>{ vehicleCounts[x.vehicleCategory]=(vehicleCounts[x.vehicleCategory]||0)+1; });
  const conv = b.length ? Math.round(completed.length/b.length*100) : 0;
  const cancelRate = b.length ? Math.round(b.filter(x=>x.status==='Cancelled').length/b.length*100) : 0;

  return `
  <div class="grid grid-4" style="margin-bottom:20px">
    ${cards.map(c=>`<div class="stat-card"><div class="label">${c[0]}</div><div class="value">${c[1]}</div></div>`).join('')}
  </div>
  <div class="grid grid-2">
    <div class="panel"><div class="panel-head"><h3>Top routes</h3></div><div class="panel-body">
      ${topRoutes.length?topRoutes.map(r=>`<div class="summary-row"><span>${esc(r[0])}</span><b>${r[1]}</b></div>`).join(''):'<p class="hint">No bookings yet.</p>'}
    </div></div>
    <div class="panel"><div class="panel-head"><h3>Booking mix by vehicle</h3></div><div class="panel-body">
      ${Object.keys(vehicleCounts).length?Object.entries(vehicleCounts).map(r=>`<div class="summary-row"><span>${esc(r[0])}</span><b>${r[1]}</b></div>`).join(''):'<p class="hint">No bookings yet.</p>'}
    </div></div>
  </div>
  <div class="panel"><div class="panel-head"><h3>Conversion &amp; cancellation</h3></div><div class="panel-body grid grid-3">
    <div><div class="label" style="color:var(--ink-soft);font-size:12px">Conversion rate</div><div class="value" style="font-family:'Fraunces',serif;font-size:22px">${conv}%</div></div>
    <div><div class="label" style="color:var(--ink-soft);font-size:12px">Cancellation rate</div><div class="value" style="font-family:'Fraunces',serif;font-size:22px">${cancelRate}%</div></div>
    <div><div class="label" style="color:var(--ink-soft);font-size:12px">Avg. booking value</div><div class="value" style="font-family:'Fraunces',serif;font-size:22px">${money(completed.length?totalValue/completed.length:0)}</div></div>
  </div></div>`;
}

/* ---- Bookings management ---- */
function filteredBookings(){
  const f = UI.admin.bookingFilters;
  return DB.bookings.filter(b=>{
    if(f.status && b.status!==f.status) return false;
    if(f.vehicle && b.vehicleCategory!==f.vehicle) return false;
    if(f.partner && b.partnerId!==f.partner) return false;
    if(f.from && b.pickupDate < f.from) return false;
    if(f.to && b.pickupDate > f.to) return false;
    if(f.q){
      const q = f.q.toLowerCase();
      if(!(b.id.toLowerCase().includes(q) || b.customerName.toLowerCase().includes(q) || b.customerPhone.includes(q))) return false;
    }
    return true;
  }).sort((a,z)=>new Date(z.createdAt)-new Date(a.createdAt));
}
function adminBookings(){
  const all = filteredBookings();
  const pageSize = UI.admin.pageSize, page = UI.admin.bookingPage;
  const totalPages = Math.max(1, Math.ceil(all.length/pageSize));
  UI.admin.bookingPage = Math.min(page, totalPages);
  const pageItems = all.slice((UI.admin.bookingPage-1)*pageSize, UI.admin.bookingPage*pageSize);
  const f = UI.admin.bookingFilters;
  const vehicleCats = ['Hatchback','Sedan','SUV','Premium','7-Seater'];

  return `
  <div class="panel">
    <div class="panel-head"><h3>All bookings (${all.length})</h3><button class="btn btn-outline btn-sm" data-act="export-csv">Export CSV</button></div>
    <div class="toolbar">
      <input type="text" placeholder="Search ID, name, phone" value="${esc(f.q)}" data-live="filter-q">
      <select data-live="filter-status"><option value="">All statuses</option>${STATUS_FLOW.concat('Cancelled').map(s=>`<option ${f.status===s?'selected':''}>${s}</option>`).join('')}</select>
      <select data-live="filter-vehicle"><option value="">All vehicles</option>${vehicleCats.map(v=>`<option ${f.vehicle===v?'selected':''}>${v}</option>`).join('')}</select>
      <select data-live="filter-partner"><option value="">All partners</option>${DB.partners.map(p=>`<option value="${p.id}" ${f.partner===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select>
      <input type="date" data-live="filter-from" value="${f.from}" title="From date">
      <input type="date" data-live="filter-to" value="${f.to}" title="To date">
      ${(f.status||f.vehicle||f.partner||f.from||f.to||f.q)?`<button class="btn btn-ghost btn-sm" data-act="filter-clear">Clear</button>`:''}
    </div>
    ${all.length===0?`<div class="empty-state">No bookings match these filters yet.</div>`:`
    <div class="table-scroll desktop-only"><table>
      <thead><tr><th>Booking ID</th><th>Customer</th><th>Phone</th><th>Pickup</th><th>Drop</th><th>Date</th><th>Vehicle</th><th>Price</th><th>Payout</th><th>Margin</th><th>Partner</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${pageItems.map(bookingRow).join('')}</tbody>
    </table></div>
    <div class="mobile-cards" style="padding:14px">${pageItems.map(bookingCard).join('')}</div>
    <div class="toolbar" style="justify-content:space-between">
      <span class="hint">Page ${UI.admin.bookingPage} of ${totalPages}</span>
      <div style="display:flex;gap:6px">
        <button class="btn btn-outline btn-sm" data-act="page-prev" ${UI.admin.bookingPage<=1?'disabled':''}>Prev</button>
        <button class="btn btn-outline btn-sm" data-act="page-next" ${UI.admin.bookingPage>=totalPages?'disabled':''}>Next</button>
      </div>
    </div>`}
  </div>`;
}
function bookingRow(b){
  const margin = (b.customerPrice||0)-(b.partnerPayout||0);
  return `<tr>
    <td class="mono">${b.id}</td><td>${esc(b.customerName)}</td><td>${esc(b.customerPhone)}</td>
    <td>${esc(b.pickup)}</td><td>${esc(b.drop)}</td><td>${fmtDate(b.pickupDate)}</td><td>${b.vehicleCategory}</td>
    <td>${money(b.customerPrice)}</td><td>${money(b.partnerPayout)}</td><td>${money(margin)}</td>
    <td>${b.partnerId?esc(partnerName(b.partnerId)):'—'}</td>
    <td><span class="badge ${statusClass(b.status)}">${b.status}</span></td>
    <td class="row-actions"><button class="btn btn-ghost btn-sm" data-act="open-booking" data-id="${b.id}">Open</button></td>
  </tr>`;
}
function bookingCard(b){
  return `<div class="bcard">
    <div class="bcard-top"><b class="mono">${b.id}</b><span class="badge ${statusClass(b.status)}">${b.status}</span></div>
    <div class="meta">${esc(b.customerName)} · ${esc(b.customerPhone)}</div>
    <div class="meta">${esc(b.pickup)} → ${esc(b.drop)} · ${fmtDate(b.pickupDate)}</div>
    <div class="meta">${money(b.customerPrice)} price · ${money(b.partnerPayout)} payout</div>
    <button class="btn btn-outline btn-sm" style="margin-top:8px" data-act="open-booking" data-id="${b.id}">Open</button>
  </div>`;
}

function bookingDetailModal(id){
  const b = DB.bookings.find(x=>x.id===id);
  if(!b) return;
  const eligiblePartners = DB.partners.filter(p=>p.active && p.verified && p.vehicleCategories.includes(b.vehicleCategory));
  const margin = (Number(b.customerPrice)||0)-(Number(b.partnerPayout)||0);
  openModal(`
    <div class="modal-head"><h3 class="mono">${b.id}</h3><button class="close-x" data-act="modal-bg-close">✕</button></div>
    <span class="badge ${statusClass(b.status)}">${b.status}</span>
    <h4 style="margin-top:18px">Customer</h4>
    ${summaryRow('Name', esc(b.customerName))}${summaryRow('Phone', esc(b.customerPhone))}${summaryRow('Email', esc(b.customerEmail||'—'))}
    <h4 style="margin-top:18px">Trip</h4>
    ${summaryRow('Pickup', esc(b.pickup))}${summaryRow('Drop', esc(b.drop))}${summaryRow('Date & time', fmtDate(b.pickupDate)+' · '+b.pickupTime)}
    ${summaryRow('Trip type', b.tripType)}${summaryRow('Passengers / luggage', b.passengers+' / '+b.luggage)}${summaryRow('Vehicle category', b.vehicleCategory)}
    ${b.instructions?summaryRow('Instructions', esc(b.instructions)):''}
    <h4 style="margin-top:18px">Financial</h4>
    <form data-form="booking-financial" data-id="${b.id}">
      <div class="field-row two">
        <div class="field"><label>Customer price (₹)</label><input type="number" name="customerPrice" value="${b.customerPrice||''}"></div>
        <div class="field"><label>Partner payout (₹)</label><input type="number" name="partnerPayout" value="${b.partnerPayout||''}"></div>
      </div>
      <div class="field-row two">
        <div class="field"><label>Additional charges (₹)</label><input type="number" name="additionalCharges" value="${b.additionalCharges||0}"></div>
        <div class="field"><label>Refund (₹)</label><input type="number" name="refund" value="${b.refund||0}"></div>
      </div>
      <div class="field"><label>Payment status</label><select name="paymentStatus">${['Unpaid','Payment Pending','Paid','Partially Paid','Refunded','Failed','Cash/Offline'].map(s=>`<option ${b.paymentStatus===s?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="summary-row"><span>Platform gross margin</span><b>${money(margin)}</b></div>
      <button class="btn btn-outline btn-block" type="submit">Save financial details</button>
    </form>
    <h4 style="margin-top:18px">Partner &amp; assignment</h4>
    <form data-form="booking-assign" data-id="${b.id}">
      <div class="field"><label>Assign partner</label>
        <select name="partnerId"><option value="">— Select a verified partner —</option>${eligiblePartners.map(p=>`<option value="${p.id}" ${b.partnerId===p.id?'selected':''}>${esc(p.name)} (${p.serviceArea})</option>`).join('')}</select>
      </div>
      ${!eligiblePartners.length?`<p class="hint">No active, verified partners cover ${b.vehicleCategory} yet. Add one in Partner Management.</p>`:''}
      <div class="field-row two">
        <div class="field"><label>Driver name</label><input name="driverName" value="${esc(b.driverName||'')}"></div>
        <div class="field"><label>Driver phone</label><input name="driverPhone" value="${esc(b.driverPhone||'')}"></div>
      </div>
      <div class="field"><label>Vehicle registration no.</label><input name="vehicleReg" value="${esc(b.vehicleReg||'')}"></div>
      <button class="btn btn-outline btn-block" type="submit">Save assignment</button>
    </form>
    <h4 style="margin-top:18px">Status</h4>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
      ${STATUS_FLOW.map(s=>`<button class="btn btn-sm ${b.status===s?'btn-primary':'btn-outline'}" data-act="set-status" data-id="${b.id}" data-status="${s}">${s}</button>`).join('')}
      <button class="btn btn-sm btn-danger" data-act="set-status" data-id="${b.id}" data-status="Cancelled">Cancel booking</button>
    </div>
    <h4>Notes</h4>
    <div>${(b.notes||[]).map(n=>`<div class="summary-row"><span>${esc(n.text)}</span><span class="hint">${fmtDateTime(n.at)}</span></div>`).join('') || '<p class="hint">No notes yet.</p>'}</div>
    <form data-form="booking-note" data-id="${b.id}" style="margin-top:8px;display:flex;gap:8px">
      <input name="text" placeholder="Add a note" style="flex:1">
      <button class="btn btn-outline btn-sm" type="submit">Add</button>
    </form>
    <h4 style="margin-top:18px">Activity</h4>
    <ul class="timeline">${(b.timeline||[]).map((t,i)=>`<li class="past"><b>${esc(t.event)}</b><time>${fmtDateTime(t.timestamp)}</time></li>`).join('')}</ul>
  `);
}

/* ---- Partners ---- */
function adminPartners(){
  return `
  <div class="panel">
    <div class="panel-head"><h3>Partners (${DB.partners.length})</h3><button class="btn btn-primary btn-sm" data-act="partner-new">Add partner</button></div>
    ${!DB.partners.length?'<div class="empty-state">No partners yet.</div>':`
    <div class="table-scroll"><table>
      <thead><tr><th>ID</th><th>Name</th><th>Phone</th><th>Service area</th><th>Vehicle categories</th><th>Status</th><th>Trips</th><th>Actions</th></tr></thead>
      <tbody>${DB.partners.map(p=>`<tr>
        <td class="mono">${p.id}</td><td>${esc(p.name)}</td><td>${esc(p.phone)}</td><td>${esc(p.serviceArea)}</td>
        <td>${p.vehicleCategories.join(', ')}</td>
        <td>${p.verified?'<span class="tag verified">Verified</span>':'<span class="tag unverified">Unverified</span>'} ${!p.active?'<span class="tag inactive">Inactive</span>':''}</td>
        <td>${p.completedTrips||0} done · ${p.cancellations||0} cancel</td>
        <td class="row-actions"><button class="btn btn-ghost btn-sm" data-act="partner-edit" data-id="${p.id}">Edit</button></td>
      </tr>`).join('')}</tbody>
    </table></div>`}
  </div>`;
}
function partnerFormModal(id){
  const p = id ? DB.partners.find(x=>x.id===id) : null;
  const cats = ['Hatchback','Sedan','SUV','Premium','7-Seater'];
  openModal(`
    <div class="modal-head"><h3>${p?'Edit partner':'Add partner'}</h3><button class="close-x" data-act="modal-bg-close">✕</button></div>
    <form data-form="partner-save" data-id="${p?p.id:''}">
      <div class="field"><label>Business / partner name</label><input name="name" required value="${esc(p?.name||'')}"></div>
      <div class="field-row two"><div class="field"><label>Phone</label><input name="phone" required value="${esc(p?.phone||'')}"></div><div class="field"><label>Email</label><input name="email" value="${esc(p?.email||'')}"></div></div>
      <div class="field"><label>Service area</label><input name="serviceArea" required value="${esc(p?.serviceArea||'')}"></div>
      <div class="field"><label>Vehicle categories served</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${cats.map(c=>`<label style="display:flex;align-items:center;gap:5px;font-weight:400;font-size:13.5px;border:1px solid var(--line);padding:6px 10px;border-radius:8px"><input type="checkbox" name="vehicleCategories" value="${c}" style="width:auto" ${p?.vehicleCategories?.includes(c)?'checked':''}> ${c}</label>`).join('')}</div>
      </div>
      <div class="field"><label>Vehicle details</label><input name="vehicleDetails" value="${esc(p?.vehicleDetails||'')}"></div>
      <div class="field-row two"><div class="field"><label>Driver name</label><input name="driverName" value="${esc(p?.driverName||'')}"></div><div class="field"><label>Driver phone</label><input name="driverPhone" value="${esc(p?.driverPhone||'')}"></div></div>
      <div class="field"><label>Registration number</label><input name="regNumber" value="${esc(p?.regNumber||'')}"></div>
      <div class="field"><label>Payment details</label><input name="paymentDetails" value="${esc(p?.paymentDetails||'')}" placeholder="e.g. bank / UPI reference — not full account numbers"></div>
      <div class="field"><label>Documents status</label><select name="documentsStatus">${['Pending','Submitted','Approved','Rejected'].map(s=>`<option ${p?.documentsStatus===s?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>Notes</label><textarea name="notes" rows="2">${esc(p?.notes||'')}</textarea></div>
      <div class="field-row two">
        <label style="display:flex;align-items:center;gap:8px;font-weight:500"><input type="checkbox" name="verified" style="width:auto" ${p?.verified?'checked':''}> Verified</label>
        <label style="display:flex;align-items:center;gap:8px;font-weight:500"><input type="checkbox" name="active" style="width:auto" ${p?.active!==false?'checked':''}> Active</label>
      </div>
      <div class="step-actions">
        ${p?`<button type="button" class="btn btn-danger" data-act="partner-delete" data-id="${p.id}">Delete</button>`:'<span></span>'}
        <button class="btn btn-primary btn-block" type="submit">${p?'Save changes':'Add partner'}</button>
      </div>
    </form>`);
}

/* ---- Vehicles ---- */
function adminVehicles(){
  return `
  <div class="panel">
    <div class="panel-head"><h3>Vehicles (${DB.vehicles.length})</h3><button class="btn btn-primary btn-sm" data-act="vehicle-new">Add vehicle</button></div>
    ${!DB.vehicles.length?'<div class="empty-state">No vehicles yet.</div>':`
    <div class="table-scroll"><table>
      <thead><tr><th>ID</th><th>Category</th><th>Make/model</th><th>Reg. no.</th><th>Seats</th><th>Partner</th><th>Availability</th><th>Actions</th></tr></thead>
      <tbody>${DB.vehicles.map(v=>`<tr>
        <td class="mono">${v.id}</td><td>${v.category}</td><td>${esc(v.makeModel)}</td><td>${esc(v.regNumber)}</td><td>${v.seating}</td>
        <td>${esc(partnerName(v.partnerId))}</td><td>${v.availability}</td>
        <td class="row-actions"><button class="btn btn-ghost btn-sm" data-act="vehicle-edit" data-id="${v.id}">Edit</button></td>
      </tr>`).join('')}</tbody>
    </table></div>`}
  </div>`;
}
function vehicleFormModal(id){
  const v = id ? DB.vehicles.find(x=>x.id===id) : null;
  openModal(`
    <div class="modal-head"><h3>${v?'Edit vehicle':'Add vehicle'}</h3><button class="close-x" data-act="modal-bg-close">✕</button></div>
    <form data-form="vehicle-save" data-id="${v?v.id:''}">
      <div class="field"><label>Category</label><select name="category">${['Hatchback','Sedan','SUV','Premium','7-Seater'].map(c=>`<option ${v?.category===c?'selected':''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Make &amp; model</label><input name="makeModel" required value="${esc(v?.makeModel||'')}"></div>
      <div class="field"><label>Registration number</label><input name="regNumber" required value="${esc(v?.regNumber||'')}"></div>
      <div class="field-row two"><div class="field"><label>Seating capacity</label><input type="number" name="seating" value="${v?.seating||4}"></div><div class="field"><label>Luggage capacity</label><input type="number" name="luggage" value="${v?.luggage||2}"></div></div>
      <div class="field"><label>Partner</label><select name="partnerId"><option value="">— Unassigned —</option>${DB.partners.map(p=>`<option value="${p.id}" ${v?.partnerId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Service area</label><input name="serviceArea" value="${esc(v?.serviceArea||'')}"></div>
      <div class="field"><label>Availability</label><select name="availability">${['Available','Assigned','Unavailable','Maintenance','Suspended'].map(s=>`<option ${v?.availability===s?'selected':''}>${s}</option>`).join('')}</select></div>
      <label style="display:flex;align-items:center;gap:8px;font-weight:500;margin-bottom:14px"><input type="checkbox" name="verified" style="width:auto" ${v?.verified?'checked':''}> Verified</label>
      <div class="step-actions">
        ${v?`<button type="button" class="btn btn-danger" data-act="vehicle-delete" data-id="${v.id}">Delete</button>`:'<span></span>'}
        <button class="btn btn-primary btn-block" type="submit">${v?'Save changes':'Add vehicle'}</button>
      </div>
    </form>`);
}

/* ---- Customers ---- */
function adminCustomers(){
  const rows = DB.customers.map(c=>{
    const cb = DB.bookings.filter(b=>b.customerPhone===c.phone);
    const completed = cb.filter(b=>b.status==='Completed');
    const cancelled = cb.filter(b=>b.status==='Cancelled');
    const spend = completed.reduce((a,b)=>a+(Number(b.finalAmount||b.customerPrice)||0),0);
    const last = cb.sort((a,z)=>new Date(z.createdAt)-new Date(a.createdAt))[0];
    return {c,total:cb.length,completed:completed.length,cancelled:cancelled.length,spend,last};
  });
  return `
  <div class="panel"><div class="panel-head"><h3>Customers (${rows.length})</h3></div>
  ${!rows.length?'<div class="empty-state">No registered customers yet — bookings can still be placed as a guest.</div>':`
  <div class="table-scroll"><table>
    <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Total bookings</th><th>Completed</th><th>Cancelled</th><th>Total spend</th><th>Last booking</th><th>Joined</th></tr></thead>
    <tbody>${rows.map(r=>`<tr><td>${esc(r.c.name)}</td><td>${esc(r.c.phone)}</td><td>${esc(r.c.email||'—')}</td><td>${r.total}</td><td>${r.completed}</td><td>${r.cancelled}</td><td>${money(r.spend)}</td><td>${r.last?fmtDate(r.last.pickupDate):'—'}</td><td>${fmtDate(r.c.createdAt)}</td></tr>`).join('')}</tbody>
  </table></div>`}
  </div>`;
}

/* ---- Pricing ---- */
function adminPricing(){
  const p = DB.settings.pricing;
  return `
  <div class="panel"><div class="panel-head"><h3>Pricing rules</h3></div><div class="panel-body">
    <form data-form="pricing-save">
      <div class="field-row two">
        <div class="field"><label>Base fare (₹)</label><input type="number" name="baseFare" value="${p.baseFare}"></div>
        <div class="field"><label>Per km rate (₹)</label><input type="number" name="perKm" value="${p.perKm}"></div>
      </div>
      <div class="field-row two">
        <div class="field"><label>Per hour rate (₹)</label><input type="number" name="perHour" value="${p.perHour}"></div>
        <div class="field"><label>Airport surcharge (₹)</label><input type="number" name="airportSurcharge" value="${p.airportSurcharge}"></div>
      </div>
      <div class="field-row two">
        <div class="field"><label>Night surcharge (₹)</label><input type="number" name="nightSurcharge" value="${p.nightSurcharge}"></div>
        <div class="field"><label>Extra passenger charge (₹)</label><input type="number" name="extraPassengerCharge" value="${p.extraPassengerCharge}"></div>
      </div>
      <div class="field-row two">
        <div class="field"><label>Driver allowance (₹)</label><input type="number" name="driverAllowance" value="${p.driverAllowance}"></div>
        <div class="field"><label>Platform commission (%)</label><input type="number" name="commissionPercent" value="${p.commissionPercent}"></div>
      </div>
      <p class="hint">These rules drive the customer-facing estimate. Tolls and parking are added manually per booking under "Additional charges". The final price on any individual booking can always be overridden from Booking Management.</p>
      <button class="btn btn-primary" type="submit">Save pricing</button>
    </form>
  </div></div>`;
}

/* ---- Reviews ---- */
function adminReviews(){
  return `
  <div class="panel"><div class="panel-head"><h3>Reviews (${DB.reviews.length})</h3></div>
  ${!DB.reviews.length?'<div class="empty-state">No reviews submitted yet.</div>':`
  <div class="table-scroll"><table>
    <thead><tr><th>Name</th><th>Booking</th><th>Rating</th><th>Review</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${DB.reviews.map(r=>`<tr><td>${esc(r.name)}</td><td class="mono">${r.bookingId||'—'}</td><td>${'★'.repeat(r.rating)}</td><td style="white-space:normal;max-width:260px">${esc(r.text)}</td>
      <td>${r.hidden?'<span class="tag inactive">Hidden</span>':r.featured?'<span class="tag verified">Featured</span>':'Visible'}</td>
      <td class="row-actions">
        <button class="btn btn-ghost btn-sm" data-act="review-toggle-hide" data-id="${r.id}">${r.hidden?'Unhide':'Hide'}</button>
        <button class="btn btn-ghost btn-sm" data-act="review-toggle-feature" data-id="${r.id}">${r.featured?'Unfeature':'Feature'}</button>
      </td></tr>`).join('')}</tbody>
  </table></div>`}
  </div>`;
}

/* ---- Support ---- */
function adminSupport(){
  const items = DB.support.slice().sort((a,z)=>new Date(z.createdAt)-new Date(a.createdAt));
  return `
  <div class="panel"><div class="panel-head"><h3>Support &amp; contact requests (${items.length})</h3></div>
  ${!items.length?'<div class="empty-state">No messages yet.</div>':`
  <div class="table-scroll"><table>
    <thead><tr><th>Name</th><th>Message</th><th>Booking</th><th>Received</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${items.map(s=>`<tr><td>${esc(s.name)}</td><td style="white-space:normal;max-width:300px">${esc(s.message)}</td><td class="mono">${s.bookingId||'—'}</td><td>${fmtDateTime(s.createdAt)}</td>
      <td>${s.resolved?'<span class="tag verified">Resolved</span>':'<span class="tag unverified">Open</span>'}</td>
      <td><button class="btn btn-ghost btn-sm" data-act="support-toggle" data-id="${s.id}">${s.resolved?'Reopen':'Mark resolved'}</button></td></tr>`).join('')}</tbody>
  </table></div>`}
  </div>`;
}

/* ---- Settings ---- */
function adminSettings(){
  const s = DB.settings;
  return `
  <div class="panel"><div class="panel-head"><h3>Business details</h3></div><div class="panel-body">
    <form data-form="business-save">
      <div class="field"><label>Business name</label><input name="businessName" required value="${esc(s.businessName)}"></div>
      <div class="field-row two"><div class="field"><label>Phone</label><input name="phone" value="${esc(s.phone)}"></div><div class="field"><label>Email</label><input name="email" value="${esc(s.email)}"></div></div>
      <div class="field"><label>WhatsApp number (digits only, with country code)</label><input name="whatsapp" value="${esc(s.whatsapp)}" placeholder="e.g. 919000000000"></div>
      <div class="field"><label>Address</label><input name="address" value="${esc(s.address)}"></div>
      <div class="field"><label>Service areas (comma separated)</label><input name="serviceAreas" value="${esc(s.serviceAreas.join(', '))}"></div>
      <button class="btn btn-primary" type="submit">Save business details</button>
    </form>
  </div></div>
  <div class="panel"><div class="panel-head"><h3>Booking rules</h3></div><div class="panel-body">
    <form data-form="booking-rules-save">
      <div class="field"><label>Booking ID prefix</label><input name="bookingPrefix" value="${esc(s.bookingPrefix)}" maxlength="4"></div>
      <div class="field-row two"><div class="field"><label>Advance booking notice (hrs)</label><input type="number" name="advanceBookingHours" value="${s.advanceBookingHours}"></div><div class="field"><label>Minimum booking notice (hrs)</label><input type="number" name="minNoticeHours" value="${s.minNoticeHours}"></div></div>
      <div class="field"><label>Cancellation rules</label><textarea name="cancellationRules" rows="3">${esc(s.cancellationRules)}</textarea></div>
      <button class="btn btn-primary" type="submit">Save booking rules</button>
    </form>
  </div></div>
  <div class="panel"><div class="panel-head"><h3>Notifications</h3></div><div class="panel-body">
    <p class="hint">No email, SMS or WhatsApp API is connected yet, so notifications are not sent — the platform will only show statuses in-app and on the tracking page until a provider is configured server-side. Wiring one up requires a backend (see README).</p>
  </div></div>
  <div class="panel"><div class="panel-head"><h3>Admin password</h3></div><div class="panel-body">
    <form data-form="admin-password-save">
      <div class="field"><label>New password</label><input type="password" name="password" minlength="4" required></div>
      <button class="btn btn-outline" type="submit">Update password</button>
    </form>
  </div></div>`;
}

/* =========================================================================
   ACTION HANDLERS
   ========================================================================= */
function handleAction(act, el){
  const id = el.getAttribute('data-id');
  if(act==='toggle-faq'){ el.closest('.faq-item').classList.toggle('open'); return; }

  if(act==='pick-trip'){ UI.booking.draft.tripType = el.getAttribute('data-val'); renderBooking(); return; }
  if(act==='pick-vehicle'){ UI.booking.draft.vehicleCategory = el.getAttribute('data-val'); renderBooking(); return; }
  if(act==='step-back'){ UI.booking.step = Math.max(1, UI.booking.step-1); renderBooking(); return; }
  if(act==='step-next'){ UI.booking.step++; renderBooking(); return; }
  if(act==='submit-booking'){ submitBooking(); return; }

  if(act==='auth-switch'){ UI.authMode = el.getAttribute('data-val'); renderCustomerAuth(); return; }
  if(act==='logout'){ SESSION=null; go('home'); return; }
  if(act==='customer-cancel'){ cancelBooking(id); return; }

  if(act==='open-booking'){ bookingDetailModal(id); return; }
  if(act==='set-status'){ setBookingStatus(id, el.getAttribute('data-status')); return; }
  if(act==='page-prev'){ UI.admin.bookingPage--; renderAdmin('admin/bookings'); return; }
  if(act==='page-next'){ UI.admin.bookingPage++; renderAdmin('admin/bookings'); return; }
  if(act==='filter-clear'){ UI.admin.bookingFilters = {status:'',vehicle:'',partner:'',from:'',to:'',q:''}; UI.admin.bookingPage=1; renderAdmin('admin/bookings'); return; }
  if(act==='export-csv'){ exportBookingsCsv(); return; }

  if(act==='partner-new'){ partnerFormModal(null); return; }
  if(act==='partner-edit'){ partnerFormModal(id); return; }
  if(act==='partner-delete'){ deletePartner(id); return; }
  if(act==='vehicle-new'){ vehicleFormModal(null); return; }
  if(act==='vehicle-edit'){ vehicleFormModal(id); return; }
  if(act==='vehicle-delete'){ deleteVehicle(id); return; }

  if(act==='review-toggle-hide'){ toggleReview(id,'hidden'); return; }
  if(act==='review-toggle-feature'){ toggleReview(id,'featured'); return; }
  if(act==='support-toggle'){ toggleSupport(id); return; }
}

async function submitBooking(){
  const d = UI.booking.draft;
  const id = await nextBookingId();
  const now = new Date().toISOString();
  const price = estimatePrice(d);
  const bk = Object.assign({}, d, {
    id, status:'Request Received', customerPrice:price, partnerPayout:0,
    additionalCharges:0, refund:0, finalAmount:null, paymentStatus:'Payment Pending',
    partnerId:null, driverName:'', driverPhone:'', vehicleReg:'',
    notes:[], timeline:[{event:'Request Received', timestamp:now}],
    createdAt:now, updatedAt:now
  });
  DB.bookings.push(bk);
  await storeSet(KEYS.bookings, DB.bookings);
  UI.booking.createdId = id;
  UI.booking.step = 6;
  renderBooking();
  showToast('Booking request sent');
}
async function cancelBooking(id){
  const bk = DB.bookings.find(b=>b.id===id);
  if(!bk) return;
  bk.status='Cancelled'; bk.updatedAt=new Date().toISOString();
  bk.timeline.push({event:'Cancelled', timestamp:bk.updatedAt});
  await storeSet(KEYS.bookings, DB.bookings);
  showToast('Booking cancelled');
  renderAccount();
}
async function setBookingStatus(id, status){
  const bk = DB.bookings.find(b=>b.id===id);
  if(!bk) return;
  bk.status = status; bk.updatedAt = new Date().toISOString();
  bk.timeline = bk.timeline||[];
  if(!bk.timeline.find(t=>t.event===status)) bk.timeline.push({event:status, timestamp:bk.updatedAt});
  if(status==='Completed'){
    const p = DB.partners.find(x=>x.id===bk.partnerId);
    if(p){ p.completedTrips = (p.completedTrips||0)+1; await storeSet(KEYS.partners, DB.partners); }
  }
  if(status==='Cancelled' && bk.partnerId){
    const p = DB.partners.find(x=>x.id===bk.partnerId);
    if(p){ p.cancellations = (p.cancellations||0)+1; await storeSet(KEYS.partners, DB.partners); }
  }
  await storeSet(KEYS.bookings, DB.bookings);
  showToast('Status updated to ' + status);
  bookingDetailModal(id);
  renderAdmin('admin/bookings');
}
async function deletePartner(id){
  DB.partners = DB.partners.filter(p=>p.id!==id);
  await storeSet(KEYS.partners, DB.partners);
  closeModal(); showToast('Partner removed'); renderAdmin('admin/partners');
}
async function deleteVehicle(id){
  DB.vehicles = DB.vehicles.filter(v=>v.id!==id);
  await storeSet(KEYS.vehicles, DB.vehicles);
  closeModal(); showToast('Vehicle removed'); renderAdmin('admin/vehicles');
}
async function toggleReview(id, field){
  const r = DB.reviews.find(x=>x.id===id); if(!r) return;
  r[field] = !r[field];
  await storeSet(KEYS.reviews, DB.reviews);
  renderAdmin('admin/reviews');
}
async function toggleSupport(id){
  const s = DB.support.find(x=>x.id===id); if(!s) return;
  s.resolved = !s.resolved;
  await storeSet(KEYS.support, DB.support);
  renderAdmin('admin/support');
}
function exportBookingsCsv(){
  const rows = filteredBookings();
  const cols = ['id','status','customerName','customerPhone','pickup','drop','pickupDate','pickupTime','vehicleCategory','customerPrice','partnerPayout','paymentStatus','partnerId','createdAt'];
  const csv = [cols.join(',')].concat(rows.map(r=>cols.map(c=>`"${String(r[c]??'').replace(/"/g,'""')}"`).join(','))).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bookings-export.csv';
  a.click();
}

/* =========================================================================
   FORM HANDLERS
   ========================================================================= */
function fd(form){ return Object.fromEntries(new FormData(form).entries()); }
function validateField(input, ok){
  const field = input.closest('.field');
  if(field) field.classList.toggle('invalid', !ok);
  return ok;
}
async function handleForm(kind, form){
  const v = fd(form);
  if(kind==='step2'){
    if(!v.pickup || !v.drop || !v.pickupDate || !v.pickupTime){ showToast('Please fill in all required fields'); return; }
    Object.assign(UI.booking.draft, v);
    UI.booking.step = 3; renderBooking(); return;
  }
  if(kind==='step3'){
    Object.assign(UI.booking.draft, v);
    UI.booking.step = 4; renderBooking(); return;
  }
  if(kind==='step4'){
    if(!/^[0-9+ ]{8,15}$/.test(v.customerPhone||'')){ showToast('Enter a valid mobile number'); return; }
    Object.assign(UI.booking.draft, v);
    UI.booking.step = 5; renderBooking(); return;
  }
  if(kind==='track'){
    UI.trackResult = DB.bookings.find(b=>b.id===v.id.trim() && b.customerPhone===v.phone.trim()) || null;
    renderTrack(); return;
  }
  if(kind==='contact'){
    const item = { id: uid('SUP'), name:v.name, message:v.message, resolved:false, createdAt:new Date().toISOString() };
    DB.support.push(item); await storeSet(KEYS.support, DB.support);
    form.reset(); showToast("Message sent — we'll get back to you soon"); return;
  }
  if(kind==='customer-login'){
    const cust = DB.customers.find(c=>c.phone===v.phone.trim());
    if(!cust){ showToast('No account found for that number'); return; }
    const hash = await sha256(v.password);
    if(hash !== cust.passwordHash){ showToast('Incorrect password'); return; }
    SESSION = { type:'customer', id:cust.id, name:cust.name, phone:cust.phone };
    go('account'); return;
  }
  if(kind==='customer-register'){
    if(DB.customers.find(c=>c.phone===v.phone.trim())){ showToast('An account already exists for that number'); return; }
    const cust = { id: uid('CUS'), name:v.name, phone:v.phone.trim(), email:'', passwordHash: await sha256(v.password), createdAt:new Date().toISOString() };
    DB.customers.push(cust); await storeSet(KEYS.customers, DB.customers);
    SESSION = { type:'customer', id:cust.id, name:cust.name, phone:cust.phone };
    go('account'); return;
  }
  if(kind==='admin-login'){
    const hash = await sha256(v.password);
    if(hash !== DB.settings.adminPasswordHash){ showToast('Incorrect password'); return; }
    SESSION = { type:'admin', name:'Admin' };
    go('admin/dashboard'); return;
  }
  if(kind==='booking-financial'){
    const b = DB.bookings.find(x=>x.id===form.getAttribute('data-id')); if(!b) return;
    b.customerPrice=Number(v.customerPrice)||0; b.partnerPayout=Number(v.partnerPayout)||0;
    b.additionalCharges=Number(v.additionalCharges)||0; b.refund=Number(v.refund)||0;
    b.finalAmount = b.customerPrice + b.additionalCharges - b.refund;
    b.paymentStatus = v.paymentStatus; b.updatedAt=new Date().toISOString();
    await storeSet(KEYS.bookings, DB.bookings);
    showToast('Financial details saved'); bookingDetailModal(b.id); renderAdmin('admin/bookings'); return;
  }
  if(kind==='booking-assign'){
    const b = DB.bookings.find(x=>x.id===form.getAttribute('data-id')); if(!b) return;
    const wasUnassigned = !b.partnerId;
    b.partnerId = v.partnerId || null; b.driverName=v.driverName; b.driverPhone=v.driverPhone; b.vehicleReg=v.vehicleReg;
    b.updatedAt = new Date().toISOString();
    if(b.partnerId && wasUnassigned){
      b.status = 'Partner Assigned';
      b.timeline.push({event:'Partner Assigned', timestamp:b.updatedAt});
    }
    await storeSet(KEYS.bookings, DB.bookings);
    showToast('Assignment saved'); bookingDetailModal(b.id); renderAdmin('admin/bookings'); return;
  }
  if(kind==='booking-note'){
    const b = DB.bookings.find(x=>x.id===form.getAttribute('data-id')); if(!b || !v.text) return;
    b.notes = b.notes||[]; b.notes.push({text:v.text, at:new Date().toISOString()});
    await storeSet(KEYS.bookings, DB.bookings);
    bookingDetailModal(b.id); return;
  }
  if(kind==='partner-save'){
    const editId = form.getAttribute('data-id');
    const cats = Array.from(form.querySelectorAll('input[name=vehicleCategories]:checked')).map(c=>c.value);
    const payload = { name:v.name, phone:v.phone, email:v.email, serviceArea:v.serviceArea, vehicleCategories:cats,
      vehicleDetails:v.vehicleDetails, driverName:v.driverName, driverPhone:v.driverPhone, regNumber:v.regNumber,
      paymentDetails:v.paymentDetails, documentsStatus:v.documentsStatus, notes:v.notes,
      verified: form.querySelector('[name=verified]').checked, active: form.querySelector('[name=active]').checked };
    if(editId){ Object.assign(DB.partners.find(p=>p.id===editId), payload); }
    else { DB.partners.push(Object.assign({id: uid('PTR'), completedTrips:0, cancellations:0}, payload)); }
    await storeSet(KEYS.partners, DB.partners);
    closeModal(); showToast('Partner saved'); renderAdmin('admin/partners'); return;
  }
  if(kind==='vehicle-save'){
    const editId = form.getAttribute('data-id');
    const payload = { category:v.category, makeModel:v.makeModel, regNumber:v.regNumber, seating:Number(v.seating)||4,
      luggage:Number(v.luggage)||0, partnerId:v.partnerId||null, serviceArea:v.serviceArea, availability:v.availability,
      verified: form.querySelector('[name=verified]').checked };
    if(editId){ Object.assign(DB.vehicles.find(x=>x.id===editId), payload); }
    else { DB.vehicles.push(Object.assign({id: uid('VEH')}, payload)); }
    await storeSet(KEYS.vehicles, DB.vehicles);
    closeModal(); showToast('Vehicle saved'); renderAdmin('admin/vehicles'); return;
  }
  if(kind==='pricing-save'){
    DB.settings.pricing = { baseFare:Number(v.baseFare)||0, perKm:Number(v.perKm)||0, perHour:Number(v.perHour)||0,
      airportSurcharge:Number(v.airportSurcharge)||0, nightSurcharge:Number(v.nightSurcharge)||0,
      extraPassengerCharge:Number(v.extraPassengerCharge)||0, driverAllowance:Number(v.driverAllowance)||0,
      commissionPercent:Number(v.commissionPercent)||0 };
    await storeSet(KEYS.settings, DB.settings);
    showToast('Pricing saved'); return;
  }
  if(kind==='business-save'){
    Object.assign(DB.settings, { businessName:v.businessName, phone:v.phone, email:v.email, whatsapp:v.whatsapp, address:v.address,
      serviceAreas: v.serviceAreas.split(',').map(s=>s.trim()).filter(Boolean) });
    await storeSet(KEYS.settings, DB.settings);
    showToast('Business details saved'); renderAdmin('admin/settings'); return;
  }
  if(kind==='booking-rules-save'){
    Object.assign(DB.settings, { bookingPrefix:(v.bookingPrefix||'CR').toUpperCase(), advanceBookingHours:Number(v.advanceBookingHours)||0,
      minNoticeHours:Number(v.minNoticeHours)||0, cancellationRules:v.cancellationRules });
    await storeSet(KEYS.settings, DB.settings);
    showToast('Booking rules saved'); return;
  }
  if(kind==='admin-password-save'){
    DB.settings.adminPasswordHash = await sha256(v.password);
    await storeSet(KEYS.settings, DB.settings);
    form.reset(); showToast('Admin password updated'); return;
  }
}
function handleLive(kind, el){
  const f = UI.admin.bookingFilters;
  if(kind==='filter-q') f.q = el.value;
  if(kind==='filter-status') f.status = el.value;
  if(kind==='filter-vehicle') f.vehicle = el.value;
  if(kind==='filter-partner') f.partner = el.value;
  if(kind==='filter-from') f.from = el.value;
  if(kind==='filter-to') f.to = el.value;
  UI.admin.bookingPage = 1;
  renderAdmin('admin/bookings');
}

/* =========================================================================
   BOOT
   ========================================================================= */
(async function boot(){
  mount(`<div style="min-height:60vh;display:flex;align-items:center;justify-content:center;color:var(--ink-soft)">Loading…</div>`);
  await seedIfEmpty();
  route();
})();
