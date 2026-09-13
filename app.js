/* =========================================================================
   Burdwan Car Rental — booking platform
   -------------------------------------------------------------------------
   Data layer: Supabase (Postgres) via a single app_data(key, value jsonb)
   table — see supabase-setup.sql and README.md for setup. Fill in
   SUPABASE_URL / SUPABASE_ANON_KEY below before this will actually save
   anything.
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

/* ---------- Supabase connection ---------- */
// Fill these in from Supabase → Project Settings → API, then re-upload
// app.js. Until you do, the app falls back to running in-memory only
// (works for testing this session, but nothing will persist or be shared
// across devices — see the console warning).
const SUPABASE_URL = 'https://rltuvefllbetzytzqdht.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_BbM25_BKdothH1m4HLzRZg_ymVkFDB5';

let sb = null;
if (SUPABASE_URL.startsWith('http') && SUPABASE_ANON_KEY.length > 20 && window.supabase) {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} else {
  console.warn('Supabase is not configured yet — data will not be saved. Fill in SUPABASE_URL and SUPABASE_ANON_KEY at the top of app.js.');
}

/* ---------- storage helpers ---------- */
// One table, app_data(key text primary key, value jsonb) — see
// supabase-setup.sql. Every collection in the app (settings, bookings,
// partners, vehicles, customers, reviews, support, counter) is one row.
const memoryFallback = {}; // used only if Supabase isn't configured yet
async function storeGet(key, fallback){
  if (!sb) return memoryFallback.hasOwnProperty(key) ? memoryFallback[key] : fallback;
  try{
    const { data, error } = await sb.from('app_data').select('value').eq('key', key).maybeSingle();
    if (error || !data) return fallback;
    return data.value;
  }catch(e){ console.error('storage get failed', key, e); return fallback; }
}
async function storeSet(key, value){
  memoryFallback[key] = value;
  if (!sb) { showToast('Not saved — Supabase is not configured yet'); return false; }
  try{
    const { error } = await sb.from('app_data').upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw error;
    return true;
  }catch(e){ console.error('storage set failed', key, e); showToast('Could not save — check connection'); return false; }
}
async function sha256(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

/* ---------- vehicle categories & pricing engine defaults ---------- */
const VEHICLE_CATEGORIES = ['Hatchback','Sedan','SUV','Premium SUV'];
const VEHICLE_CAPACITY = { Hatchback:4, Sedan:4, SUV:6, 'Premium SUV':6 };
function defaultPricingV2(){
  return {
    local: {
      Hatchback:  { pkg4h40:999,  pkg8h80:1499, pkg12h120:1999, extraKm:14, extraHour:150 },
      Sedan:      { pkg4h40:1199, pkg8h80:1799, pkg12h120:2399, extraKm:16, extraHour:200 },
      SUV:        { pkg4h40:1499, pkg8h80:2299, pkg12h120:2999, extraKm:20, extraHour:250 },
      'Premium SUV': { pkg4h40:1999, pkg8h80:2999, pkg12h120:3999, extraKm:25, extraHour:350 }
    },
    outstation: {
      Hatchback:  { perKm:13, minKmPerDay:150, driverAllowancePerDay:300 },
      Sedan:      { perKm:15, minKmPerDay:150, driverAllowancePerDay:300 },
      SUV:        { perKm:18, minKmPerDay:150, driverAllowancePerDay:400 },
      'Premium SUV': { perKm:22, minKmPerDay:150, driverAllowancePerDay:500 }
    },
    outstationExtras: { tolls:'Excluded', parking:'Excluded', permits:'Excluded' }, // 'Included' | 'Excluded'
    airportRoutes: [
      { id:'RTE-001', pickupZone:'Burdwan', dropZone:'Kolkata Airport', tripType:'One Way',
        fares:{ Hatchback:1899, Sedan:2099, SUV:2699, 'Premium SUV':3499 },
        tollIncluded:false, parkingIncluded:false, nightChargeApplies:true, active:true }
    ],
    routePricing: [], // general fixed routes admin adds — Burdwan → Durgapur, → Bolpur, → Asansol, etc. None seeded by default; only shown once admin configures them.
    night: { enabled:true, startHour:22, endHour:6, charges:{ Hatchback:200, Sedan:250, SUV:300, 'Premium SUV':400 } },
    extraStop: { charge:100 },
    waiting: { perHour:{ Hatchback:150, Sedan:200, SUV:250, 'Premium SUV':350 }, airportFreeMinutes:30 },
    targetMarginPercent: 15, // allowed range 5–30
    directPlatformCostDefault: 0,
    lastUpdated: {} // { local:{at,by}, outstation:{at,by}, ... }
  };
}

/* ---------- defaults / seed ---------- */
function defaultSettings(){
  return {
    businessName: 'Burdwan Car Rental',
    phone: '+91 7001499325',
    email: 'burdwancarrental@gmail.com',
    whatsapp: '',
    address: 'Add your registered business address here',
    // Each service area is a simple circle: a center point + radius. This is
    // an approximation of a real coverage area (not a true district polygon)
    // but is enough to genuinely validate "is this pickup/drop in range" —
    // see README for upgrading to real polygon boundaries later.
    serviceAreas: [
      { name:'Burdwan (Bardhaman)', lat:23.2324, lng:87.8615, radiusKm:15 },
      { name:'Durgapur', lat:23.5204, lng:87.3119, radiusKm:12 },
      { name:'Asansol', lat:23.6739, lng:86.9524, radiusKm:12 },
      { name:'Kolkata / Kolkata Airport', lat:22.6540, lng:88.4467, radiusKm:20 }
    ],
    bookingPrefix: 'BCR',
    cancellationRules: 'Free cancellation up to 4 hours before pickup. Cancellations after that, or no-shows, may be charged a fee once a partner has been assigned.',
    advanceBookingHours: 2,
    minNoticeHours: 2,
    payLaterEnabled: true,
    payLaterBlockedCategories: ['Premium SUV'], // these categories require Pay Now
    payment: {
      upiId: '', // e.g. 'yourbusiness@upi' — leave blank to hide Pay Now until configured
      payeeName: 'Burdwan Car Rental'
    },
    pricing: defaultPricingV2(),
    // Which documents to ask for, per service mode. Admin-configurable —
    // deliberately NOT asking for a driving licence on chauffeur-driven trips,
    // and not making Aadhaar/any ID mandatory by default.
    documentRequirements: {
      Chauffeur: [
        { key:'govtId', label:'Government-issued photo ID', required:false }
      ],
      'Self-Drive': [
        { key:'drivingLicence', label:'Valid driving licence', required:true },
        { key:'govtId', label:'Government-issued photo ID', required:true }
      ]
    },
    maxDocSizeMb: 5,
    adminUsername: 'kalicharanmurmu23199@gmail.com',
    adminPasswordHash: null // set on first boot to sha256(the admin password)
  };
}
async function seedIfEmpty(){
  let settings = await storeGet(KEYS.settings, null);
  if(!settings){
    settings = defaultSettings();
    settings.adminPasswordHash = await sha256('kalicharanmurmu23199@gmail.com');
    await storeSet(KEYS.settings, settings);
  }
  settings = migrateSettings(settings);
  DB.settings = settings;

  DB.bookings = (await storeGet(KEYS.bookings, [])).map(migrateBooking);
  DB.customers = await storeGet(KEYS.customers, []);
  DB.reviews = await storeGet(KEYS.reviews, []);
  DB.support = await storeGet(KEYS.support, []);
  DB.counter = await storeGet(KEYS.counter, {});

  let partners = await storeGet(KEYS.partners, null);
  if(!partners){
    partners = [
      { id:'PTR-001', name:'Add your first verified partner', phone:'', email:'', serviceArea:'Burdwan', vehicleCategories:['Sedan','SUV'], vehicleDetails:'', regNumber:'', driverName:'', driverPhone:'', driverPhoto:'', address:'', bankDetails:'', documentsStatus:'Pending', notes:'Example record — edit or delete from Partner Management.', verificationStatus:'Pending', active:true, completedTrips:0, cancellations:0, earnings:0, passwordHash:null }
    ];
    await storeSet(KEYS.partners, partners);
  }
  DB.partners = partners.map(migratePartner);

  let vehicles = await storeGet(KEYS.vehicles, null);
  if(!vehicles){
    vehicles = [
      { id:'VEH-001', category:'Sedan', makeModel:'Add make & model', regNumber:'', seating:4, luggage:2, partnerId:'PTR-001', serviceArea:'Burdwan', availability:'Available', verified:false, insuranceExpiry:'', pucExpiry:'', permitExpiry:'', fitnessExpiry:'' }
    ];
    await storeSet(KEYS.vehicles, vehicles);
  }
  DB.vehicles = vehicles.map(migrateVehicle);
}

/* ---------- migrations (so an already-live site with old-shape data in
   Supabase upgrades cleanly instead of breaking) ---------- */
const LEGACY_STATUS_MAP = {
  'Request Received':'REQUEST_RECEIVED', 'Searching for Vehicle':'UNDER_REVIEW',
  'Partner Assigned':'PARTNER_ASSIGNED', 'Awaiting Confirmation':'AWAITING_PARTNER_ACCEPTANCE',
  'Confirmed':'BOOKING_CONFIRMED', 'Driver/Vehicle Assigned':'DRIVER_ASSIGNED',
  'Trip Started':'TRIP_STARTED', 'Completed':'TRIP_COMPLETED', 'Cancelled':'CANCELLED'
};
const CATEGORY_RENAME = { 'Premium':'Premium SUV', '7-Seater':'SUV' };
function renameCategory(c){ return CATEGORY_RENAME[c] || c; }
function migrateSettings(s){
  const def = defaultSettings();
  Object.keys(def).forEach(k=>{ if(s[k]===undefined || s[k]===null) s[k] = def[k]; });
  if(Array.isArray(s.serviceAreas) && s.serviceAreas.length && typeof s.serviceAreas[0]==='string'){
    s.serviceAreas = def.serviceAreas; // old plain-name list can't be geo-validated; replace with real coordinates once
  }
  s.pricing = Object.assign({}, def.pricing, s.pricing||{});
  // old flat pricing fields (baseFare, perKm, etc.) from before the pricing-engine
  // upgrade are harmless leftovers — the code below only reads the nested
  // local/outstation/airportRoutes/night/etc. shape, which def.pricing supplies
  // fresh if the old settings predate it.
  s.payment = Object.assign({}, def.payment, s.payment||{});
  s.documentRequirements = s.documentRequirements || def.documentRequirements;
  if(!Array.isArray(s.payLaterBlockedCategories) || s.payLaterBlockedCategories.includes('Premium')){
    s.payLaterBlockedCategories = (s.payLaterBlockedCategories||[]).map(renameCategory);
    if(!s.payLaterBlockedCategories.length) s.payLaterBlockedCategories = def.payLaterBlockedCategories;
  }
  if(s.payLaterEnabled===undefined) s.payLaterEnabled = true;
  if(!s.maxDocSizeMb) s.maxDocSizeMb = 5;
  if(s.bookingPrefix==='CR') s.bookingPrefix = 'BCR';
  return s;
}
function migrateBooking(bk){
  if(LEGACY_STATUS_MAP[bk.status]) bk.status = LEGACY_STATUS_MAP[bk.status];
  if(Array.isArray(bk.timeline)) bk.timeline = bk.timeline.map(t=>({ event: LEGACY_STATUS_MAP[t.event]||t.event, timestamp:t.timestamp }));
  if(!bk.documents) bk.documents = {};
  if(!bk.serviceMode) bk.serviceMode = 'Chauffeur';
  if(!bk.paymentMethod) bk.paymentMethod = 'Pay Later';
  if(bk.paymentStatus==='Payment Pending') bk.paymentStatus = 'Pending';
  if(bk.pickupLat===undefined) bk.pickupLat = null;
  if(bk.pickupLng===undefined) bk.pickupLng = null;
  if(bk.dropLat===undefined) bk.dropLat = null;
  if(bk.dropLng===undefined) bk.dropLng = null;
  if(bk.distanceKm===undefined) bk.distanceKm = null;
  if(bk.partnerAcceptance===undefined) bk.partnerAcceptance = null;
  if(bk.vehicleCategory) bk.vehicleCategory = renameCategory(bk.vehicleCategory);
  if(!bk.priceBreakdown) bk.priceBreakdown = null; // pre-pricing-engine bookings have no stored snapshot — shown as "priced under an earlier version"
  if(bk.directPlatformCost===undefined) bk.directPlatformCost = 0;
  if(bk.priceOverrides===undefined) bk.priceOverrides = [];
  return bk;
}
function migratePartner(p){
  if(!p.verificationStatus) p.verificationStatus = p.verified ? 'Verified' : 'Pending';
  if(p.bankDetails===undefined) p.bankDetails = p.paymentDetails || '';
  if(p.passwordHash===undefined) p.passwordHash = null;
  if(p.earnings===undefined) p.earnings = 0;
  if(p.driverPhoto===undefined) p.driverPhoto = '';
  if(p.address===undefined) p.address = '';
  if(Array.isArray(p.vehicleCategories)) p.vehicleCategories = [...new Set(p.vehicleCategories.map(renameCategory))];
  return p;
}
function migrateVehicle(v){
  ['insuranceExpiry','pucExpiry','permitExpiry','fitnessExpiry'].forEach(k=>{ if(v[k]===undefined) v[k]=''; });
  if(v.category) v.category = renameCategory(v.category);
  return v;
}
function isPartnerVerified(p){ return p.verificationStatus==='Verified'; }

/* ---------- geo helpers ---------- */
function haversineKm(lat1,lng1,lat2,lng2){
  if([lat1,lng1,lat2,lng2].some(v=>v===null||v===undefined||isNaN(v))) return null;
  const R=6371, toRad=x=>x*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return R * 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function isInServiceArea(lat,lng){
  if(lat==null||lng==null) return false;
  return DB.settings.serviceAreas.some(a=>{
    const d = haversineKm(lat,lng,a.lat,a.lng);
    return d!==null && d<=a.radiusKm;
  });
}
function roadDistanceKm(lat1,lng1,lat2,lng2){
  const straight = haversineKm(lat1,lng1,lat2,lng2);
  return straight===null ? null : Math.round(straight * 1.35 * 10)/10; // rough road-distance factor, clearly labeled as approximate everywhere it's shown
}
function estimateEtaMinutes(distanceKm){
  if(distanceKm==null) return null;
  return Math.round(distanceKm / 32 * 60); // ~32 km/h blended average, approximate only
}

/* ---------- vehicle availability ---------- */
function timesOverlap(aStart,aEnd,bStart,bEnd){ return aStart < bEnd && bStart < aEnd; }
function bookingWindow(bk){
  const start = new Date(`${bk.pickupDate}T${bk.pickupTime||'00:00'}`);
  const end = bk.returnDate ? new Date(`${bk.returnDate}T${bk.returnTime||'23:59'}`) : new Date(start.getTime() + 4*3600*1000); // assume ~4hr trip window if no return given
  return { start, end };
}
function isPartnerAvailableFor(partnerId, pickupDate, pickupTime, returnDate, returnTime, excludeBookingId){
  const draftStart = new Date(`${pickupDate}T${pickupTime||'00:00'}`);
  const draftEnd = returnDate ? new Date(`${returnDate}T${returnTime||'23:59'}`) : new Date(draftStart.getTime()+4*3600*1000);
  const activeStatuses = ['AWAITING_PARTNER_ACCEPTANCE','BOOKING_CONFIRMED','DRIVER_ASSIGNED','DRIVER_ON_THE_WAY','DRIVER_ARRIVED','TRIP_STARTED'];
  return !DB.bookings.some(b=>{
    if(b.id===excludeBookingId || b.partnerId!==partnerId) return false;
    if(!activeStatuses.includes(b.status)) return false;
    const w = bookingWindow(b);
    return timesOverlap(draftStart, draftEnd, w.start, w.end);
  });
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
function statusClass(s){ return 'status-' + (STATUS_COLOR[s] || 'warn'); }

const STATUS_FLOW = ['REQUEST_RECEIVED','PAYMENT_PENDING','PAYMENT_VERIFIED','UNDER_REVIEW','PARTNER_BEING_ASSIGNED','PARTNER_ASSIGNED','AWAITING_PARTNER_ACCEPTANCE','BOOKING_CONFIRMED','DRIVER_ASSIGNED','DRIVER_ON_THE_WAY','DRIVER_ARRIVED','TRIP_STARTED','TRIP_COMPLETED'];
const STATUS_BRANCH = ['CANCELLATION_REQUESTED','CANCELLED','REFUND_PENDING','REFUNDED','FAILED'];
const ALL_STATUSES = STATUS_FLOW.concat(STATUS_BRANCH);
const STATUS_LABELS = {
  REQUEST_RECEIVED:'Request Received', PAYMENT_PENDING:'Payment Pending', PAYMENT_VERIFIED:'Payment Verified',
  UNDER_REVIEW:'Under Review', PARTNER_BEING_ASSIGNED:'Partner Being Assigned', PARTNER_ASSIGNED:'Partner Assigned',
  AWAITING_PARTNER_ACCEPTANCE:'Awaiting Partner Acceptance', BOOKING_CONFIRMED:'Booking Confirmed',
  DRIVER_ASSIGNED:'Driver Assigned', DRIVER_ON_THE_WAY:'Driver On The Way', DRIVER_ARRIVED:'Driver Arrived',
  TRIP_STARTED:'Trip Started', TRIP_COMPLETED:'Trip Completed', CANCELLATION_REQUESTED:'Cancellation Requested',
  CANCELLED:'Cancelled', REFUND_PENDING:'Refund Pending', REFUNDED:'Refunded', FAILED:'Failed'
};
const STATUS_COLOR = {
  REQUEST_RECEIVED:'warn', PAYMENT_PENDING:'warn', PAYMENT_VERIFIED:'info', UNDER_REVIEW:'warn',
  PARTNER_BEING_ASSIGNED:'warn', PARTNER_ASSIGNED:'info', AWAITING_PARTNER_ACCEPTANCE:'warn',
  BOOKING_CONFIRMED:'info', DRIVER_ASSIGNED:'info', DRIVER_ON_THE_WAY:'info', DRIVER_ARRIVED:'info',
  TRIP_STARTED:'info', TRIP_COMPLETED:'success', CANCELLATION_REQUESTED:'warn', CANCELLED:'danger',
  REFUND_PENDING:'warn', REFUNDED:'success', FAILED:'danger'
};
function statusLabel(s){ return STATUS_LABELS[s] || s; }

/* ---------- toast / modal ---------- */
let toastTimer=null;
function showToast(msg){
  const root = document.getElementById('toast-root');
  root.innerHTML = `<div class="toast show">${esc(msg)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ const t=root.querySelector('.toast'); if(t) t.classList.remove('show'); }, 2600);
}
function openModal(html){
  document.getElementById('modal-root').innerHTML = `<div class="modal-bg" data-act="modal-bg-close"><div class="modal">${html}</div></div>`;
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
  if(ROUTE.path !== 'login') UI.authMode = null; // don't leak "Register" mode into the next visit to Sign in
  closeModal(); // never leave a modal stuck on top of the next page after navigating
  window.scrollTo(0,0);
  render();
}

/* ---------- render dispatch ---------- */
function render(){
  const p = ROUTE.path;
  document.body.classList.toggle('has-bottom-nav', ['home','book','track','account'].includes(p));
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
  if(p==='partner' || p.startsWith('partner/')) return renderPartner(p);
  if(p.startsWith('admin')) return renderAdmin(p);
  return renderHome();
}
function bottomNav(active){
  const items = [['home','Home','pin'],['book','Book','car'],['track','Trips','route'],[SESSION&&SESSION.type==='customer'?'account':'login','Account','users']];
  return `<nav class="bottom-nav">${items.map(([path,label,ic])=>`<a data-act="go" data-path="${path}" class="${active===path?'active':''}">${icon(ic,20)}<span>${label}</span></a>`).join('')}</nav>`;
}

/* ---------- delegated events ---------- */
document.addEventListener('click', (e)=>{
  const el = e.target.closest('[data-act]');
  if(!el) return;
  const act = el.getAttribute('data-act');
  if(act==='modal-bg-close'){ if(el===e.target) closeModal(); return; }
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
/* ---------- SVG icon system (no emojis — small hand-rolled Lucide-style set) ---------- */
const ICONS = {
  car: '<path d="M3 13l1.5-4.5A2 2 0 0 1 6.4 7h11.2a2 2 0 0 1 1.9 1.5L21 13"/><path d="M3 13h18v4a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4z"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>',
  pin: '<path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  phone: '<path d="M4 4h4l1.5 5-2.2 1.6a12 12 0 0 0 6.1 6.1L15 14.5l5 1.5v4a2 2 0 0 1-2.2 2A17 17 0 0 1 2 5.2 2 2 0 0 1 4 4z"/>',
  star: '<path d="M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6z"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.2" cy="9" r="2.6"/><path d="M15.8 13.2a5.4 5.4 0 0 1 5.7 5.4"/>',
  bag: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
  snow: '<path d="M12 2v20M4.9 4.9l14.2 14.2M19.1 4.9L4.9 19.1M2 12h20M8 6l4 2 4-2M8 18l4-2 4 2M6 8l2 4-2 4M18 8l-2 4 2 4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.2-1.6l2-1.6-2-3.4-2.4.8a7 7 0 0 0-2.7-1.6L13 2h-4l-.7 2.6a7 7 0 0 0-2.7 1.6l-2.4-.8-2 3.4 2 1.6A7 7 0 0 0 5 12a7 7 0 0 0 .2 1.6l-2 1.6 2 3.4 2.4-.8a7 7 0 0 0 2.7 1.6L11 22h4l.7-2.6a7 7 0 0 0 2.7-1.6l2.4.8 2-3.4-2-1.6c.13-.5.2-1 .2-1.4z"/>',
  whatsapp: '<path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2z"/><path d="M8.5 8.3c.2-.5.4-.5.6-.5h.5c.2 0 .4 0 .5.4l.7 1.7c.1.2 0 .4-.1.5l-.5.6c-.1.2-.2.3 0 .6.2.4 1 1.4 2.1 1.9.2.1.4.1.5-.1l.5-.7c.1-.2.3-.2.5-.1l1.6.8c.2.1.3.2.3.4 0 .8-.6 1.6-1.4 1.7-1.5.3-3.6-.4-5.6-2.4S8.2 9.8 8.5 8.3z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  shield: '<path d="M12 2l8 3v6c0 5-3.4 8.7-8 10-4.6-1.3-8-5-8-10V5l8-3z"/>',
  tag: '<path d="M20 12l-8 8-9-9V4h7z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  route: '<circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M5 17c0-6 4-6 7-9s4-1 7-1"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plane: '<path d="M10.5 3.5L13 9l6-2 1.5 1.5-6 3.5-1 5.5-2-1-.5-4-4-2.5-1 .5L3 9.5l1.5-1.5 6 1.5z"/>',
  swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  briefcase: '<rect x="3" y="8" width="18" height="11" rx="2"/><path d="M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  starFilled: '<path fill="currentColor" stroke="none" d="M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6z"/>',
  starOutline: '<path d="M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6z"/>',
};
function starRating(n, size){
  size = size || 15;
  let out = '';
  for(let i=1;i<=5;i++) out += icon(i<=n ? 'starFilled' : 'starOutline', size);
  return `<span class="stars">${out}</span>`;
}
function icon(name, size){
  size = size || 18;
  const path = ICONS[name] || ICONS.info;
  return `<svg class="icon-svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
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
        <a data-act="go" data-path="admin">Admin login</a>
        <a data-act="go" data-path="partner">Partner login</a>
      </div>
    </div>
    <div class="wrap foot-bottom">
      <span>© ${new Date().getFullYear()} ${esc(s.businessName)}. All rights reserved.</span>
      <span>Prices are estimates until confirmed.</span>
    </div>
  </footer>`;
}
function mount(html){
  document.getElementById('app').innerHTML = html;
  requestAnimationFrame(initMotion);
}
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let _revealObserver = null;
function initMotion(){
  // Scroll reveal
  if(!_revealObserver && 'IntersectionObserver' in window){
    _revealObserver = new IntersectionObserver((entries)=>{
      entries.forEach(en=>{ if(en.isIntersecting){ en.target.classList.add('in-view'); _revealObserver.unobserve(en.target); } });
    }, { threshold:0.15 });
  }
  document.querySelectorAll('.reveal:not(.in-view)').forEach(el=>{
    if(REDUCED_MOTION) el.classList.add('in-view');
    else if(_revealObserver) _revealObserver.observe(el);
  });
  // Count-up stats
  document.querySelectorAll('[data-countup]').forEach(el=>{
    const target = Number(el.getAttribute('data-countup'))||0;
    if(el.dataset.counted) return;
    el.dataset.counted = '1';
    if(REDUCED_MOTION || target===0){ el.textContent = target; return; }
    const start = performance.now(), dur = 700;
    function step(now){
      const t = Math.min(1, (now-start)/dur);
      el.textContent = Math.round(target * (1 - Math.pow(1-t, 3)));
      if(t<1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
  // Hero pointer tilt (skip on touch/reduced-motion)
  const routeCard = document.querySelector('.route-card');
  if(routeCard && !REDUCED_MOTION && matchMedia('(pointer:fine)').matches && !routeCard.dataset.tiltBound){
    routeCard.dataset.tiltBound = '1';
    routeCard.addEventListener('pointermove', (e)=>{
      const r = routeCard.getBoundingClientRect();
      const px = (e.clientX - r.left)/r.width - 0.5, py = (e.clientY - r.top)/r.height - 0.5;
      routeCard.style.transform = `rotateY(${px*8}deg) rotateX(${-py*8}deg)`;
    });
    routeCard.addEventListener('pointerleave', ()=>{ routeCard.style.transform = 'rotateY(0) rotateX(0)'; });
  }
}

/* =========================================================================
   HOME PAGE
   ========================================================================= */
function renderHome(){
  const s = DB.settings;
  const routes = [
    ['Burdwan → Kolkata','Outstation'],['Kolkata Airport → Burdwan','Airport Transfer'],
    ['Burdwan → Durgapur','One Way'],['City Local (8 hrs / 80 km)','Local Rental']
  ];
  const reviews = DB.reviews.filter(r=>!r.hidden).slice(0,3);
  mount(`
  ${siteHeader('home')}
  <section class="hero">
    <div class="wrap">
      <div>
        <div class="eyebrow-route"><span class="dot"></span><span class="dash"></span><span>Pickup to drop, sorted</span></div>
        <h1>Book a cab in minutes. A real person confirms it.</h1>
        <p class="lead">Local rides, airport transfers and outstation cars from Burdwan. Choose your route, vehicle and payment option, then let our team handle the rest.</p>
        <div class="hero-cta-row">
          <button class="btn btn-primary" data-act="go" data-path="book">Book Your Ride</button>
          <button class="btn btn-outline" data-act="go" data-path="track">Track Booking</button>
        </div>
        ${heroTrustRow()}
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
        <div class="card reveal"><div class="icon-badge">${icon('shield',20)}</div><h3 style="font-size:17px">Verified partners</h3><p style="color:var(--ink-soft);font-size:14.5px">Every trip is assigned to a partner reviewed by our team before dispatch.</p></div>
        <div class="card reveal"><div class="icon-badge">${icon('tag',20)}</div><h3 style="font-size:17px">Clear pricing</h3><p style="color:var(--ink-soft);font-size:14.5px">See an estimate upfront; the final price is confirmed before your trip starts.</p></div>
        <div class="card reveal"><div class="icon-badge">${icon('clock',20)}</div><h3 style="font-size:17px">Booking status tracking</h3><p style="color:var(--ink-soft);font-size:14.5px">Follow your booking status from request through to completion.</p></div>
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
        ${VEHICLE_CATEGORIES.map(v=>`<div class="card reveal" style="text-align:center"><div style="color:var(--accent-deep);margin-bottom:6px;display:flex;justify-content:center">${icon('car',26)}</div><b style="font-size:14px">${v}</b></div>`).join('')}
      </div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <div class="section-head"><h2>Transparent Pricing</h2><p>Clear starting rates — final fare is always confirmed by our booking team before your trip.</p></div>
      <div class="grid grid-3">${transparentPricingCards()}</div>
    </div>
  </section>

  <section>
    <div class="wrap">
      <div class="section-head"><h2>What customers say</h2></div>
      ${reviews.length ? `<div class="grid grid-3">${reviews.map(r=>`
        <div class="card review-card reveal">${starRating(r.rating)}<p>${esc(r.text)}</p><b style="font-size:13.5px">${esc(r.name)}</b></div>
      `).join('')}</div>` : `<div class="empty-state"><div class="icon-badge" style="margin:0 auto">${icon('star',18)}</div>No reviews yet — they'll appear here once customers complete trips and leave feedback.</div>`}
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
        ${WhatsAppService.configured() ? `<a class="btn btn-accent btn-sm" style="margin-top:10px" href="${WhatsAppService.contactLink()}" target="_blank" rel="noopener">Message on WhatsApp</a>` : ''}
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
  ${bottomNav('home')}
  `);
}
function faqItem(q,a){
  return `<div class="faq-item"><button class="faq-q" data-act="toggle-faq">${esc(q)}<span>+</span></button><div class="faq-a"><p>${a}</p></div></div>`;
}
function transparentPricingCards(){
  const P = DB.settings.pricing;
  const cards = [];
  const localMin = Math.min(...VEHICLE_CATEGORIES.map(c=>P.local[c].pkg4h40));
  cards.push(['Local Rentals', 'Starting from '+money(localMin), '4 hrs / 40 km package, hatchback rate']);
  const outstationMin = Math.min(...VEHICLE_CATEGORIES.map(c=>P.outstation[c].perKm));
  cards.push(['Outstation', 'Starting from ₹'+outstationMin+'/km', 'Plus driver allowance — minimum billing applies']);
  const activeAirport = P.airportRoutes.filter(r=>r.active);
  if(activeAirport.length){
    const fares = activeAirport.flatMap(r=>Object.values(r.fares));
    const airportMin = fares.length ? Math.min(...fares) : null;
    cards.push(['Airport Transfers', airportMin?'Starting from '+money(airportMin):'Contact us for a quote', activeAirport[0].pickupZone+' → '+activeAirport[0].dropZone+' and more']);
  } else {
    cards.push(['Airport Transfers', 'Contact us for a quote', 'Fixed routes coming soon']);
  }
  return cards.map(c=>`<div class="card reveal"><h3 style="font-size:16px;margin-bottom:4px">${c[0]}</h3><div class="fare" style="margin:6px 0">${c[1]}</div><p style="font-size:13px;color:var(--ink-soft);margin:0">${c[2]}</p></div>`).join('');
}
function heroTrustRow(){
  const completed = DB.bookings.filter(b=>b.status==='TRIP_COMPLETED').length;
  const partners = DB.partners.filter(p=>isPartnerVerified(p) && p.active).length;
  // Only show real counts once there's something to show — otherwise lead with
  // trust content instead of a hollow "0 trips" / "0 partners".
  if(completed>0 || partners>0){
    return `<div class="hero-stats">
      <div><b data-countup="${completed}">0</b><span>Trips completed</span></div>
      <div><b data-countup="${partners}">0</b><span>Verified partners</span></div>
      <div><b data-countup="${DB.settings.serviceAreas.length}">0</b><span>Service areas</span></div>
    </div>`;
  }
  return `<div class="hero-stats">
    <div><b>${icon('check',18)}</b><span>Local booking support</span></div>
    <div><b>${icon('shield',18)}</b><span>Verified partner network</span></div>
    <div><b>${icon('tag',18)}</b><span>Clear pricing</span></div>
    <div><b>${icon('clock',18)}</b><span>Booking status tracking</span></div>
  </div>`;
}

/* =========================================================================
   BOOKING FLOW (multi-step)
   ========================================================================= */
function freshDraft(){
  return {
    tripType:'', serviceMode:'Chauffeur',
    pickup:'', pickupLat:null, pickupLng:null,
    drop:'', dropLat:null, dropLng:null,
    pickupDate:'', pickupTime:'', returnDate:'', returnTime:'',
    passengers:1, luggage:0, vehicleCategory:'', localPackage:'',
    customerName:'', customerPhone:'', customerEmail:'', altPhone:'', instructions:'',
    additionalPassenger:'', extraStop:'', accessibility:'',
    documents:{}, paymentMethod:'', paymentStatusDraft:null
  };
}
function renderBooking(){
  if(!UI.booking) UI.booking = { step:1, draft: freshDraft(), createdId:null, locWarning:null, maps:{}, tempId:null };
  const qTrip = ROUTE.params.trip;
  if(qTrip && !UI.booking.draft.tripType && UI.booking.step===1) UI.booking.draft.tripType = qTrip;
  const b = UI.booking;
  const showProgress = b.step<=7;
  mount(`
  ${siteHeader()}
  <div class="booking-shell">
    <h2 style="margin-bottom:4px">Book your ride</h2>
    ${showProgress?`<p style="color:var(--ink-soft);font-size:14px;margin-bottom:20px">Step ${b.step} of 7 — ${STEP_NAMES[b.step]}</p>
    <div class="progress-track">${[1,2,3,4,5,6,7].map(i=>`<span class="${b.step>=i?'done':''}"></span>`).join('')}</div>`:''}
    <div id="booking-step">${bookingStepHtml()}</div>
  </div>
  ${siteFooter()}
  ${bottomNav('book')}
  `);
  if(b.step===2) setTimeout(initLocationStep,0);
  if(b.step===5) setTimeout(initDocumentsStep,0);
  if(b.step===7) setTimeout(initPaymentStep,0);
}
const STEP_NAMES = {1:'Trip',2:'Location',3:'Vehicle',4:'Details',5:'Documents',6:'Review',7:'Payment'};

function bookingStepHtml(){
  const b = UI.booking, d = b.draft;
  if(b.step===1) return step1Html(d);
  if(b.step===2) return step2Html(d);
  if(b.step===3) return step3Html(d);
  if(b.step===4) return step4Html(d);
  if(b.step===5) return step5Html(d);
  if(b.step===6) return step6Html(d);
  if(b.step===7) return step7Html(d);
  if(b.step===8) return step8Html();
}

/* ---- Step 1: Trip type + service mode ---- */
function step1Html(d){
  const trips = [
    ['Local Rental','car','Hourly or package-based rides within Burdwan.'],
    ['Airport Transfer','plane','Reliable pickup or drop-off to Kolkata Airport.'],
    ['One Way','arrow','Single pickup to a single drop.'],
    ['Round Trip','swap','Out and back on a later date.'],
    ['Outstation','route','Longer intercity trips beyond Burdwan.'],
    ['Corporate','briefcase','Recurring or business travel bookings.']
  ];
  return `
  <div>${trips.map(t=>`<div class="trip-card-lg ${d.tripType===t[0]?'selected':''}" data-act="pick-trip" data-val="${t[0]}"><div class="ic">${icon(t[1],22)}</div><div><b>${t[0]}</b><span>${t[2]}</span></div></div>`).join('')}</div>
  <label style="display:block;font-size:13px;font-weight:600;margin:16px 0 4px">Service mode</label>
  <div class="mode-toggle">
    <button type="button" class="${d.serviceMode==='Chauffeur'?'active':''}" data-act="pick-mode" data-val="Chauffeur">Chauffeur / Driver included</button>
    <button type="button" class="${d.serviceMode==='Self-Drive'?'active':''}" data-act="pick-mode" data-val="Self-Drive">Self-Drive</button>
  </div>
  <div class="step-actions"><button class="btn btn-primary btn-block" data-act="step-next" ${!d.tripType?'disabled':''}>Continue</button></div>`;
}

/* ---- Step 2: Map location selection ---- */
function step2Html(d){
  const showReturn = d.tripType==='Round Trip';
  return `
  <div class="field-row two">
    <div class="field"><label>Pickup date</label><input type="date" data-live="draft-silent-pickupDate" value="${d.pickupDate}"></div>
    <div class="field"><label>Pickup time</label><input type="time" data-live="draft-silent-pickupTime" value="${d.pickupTime}"></div>
  </div>
  ${showReturn?`<div class="field-row two"><div class="field"><label>Return date</label><input type="date" data-live="draft-silent-returnDate" value="${d.returnDate}"></div><div class="field"><label>Return time</label><input type="time" data-live="draft-silent-returnTime" value="${d.returnTime}"></div></div>`:''}
  <label style="display:block;font-size:13px;font-weight:600;margin:10px 0 6px">Pickup location</label>
  <div class="map-search"><input id="loc-search-pickup" placeholder="Search pickup — e.g. Bardhaman Railway Station" autocomplete="off"><div id="loc-results-pickup" class="map-results" hidden></div></div>
  <button type="button" class="btn btn-outline btn-sm" style="margin-bottom:8px" data-act="use-my-location" data-which="pickup">Use my current location</button>
  <div id="map-pickup" class="leaflet-map"></div>
  <div id="loc-set-pickup">${d.pickupLat?locSetSummary('pickup', d):''}</div>

  <label style="display:block;font-size:13px;font-weight:600;margin:18px 0 6px">Drop location</label>
  <div class="map-search"><input id="loc-search-drop" placeholder="Search drop — e.g. Kolkata Airport" autocomplete="off"><div id="loc-results-drop" class="map-results" hidden></div></div>
  <button type="button" class="btn btn-outline btn-sm" style="margin-bottom:8px" data-act="use-my-location" data-which="drop">Use my current location</button>
  <div id="map-drop" class="leaflet-map"></div>
  <div id="loc-set-drop">${d.dropLat?locSetSummary('drop', d):''}</div>

  <div id="loc-route-est">${routeEstHtml(d)}</div>
  <div id="loc-warning-slot">${UI.booking.locWarning ? locWarningHtml() : ''}</div>
  <p class="hint">Search examples: Bardhaman Railway Station, Burdwan Medical College, Kolkata Airport, Durgapur.</p>

  <div class="step-actions"><button type="button" class="btn btn-outline" data-act="step-back">Back</button><button class="btn btn-primary btn-block" id="loc-continue-btn" data-act="loc-continue" ${(!d.pickupLat||!d.dropLat)?'disabled':''}>Continue</button></div>`;
}
function locSetSummary(which, d){
  const name = which==='pickup' ? d.pickup : d.drop;
  const color = which==='pickup' ? 'var(--accent)' : 'var(--ink)';
  return `<div class="loc-summary"><span class="dot" style="background:${color}"></span><div><b>${esc(name||'Selected location')}</b><span>Pin set — drag the marker or search again to change</span></div></div>`;
}
function routeEstHtml(d){
  if(!d.pickupLat || !d.dropLat) return '';
  const dist = roadDistanceKm(d.pickupLat,d.pickupLng,d.dropLat,d.dropLng);
  const eta = estimateEtaMinutes(dist);
  if(dist==null) return '';
  return `<div class="route-est"><span>Approx. distance: <b>${dist} km</b></span><span>Approx. travel time: <b>${eta} min</b></span></div><p class="hint" style="margin-top:-8px">Estimates only — actual distance/time may vary and are not guaranteed.</p>`;
}
function locWarningHtml(){
  const s = DB.settings;
  return `<div class="service-area-warn">
    <b>Currently unavailable for this location.</b>
    <p style="margin:6px 0 0">Please contact us for a custom booking.</p>
    <div class="row-actions">
      ${WhatsAppService.configured()?`<a class="btn btn-accent btn-sm" href="${WhatsAppService.contactLink('Hi, I need a custom quote for a trip outside your listed service area.')}" target="_blank" rel="noopener">WhatsApp us</a>`:''}
      <button type="button" class="btn btn-outline btn-sm" data-act="go" data-path="contact">Contact</button>
      <button type="button" class="btn btn-primary btn-sm" data-act="loc-custom-quote">Request Custom Quote</button>
    </div>
  </div>`;
}
function initLocationStep(){
  const d = UI.booking.draft;
  UI.booking.maps = UI.booking.maps || {};
  if(!window.L){ showToast('Map failed to load — you can still search and continue'); }
  ['pickup','drop'].forEach(which=>{
    const containerId = 'map-'+which;
    const el = document.getElementById(containerId);
    if(!el || !window.L) return;
    const lat = which==='pickup' ? d.pickupLat : d.dropLat;
    const lng = which==='pickup' ? d.pickupLng : d.dropLng;
    const center = [lat||23.2324, lng||87.8615];
    const map = L.map(containerId,{zoomControl:true}).setView(center, lat?14:11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
    let marker = lat ? L.marker(center,{draggable:true}).addTo(map) : null;
    if(marker) marker.on('dragend', ()=>{ const p=marker.getLatLng(); setLocationPoint(which,p.lat,p.lng); });
    map.on('click', e=>{
      if(marker) marker.setLatLng(e.latlng);
      else { marker = L.marker(e.latlng,{draggable:true}).addTo(map); marker.on('dragend', ()=>{ const p=marker.getLatLng(); setLocationPoint(which,p.lat,p.lng); }); }
      setLocationPoint(which, e.latlng.lat, e.latlng.lng);
    });
    UI.booking.maps[which] = { map, place(lt,lg){ if(marker) marker.setLatLng([lt,lg]); else { marker=L.marker([lt,lg],{draggable:true}).addTo(map); marker.on('dragend', ()=>{ const p=marker.getLatLng(); setLocationPoint(which,p.lat,p.lng); }); } map.setView([lt,lg],14); } };
    setTimeout(()=>map.invalidateSize(), 80);
  });
  ['pickup','drop'].forEach(which=>{
    const input = document.getElementById('loc-search-'+which);
    const results = document.getElementById('loc-results-'+which);
    if(!input) return;
    let timer=null;
    input.addEventListener('input', ()=>{
      clearTimeout(timer);
      const q = input.value.trim();
      if(q.length<3){ results.hidden=true; results.innerHTML=''; return; }
      timer = setTimeout(async ()=>{
        const items = await geocodeSearch(q);
        if(!items.length){ results.innerHTML = '<div style="color:var(--ink-soft)">No matches found</div>'; results.hidden=false; return; }
        results.innerHTML = items.map((it,i)=>`<div data-idx="${i}">${esc(it.display_name)}</div>`).join('');
        results.hidden = false;
        results.querySelectorAll('div[data-idx]').forEach(row=>{
          row.addEventListener('click', ()=>{
            const it = items[Number(row.getAttribute('data-idx'))];
            input.value = it.display_name;
            results.hidden = true;
            setLocationPoint(which, parseFloat(it.lat), parseFloat(it.lon), it.display_name);
            if(UI.booking.maps[which]) UI.booking.maps[which].place(parseFloat(it.lat), parseFloat(it.lon));
          });
        });
      }, 450);
    });
  });
}
/* =========================================================================
   LocationProvider — abstraction over the geocoding/routing backend.
   Swap the Nominatim calls below for Google/Mapbox/LocationIQ/etc. later
   without touching any calling code — every caller in this file only ever
   talks to LocationProvider, never to a specific API directly.
   Note: Nominatim needs no API key so it's safe to call from the browser.
   A provider that requires a secret key (OpenRouteService, Google, Mapbox)
   must NOT be called directly from this frontend — route it through a
   small serverless function first (see README "Backend architecture").
   ========================================================================= */
let _geocodeAbort = null;
const LocationProvider = {
  async search(query){
    if(_geocodeAbort) _geocodeAbort.abort(); // cancel a stale in-flight search
    _geocodeAbort = new AbortController();
    try{
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=in&q=${encodeURIComponent(query+' West Bengal')}`;
      const res = await fetch(url, { headers:{ 'Accept-Language':'en' }, signal:_geocodeAbort.signal });
      if(!res.ok) return [];
      return await res.json();
    }catch(e){
      if(e.name==='AbortError') return []; // superseded by a newer keystroke — not an error
      console.warn('LocationProvider.search failed', e);
      return [];
    }
  },
  async reverseGeocode(lat,lng){
    try{
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
      const res = await fetch(url, { headers:{ 'Accept-Language':'en' } });
      if(!res.ok) return null;
      const data = await res.json();
      return data && data.display_name ? data.display_name : null;
    }catch(e){ console.warn('LocationProvider.reverseGeocode failed', e); return null; }
  },
  // No routing API key is configured (would require a backend proxy — see
  // README), so distance/route use a straight-line estimate with a road
  // factor, clearly labeled "approximate" everywhere it's shown.
  calculateDistance(lat1,lng1,lat2,lng2){ return roadDistanceKm(lat1,lng1,lat2,lng2); },
  getRoute(lat1,lng1,lat2,lng2){
    return { distanceKm: roadDistanceKm(lat1,lng1,lat2,lng2), estimatedMinutes: estimateEtaMinutes(roadDistanceKm(lat1,lng1,lat2,lng2)), provider:'straight-line-estimate' };
  }
};
async function geocodeSearch(query){ return LocationProvider.search(query); }
async function reverseGeocode(lat,lng){ return LocationProvider.reverseGeocode(lat,lng); }

/* =========================================================================
   Service-layer abstractions (architecture only in this static-site build)
   -------------------------------------------------------------------------
   These exist so every call site goes through one named service rather than
   constructing SMS/email/WhatsApp requests ad hoc. None of them can actually
   send anything from a GitHub Pages–only frontend — sending requires a
   secret provider API key, and secret keys must never live in frontend code
   (see README "Backend architecture" for the minimal serverless shape that
   plugs into these same method signatures without changing any UI code).
   ========================================================================= */
const NotificationService = {
  // events: 'booking_received' | 'booking_confirmed' | 'driver_assigned' |
  //         'trip_reminder' | 'booking_cancelled' | 'trip_completed'
  async notify(event, booking){
    console.info(`[NotificationService] "${event}" for ${booking?.id||'?'} — no SMS/email/WhatsApp provider is configured; this is a no-op until a backend is connected.`);
    return { sent:false, reason:'no-provider-configured' };
  }
};
const EmailService = {
  async send(templateName, toAddress, data){
    console.info(`[EmailService] would send "${templateName}" to ${toAddress||'(no email on file)'} — no SMTP/email provider configured.`);
    return { sent:false, reason:'no-provider-configured' };
  }
};
const WhatsAppService = {
  configured(){ return !!(DB.settings.whatsapp && DB.settings.whatsapp.trim()); },
  contactLink(message){
    if(!this.configured()) return null;
    return `https://wa.me/${DB.settings.whatsapp.replace(/\D/g,'')}${message?`?text=${encodeURIComponent(message)}`:''}`;
  },
  async sendTemplate(){
    // Real outbound WhatsApp template sends require the WhatsApp Business
    // Cloud API (or a BSP) and a server — never faked here.
    console.info('[WhatsAppService] template sending needs a backend provider — falling back to a manual wa.me contact link.');
    return { sent:false, reason:'no-provider-configured' };
  }
};
async function setLocationPoint(which, lat, lng, knownName){
  const d = UI.booking.draft;
  let name = knownName;
  if(!name) name = await reverseGeocode(lat,lng) || `Pinned location (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
  if(which==='pickup'){ d.pickup=name; d.pickupLat=lat; d.pickupLng=lng; }
  else { d.drop=name; d.dropLat=lat; d.dropLng=lng; }
  const summaryEl = document.getElementById('loc-set-'+which);
  if(summaryEl) summaryEl.innerHTML = locSetSummary(which, d);
  const routeEl = document.getElementById('loc-route-est');
  if(routeEl) routeEl.innerHTML = routeEstHtml(d);
  UI.booking.locWarning = null;
  const warnSlot = document.getElementById('loc-warning-slot');
  if(warnSlot) warnSlot.innerHTML = '';
  const btn = document.getElementById('loc-continue-btn');
  if(btn) btn.disabled = !(d.pickupLat && d.dropLat);
}

/* ---- Step 3: Vehicle ---- */
function categoryAvailable(category, d){
  const candidates = DB.vehicles.filter(v=>v.category===category && v.availability==='Available');
  if(!candidates.length) return false;
  return candidates.some(v=>{
    const partner = DB.partners.find(p=>p.id===v.partnerId);
    if(!partner || !partner.active || !isPartnerVerified(partner)) return false;
    if(!d.pickupDate) return true;
    return isPartnerAvailableFor(partner.id, d.pickupDate, d.pickupTime, d.returnDate, d.returnTime);
  });
}
function step3Html(d){
  if(d.tripType==='Local Rental' && !d.localPackage) d.localPackage = '8h80km';
  const vehicles = [
    ['Hatchback','1–2 bags','Budget-friendly local rides'],
    ['Sedan','2–3 bags','Ideal for airport and outstation travel'],
    ['SUV','3–4 bags','More space for groups and luggage'],
    ['Premium SUV','3–4 bags','High-end, extra comfort and space']
  ];
  const packages = [['4h40km','4 hrs / 40 km'],['8h80km','8 hrs / 80 km'],['12h120km','12 hrs / 120 km']];
  return `
  <div class="field-row two">
    <div class="field"><label>Passengers</label><input type="number" min="1" max="20" data-live="draft-silent-passengers" value="${d.passengers}"></div>
    <div class="field"><label>Luggage (bags)</label><input type="number" min="0" max="20" data-live="draft-silent-luggage" value="${d.luggage}"></div>
  </div>
  ${d.tripType==='Local Rental' ? `
  <label style="display:block;font-size:13px;font-weight:600;margin:10px 0 8px">Package</label>
  <div class="mode-toggle" style="margin-bottom:18px">
    ${packages.map(p=>`<button type="button" class="${d.localPackage===p[0]?'active':''}" data-act="pick-package" data-val="${p[0]}">${p[1]}</button>`).join('')}
  </div>` : ''}
  <label style="display:block;font-size:13px;font-weight:600;margin:6px 0 10px">Choose a vehicle category</label>
  ${vehicles.map(v=>{
    const cat = v[0];
    const avail = categoryAvailable(cat, d);
    const fareResult = calculateFare(Object.assign({},d,{vehicleCategory:cat}));
    return `<div class="vehicle-card-lg ${d.vehicleCategory===cat?'selected':''}" data-act="pick-vehicle" data-val="${cat}">
      <div class="vtop"><b style="font-size:15px">${cat}</b><span class="avail-badge ${avail?'yes':'no'}">${avail?'Available now':'Request Quote'}</span></div>
      <ul><li>Up to ${VEHICLE_CAPACITY[cat]} passengers</li><li>${v[1]}</li><li>${v[2]}</li></ul>
      <div class="fare">${fareResult?money(fareResult.total)+' (approx.)':'Request a Quote'}</div>
    </div>`;
  }).join('')}
  <p class="hint">The exact vehicle is confirmed once our team assigns a verified partner. Final fare may be confirmed by our booking team before your trip.</p>
  <div class="step-actions"><button type="button" class="btn btn-outline" data-act="step-back">Back</button><button class="btn btn-primary btn-block" data-act="step-next" ${!d.vehicleCategory?'disabled':''}>Continue</button></div>`;
}

/* ---- Step 4: Customer details ---- */
function step4Html(d){
  return `
  <form data-form="step4">
    <div class="field"><label>Full Name *</label><input name="customerName" required value="${esc(d.customerName)}"></div>
    <div class="field"><label>Mobile Number *</label><input name="customerPhone" required pattern="[0-9+ ]{8,15}" value="${esc(d.customerPhone)}" placeholder="10-digit mobile"></div>
    <div class="field"><label>Email Address</label><input type="email" name="customerEmail" value="${esc(d.customerEmail)}"></div>
    <div class="field"><label>Alternate phone (optional)</label><input name="altPhone" value="${esc(d.altPhone)}"></div>
    <div class="field"><label>Additional passenger name (optional)</label><input name="additionalPassenger" value="${esc(d.additionalPassenger)}"></div>
    <div class="field"><label>Additional stop (optional)</label><input name="extraStop" value="${esc(d.extraStop)}"></div>
    <div class="field"><label>Accessibility requirement (optional)</label><input name="accessibility" value="${esc(d.accessibility)}"></div>
    <div class="field"><label>Special instructions (optional)</label><textarea name="instructions" rows="2">${esc(d.instructions)}</textarea></div>
    <p class="hint">Your details are used only to create and manage this booking and are never shown to other customers. See our <a data-act="go" data-path="privacy" style="cursor:pointer;text-decoration:underline">Privacy Policy</a>.</p>
    <div class="step-actions"><button type="button" class="btn btn-outline" data-act="step-back">Back</button><button class="btn btn-primary btn-block" type="submit">Continue</button></div>
  </form>`;
}

/* ---- Step 5: Documents ---- */
function step5Html(d){
  const reqs = DB.settings.documentRequirements[d.serviceMode] || [];
  if(!reqs.length){
    return `<div class="card" style="text-align:center;padding:28px"><p style="color:var(--ink-soft)">No documents are required for this booking.</p></div>
    <div class="step-actions"><button type="button" class="btn btn-outline" data-act="step-back">Back</button><button class="btn btn-primary btn-block" data-act="step-next">Continue</button></div>`;
  }
  const allRequiredUploaded = reqs.filter(r=>r.required).every(r=> d.documents[r.key] && !['Not uploaded','Uploading'].includes(d.documents[r.key].status));
  return `
  <p class="hint" style="margin-bottom:14px">Documents are securely used for booking verification. Supported: JPG, PNG, PDF — max ${DB.settings.maxDocSizeMb}MB.</p>
  ${reqs.map(r=>docRowHtml(r,d)).join('')}
  <div class="step-actions"><button type="button" class="btn btn-outline" data-act="step-back">Back</button><button class="btn btn-primary btn-block" data-act="step-next" ${allRequiredUploaded?'':'disabled'}>Continue</button></div>`;
}
function docRowHtml(reqDef, d){
  const doc = d.documents[reqDef.key];
  const status = doc ? doc.status : 'Not uploaded';
  return `<div class="doc-row" data-doc-row="${reqDef.key}">
    <div class="doc-row-top"><b>${esc(reqDef.label)}${reqDef.required?' *':''}</b><span class="doc-status ${status.replace(/\s/g,'-')}">${status}</span></div>
    ${doc && doc.fileName ? `<div class="doc-preview">📄 ${esc(doc.fileName)}</div>` : ''}
    ${doc && doc.rejectReason ? `<div class="doc-reject-note">${esc(doc.rejectReason)}</div>` : ''}
    <input type="file" accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" data-doc-key="${reqDef.key}" data-doc-label="${esc(reqDef.label)}" style="margin-top:8px">
  </div>`;
}
function initDocumentsStep(){
  document.querySelectorAll('input[type=file][data-doc-key]').forEach(input=>{
    input.addEventListener('change', async ()=>{
      const file = input.files[0];
      if(!file) return;
      const key = input.getAttribute('data-doc-key');
      const label = input.getAttribute('data-doc-label');
      const maxBytes = (DB.settings.maxDocSizeMb||5) * 1024*1024;
      if(file.size > maxBytes){ showToast(`File too large — max ${DB.settings.maxDocSizeMb||5}MB`); input.value=''; return; }
      const okTypes = ['image/jpeg','image/jpg','image/png','application/pdf'];
      if(!okTypes.includes(file.type)){ showToast('Please upload a JPG, PNG or PDF'); input.value=''; return; }
      await uploadBookingDocument(key, label, file);
    });
  });
}
async function uploadBookingDocument(key, label, file){
  const d = UI.booking.draft;
  d.documents[key] = { status:'Uploading', fileName:file.name };
  refreshDocRow(key);
  if(!sb){ showToast('Documents need Supabase connected — see README'); d.documents[key] = { status:'Not uploaded' }; refreshDocRow(key); return; }
  try{
    const ext = (file.name.split('.').pop()||'dat').toLowerCase();
    if(!UI.booking.tempId) UI.booking.tempId = uid('TMP');
    const path = `pending-${UI.booking.tempId}/${key}-${Date.now()}.${ext}`;
    const { error } = await sb.storage.from('booking-documents').upload(path, file, { upsert:true });
    if(error) throw error;
    d.documents[key] = { status:'Pending', path, fileName:file.name, rejectReason:null };
    showToast(label+' uploaded');
  }catch(e){
    console.error('doc upload failed', e);
    d.documents[key] = { status:'Not uploaded' };
    showToast('Upload failed — check connection, or that the "booking-documents" storage bucket exists');
  }
  refreshDocRow(key);
}
function refreshDocRow(key){
  const d = UI.booking.draft;
  const reqs = DB.settings.documentRequirements[d.serviceMode] || [];
  const reqDef = reqs.find(r=>r.key===key);
  if(!reqDef) return;
  const row = document.querySelector(`.doc-row[data-doc-row="${key}"]`);
  if(row){ row.outerHTML = docRowHtml(reqDef, d); initDocumentsStep(); }
  const allRequiredUploaded = reqs.filter(r=>r.required).every(r=> d.documents[r.key] && !['Not uploaded','Uploading'].includes(d.documents[r.key].status));
  const btn = document.querySelector('#booking-step .step-actions .btn-primary');
  if(btn) btn.disabled = !allRequiredUploaded;
}
async function finalizeDocumentPaths(bookingId, documents){
  const out = {};
  for(const key of Object.keys(documents||{})){
    const doc = documents[key];
    if(doc && doc.path && sb){
      const newPath = doc.path.replace(/^pending-[^/]+/, bookingId);
      try{
        const { error } = await sb.storage.from('booking-documents').move(doc.path, newPath);
        out[key] = error ? doc : Object.assign({}, doc, { path:newPath });
      }catch(e){ out[key] = doc; }
    } else out[key] = doc;
  }
  return out;
}

/* ---- Step 6: Review ---- */
function step6Html(d){
  const dist = (d.pickupLat&&d.dropLat) ? roadDistanceKm(d.pickupLat,d.pickupLng,d.dropLat,d.dropLng) : null;
  const fare = calculateFare(d);
  return `
  <div class="card">
    ${summaryRow('Trip', d.tripType)}
    ${summaryRow('Service mode', d.serviceMode)}
    ${summaryRow('Pickup', d.pickup)}
    ${summaryRow('Drop', d.drop)}
    ${summaryRow('Date', fmtDate(d.pickupDate))}
    ${summaryRow('Time', d.pickupTime)}
    ${d.tripType==='Round Trip'?summaryRow('Return', fmtDate(d.returnDate)+' · '+(d.returnTime||'—')):''}
    ${summaryRow('Vehicle', d.vehicleCategory)}
    ${summaryRow('Passengers', d.passengers+' · '+d.luggage+' bag(s)')}
    ${dist?summaryRow('Distance', 'Approx. '+dist+' km'):''}
  </div>
  <h4 style="margin:18px 0 8px">Fare breakdown</h4>
  <div class="card">
    ${fare ? fare.breakdown.map(b=>summaryRow(b.label, b.amount ? money(b.amount) : (b.note||'—'))).join('') : `<p style="color:var(--ink-soft);font-size:14.5px">We couldn't calculate an automatic estimate for this trip — our team will send a manual quote after you submit the request.</p>`}
    ${fare ? `<div class="summary-row" style="border-top:2px solid var(--ink);margin-top:6px;padding-top:12px"><span><b>Total Estimated Fare</b></span><b style="font-family:'Fraunces',serif;font-size:18px">${money(fare.total)}</b></div>` : ''}
  </div>
  <p class="hint" style="margin:12px 0">Final fare is confirmed before the trip. Additional charges may apply where applicable for tolls, parking, waiting time, route changes or other agreed services. Waiting charges (where applicable) and any extra km/hours beyond a local package are billed after the trip based on actual usage.</p>
  <div class="step-actions"><button type="button" class="btn btn-outline" data-act="step-back">Back</button><button class="btn btn-primary btn-block" data-act="step-next">Continue to Payment</button></div>`;
}

/* ---- Step 7: Payment ---- */
function step7Html(d){
  const price = estimatePrice(d);
  const s = DB.settings;
  const forcedPayNow = s.payLaterBlockedCategories.includes(d.vehicleCategory) || !s.payLaterEnabled;
  const upiConfigured = !!(s.payment && s.payment.upiId);
  if(!d.paymentMethod) d.paymentMethod = (forcedPayNow && upiConfigured) ? 'Pay Now' : (upiConfigured ? '' : 'Pay Later');
  return `
  <div class="pay-toggle">
    <button type="button" class="${d.paymentMethod==='Pay Now'?'active':''}" data-act="pick-payment" data-val="Pay Now" ${!upiConfigured?'disabled':''}>Pay Now<span>${upiConfigured?'Pay via UPI now':'Not configured yet'}</span></button>
    <button type="button" class="${d.paymentMethod==='Pay Later'?'active':''}" data-act="pick-payment" data-val="Pay Later" ${forcedPayNow?'disabled':''}>Pay Later<span>${forcedPayNow?'Not available for this booking':'Pay before/at pickup'}</span></button>
  </div>
  ${!d.paymentMethod ? `<p class="hint">Choose a payment option above to continue.</p>` : (d.paymentMethod==='Pay Now' ? payNowHtml(d,price) : payLaterHtml(d,price))}
  <div class="step-actions"><button type="button" class="btn btn-outline" data-act="step-back">Back</button><button class="btn btn-primary btn-block" id="submit-booking-btn" data-act="submit-booking" ${(!d.paymentMethod || (d.paymentMethod==='Pay Now' && price && d.paymentStatusDraft!=='Reported'))?'disabled':''}>${d.paymentMethod==='Pay Now'?"I've Paid — Submit Booking":'Confirm Booking Request'}</button></div>`;
}
function payNowHtml(d, price){
  if(!price){
    return `<div class="card"><p>Pricing isn't configured for this trip yet — we'll send a manual quote after you submit the request, then share a payment link separately.</p></div>`;
  }
  return `<div class="qr-box">
    <p style="font-weight:600;margin-bottom:4px">Amount to pay</p>
    <p style="font-family:'Fraunces',serif;font-size:26px;margin:0 0 14px">${money(price)}</p>
    <canvas id="upi-qr"></canvas>
    <p class="hint" style="margin-top:12px">Scan with any UPI app (GPay, PhonePe, Paytm...) and pay to ${esc(DB.settings.payment.upiId)}.</p>
    <p class="hint">Payment is confirmed manually by our team after you submit — your booking will show "Payment Pending" until then. We never treat an on-screen success alone as verified payment.</p>
  </div>
  <label style="display:flex;gap:8px;align-items:center;margin:14px 0;font-size:13.5px"><input type="checkbox" id="paid-confirm-check" style="width:auto"> I've completed the payment via UPI</label>`;
}
function payLaterHtml(d, price){
  return `<div class="card">
    ${summaryRow('You have selected', 'Pay Later')}
    ${summaryRow('Amount Due', price?money(price):'To be confirmed')}
    ${summaryRow('Payment Due', 'Before/at pickup, per booking policy')}
    ${summaryRow('Payment Method', 'As arranged with our team')}
  </div>`;
}
function initPaymentStep(){
  const d = UI.booking.draft;
  const checkbox = document.getElementById('paid-confirm-check');
  if(checkbox){
    checkbox.addEventListener('change', ()=>{
      d.paymentStatusDraft = checkbox.checked ? 'Reported' : null;
      const btn = document.getElementById('submit-booking-btn');
      if(btn) btn.disabled = !checkbox.checked;
    });
  }
  if(d.paymentMethod!=='Pay Now') return;
  const price = estimatePrice(d);
  if(!price || !window.QRCode) return;
  const upi = DB.settings.payment;
  if(!UI.booking.tempId) UI.booking.tempId = uid('TMP');
  const uri = `upi://pay?pa=${encodeURIComponent(upi.upiId)}&pn=${encodeURIComponent(upi.payeeName||'')}&am=${price}&cu=INR&tn=${encodeURIComponent('Booking '+UI.booking.tempId)}`;
  const canvas = document.getElementById('upi-qr');
  if(canvas) QRCode.toCanvas(canvas, uri, { width:200 }, ()=>{});
}

/* ---- Step 8: Confirmation ---- */
function step8Html(){
  const bk = DB.bookings.find(x=>x.id===UI.booking.createdId);
  if(!bk) return `<p>Booking not found.</p>`;
  const s = DB.settings;
  return `
  <div class="card" style="text-align:center;padding:32px 20px">
    <div class="icon-badge" style="margin:0 auto 12px;background:var(--success-bg);color:var(--success);width:48px;height:48px">${icon('check',22)}</div>
    <h2>Booking Request Received</h2>
    <p style="color:var(--ink-soft);font-size:14.5px">Thank you, ${esc((bk.customerName||'').split(' ')[0]||bk.customerName)}.</p>
    <div class="mono" style="font-size:18px;margin:14px 0;background:var(--paper);padding:10px;border-radius:8px">${bk.id}</div>
    <div style="text-align:left;margin-top:10px">
      ${summaryRow('Trip', bk.pickup+' → '+bk.drop)}
      ${summaryRow('Date', fmtDate(bk.pickupDate))}
      ${summaryRow('Pickup', bk.pickupTime)}
      ${summaryRow('Vehicle', bk.vehicleCategory)}
      ${summaryRow('Payment', bk.paymentMethod+' · '+bk.paymentStatus)}
      ${summaryRow('Status', `<span class="badge ${statusClass(bk.status)}">${statusLabel(bk.status)}</span>`)}
    </div>
  </div>
  <div class="step-actions" style="flex-direction:column">
    <button class="btn btn-primary btn-block" data-act="go" data-path="track?id=${bk.id}&phone=${encodeURIComponent(bk.customerPhone)}">Track Booking</button>
    <button class="btn btn-outline btn-block" data-act="receipt-print">Download Booking Receipt</button>
    <button class="btn btn-outline btn-block" data-act="receipt-share" data-id="${bk.id}">Share Booking</button>
    <button class="btn btn-outline btn-block" data-act="go" data-path="contact">Contact Us</button>
    ${WhatsAppService.configured()?`<a class="btn btn-accent btn-block" href="${WhatsAppService.contactLink('Hello Burdwan Car Rental, I need help with booking '+bk.id+'.')}" target="_blank" rel="noopener">WhatsApp Support</a>`:''}
  </div>`;
}

function summaryRow(label, val){ return `<div class="summary-row"><span>${esc(label)}</span><b>${val}</b></div>`; }

/* ---------- pricing engine ---------- */
function isNightTime(timeStr, nightCfg){
  if(!timeStr || !nightCfg || !nightCfg.enabled) return false;
  const h = Number((timeStr.split(':')||[])[0]);
  if(isNaN(h)) return false;
  const {startHour, endHour} = nightCfg;
  if(startHour===endHour) return false;
  return startHour > endHour ? (h >= startHour || h < endHour) : (h >= startHour && h < endHour);
}
function matchFixedRoute(d){
  const P = DB.settings.pricing;
  const pu = (d.pickup||'').toLowerCase(), dr = (d.drop||'').toLowerCase();
  const wantRT = d.tripType==='Round Trip';
  if(!pu || !dr) return null;
  const airport = (P.airportRoutes||[]).find(r=>r.active && pu.includes(r.pickupZone.toLowerCase()) && dr.includes(r.dropZone.toLowerCase()) && ((r.tripType==='Round Trip')===wantRT));
  if(airport) return { kind:'airport', route:airport };
  const route = (P.routePricing||[]).find(r=>r.active && pu.includes(r.pickup.toLowerCase()) && dr.includes(r.drop.toLowerCase()));
  if(route) return { kind:'route', route };
  return null;
}
function tripDays(d){
  if(!d.pickupDate || !d.returnDate) return 1;
  const diff = Math.round((new Date(d.returnDate) - new Date(d.pickupDate)) / (24*3600*1000));
  return Math.max(1, diff+1);
}
function finalizeFare(d, breakdown, total, source){
  const P = DB.settings.pricing;
  if(d.extraStop){ const c=(P.extraStop&&P.extraStop.charge)||0; if(c){ breakdown.push({label:'Extra stop charge', amount:c}); total+=c; } }
  return { total: Math.round(total), breakdown, source };
}
function calculateFare(d){
  const P = DB.settings.pricing;
  const cat = d.vehicleCategory;
  if(!cat || !P.local) return null;
  const breakdown = [];
  const night = isNightTime(d.pickupTime, P.night);
  const fixed = matchFixedRoute(d);

  if(fixed && fixed.kind==='airport'){
    const r = fixed.route, fare = r.fares[cat];
    if(fare!=null){
      breakdown.push({label:`Fixed fare — ${r.pickupZone} → ${r.dropZone} (${r.tripType})`, amount:fare});
      let total = fare;
      if(night && r.nightChargeApplies){ const nc=(P.night.charges||{})[cat]||0; if(nc){ breakdown.push({label:'Night charge', amount:nc}); total+=nc; } }
      breakdown.push({label:'Toll', amount:0, note:r.tollIncluded?'Included':'Excluded — payable at actual'});
      breakdown.push({label:'Parking', amount:0, note:r.parkingIncluded?'Included':'Excluded — payable at actual'});
      return finalizeFare(d, breakdown, total, 'Fixed airport route');
    }
  }
  if(fixed && fixed.kind==='route'){
    const r = fixed.route, fare = d.tripType==='Round Trip' ? r.roundTripFare : r.oneWayFare;
    if(fare!=null){
      breakdown.push({label:`Fixed route fare — ${r.pickup} → ${r.drop}`, amount:fare});
      return finalizeFare(d, breakdown, fare, 'Fixed route');
    }
  }

  if(d.tripType==='Local Rental'){
    const lp = P.local[cat];
    if(!lp) return null;
    const pkg = d.localPackage || '8h80km';
    const fare = { '4h40km':lp.pkg4h40, '8h80km':lp.pkg8h80, '12h120km':lp.pkg12h120 }[pkg];
    if(fare==null) return null;
    breakdown.push({label:`Local package — ${pkg.replace('h',' hr / ').replace('km',' km')}`, amount:fare});
    let total = fare;
    if(night){ const nc=(P.night.charges||{})[cat]||0; if(nc){ breakdown.push({label:'Night charge', amount:nc}); total+=nc; } }
    breakdown.push({label:'Extra km beyond package', amount:0, note:`₹${lp.extraKm}/km if exceeded — billed after the trip`});
    breakdown.push({label:'Extra hour beyond package', amount:0, note:`₹${lp.extraHour}/hr if exceeded — billed after the trip`});
    return finalizeFare(d, breakdown, total, 'Local package');
  }

  const op = P.outstation[cat];
  if(!op) return null;
  const dist = (d.pickupLat && d.dropLat) ? roadDistanceKm(d.pickupLat,d.pickupLng,d.dropLat,d.dropLng) : null;
  if(dist==null) return null;
  const days = d.tripType==='Round Trip' ? tripDays(d) : 1;
  const rawKm = d.tripType==='Round Trip' ? dist*2 : dist;
  const minKm = op.minKmPerDay * days;
  const billableKm = Math.max(rawKm, minKm);
  const distanceFare = Math.round(billableKm * op.perKm);
  breakdown.push({label:`Distance fare — ${billableKm.toFixed(0)} km × ₹${op.perKm}/km${minKm>rawKm?' (minimum billing applied)':''}`, amount:distanceFare});
  const driverAllowance = op.driverAllowancePerDay * days;
  breakdown.push({label:`Driver allowance (${days} day${days>1?'s':''})`, amount:driverAllowance});
  let total = distanceFare + driverAllowance;
  if(night){ const nc=(P.night.charges||{})[cat]||0; if(nc){ breakdown.push({label:'Night charge', amount:nc}); total+=nc; } }
  const ext = P.outstationExtras||{};
  breakdown.push({label:'Toll', amount:0, note:ext.tolls==='Included'?'Included':'Excluded — payable at actual'});
  breakdown.push({label:'Parking', amount:0, note:ext.parking==='Included'?'Included':'Excluded — payable at actual'});
  breakdown.push({label:'Permits', amount:0, note:ext.permits==='Included'?'Included':'Excluded — payable at actual'});
  return finalizeFare(d, breakdown, total, 'Distance-based');
}
function estimatePrice(d){ const r = calculateFare(d); return r ? r.total : null; }

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
      <div class="field"><label>Booking ID</label><input name="id" required value="${esc(presetId)}" placeholder="BCR-20260910-000123"></div>
      <div class="field"><label>Mobile number</label><input name="phone" required value="${esc(presetPhone)}"></div>
      <button class="btn btn-primary btn-block" type="submit">Track booking</button>
    </form>
    <div style="margin-top:22px">${found===undefined?'':found===null?trackNotFound():trackResultHtml(found)}</div>
  </div>
  ${siteFooter()}
  ${bottomNav('track')}
  `);
  if(presetId && presetPhone && found===undefined){
    UI.trackResult = DB.bookings.find(b=>b.id===presetId && b.customerPhone===presetPhone) || null;
    renderTrack();
  }
}
function trackNotFound(){
  return `<div class="empty-state"><div class="icon-badge" style="margin:0 auto">${icon('info',18)}</div>No booking found for that ID and phone number. Double-check both fields.</div>`;
}
function flowForBooking(bk){
  if(bk.paymentMethod==='Pay Later') return STATUS_FLOW.filter(s=>!['PAYMENT_PENDING','PAYMENT_VERIFIED'].includes(s));
  return STATUS_FLOW;
}
function trackResultHtml(bk){
  const flow = flowForBooking(bk);
  const idx = flow.indexOf(bk.status);
  const branch = STATUS_BRANCH.includes(bk.status);
  return `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <b class="mono">${bk.id}</b><span class="badge ${statusClass(bk.status)}">${statusLabel(bk.status)}</span>
    </div>
    ${summaryRow('Trip', bk.tripType+' · '+bk.pickup+' → '+bk.drop)}
    ${summaryRow('Date & time', fmtDate(bk.pickupDate)+' · '+bk.pickupTime)}
    ${summaryRow('Vehicle category', bk.vehicleCategory)}
    ${summaryRow('Payment', (bk.paymentMethod||'—')+' · '+(bk.paymentStatus||'—'))}
    ${bk.partnerId?summaryRow('Partner assigned', partnerName(bk.partnerId)):''}
    ${bk.driverPhone?summaryRow('Driver contact', bk.driverPhone):''}
    <h3 style="font-size:15px;margin:20px 0 10px">Booking Status Tracking</h3>
    <ul class="timeline">
      ${branch ? `<li class="active"><b>${statusLabel(bk.status)}</b><time>${fmtDateTime(bk.updatedAt)}</time></li>` :
      flow.map((s,i)=>`<li class="${i<idx?'past':i===idx?'active':''}"><b>${statusLabel(s)}</b>${i<=idx?`<time>${timelineTime(bk,s)}</time>`:''}</li>`).join('')}
    </ul>
  </div>`;
}
function timelineTime(bk,eventKey){
  const t = (bk.timeline||[]).find(x=>x.event===eventKey);
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
  const upcoming = mine.filter(b=>!['TRIP_COMPLETED','CANCELLED','FAILED','REFUNDED'].includes(b.status));
  const past = mine.filter(b=>['TRIP_COMPLETED','CANCELLED','FAILED','REFUNDED'].includes(b.status));
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
  ${bottomNav('account')}
  `);
}
function accountBookingRow(bk){
  const cancellable = ['REQUEST_RECEIVED','PAYMENT_PENDING','PAYMENT_VERIFIED','UNDER_REVIEW','PARTNER_BEING_ASSIGNED'].includes(bk.status);
  const canReview = bk.status==='TRIP_COMPLETED' && !DB.reviews.find(r=>r.bookingId===bk.id);
  return `<div class="bcard" style="margin-bottom:10px">
    <div class="bcard-top"><b class="mono">${bk.id}</b><span class="badge ${statusClass(bk.status)}">${statusLabel(bk.status)}</span></div>
    <div class="meta">${bk.tripType} · ${esc(bk.pickup)} → ${esc(bk.drop)}</div>
    <div class="meta">${fmtDate(bk.pickupDate)} · ${bk.pickupTime}</div>
    <div class="row-actions" style="margin-top:10px">
      <button class="btn btn-ghost btn-sm" data-act="go" data-path="track?id=${bk.id}&phone=${encodeURIComponent(bk.customerPhone)}">View / track</button>
      ${cancellable?`<button class="btn btn-danger btn-sm" data-act="customer-cancel" data-id="${bk.id}">Cancel</button>`:''}
      ${canReview?`<button class="btn btn-outline btn-sm" data-act="open-review" data-id="${bk.id}">Leave a review</button>`:''}
    </div>
  </div>`;
}
function reviewFormModal(bookingId){
  const bk = DB.bookings.find(b=>b.id===bookingId);
  if(!bk) return;
  openModal(`
    <div class="modal-head"><h3>How was your trip?</h3><button class="close-x" data-act="modal-bg-close">${icon('x',16)}</button></div>
    <p class="hint" style="margin-bottom:10px">${esc(bk.pickup)} → ${esc(bk.drop)} · ${fmtDate(bk.pickupDate)}</p>
    <form data-form="submit-review" data-id="${bk.id}">
      <div class="field"><label>Rating</label>
        <select name="rating" required>${[5,4,3,2,1].map(n=>`<option value="${n}">${'★'.repeat(n)}${'☆'.repeat(5-n)}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Comment</label><textarea name="text" rows="3" required placeholder="Tell us about your trip"></textarea></div>
      <button class="btn btn-primary btn-block" type="submit">Submit review</button>
    </form>`);
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
        <div style="display:flex;gap:8px;align-items:center"><span style="font-size:13px;color:var(--ink-soft)" class="hide-mobile">${esc(SESSION.name||'Admin')}</span><button class="btn btn-ghost btn-sm hide-mobile" data-act="go" data-path="home">View site</button><button class="btn btn-outline btn-sm" data-act="logout">Log out</button></div>
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
        <div class="field"><label>Admin username</label><input name="username" required value="${esc(DB.settings.adminUsername||'')}"></div>
        <div class="field"><label>Password</label><input name="password" type="password" required></div>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
      </form>
      <p class="hint" style="margin-top:10px">You can change the admin username and password any time from Admin → Settings. This is a client-side demo login; see README before using it for a real launch.</p>
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
  const completed = b.filter(x=>x.status==='TRIP_COMPLETED');
  const totalValue = sum(completed, x=>x.finalAmount||x.customerPrice);
  const totalPayout = sum(completed, x=>x.partnerPayout);
  const margin = totalValue - totalPayout;
  const monthKey = new Date().toISOString().slice(0,7);
  const monthCompleted = completed.filter(x=>(x.createdAt||'').slice(0,7)===monthKey);
  const monthRevenue = sum(monthCompleted, x=>x.finalAmount||x.customerPrice);
  const pendingPayments = b.filter(x=>x.paymentMethod==='Pay Now' && ['PAYMENT_PENDING'].includes(x.status)).length;
  const pendingVerification = b.filter(x=>Object.values(x.documents||{}).some(dd=>dd && dd.status==='Pending')).length;
  const partnerAssignment = b.filter(x=>['PARTNER_BEING_ASSIGNED','AWAITING_PARTNER_ACCEPTANCE'].includes(x.status)).length;
  const activeTrips = b.filter(x=>['DRIVER_ASSIGNED','DRIVER_ON_THE_WAY','DRIVER_ARRIVED','TRIP_STARTED'].includes(x.status)).length;

  const cards = [
    ['New Requests', b.filter(x=>x.status==='REQUEST_RECEIVED').length],
    ['Pending Payments', pendingPayments],
    ['Pending Verification', pendingVerification],
    ['Partner Assignment', partnerAssignment],
    ['Confirmed', b.filter(x=>x.status==='BOOKING_CONFIRMED').length],
    ['Active Trips', activeTrips],
    ['Completed', completed.length],
    ['Cancelled', b.filter(x=>x.status==='CANCELLED').length],
    ['Revenue (this month)', money(monthRevenue)],
    ['Gross margin (all time)', money(margin)],
    ["Today's bookings", b.filter(isToday).length],
    ['Active partners', DB.partners.filter(p=>p.active).length]
  ];
  const routeCounts = {};
  b.forEach(x=>{ const k = `${x.pickup} → ${x.drop}`; routeCounts[k]=(routeCounts[k]||0)+1; });
  const topRoutes = Object.entries(routeCounts).sort((a,z)=>z[1]-a[1]).slice(0,5);
  const vehicleCounts = {};
  b.forEach(x=>{ vehicleCounts[x.vehicleCategory]=(vehicleCounts[x.vehicleCategory]||0)+1; });
  const conv = b.length ? Math.round(completed.length/b.length*100) : 0;
  const cancelRate = b.length ? Math.round(b.filter(x=>x.status==='CANCELLED').length/b.length*100) : 0;
  const expiring = vehicleExpiryAlerts();

  return `
  ${expiring.length?`<div class="notice-box" style="margin-bottom:16px"><b>${expiring.length} vehicle document(s) expiring soon or expired.</b> <a data-act="go" data-path="admin/vehicles" style="cursor:pointer;text-decoration:underline">Review in Vehicle Management</a></div>`:''}
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
function vehicleExpiryAlerts(){
  const now = Date.now(), soon = now + 21*24*3600*1000;
  const out = [];
  DB.vehicles.forEach(v=>{
    ['insuranceExpiry','pucExpiry','permitExpiry','fitnessExpiry'].forEach(k=>{
      if(!v[k]) return;
      const t = new Date(v[k]).getTime();
      if(isNaN(t)) return;
      if(t < now) out.push({vehicle:v, field:k, state:'expired'});
      else if(t < soon) out.push({vehicle:v, field:k, state:'soon'});
    });
  });
  return out;
}
function expiryChip(dateStr){
  if(!dateStr) return '';
  const t = new Date(dateStr).getTime();
  if(isNaN(t)) return '';
  const now = Date.now(), soon = now + 21*24*3600*1000;
  const cls = t<now ? 'expired' : t<soon ? 'soon' : 'ok';
  const label = t<now ? 'Expired' : t<soon ? 'Expiring soon' : 'OK';
  return `<span class="expiry-chip ${cls}">${label}</span>`;
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
  const vehicleCats = VEHICLE_CATEGORIES;

  return `
  <div class="panel">
    <div class="panel-head"><h3>All bookings (${all.length})</h3><button class="btn btn-outline btn-sm" data-act="export-csv">Export CSV</button></div>
    <div class="toolbar">
      <input type="text" placeholder="Search ID, name, phone" value="${esc(f.q)}" data-live="filter-q">
      <select data-live="filter-status"><option value="">All statuses</option>${ALL_STATUSES.map(s=>`<option value="${s}" ${f.status===s?'selected':''}>${statusLabel(s)}</option>`).join('')}</select>
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
  const margin = (b.customerPrice||0)-(b.partnerPayout||0)-(b.directPlatformCost||0);
  return `<tr>
    <td class="mono">${b.id}</td><td>${esc(b.customerName)}</td><td>${esc(b.customerPhone)}</td>
    <td>${esc(b.pickup)}</td><td>${esc(b.drop)}</td><td>${fmtDate(b.pickupDate)}</td><td>${b.vehicleCategory}</td>
    <td>${money(b.customerPrice)}</td><td>${money(b.partnerPayout)}</td><td>${money(margin)}</td>
    <td>${b.partnerId?esc(partnerName(b.partnerId)):'—'}</td>
    <td><span class="badge ${statusClass(b.status)}">${statusLabel(b.status)}</span></td>
    <td class="row-actions"><button class="btn btn-ghost btn-sm" data-act="open-booking" data-id="${b.id}">Open</button></td>
  </tr>`;
}
function bookingCard(b){
  return `<div class="bcard">
    <div class="bcard-top"><b class="mono">${b.id}</b><span class="badge ${statusClass(b.status)}">${statusLabel(b.status)}</span></div>
    <div class="meta">${esc(b.customerName)} · ${esc(b.customerPhone)}</div>
    <div class="meta">${esc(b.pickup)} → ${esc(b.drop)} · ${fmtDate(b.pickupDate)}</div>
    <div class="meta">${money(b.customerPrice)} price · ${money(b.partnerPayout)} payout</div>
    <button class="btn btn-outline btn-sm" style="margin-top:8px" data-act="open-booking" data-id="${b.id}">Open</button>
  </div>`;
}

function bookingDetailModal(id){
  const b = DB.bookings.find(x=>x.id===id);
  if(!b) return;
  const eligiblePartners = DB.partners.filter(p=>p.active && isPartnerVerified(p) && p.vehicleCategories.includes(b.vehicleCategory) && isPartnerAvailableFor(p.id, b.pickupDate, b.pickupTime, b.returnDate, b.returnTime, b.id));
  const margin = (Number(b.customerPrice)||0)-(Number(b.partnerPayout)||0)-(Number(b.directPlatformCost)||0);
  const marginPct = b.customerPrice ? (margin/b.customerPrice*100) : 0;
  const reqs = DB.settings.documentRequirements[b.serviceMode] || [];
  openModal(`
    <div class="modal-head"><h3 class="mono">${b.id}</h3><button class="close-x" data-act="modal-bg-close">${icon('x',16)}</button></div>
    <span class="badge ${statusClass(b.status)}">${statusLabel(b.status)}</span>
    <h4 style="margin-top:18px">Customer</h4>
    ${summaryRow('Name', esc(b.customerName))}${summaryRow('Phone', esc(b.customerPhone))}${summaryRow('Email', esc(b.customerEmail||'—'))}
    <h4 style="margin-top:18px">Trip</h4>
    ${summaryRow('Pickup', esc(b.pickup))}${summaryRow('Drop', esc(b.drop))}${summaryRow('Date & time', fmtDate(b.pickupDate)+' · '+b.pickupTime)}
    ${summaryRow('Trip type', b.tripType)}${summaryRow('Service mode', b.serviceMode||'—')}${summaryRow('Passengers / luggage', b.passengers+' / '+b.luggage)}${summaryRow('Vehicle category', b.vehicleCategory)}
    ${b.distanceKm?summaryRow('Approx. distance', b.distanceKm+' km'):''}
    ${b.instructions?summaryRow('Instructions', esc(b.instructions)):''}
    ${b.extraStop?summaryRow('Additional stop', esc(b.extraStop)):''}
    ${b.accessibility?summaryRow('Accessibility', esc(b.accessibility)):''}
    ${reqs.length?`<h4 style="margin-top:18px">Documents</h4>${reqs.map(r=>docReviewRow(b,r)).join('')}`:''}
    ${b.priceBreakdown ? `<h4 style="margin-top:18px">Original price snapshot</h4>
      <p class="hint">Frozen at booking time (${b.priceSource||'—'}) — pricing changes made later never affect this booking.</p>
      <div class="card" style="margin-bottom:0">${b.priceBreakdown.map(x=>summaryRow(x.label, x.amount?money(x.amount):(x.note||'—'))).join('')}</div>` : ''}
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
      <div class="field"><label>Direct platform cost (₹)</label><input type="number" name="directPlatformCost" value="${b.directPlatformCost||0}"></div>
      <div class="field"><label>Payment method</label><select name="paymentMethod">${['Pay Now','Pay Later'].map(s=>`<option ${b.paymentMethod===s?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>Payment status</label><select name="paymentStatus">${['Pending','Processing','Paid','Failed','Refunded','Partially Refunded'].map(s=>`<option ${b.paymentStatus===s?'selected':''}>${s}</option>`).join('')}</select></div>
      ${b.paymentMethod==='Pay Now'?`<p class="hint">Verify the UPI transaction in your bank/UPI app before marking Paid — booking status never confirms payment automatically.</p>`:''}
      <div class="field"><label>Reason for change (optional — recorded in the audit log below)</label><input name="overrideReason" placeholder="e.g. customer requested tolls added"></div>
      <div class="summary-row"><span>Gross platform margin</span><b>${money(margin)}</b></div>
      <div class="summary-row"><span>Margin %</span><b>${marginPct.toFixed(1)}%</b></div>
      <button class="btn btn-outline btn-block" type="submit">Save financial details</button>
    </form>
    ${(b.priceOverrides&&b.priceOverrides.length) ? `<h4 style="margin-top:18px">Price override audit log</h4>
      <div class="card" style="margin-bottom:0">${b.priceOverrides.slice().reverse().map(o=>`
        <div class="summary-row" style="flex-direction:column;align-items:flex-start">
          <span style="font-size:12.5px;color:var(--ink-soft)">${fmtDateTime(o.at)} · ${esc(o.by)}${o.reason?' · '+esc(o.reason):''}</span>
          <span style="font-size:13.5px">${o.changes.map(c=>`${c.field}: ${c.old} → ${c.new}`).join(', ')}</span>
        </div>`).join('')}</div>` : ''}
    <h4 style="margin-top:18px">Partner &amp; assignment</h4>
    <form data-form="booking-assign" data-id="${b.id}">
      <div class="field"><label>Assign partner</label>
        <select name="partnerId"><option value="">— Select a verified, available partner —</option>${eligiblePartners.map(p=>`<option value="${p.id}" ${b.partnerId===p.id?'selected':''}>${esc(p.name)} (${p.serviceArea})</option>`).join('')}</select>
      </div>
      ${!eligiblePartners.length?`<p class="hint">No active, verified, available partners cover ${b.vehicleCategory} for this date/time yet. Add or free one up in Partner Management.</p>`:''}
      ${b.partnerAcceptance?summaryRow('Partner response', b.partnerAcceptance):''}
      <div class="field-row two">
        <div class="field"><label>Driver name</label><input name="driverName" value="${esc(b.driverName||'')}"></div>
        <div class="field"><label>Driver phone</label><input name="driverPhone" value="${esc(b.driverPhone||'')}"></div>
      </div>
      <div class="field"><label>Vehicle registration no.</label><input name="vehicleReg" value="${esc(b.vehicleReg||'')}"></div>
      <button class="btn btn-outline btn-block" type="submit">Save assignment — sends to partner for acceptance</button>
    </form>
    <h4 style="margin-top:18px">Status</h4>
    ${b.status==='CANCELLATION_REQUESTED' ? `
      <p class="hint">Customer requested cancellation.</p>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <button class="btn btn-sm btn-danger" data-act="set-status" data-id="${b.id}" data-status="CANCELLED">Approve Cancellation</button>
        <button class="btn btn-sm btn-outline" data-act="restore-status" data-id="${b.id}">Keep Booking</button>
      </div>` : `
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
        ${STATUS_FLOW.map(s=>`<button class="btn btn-sm ${b.status===s?'btn-primary':'btn-outline'}" data-act="set-status" data-id="${b.id}" data-status="${s}">${statusLabel(s)}</button>`).join('')}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
        <button class="btn btn-sm btn-danger" data-act="set-status" data-id="${b.id}" data-status="CANCELLED">Cancel booking</button>
        <button class="btn btn-sm btn-outline" data-act="set-status" data-id="${b.id}" data-status="REFUND_PENDING">Refund Pending</button>
        <button class="btn btn-sm btn-outline" data-act="set-status" data-id="${b.id}" data-status="REFUNDED">Refunded</button>
        <button class="btn btn-sm btn-outline" data-act="set-status" data-id="${b.id}" data-status="FAILED">Failed</button>
      </div>`}
    <h4>Notes</h4>
    <div>${(b.notes||[]).map(n=>`<div class="summary-row"><span>${esc(n.text)}</span><span class="hint">${fmtDateTime(n.at)}</span></div>`).join('') || '<p class="hint">No notes yet.</p>'}</div>
    <form data-form="booking-note" data-id="${b.id}" style="margin-top:8px;display:flex;gap:8px">
      <input name="text" placeholder="Add a note" style="flex:1">
      <button class="btn btn-outline btn-sm" type="submit">Add</button>
    </form>
    <h4 style="margin-top:18px">Activity</h4>
    <ul class="timeline">${(b.timeline||[]).map((t)=>`<li class="past"><b>${esc(statusLabel(t.event))}</b><time>${fmtDateTime(t.timestamp)}</time></li>`).join('')}</ul>
  `);
}
function docReviewRow(b, reqDef){
  const doc = (b.documents||{})[reqDef.key];
  const status = doc ? doc.status : 'Not uploaded';
  return `<div class="doc-row">
    <div class="doc-row-top"><b>${esc(reqDef.label)}</b><span class="doc-status ${status.replace(/\s/g,'-')}">${status}</span></div>
    ${doc && doc.path ? `<button type="button" class="btn btn-ghost btn-sm" data-act="view-doc" data-id="${b.id}" data-key="${reqDef.key}">View file</button>` : '<p class="hint">Not uploaded</p>'}
    ${doc && doc.status==='Pending' ? `
      <div class="row-actions" style="margin-top:8px">
        <button type="button" class="btn btn-sm btn-outline" data-act="doc-verify" data-id="${b.id}" data-key="${reqDef.key}">Verify</button>
        <button type="button" class="btn btn-sm btn-danger" data-act="doc-reject" data-id="${b.id}" data-key="${reqDef.key}">Reject</button>
      </div>` : ''}
    ${doc && doc.rejectReason ? `<div class="doc-reject-note">${esc(doc.rejectReason)}</div>` : ''}
  </div>`;
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
        <td>${p.verificationStatus==='Verified'?'<span class="tag verified">Verified</span>':p.verificationStatus==='Suspended'?'<span class="tag inactive">Suspended</span>':`<span class="tag unverified">${esc(p.verificationStatus||'Pending')}</span>`} ${!p.active?'<span class="tag inactive">Inactive</span>':''}</td>
        <td>${p.completedTrips||0} done · ${p.cancellations||0} cancel · ${money(p.earnings||0)} earned</td>
        <td class="row-actions"><button class="btn btn-ghost btn-sm" data-act="partner-edit" data-id="${p.id}">Edit</button></td>
      </tr>`).join('')}</tbody>
    </table></div>`}
  </div>`;
}
function partnerFormModal(id){
  const p = id ? DB.partners.find(x=>x.id===id) : null;
  const cats = VEHICLE_CATEGORIES;
  openModal(`
    <div class="modal-head"><h3>${p?'Edit partner':'Add partner'}</h3><button class="close-x" data-act="modal-bg-close">${icon('x',16)}</button></div>
    <form data-form="partner-save" data-id="${p?p.id:''}">
      <div class="field"><label>Business / partner name</label><input name="name" required value="${esc(p?.name||'')}"></div>
      <div class="field-row two"><div class="field"><label>Phone</label><input name="phone" required value="${esc(p?.phone||'')}"></div><div class="field"><label>Email</label><input name="email" value="${esc(p?.email||'')}"></div></div>
      <div class="field"><label>Service area</label><input name="serviceArea" required value="${esc(p?.serviceArea||'')}"></div>
      <div class="field"><label>Vehicle categories served</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${cats.map(c=>`<label style="display:flex;align-items:center;gap:5px;font-weight:400;font-size:13.5px;border:1px solid var(--line);padding:6px 10px;border-radius:8px"><input type="checkbox" name="vehicleCategories" value="${c}" style="width:auto" ${p?.vehicleCategories?.includes(c)?'checked':''}> ${c}</label>`).join('')}</div>
      </div>
      <div class="field"><label>Vehicle details</label><input name="vehicleDetails" value="${esc(p?.vehicleDetails||'')}"></div>
      <div class="field-row two"><div class="field"><label>Driver name</label><input name="driverName" value="${esc(p?.driverName||'')}"></div><div class="field"><label>Driver phone</label><input name="driverPhone" value="${esc(p?.driverPhone||'')}"></div></div>
      <div class="field"><label>Driver / partner address</label><input name="address" value="${esc(p?.address||'')}"></div>
      <div class="field"><label>Registration number</label><input name="regNumber" value="${esc(p?.regNumber||'')}"></div>
      <div class="field"><label>Bank / payout details</label><input name="bankDetails" value="${esc(p?.bankDetails||'')}" placeholder="e.g. bank name + UPI ID — not full account numbers"></div>
      <div class="field"><label>Documents status</label><select name="documentsStatus">${['Pending','Submitted','Approved','Rejected'].map(s=>`<option ${p?.documentsStatus===s?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>Verification status</label><select name="verificationStatus">${['Pending','Under Review','Verified','Rejected','Suspended'].map(s=>`<option ${p?.verificationStatus===s?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>Notes</label><textarea name="notes" rows="2">${esc(p?.notes||'')}</textarea></div>
      <label style="display:flex;align-items:center;gap:8px;font-weight:500;margin-bottom:14px"><input type="checkbox" name="active" style="width:auto" ${p?.active!==false?'checked':''}> Active</label>
      <div class="field"><label>Partner portal password ${p?'(leave blank to keep current)':''}</label><input type="password" name="password" minlength="4" placeholder="Set a login password for the partner portal"></div>
      <p class="hint">Partner logs in at #partner with this phone number and password.</p>
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
      <thead><tr><th>ID</th><th>Category</th><th>Make/model</th><th>Reg. no.</th><th>Seats</th><th>Partner</th><th>Availability</th><th>Insurance</th><th>PUC</th><th>Permit</th><th>Fitness</th><th>Actions</th></tr></thead>
      <tbody>${DB.vehicles.map(v=>`<tr>
        <td class="mono">${v.id}</td><td>${v.category}</td><td>${esc(v.makeModel)}</td><td>${esc(v.regNumber)}</td><td>${v.seating}</td>
        <td>${esc(partnerName(v.partnerId))}</td><td>${v.availability}</td>
        <td>${expiryChip(v.insuranceExpiry)}</td><td>${expiryChip(v.pucExpiry)}</td><td>${expiryChip(v.permitExpiry)}</td><td>${expiryChip(v.fitnessExpiry)}</td>
        <td class="row-actions"><button class="btn btn-ghost btn-sm" data-act="vehicle-edit" data-id="${v.id}">Edit</button></td>
      </tr>`).join('')}</tbody>
    </table></div>`}
  </div>`;
}
function vehicleFormModal(id){
  const v = id ? DB.vehicles.find(x=>x.id===id) : null;
  openModal(`
    <div class="modal-head"><h3>${v?'Edit vehicle':'Add vehicle'}</h3><button class="close-x" data-act="modal-bg-close">${icon('x',16)}</button></div>
    <form data-form="vehicle-save" data-id="${v?v.id:''}">
      <div class="field"><label>Category</label><select name="category">${VEHICLE_CATEGORIES.map(c=>`<option ${v?.category===c?'selected':''}>${c}</option>`).join('')}</select></div>
      <div class="field"><label>Make &amp; model</label><input name="makeModel" required value="${esc(v?.makeModel||'')}"></div>
      <div class="field"><label>Registration number</label><input name="regNumber" required value="${esc(v?.regNumber||'')}"></div>
      <div class="field-row two"><div class="field"><label>Seating capacity</label><input type="number" name="seating" value="${v?.seating||4}"></div><div class="field"><label>Luggage capacity</label><input type="number" name="luggage" value="${v?.luggage||2}"></div></div>
      <div class="field"><label>Partner</label><select name="partnerId"><option value="">— Unassigned —</option>${DB.partners.map(p=>`<option value="${p.id}" ${v?.partnerId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Service area</label><input name="serviceArea" value="${esc(v?.serviceArea||'')}"></div>
      <div class="field"><label>Availability</label><select name="availability">${['Available','Assigned','Unavailable','Maintenance','Suspended'].map(s=>`<option ${v?.availability===s?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="field-row two"><div class="field"><label>Insurance expiry</label><input type="date" name="insuranceExpiry" value="${v?.insuranceExpiry||''}"></div><div class="field"><label>PUC expiry</label><input type="date" name="pucExpiry" value="${v?.pucExpiry||''}"></div></div>
      <div class="field-row two"><div class="field"><label>Permit expiry</label><input type="date" name="permitExpiry" value="${v?.permitExpiry||''}"></div><div class="field"><label>Fitness cert. expiry</label><input type="date" name="fitnessExpiry" value="${v?.fitnessExpiry||''}"></div></div>
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
    const completed = cb.filter(b=>b.status==='TRIP_COMPLETED');
    const cancelled = cb.filter(b=>b.status==='CANCELLED');
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
  if(!UI.admin.pricingTab) UI.admin.pricingTab = 'local';
  const tabs = [
    ['local','Local'],['outstation','Outstation'],['airport','Airport'],['routes','Routes'],
    ['night','Night'],['waiting','Waiting'],['extrastop','Extra Stop'],['vehicles','Vehicles'],
    ['margin','Platform Margin'],['additional','Additional']
  ];
  const tab = UI.admin.pricingTab;
  return `
  <div class="toolbar" style="border-radius:12px 12px 0 0;border:1px solid var(--line);border-bottom:none;background:#fff">
    ${tabs.map(t=>`<button type="button" class="btn btn-sm ${tab===t[0]?'btn-primary':'btn-outline'}" data-act="pricing-tab" data-val="${t[0]}">${t[1]}</button>`).join('')}
  </div>
  <div class="panel" style="border-radius:0 0 12px 12px;margin-top:0"><div class="panel-body">
    ${pricingTabBody(tab)}
  </div></div>`;
}
function lastUpdatedLine(section){
  const lu = (DB.settings.pricing.lastUpdated||{})[section];
  if(!lu) return '';
  return `<p class="hint">Last updated ${fmtDateTime(lu.at)} by ${esc(lu.by)}</p>`;
}
function pricingTabBody(tab){
  const P = DB.settings.pricing;
  if(tab==='local'){
    return `<h3 style="margin-bottom:14px">Local Rental package pricing</h3>
    <form data-form="local-pricing-save">
      ${VEHICLE_CATEGORIES.map(cat=>{
        const lp = P.local[cat];
        return `<div class="card" style="margin-bottom:14px">
          <b style="display:block;margin-bottom:10px">${cat}</b>
          <div class="field-row two">
            <div class="field"><label>4 hrs / 40 km (₹)</label><input type="number" min="0" name="${cat}__pkg4h40" value="${lp.pkg4h40}"></div>
            <div class="field"><label>8 hrs / 80 km (₹)</label><input type="number" min="0" name="${cat}__pkg8h80" value="${lp.pkg8h80}"></div>
          </div>
          <div class="field-row two">
            <div class="field"><label>12 hrs / 120 km (₹)</label><input type="number" min="0" name="${cat}__pkg12h120" value="${lp.pkg12h120}"></div>
            <div class="field"><label>Extra km (₹)</label><input type="number" min="0" name="${cat}__extraKm" value="${lp.extraKm}"></div>
          </div>
          <div class="field"><label>Extra hour (₹)</label><input type="number" min="0" name="${cat}__extraHour" value="${lp.extraHour}"></div>
        </div>`;
      }).join('')}
      ${lastUpdatedLine('local')}
      <div class="step-actions"><button type="button" class="btn btn-outline" data-act="pricing-reset" data-section="local">Reset to Default</button><button class="btn btn-primary btn-block" type="submit">Save Changes</button></div>
    </form>`;
  }
  if(tab==='outstation'){
    return `<h3 style="margin-bottom:14px">Outstation pricing</h3>
    <form data-form="outstation-pricing-save">
      ${VEHICLE_CATEGORIES.map(cat=>{
        const op = P.outstation[cat];
        return `<div class="card" style="margin-bottom:14px">
          <b style="display:block;margin-bottom:10px">${cat}</b>
          <div class="field-row two">
            <div class="field"><label>Per km (₹)</label><input type="number" min="0" name="${cat}__perKm" value="${op.perKm}"></div>
            <div class="field"><label>Minimum billing (km/day)</label><input type="number" min="0" name="${cat}__minKmPerDay" value="${op.minKmPerDay}"></div>
          </div>
          <div class="field"><label>Driver allowance (₹/day)</label><input type="number" min="0" name="${cat}__driverAllowancePerDay" value="${op.driverAllowancePerDay}"></div>
        </div>`;
      }).join('')}
      <div class="card">
        <b style="display:block;margin-bottom:10px">Extras (outstation)</b>
        ${['tolls','parking','permits'].map(k=>`<div class="field"><label>${k[0].toUpperCase()+k.slice(1)}</label><select name="extra__${k}"><option ${P.outstationExtras[k]==='Excluded'?'selected':''}>Excluded</option><option ${P.outstationExtras[k]==='Included'?'selected':''}>Included</option></select></div>`).join('')}
        <p class="hint">Billable KM = MAX(actual km, minimum km/day). Distance fare = billable km × rate. Outstation fare = distance fare + driver allowance + applicable extras.</p>
      </div>
      ${lastUpdatedLine('outstation')}
      <div class="step-actions"><button type="button" class="btn btn-outline" data-act="pricing-reset" data-section="outstation">Reset to Default</button><button class="btn btn-primary btn-block" type="submit">Save Changes</button></div>
    </form>`;
  }
  if(tab==='airport'){
    return `<h3 style="margin-bottom:14px">Fixed airport route pricing</h3>
    ${!P.airportRoutes.length?'<p class="hint">No airport routes configured.</p>':P.airportRoutes.map(r=>`
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <b>${esc(r.pickupZone)} → ${esc(r.dropZone)} (${r.tripType})</b>
          <span class="tag ${r.active?'verified':'inactive'}">${r.active?'Active':'Inactive'}</span>
        </div>
        <div class="grid grid-4" style="margin-bottom:8px">${VEHICLE_CATEGORIES.map(c=>`<div><div class="hint">${c}</div><b>${r.fares[c]!=null?money(r.fares[c]):'—'}</b></div>`).join('')}</div>
        <div class="hint">Toll: ${r.tollIncluded?'Included':'Excluded'} · Parking: ${r.parkingIncluded?'Included':'Excluded'} · Night charge applies: ${r.nightChargeApplies?'Yes':'No'}</div>
        <div class="row-actions" style="margin-top:8px">
          <button type="button" class="btn btn-outline btn-sm" data-act="airport-toggle" data-id="${r.id}">${r.active?'Deactivate':'Activate'}</button>
          <button type="button" class="btn btn-danger btn-sm" data-act="airport-delete" data-id="${r.id}">Delete</button>
        </div>
      </div>`).join('')}
    <h4 style="margin-top:18px">Add airport route</h4>
    <form data-form="airport-route-add">
      <div class="field-row two"><div class="field"><label>Pickup zone</label><input name="pickupZone" required placeholder="e.g. Burdwan"></div><div class="field"><label>Drop zone</label><input name="dropZone" required placeholder="e.g. Kolkata Airport"></div></div>
      <div class="field"><label>Trip type</label><select name="tripType"><option>One Way</option><option>Round Trip</option></select></div>
      <div class="field-row two">${VEHICLE_CATEGORIES.slice(0,2).map(c=>`<div class="field"><label>${c} fare (₹)</label><input type="number" min="0" name="fare__${c}" placeholder="Leave blank if N/A"></div>`).join('')}</div>
      <div class="field-row two">${VEHICLE_CATEGORIES.slice(2).map(c=>`<div class="field"><label>${c} fare (₹)</label><input type="number" min="0" name="fare__${c}" placeholder="Leave blank if N/A"></div>`).join('')}</div>
      <div class="field-row two">
        <label style="display:flex;align-items:center;gap:6px;font-size:13.5px"><input type="checkbox" name="tollIncluded" style="width:auto"> Toll included</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13.5px"><input type="checkbox" name="parkingIncluded" style="width:auto"> Parking included</label>
      </div>
      <label style="display:flex;align-items:center;gap:6px;font-size:13.5px;margin:10px 0"><input type="checkbox" name="nightChargeApplies" style="width:auto" checked> Night charge applies</label>
      <button class="btn btn-outline btn-block" type="submit">Add airport route</button>
    </form>
    ${lastUpdatedLine('airport')}`;
  }
  if(tab==='routes'){
    return `<h3 style="margin-bottom:14px">Route-based fixed pricing</h3>
    <p class="hint">General named routes (e.g. Burdwan → Durgapur). Only routes you add here get a fixed price — nothing is invented automatically.</p>
    ${!P.routePricing.length?'<p class="hint">No routes configured yet.</p>':P.routePricing.map(r=>`
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <b>${esc(r.pickup)} → ${esc(r.drop)} · ${esc(r.vehicle)}</b>
          <span class="tag ${r.active?'verified':'inactive'}">${r.active?'Active':'Inactive'}</span>
        </div>
        <div class="hint">One way: ${money(r.oneWayFare)} · Round trip: ${r.roundTripFare?money(r.roundTripFare):'—'}</div>
        <div class="row-actions" style="margin-top:8px">
          <button type="button" class="btn btn-outline btn-sm" data-act="route-toggle" data-id="${r.id}">${r.active?'Deactivate':'Activate'}</button>
          <button type="button" class="btn btn-danger btn-sm" data-act="route-delete" data-id="${r.id}">Delete</button>
        </div>
      </div>`).join('')}
    <h4 style="margin-top:18px">Add route</h4>
    <form data-form="route-add">
      <div class="field-row two"><div class="field"><label>Pickup</label><input name="pickup" required placeholder="Burdwan"></div><div class="field"><label>Drop</label><input name="drop" required placeholder="Durgapur"></div></div>
      <div class="field"><label>Vehicle category</label><select name="vehicle">${VEHICLE_CATEGORIES.map(c=>`<option>${c}</option>`).join('')}</select></div>
      <div class="field-row two"><div class="field"><label>One way fare (₹)</label><input type="number" min="0" name="oneWayFare" required></div><div class="field"><label>Round trip fare (₹, optional)</label><input type="number" min="0" name="roundTripFare"></div></div>
      <button class="btn btn-outline btn-block" type="submit">Add route</button>
    </form>`;
  }
  if(tab==='night'){
    const n = P.night;
    return `<h3 style="margin-bottom:14px">Night charge</h3>
    <form data-form="night-save">
      <label style="display:flex;align-items:center;gap:8px;font-weight:500;margin-bottom:14px"><input type="checkbox" name="enabled" style="width:auto" ${n.enabled?'checked':''}> Enable night surcharge</label>
      <div class="field-row two"><div class="field"><label>Start hour (24h, 0–23)</label><input type="number" min="0" max="23" name="startHour" value="${n.startHour}"></div><div class="field"><label>End hour (24h, 0–23)</label><input type="number" min="0" max="23" name="endHour" value="${n.endHour}"></div></div>
      <div class="grid grid-4">${VEHICLE_CATEGORIES.map(c=>`<div class="field"><label>${c} (₹)</label><input type="number" min="0" name="charge__${c}" value="${n.charges[c]}"></div>`).join('')}</div>
      <p class="hint">Applies when pickup time falls in the configured window (wraps past midnight automatically, e.g. 22 → 6).</p>
      ${lastUpdatedLine('night')}
      <button class="btn btn-primary" type="submit">Save Changes</button>
    </form>`;
  }
  if(tab==='waiting'){
    const w = P.waiting;
    return `<h3 style="margin-bottom:14px">Waiting charges</h3>
    <p class="hint">Waiting time is only known during/after a trip, so it's not part of the customer's upfront estimate — use these rates as a reference when adding "Additional charges" on a booking after the trip.</p>
    <form data-form="waiting-save">
      <div class="grid grid-4">${VEHICLE_CATEGORIES.map(c=>`<div class="field"><label>${c} (₹/hr)</label><input type="number" min="0" name="perHour__${c}" value="${w.perHour[c]}"></div>`).join('')}</div>
      <div class="field"><label>Airport free waiting (minutes)</label><input type="number" min="0" name="airportFreeMinutes" value="${w.airportFreeMinutes}"></div>
      ${lastUpdatedLine('waiting')}
      <button class="btn btn-primary" type="submit">Save Changes</button>
    </form>`;
  }
  if(tab==='extrastop'){
    return `<h3 style="margin-bottom:14px">Extra stop charge</h3>
    <form data-form="extrastop-save">
      <div class="field"><label>Charge per extra stop (₹)</label><input type="number" min="0" name="charge" value="${P.extraStop.charge}"></div>
      ${lastUpdatedLine('extraStop')}
      <button class="btn btn-primary" type="submit">Save Changes</button>
    </form>`;
  }
  if(tab==='vehicles'){
    return `<h3 style="margin-bottom:14px">Vehicle categories</h3>
    <p class="hint">These 4 categories are used throughout booking, pricing and partner/vehicle management.</p>
    ${VEHICLE_CATEGORIES.map(c=>summaryRow(c, 'Up to '+VEHICLE_CAPACITY[c]+' passengers')).join('')}
    <h4 style="margin-top:18px">Pay Later restrictions</h4>
    <form data-form="paylater-save">
      <label style="display:flex;align-items:center;gap:8px;font-weight:500;margin-bottom:14px"><input type="checkbox" name="payLaterEnabled" style="width:auto" ${DB.settings.payLaterEnabled?'checked':''}> Allow Pay Later at all</label>
      <div class="field"><label>Categories that always require Pay Now</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${VEHICLE_CATEGORIES.map(c=>`<label style="display:flex;align-items:center;gap:5px;font-weight:400;font-size:13.5px;border:1px solid var(--line);padding:6px 10px;border-radius:8px"><input type="checkbox" name="payLaterBlockedCategories" value="${c}" style="width:auto" ${DB.settings.payLaterBlockedCategories.includes(c)?'checked':''}> ${c}</label>`).join('')}</div>
      </div>
      <button class="btn btn-primary" type="submit">Save</button>
    </form>`;
  }
  if(tab==='margin'){
    return `<h3 style="margin-bottom:14px">Platform margin</h3>
    <form data-form="margin-save">
      <div class="field"><label>Target margin % (5–30)</label><input type="number" min="5" max="30" name="targetMarginPercent" value="${P.targetMarginPercent}"></div>
      <div class="field"><label>Default direct platform cost per booking (₹)</label><input type="number" min="0" name="directPlatformCostDefault" value="${P.directPlatformCostDefault}"></div>
      <p class="hint">Gross platform margin = customer fare − partner payout − direct platform cost. This is never called "net profit" anywhere in the app. Applied as a default on new bookings; override per booking from its detail page.</p>
      ${lastUpdatedLine('margin')}
      <button class="btn btn-primary" type="submit">Save Changes</button>
    </form>`;
  }
  if(tab==='additional'){
    return `
    <h3 style="margin-bottom:14px">UPI payment (Pay Now)</h3>
    <form data-form="payment-save">
      <div class="field"><label>UPI ID</label><input name="upiId" value="${esc(DB.settings.payment.upiId)}" placeholder="yourbusiness@upi"></div>
      <div class="field"><label>Payee name shown to customers</label><input name="payeeName" value="${esc(DB.settings.payment.payeeName)}"></div>
      <p class="hint">Leave UPI ID blank to hide "Pay Now" until you're ready. Payments are confirmed manually.</p>
      <button class="btn btn-primary" type="submit">Save payment settings</button>
    </form>
    <h3 style="margin:24px 0 14px">Service areas</h3>
    ${DB.settings.serviceAreas.map((a,i)=>`<div class="summary-row"><span>${esc(a.name)} — ${a.radiusKm} km radius</span><button class="btn btn-ghost btn-sm" type="button" data-act="area-delete" data-idx="${i}">Remove</button></div>`).join('') || '<p class="hint">No service areas configured — every location will show as unavailable.</p>'}
    <form data-form="area-add" style="margin-top:12px">
      <div class="field-row two"><div class="field"><label>Area name</label><input name="name" required placeholder="e.g. Bolpur"></div><div class="field"><label>Radius (km)</label><input type="number" name="radiusKm" required value="12"></div></div>
      <div class="field-row two"><div class="field"><label>Center latitude</label><input type="number" step="any" name="lat" required placeholder="23.6"></div><div class="field"><label>Center longitude</label><input type="number" step="any" name="lng" required placeholder="87.7"></div></div>
      <button class="btn btn-outline" type="submit">Add service area</button>
    </form>
    <h3 style="margin:24px 0 14px">Document requirements</h3>
    ${['Chauffeur','Self-Drive'].map(mode=>`
      <h4 style="font-size:14px">${mode}</h4>
      ${(DB.settings.documentRequirements[mode]||[]).map((r,i)=>`<div class="summary-row"><span>${esc(r.label)} ${r.required?'(required)':'(optional)'}</span><button class="btn btn-ghost btn-sm" type="button" data-act="docreq-delete" data-mode="${mode}" data-idx="${i}">Remove</button></div>`).join('') || '<p class="hint">None configured.</p>'}
      <form data-form="docreq-add" data-mode="${mode}" style="margin:10px 0 18px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        <div class="field" style="flex:1;min-width:160px;margin-bottom:0"><label>Document label</label><input name="label" required placeholder="e.g. Vehicle insurance copy"></div>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:10px"><input type="checkbox" name="required" style="width:auto"> Required</label>
        <button class="btn btn-outline btn-sm" type="submit">Add</button>
      </form>`).join('')}
    `;
  }
  return '';
}

/* ---- Reviews ---- */
function adminReviews(){
  return `
  <div class="panel"><div class="panel-head"><h3>Reviews (${DB.reviews.length})</h3></div>
  ${!DB.reviews.length?'<div class="empty-state">No reviews submitted yet.</div>':`
  <div class="table-scroll"><table>
    <thead><tr><th>Name</th><th>Booking</th><th>Rating</th><th>Review</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${DB.reviews.map(r=>`<tr><td>${esc(r.name)}</td><td class="mono">${r.bookingId||'—'}</td><td>${starRating(r.rating,13)}</td><td style="white-space:normal;max-width:260px">${esc(r.text)}</td>
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
      <p class="hint">Manage service area coverage (with map coordinates) under Pricing → Service areas.</p>
      <button class="btn btn-primary" type="submit">Save business details</button>
    </form>
  </div></div>
  <div class="panel"><div class="panel-head"><h3>Booking rules</h3></div><div class="panel-body">
    <form data-form="booking-rules-save">
      <div class="field"><label>Booking ID prefix</label><input name="bookingPrefix" value="${esc(s.bookingPrefix)}" maxlength="4"></div>
      <div class="field-row two"><div class="field"><label>Advance booking notice (hrs)</label><input type="number" name="advanceBookingHours" value="${s.advanceBookingHours}"></div><div class="field"><label>Minimum booking notice (hrs)</label><input type="number" name="minNoticeHours" value="${s.minNoticeHours}"></div></div>
      <div class="field"><label>Cancellation rules</label><textarea name="cancellationRules" rows="3">${esc(s.cancellationRules)}</textarea></div>
      <div class="field"><label>Max document upload size (MB)</label><input type="number" name="maxDocSizeMb" value="${s.maxDocSizeMb||5}"></div>
      <button class="btn btn-primary" type="submit">Save booking rules</button>
    </form>
  </div></div>
  <div class="panel"><div class="panel-head"><h3>Notifications</h3></div><div class="panel-body">
    <p class="hint">No email, SMS or WhatsApp API is connected yet, so notifications are not sent — the platform will only show statuses in-app and on the tracking page until a provider is configured server-side. Wiring one up requires a backend (see README).</p>
  </div></div>
  <div class="panel"><div class="panel-head"><h3>Admin login</h3></div><div class="panel-body">
    <form data-form="admin-password-save">
      <div class="field"><label>Admin username</label><input name="username" required value="${esc(s.adminUsername||'')}"></div>
      <div class="field"><label>New password (leave blank to keep current password)</label><input type="password" name="password" minlength="4"></div>
      <button class="btn btn-outline" type="submit">Save admin login</button>
    </form>
  </div></div>`;
}

/* =========================================================================
   PARTNER PORTAL
   ========================================================================= */
function renderPartner(path){
  if(!SESSION || SESSION.type!=='partner') return renderPartnerLogin();
  const sub = path.split('/')[1] || 'bookings';
  const partner = DB.partners.find(p=>p.id===SESSION.id);
  if(!partner){ SESSION=null; return renderPartnerLogin(); }
  mount(`
  <div class="dash-shell">
    <aside class="dash-side">
      <div class="brand">${logoSvg()} Partner Portal</div>
      <nav class="dash-nav">${partnerNavLinks(sub)}</nav>
      <button class="btn btn-outline btn-sm btn-block" style="margin-top:16px;border-color:#444;color:#eee" data-act="partner-logout">Log out</button>
    </aside>
    <div class="dash-main">
      <div class="dash-topbar">
        <b style="font-family:'Fraunces',serif;font-size:16px">${partnerTitle(sub)}</b>
        <span style="font-size:13px;color:var(--ink-soft)">${esc(partner.name)}</span>
      </div>
      <div class="dash-mobile-tabs">${partnerNavLinks(sub,true)}</div>
      <div class="dash-body">${partnerBody(sub, partner)}</div>
    </div>
  </div>`);
}
function partnerNavLinks(sub){
  const items = [['bookings','Bookings'],['active','Active Trip'],['completed','Completed'],['earnings','Earnings'],['profile','Profile']];
  return items.map(([k,label])=>`<a class="${sub===k?'active':''}" data-act="go" data-path="partner/${k}">${label}</a>`).join('');
}
function partnerTitle(sub){ return {bookings:'Available & Assigned Bookings',active:'Active Trip',completed:'Completed Trips',earnings:'Earnings',profile:'Profile & Documents'}[sub]||'Bookings'; }
function renderPartnerLogin(){
  mount(`
  <div class="auth-shell">
    <div class="auth-card">
      <div class="brand" style="margin-bottom:16px">${logoSvg()} Partner sign in</div>
      <form data-form="partner-login">
        <div class="field"><label>Phone number</label><input name="phone" required></div>
        <div class="field"><label>Password</label><input name="password" type="password" required></div>
        <button class="btn btn-primary btn-block" type="submit">Sign in</button>
      </form>
      <p class="hint" style="margin-top:10px">Don't have portal access yet? Ask Burdwan Car Rental admin to set a password for your partner account.</p>
    </div>
    <p style="text-align:center;margin-top:16px"><a data-act="go" data-path="home" style="cursor:pointer;color:var(--ink-soft);font-size:13.5px">← Back to site</a></p>
  </div>`);
}
function partnerBody(sub, partner){
  const mine = DB.bookings.filter(b=>b.partnerId===partner.id);
  if(sub==='bookings'){
    const awaiting = mine.filter(b=>b.status==='AWAITING_PARTNER_ACCEPTANCE');
    const upcoming = mine.filter(b=>['BOOKING_CONFIRMED'].includes(b.status));
    return `
    <div class="panel"><div class="panel-head"><h3>Awaiting your response (${awaiting.length})</h3></div>
      ${!awaiting.length?'<div class="empty-state">Nothing needs a response right now.</div>':awaiting.map(b=>`
      <div class="panel-body" style="border-top:1px solid var(--line)">
        ${summaryRow('Route', esc(b.pickup)+' → '+esc(b.drop))}
        ${summaryRow('Date', fmtDate(b.pickupDate)+' · '+b.pickupTime)}
        ${summaryRow('Vehicle', b.vehicleCategory)}
        ${summaryRow('Estimated earnings', money(b.partnerPayout||0))}
        <div class="row-actions" style="margin-top:10px">
          <button class="btn btn-primary btn-sm" data-act="partner-accept" data-id="${b.id}">Accept</button>
          <button class="btn btn-danger btn-sm" data-act="partner-reject" data-id="${b.id}">Reject</button>
        </div>
      </div>`).join('')}
    </div>
    <div class="panel"><div class="panel-head"><h3>Confirmed — awaiting trip start (${upcoming.length})</h3></div>
      ${!upcoming.length?'<div class="empty-state">No confirmed upcoming trips.</div>':upcoming.map(b=>`
      <div class="panel-body" style="border-top:1px solid var(--line)">
        ${summaryRow('Route', esc(b.pickup)+' → '+esc(b.drop))}
        ${summaryRow('Date', fmtDate(b.pickupDate)+' · '+b.pickupTime)}
        <div class="row-actions" style="margin-top:10px">
          <button class="btn btn-outline btn-sm" data-act="partner-set-status" data-id="${b.id}" data-status="DRIVER_ASSIGNED">Driver Assigned</button>
        </div>
      </div>`).join('')}
    </div>`;
  }
  if(sub==='active'){
    const active = mine.filter(b=>['DRIVER_ASSIGNED','DRIVER_ON_THE_WAY','DRIVER_ARRIVED','TRIP_STARTED'].includes(b.status));
    const nextStatus = {DRIVER_ASSIGNED:'DRIVER_ON_THE_WAY', DRIVER_ON_THE_WAY:'DRIVER_ARRIVED', DRIVER_ARRIVED:'TRIP_STARTED', TRIP_STARTED:'TRIP_COMPLETED'};
    return `<div class="panel"><div class="panel-head"><h3>Active trips (${active.length})</h3></div>
      ${!active.length?'<div class="empty-state">No active trip right now.</div>':active.map(b=>`
      <div class="panel-body" style="border-top:1px solid var(--line)">
        <div style="display:flex;justify-content:space-between"><b class="mono">${b.id}</b><span class="badge ${statusClass(b.status)}">${statusLabel(b.status)}</span></div>
        ${summaryRow('Route', esc(b.pickup)+' → '+esc(b.drop))}
        ${summaryRow('Customer', esc(b.customerName)+' · '+esc(b.customerPhone))}
        <button class="btn btn-primary btn-sm" style="margin-top:10px" data-act="partner-set-status" data-id="${b.id}" data-status="${nextStatus[b.status]}">Mark: ${statusLabel(nextStatus[b.status])}</button>
      </div>`).join('')}
    </div>`;
  }
  if(sub==='completed'){
    const done = mine.filter(b=>b.status==='TRIP_COMPLETED').sort((a,z)=>new Date(z.updatedAt)-new Date(a.updatedAt));
    return `<div class="panel"><div class="panel-head"><h3>Completed trips (${done.length})</h3></div>
      ${!done.length?'<div class="empty-state">No completed trips yet.</div>':`<div class="table-scroll"><table><thead><tr><th>Booking</th><th>Route</th><th>Date</th><th>Payout</th></tr></thead>
      <tbody>${done.map(b=>`<tr><td class="mono">${b.id}</td><td>${esc(b.pickup)} → ${esc(b.drop)}</td><td>${fmtDate(b.pickupDate)}</td><td>${money(b.partnerPayout)}</td></tr>`).join('')}</tbody></table></div>`}
    </div>`;
  }
  if(sub==='earnings'){
    return `<div class="grid grid-3">
      <div class="stat-card"><div class="label">Total earnings</div><div class="value">${money(partner.earnings||0)}</div></div>
      <div class="stat-card"><div class="label">Completed trips</div><div class="value">${partner.completedTrips||0}</div></div>
      <div class="stat-card"><div class="label">Cancellations</div><div class="value">${partner.cancellations||0}</div></div>
    </div>`;
  }
  if(sub==='profile'){
    return `<div class="panel"><div class="panel-head"><h3>Profile</h3></div><div class="panel-body">
      ${summaryRow('Name', esc(partner.name))}${summaryRow('Phone', esc(partner.phone))}${summaryRow('Service area', esc(partner.serviceArea))}
      ${summaryRow('Vehicle categories', partner.vehicleCategories.join(', '))}
      ${summaryRow('Verification status', partner.verificationStatus)}
      <p class="hint">To update your details, contact Burdwan Car Rental admin.</p>
    </div></div>`;
  }
  return '';
}

/* =========================================================================
   ACTION HANDLERS
   ========================================================================= */
function handleAction(act, el){
  const id = el.getAttribute('data-id');
  if(act==='toggle-faq'){ el.closest('.faq-item').classList.toggle('open'); return; }

  if(act==='pick-trip'){ UI.booking.draft.tripType = el.getAttribute('data-val'); renderBooking(); return; }
  if(act==='pick-mode'){ UI.booking.draft.serviceMode = el.getAttribute('data-val'); renderBooking(); return; }
  if(act==='pick-package'){ UI.booking.draft.localPackage = el.getAttribute('data-val'); renderBooking(); return; }
  if(act==='pick-vehicle'){ UI.booking.draft.vehicleCategory = el.getAttribute('data-val'); renderBooking(); return; }
  if(act==='pick-payment'){ UI.booking.draft.paymentMethod = el.getAttribute('data-val'); UI.booking.draft.paymentStatusDraft=null; renderBooking(); return; }
  if(act==='step-back'){ UI.booking.step = Math.max(1, UI.booking.step-1); renderBooking(); return; }
  if(act==='step-next'){ UI.booking.step++; renderBooking(); return; }
  if(act==='submit-booking'){ submitBooking(); return; }
  if(act==='receipt-print'){ window.print(); return; }
  if(act==='receipt-share'){
    const bkId = el.getAttribute('data-id');
    const text = `My Burdwan Car Rental booking: ${bkId} — track at ${location.origin+location.pathname}#track?id=${bkId}`;
    if(navigator.share){ navigator.share({title:'Booking '+bkId, text}).catch(()=>{}); }
    else if(navigator.clipboard){ navigator.clipboard.writeText(text); showToast('Booking link copied'); }
    return;
  }

  if(act==='use-my-location'){
    const which = el.getAttribute('data-which');
    if(!navigator.geolocation){ showToast('Location is not available on this device/browser'); return; }
    navigator.geolocation.getCurrentPosition(async (pos)=>{
      const {latitude,longitude} = pos.coords;
      await setLocationPoint(which, latitude, longitude);
      if(UI.booking.maps && UI.booking.maps[which]) UI.booking.maps[which].place(latitude, longitude);
    }, ()=> showToast('Could not get your location — check permission'));
    return;
  }
  if(act==='loc-continue'){
    const d = UI.booking.draft;
    if(!d.pickupDate || !d.pickupTime){ showToast('Pick a pickup date and time'); return; }
    if(isInServiceArea(d.pickupLat,d.pickupLng) && isInServiceArea(d.dropLat,d.dropLng)){
      UI.booking.locWarning = null; UI.booking.step = 3; renderBooking();
    } else {
      UI.booking.locWarning = true;
      const slot = document.getElementById('loc-warning-slot');
      if(slot) slot.innerHTML = locWarningHtml();
    }
    return;
  }
  if(act==='loc-custom-quote'){
    const d = UI.booking.draft;
    const msg = `Custom quote requested — Pickup: ${d.pickup||'—'}; Drop: ${d.drop||'—'}; Trip type: ${d.tripType||'—'}`;
    DB.support.push({ id: uid('SUP'), name: d.customerName||'Booking wizard lead', message: msg, resolved:false, createdAt:new Date().toISOString() });
    storeSet(KEYS.support, DB.support);
    showToast('Request sent — our team will reach out');
    go('home');
    return;
  }

  if(act==='auth-switch'){ UI.authMode = el.getAttribute('data-val'); renderCustomerAuth(); return; }
  if(act==='logout'){ SESSION=null; go('home'); return; }
  if(act==='customer-cancel'){ cancelBooking(id); return; }
  if(act==='open-review'){ reviewFormModal(id); return; }

  if(act==='open-booking'){ bookingDetailModal(id); return; }
  if(act==='set-status'){ setBookingStatus(id, el.getAttribute('data-status')); return; }
  if(act==='restore-status'){ restoreBookingStatus(id); return; }
  if(act==='view-doc'){ viewBookingDocument(id, el.getAttribute('data-key')); return; }
  if(act==='doc-verify'){ setDocStatus(id, el.getAttribute('data-key'), 'Verified'); return; }
  if(act==='doc-reject'){
    const reason = prompt('Reason for rejecting this document (shown to the customer):', 'Document image is unclear.');
    if(reason===null) return;
    setDocStatus(id, el.getAttribute('data-key'), 'Rejected', reason);
    return;
  }
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
  if(act==='area-delete'){ deleteServiceArea(Number(el.getAttribute('data-idx'))); return; }
  if(act==='pricing-tab'){ UI.admin.pricingTab = el.getAttribute('data-val'); renderAdmin('admin/pricing'); return; }
  if(act==='pricing-reset'){
    const section = el.getAttribute('data-section');
    const def = defaultPricingV2();
    DB.settings.pricing[section] = def[section];
    storeSet(KEYS.settings, DB.settings).then(()=>{ showToast('Reset to default'); renderAdmin('admin/pricing'); });
    return;
  }
  if(act==='airport-toggle'){ toggleAirportRoute(id); return; }
  if(act==='airport-delete'){ deleteAirportRoute(id); return; }
  if(act==='route-toggle'){ toggleRoutePricing(id); return; }
  if(act==='route-delete'){ deleteRoutePricing(id); return; }
  if(act==='docreq-delete'){ deleteDocRequirement(el.getAttribute('data-mode'), Number(el.getAttribute('data-idx'))); return; }

  if(act==='review-toggle-hide'){ toggleReview(id,'hidden'); return; }
  if(act==='review-toggle-feature'){ toggleReview(id,'featured'); return; }
  if(act==='support-toggle'){ toggleSupport(id); return; }

  if(act==='partner-logout'){ SESSION=null; go('partner'); return; }
  if(act==='partner-accept'){ partnerRespond(id, true); return; }
  if(act==='partner-reject'){ partnerRespond(id, false); return; }
  if(act==='partner-set-status'){ partnerSetStatus(id, el.getAttribute('data-status')); return; }
}

async function submitBooking(){
  const d = UI.booking.draft;
  const id = await nextBookingId();
  const now = new Date().toISOString();
  const fare = calculateFare(d);
  const distanceKm = (d.pickupLat&&d.dropLat) ? roadDistanceKm(d.pickupLat,d.pickupLng,d.dropLat,d.dropLng) : null;
  const documents = await finalizeDocumentPaths(id, d.documents);
  const initialStatus = d.paymentMethod==='Pay Now' ? 'PAYMENT_PENDING' : 'UNDER_REVIEW';
  const directCost = DB.settings.pricing.directPlatformCostDefault||0;
  const bk = {
    id, status:initialStatus, tripType:d.tripType, serviceMode:d.serviceMode, localPackage:d.localPackage||null,
    pickup:d.pickup, pickupLat:d.pickupLat, pickupLng:d.pickupLng,
    drop:d.drop, dropLat:d.dropLat, dropLng:d.dropLng, distanceKm,
    pickupDate:d.pickupDate, pickupTime:d.pickupTime, returnDate:d.returnDate, returnTime:d.returnTime,
    passengers:d.passengers, luggage:d.luggage, vehicleCategory:d.vehicleCategory,
    customerName:d.customerName, customerPhone:d.customerPhone, customerEmail:d.customerEmail,
    altPhone:d.altPhone, instructions:d.instructions, additionalPassenger:d.additionalPassenger||'',
    extraStop:d.extraStop||'', accessibility:d.accessibility||'',
    documents,
    // Pricing snapshot — frozen at booking time. If admin pricing changes later,
    // this booking's fare does NOT change; only new bookings use new rates.
    priceBreakdown: fare ? fare.breakdown : null,
    priceSource: fare ? fare.source : 'Manual quote',
    pricingSnapshotAt: now,
    customerPrice: fare ? fare.total : 0, partnerPayout:0, directPlatformCost:directCost, additionalCharges:0, refund:0, finalAmount:null,
    priceOverrides:[],
    paymentMethod:d.paymentMethod, paymentStatus: d.paymentMethod==='Pay Now' ? 'Processing' : 'Pending',
    partnerId:null, partnerAcceptance:null, driverName:'', driverPhone:'', vehicleReg:'',
    notes:[], timeline:[{event:'REQUEST_RECEIVED', timestamp:now}, {event:initialStatus, timestamp:now}],
    createdAt:now, updatedAt:now
  };
  DB.bookings.push(bk);
  await storeSet(KEYS.bookings, DB.bookings);
  NotificationService.notify('booking_received', bk);
  UI.booking.createdId = id;
  UI.booking.step = 8;
  renderBooking();
  showToast('Booking request sent');
}
async function cancelBooking(id){
  const bk = DB.bookings.find(b=>b.id===id);
  if(!bk) return;
  bk.preCancelStatus = bk.status;
  bk.status='CANCELLATION_REQUESTED'; bk.updatedAt=new Date().toISOString();
  bk.timeline.push({event:'CANCELLATION_REQUESTED', timestamp:bk.updatedAt});
  await storeSet(KEYS.bookings, DB.bookings);
  showToast('Cancellation requested — our team will confirm shortly');
  renderAccount();
}
const STATUS_NOTIFY_EVENT = {
  BOOKING_CONFIRMED:'booking_confirmed', DRIVER_ASSIGNED:'driver_assigned',
  TRIP_COMPLETED:'trip_completed', CANCELLED:'booking_cancelled'
};
async function setBookingStatus(id, status){
  const bk = DB.bookings.find(b=>b.id===id);
  if(!bk) return;
  bk.status = status; bk.updatedAt = new Date().toISOString();
  bk.timeline = bk.timeline||[];
  if(!bk.timeline.find(t=>t.event===status)) bk.timeline.push({event:status, timestamp:bk.updatedAt});
  if(status==='TRIP_COMPLETED'){
    const p = DB.partners.find(x=>x.id===bk.partnerId);
    if(p){ p.completedTrips=(p.completedTrips||0)+1; p.earnings=(p.earnings||0)+(Number(bk.partnerPayout)||0); await storeSet(KEYS.partners, DB.partners); }
  }
  if(status==='CANCELLED' && bk.partnerId){
    const p = DB.partners.find(x=>x.id===bk.partnerId);
    if(p){ p.cancellations=(p.cancellations||0)+1; await storeSet(KEYS.partners, DB.partners); }
  }
  await storeSet(KEYS.bookings, DB.bookings);
  if(STATUS_NOTIFY_EVENT[status]) NotificationService.notify(STATUS_NOTIFY_EVENT[status], bk);
  showToast('Status updated to ' + statusLabel(status));
  bookingDetailModal(id);
  renderAdmin('admin/bookings');
}
async function restoreBookingStatus(id){
  const bk = DB.bookings.find(b=>b.id===id);
  if(!bk || !bk.preCancelStatus) return;
  bk.status = bk.preCancelStatus; bk.preCancelStatus=null; bk.updatedAt=new Date().toISOString();
  await storeSet(KEYS.bookings, DB.bookings);
  showToast('Booking kept — cancellation request dismissed');
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
function stampPricingUpdate(section){
  DB.settings.pricing.lastUpdated = DB.settings.pricing.lastUpdated || {};
  DB.settings.pricing.lastUpdated[section] = { at: new Date().toISOString(), by: (SESSION && SESSION.name) || 'Admin' };
}
async function handleForm(kind, form){
  const v = fd(form);
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
  if(kind==='submit-review'){
    const bookingId = form.getAttribute('data-id');
    const bk = DB.bookings.find(x=>x.id===bookingId);
    if(!bk) return;
    DB.reviews.push({ id: uid('REV'), bookingId, name:bk.customerName, rating:Number(v.rating)||5, text:v.text, hidden:false, featured:false, createdAt:new Date().toISOString() });
    await storeSet(KEYS.reviews, DB.reviews);
    closeModal(); showToast('Thanks for your review!'); renderAccount(); return;
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
    if((v.username||'').trim().toLowerCase() !== (DB.settings.adminUsername||'').trim().toLowerCase()){ showToast('Incorrect username or password'); return; }
    const hash = await sha256(v.password);
    if(hash !== DB.settings.adminPasswordHash){ showToast('Incorrect username or password'); return; }
    SESSION = { type:'admin', name:'Admin' };
    go('admin/dashboard'); return;
  }
  if(kind==='partner-login'){
    const p = DB.partners.find(x=>x.phone.trim()===v.phone.trim());
    if(!p || !p.passwordHash){ showToast('No partner portal account for that number — ask admin to set a password'); return; }
    const hash = await sha256(v.password);
    if(hash !== p.passwordHash){ showToast('Incorrect password'); return; }
    SESSION = { type:'partner', id:p.id, name:p.name, phone:p.phone };
    go('partner/bookings'); return;
  }
  if(kind==='booking-financial'){
    const b = DB.bookings.find(x=>x.id===form.getAttribute('data-id')); if(!b) return;
    const tracked = [
      ['customerPrice','Customer price'], ['partnerPayout','Partner payout'],
      ['additionalCharges','Additional charges'], ['refund','Refund'], ['directPlatformCost','Direct platform cost']
    ];
    const newVals = { customerPrice:Number(v.customerPrice)||0, partnerPayout:Number(v.partnerPayout)||0,
      additionalCharges:Number(v.additionalCharges)||0, refund:Number(v.refund)||0, directPlatformCost:Number(v.directPlatformCost)||0 };
    const changes = tracked.filter(([f])=> (b[f]||0) !== newVals[f]).map(([f,label])=>({field:label, old:money(b[f]||0), new:money(newVals[f])}));
    Object.assign(b, newVals);
    b.finalAmount = b.customerPrice + b.additionalCharges - b.refund;
    b.paymentMethod = v.paymentMethod; b.paymentStatus = v.paymentStatus; b.updatedAt=new Date().toISOString();
    if(changes.length){
      b.priceOverrides = b.priceOverrides||[];
      b.priceOverrides.push({ at:b.updatedAt, by:SESSION.name||'Admin', reason:v.overrideReason||'', changes });
    }
    await storeSet(KEYS.bookings, DB.bookings);
    showToast('Financial details saved'); bookingDetailModal(b.id); renderAdmin('admin/bookings'); return;
  }
  if(kind==='booking-assign'){
    const b = DB.bookings.find(x=>x.id===form.getAttribute('data-id')); if(!b) return;
    const newPartnerId = v.partnerId || null;
    const changed = newPartnerId !== b.partnerId;
    b.partnerId = newPartnerId; b.driverName=v.driverName; b.driverPhone=v.driverPhone; b.vehicleReg=v.vehicleReg;
    b.updatedAt = new Date().toISOString();
    if(newPartnerId && changed){
      b.status = 'AWAITING_PARTNER_ACCEPTANCE';
      b.partnerAcceptance = 'Awaiting';
      if(!b.timeline.find(t=>t.event==='PARTNER_ASSIGNED')) b.timeline.push({event:'PARTNER_ASSIGNED', timestamp:b.updatedAt});
      b.timeline.push({event:'AWAITING_PARTNER_ACCEPTANCE', timestamp:b.updatedAt});
    }
    await storeSet(KEYS.bookings, DB.bookings);
    showToast('Assignment saved — partner notified in their portal'); bookingDetailModal(b.id); renderAdmin('admin/bookings'); return;
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
      vehicleDetails:v.vehicleDetails, driverName:v.driverName, driverPhone:v.driverPhone, address:v.address, regNumber:v.regNumber,
      bankDetails:v.bankDetails, documentsStatus:v.documentsStatus, verificationStatus:v.verificationStatus, notes:v.notes,
      active: form.querySelector('[name=active]').checked };
    if(v.password && v.password.trim()) payload.passwordHash = await sha256(v.password);
    if(editId){ Object.assign(DB.partners.find(p=>p.id===editId), payload); }
    else { DB.partners.push(Object.assign({id: uid('PTR'), completedTrips:0, cancellations:0, earnings:0, passwordHash:null}, payload)); }
    await storeSet(KEYS.partners, DB.partners);
    closeModal(); showToast('Partner saved'); renderAdmin('admin/partners'); return;
  }
  if(kind==='vehicle-save'){
    const editId = form.getAttribute('data-id');
    const payload = { category:v.category, makeModel:v.makeModel, regNumber:v.regNumber, seating:Number(v.seating)||4,
      luggage:Number(v.luggage)||0, partnerId:v.partnerId||null, serviceArea:v.serviceArea, availability:v.availability,
      insuranceExpiry:v.insuranceExpiry||'', pucExpiry:v.pucExpiry||'', permitExpiry:v.permitExpiry||'', fitnessExpiry:v.fitnessExpiry||'',
      verified: form.querySelector('[name=verified]').checked };
    if(editId){ Object.assign(DB.vehicles.find(x=>x.id===editId), payload); }
    else { DB.vehicles.push(Object.assign({id: uid('VEH')}, payload)); }
    await storeSet(KEYS.vehicles, DB.vehicles);
    closeModal(); showToast('Vehicle saved'); renderAdmin('admin/vehicles'); return;
  }
  if(kind==='local-pricing-save'){
    VEHICLE_CATEGORIES.forEach(cat=>{
      const lp = DB.settings.pricing.local[cat];
      ['pkg4h40','pkg8h80','pkg12h120','extraKm','extraHour'].forEach(f=>{
        const raw = v[`${cat}__${f}`];
        if(raw!==undefined) lp[f] = Math.max(0, Number(raw)||0);
      });
    });
    stampPricingUpdate('local');
    await storeSet(KEYS.settings, DB.settings);
    showToast('Local pricing saved'); renderAdmin('admin/pricing'); return;
  }
  if(kind==='outstation-pricing-save'){
    VEHICLE_CATEGORIES.forEach(cat=>{
      const op = DB.settings.pricing.outstation[cat];
      ['perKm','minKmPerDay','driverAllowancePerDay'].forEach(f=>{
        const raw = v[`${cat}__${f}`];
        if(raw!==undefined) op[f] = Math.max(0, Number(raw)||0);
      });
    });
    ['tolls','parking','permits'].forEach(k=>{
      const raw = v[`extra__${k}`];
      if(raw) DB.settings.pricing.outstationExtras[k] = raw;
    });
    stampPricingUpdate('outstation');
    await storeSet(KEYS.settings, DB.settings);
    showToast('Outstation pricing saved'); renderAdmin('admin/pricing'); return;
  }
  if(kind==='airport-route-add'){
    const fares = {};
    VEHICLE_CATEGORIES.forEach(c=>{ const raw = v[`fare__${c}`]; if(raw!==undefined && raw!=='') fares[c] = Math.max(0, Number(raw)||0); });
    DB.settings.pricing.airportRoutes.push({
      id: uid('RTE'), pickupZone:v.pickupZone, dropZone:v.dropZone, tripType:v.tripType, fares,
      tollIncluded: form.querySelector('[name=tollIncluded]').checked,
      parkingIncluded: form.querySelector('[name=parkingIncluded]').checked,
      nightChargeApplies: form.querySelector('[name=nightChargeApplies]').checked,
      active: true
    });
    stampPricingUpdate('airport');
    await storeSet(KEYS.settings, DB.settings);
    showToast('Airport route added'); renderAdmin('admin/pricing'); return;
  }
  if(kind==='route-add'){
    DB.settings.pricing.routePricing.push({
      id: uid('RTE'), pickup:v.pickup, drop:v.drop, vehicle:v.vehicle,
      oneWayFare: Math.max(0, Number(v.oneWayFare)||0),
      roundTripFare: v.roundTripFare ? Math.max(0, Number(v.roundTripFare)||0) : null,
      active: true
    });
    stampPricingUpdate('routes');
    await storeSet(KEYS.settings, DB.settings);
    showToast('Route added'); renderAdmin('admin/pricing'); return;
  }
  if(kind==='night-save'){
    const n = DB.settings.pricing.night;
    n.enabled = form.querySelector('[name=enabled]').checked;
    n.startHour = Math.min(23, Math.max(0, Number(v.startHour)||0));
    n.endHour = Math.min(23, Math.max(0, Number(v.endHour)||0));
    VEHICLE_CATEGORIES.forEach(c=>{ const raw = v[`charge__${c}`]; if(raw!==undefined) n.charges[c] = Math.max(0, Number(raw)||0); });
    stampPricingUpdate('night');
    await storeSet(KEYS.settings, DB.settings);
    showToast('Night charge settings saved'); renderAdmin('admin/pricing'); return;
  }
  if(kind==='waiting-save'){
    const w = DB.settings.pricing.waiting;
    VEHICLE_CATEGORIES.forEach(c=>{ const raw = v[`perHour__${c}`]; if(raw!==undefined) w.perHour[c] = Math.max(0, Number(raw)||0); });
    w.airportFreeMinutes = Math.max(0, Number(v.airportFreeMinutes)||0);
    stampPricingUpdate('waiting');
    await storeSet(KEYS.settings, DB.settings);
    showToast('Waiting charge settings saved'); renderAdmin('admin/pricing'); return;
  }
  if(kind==='extrastop-save'){
    DB.settings.pricing.extraStop.charge = Math.max(0, Number(v.charge)||0);
    stampPricingUpdate('extraStop');
    await storeSet(KEYS.settings, DB.settings);
    showToast('Extra stop charge saved'); renderAdmin('admin/pricing'); return;
  }
  if(kind==='margin-save'){
    const pct = Math.min(30, Math.max(5, Number(v.targetMarginPercent)||15));
    DB.settings.pricing.targetMarginPercent = pct;
    DB.settings.pricing.directPlatformCostDefault = Math.max(0, Number(v.directPlatformCostDefault)||0);
    stampPricingUpdate('margin');
    await storeSet(KEYS.settings, DB.settings);
    showToast('Platform margin settings saved'); renderAdmin('admin/pricing'); return;
  }
  if(kind==='paylater-save'){
    const cats = Array.from(form.querySelectorAll('input[name=payLaterBlockedCategories]:checked')).map(c=>c.value);
    DB.settings.payLaterEnabled = form.querySelector('[name=payLaterEnabled]').checked;
    DB.settings.payLaterBlockedCategories = cats;
    await storeSet(KEYS.settings, DB.settings);
    showToast('Pay Later settings saved'); renderAdmin('admin/pricing'); return;
  }
  if(kind==='payment-save'){
    DB.settings.payment = { upiId:(v.upiId||'').trim(), payeeName:v.payeeName||DB.settings.businessName };
    await storeSet(KEYS.settings, DB.settings);
    showToast('Payment settings saved'); return;
  }
  if(kind==='area-add'){
    DB.settings.serviceAreas.push({ name:v.name, lat:Number(v.lat), lng:Number(v.lng), radiusKm:Number(v.radiusKm)||10 });
    await storeSet(KEYS.settings, DB.settings);
    form.reset(); showToast('Service area added'); renderAdmin('admin/pricing'); return;
  }
  if(kind==='docreq-add'){
    const mode = form.getAttribute('data-mode');
    const key = 'doc_'+uid('').slice(1);
    DB.settings.documentRequirements[mode] = DB.settings.documentRequirements[mode]||[];
    DB.settings.documentRequirements[mode].push({ key, label:v.label, required: form.querySelector('[name=required]').checked });
    await storeSet(KEYS.settings, DB.settings);
    showToast('Document requirement added'); renderAdmin('admin/pricing'); return;
  }
  if(kind==='business-save'){
    Object.assign(DB.settings, { businessName:v.businessName, phone:v.phone, email:v.email, whatsapp:v.whatsapp, address:v.address });
    await storeSet(KEYS.settings, DB.settings);
    showToast('Business details saved'); renderAdmin('admin/settings'); return;
  }
  if(kind==='booking-rules-save'){
    Object.assign(DB.settings, { bookingPrefix:(v.bookingPrefix||'BCR').toUpperCase(), advanceBookingHours:Number(v.advanceBookingHours)||0,
      minNoticeHours:Number(v.minNoticeHours)||0, cancellationRules:v.cancellationRules, maxDocSizeMb:Number(v.maxDocSizeMb)||5 });
    await storeSet(KEYS.settings, DB.settings);
    showToast('Booking rules saved'); return;
  }
  if(kind==='admin-password-save'){
    if(!v.username || !v.username.trim()){ showToast('Username cannot be empty'); return; }
    DB.settings.adminUsername = v.username.trim();
    if(v.password && v.password.trim()){ DB.settings.adminPasswordHash = await sha256(v.password); }
    await storeSet(KEYS.settings, DB.settings);
    form.reset(); showToast('Admin login updated'); renderAdmin('admin/settings'); return;
  }
}
function handleLive(kind, el){
  if(kind.startsWith('draft-silent-')){ UI.booking.draft[kind.slice(13)] = el.value; return; }
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

/* ---- document review / signed URLs ---- */
async function viewBookingDocument(bookingId, key){
  const bk = DB.bookings.find(b=>b.id===bookingId);
  const doc = bk && bk.documents && bk.documents[key];
  if(!doc || !doc.path){ showToast('No file on record'); return; }
  if(!sb){ showToast('Supabase is not connected'); return; }
  try{
    const { data, error } = await sb.storage.from('booking-documents').createSignedUrl(doc.path, 600);
    if(error || !data) throw error;
    window.open(data.signedUrl, '_blank');
  }catch(e){ console.error(e); showToast('Could not open file'); }
}
async function setDocStatus(bookingId, key, status, reason){
  const bk = DB.bookings.find(b=>b.id===bookingId);
  if(!bk || !bk.documents || !bk.documents[key]) return;
  bk.documents[key].status = status;
  bk.documents[key].rejectReason = status==='Rejected' ? (reason||'Document does not meet the required criteria.') : null;
  bk.updatedAt = new Date().toISOString();
  await storeSet(KEYS.bookings, DB.bookings);
  showToast('Document marked '+status);
  bookingDetailModal(bookingId);
}
async function deleteServiceArea(idx){
  DB.settings.serviceAreas.splice(idx,1);
  await storeSet(KEYS.settings, DB.settings);
  renderAdmin('admin/pricing');
}
async function deleteDocRequirement(mode, idx){
  DB.settings.documentRequirements[mode].splice(idx,1);
  await storeSet(KEYS.settings, DB.settings);
  renderAdmin('admin/pricing');
}
async function toggleAirportRoute(id){
  const r = DB.settings.pricing.airportRoutes.find(x=>x.id===id); if(!r) return;
  r.active = !r.active;
  await storeSet(KEYS.settings, DB.settings);
  renderAdmin('admin/pricing');
}
async function deleteAirportRoute(id){
  DB.settings.pricing.airportRoutes = DB.settings.pricing.airportRoutes.filter(x=>x.id!==id);
  await storeSet(KEYS.settings, DB.settings);
  renderAdmin('admin/pricing');
}
async function toggleRoutePricing(id){
  const r = DB.settings.pricing.routePricing.find(x=>x.id===id); if(!r) return;
  r.active = !r.active;
  await storeSet(KEYS.settings, DB.settings);
  renderAdmin('admin/pricing');
}
async function deleteRoutePricing(id){
  DB.settings.pricing.routePricing = DB.settings.pricing.routePricing.filter(x=>x.id!==id);
  await storeSet(KEYS.settings, DB.settings);
  renderAdmin('admin/pricing');
}

/* ---- partner portal actions ---- */
async function partnerRespond(bookingId, accept){
  const bk = DB.bookings.find(b=>b.id===bookingId);
  if(!bk) return;
  bk.updatedAt = new Date().toISOString();
  if(accept){
    bk.partnerAcceptance = 'Accepted';
    bk.status = 'BOOKING_CONFIRMED';
    bk.timeline.push({event:'BOOKING_CONFIRMED', timestamp:bk.updatedAt});
    showToast('Booking accepted');
  } else {
    bk.partnerAcceptance = 'Rejected';
    bk.status = 'PARTNER_BEING_ASSIGNED';
    bk.notes = bk.notes||[]; bk.notes.push({text:`Partner ${SESSION.name} declined this trip`, at:bk.updatedAt});
    bk.partnerId = null;
    showToast('Booking declined — sent back to admin for reassignment');
  }
  await storeSet(KEYS.bookings, DB.bookings);
  renderPartner('partner/bookings');
}
async function partnerSetStatus(bookingId, status){
  const bk = DB.bookings.find(b=>b.id===bookingId);
  if(!bk || bk.partnerId!==SESSION.id) return;
  bk.status = status; bk.updatedAt = new Date().toISOString();
  if(!bk.timeline.find(t=>t.event===status)) bk.timeline.push({event:status, timestamp:bk.updatedAt});
  if(status==='TRIP_COMPLETED'){
    const p = DB.partners.find(x=>x.id===SESSION.id);
    if(p){ p.completedTrips=(p.completedTrips||0)+1; p.earnings=(p.earnings||0)+(Number(bk.partnerPayout)||0); await storeSet(KEYS.partners, DB.partners); }
  }
  await storeSet(KEYS.bookings, DB.bookings);
  showToast('Status updated');
  renderPartner('partner/bookings');
}

/* =========================================================================
   BOOT
   ========================================================================= */
(async function boot(){
  mount(`<div style="min-height:60vh;display:flex;align-items:center;justify-content:center;color:var(--ink-soft)">Loading…</div>`);
  await seedIfEmpty();
  route();
})();
