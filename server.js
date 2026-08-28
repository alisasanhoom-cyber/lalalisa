/* ===================================================================
   MP MODELS — BOOKING & JOB TRACKER SERVER
   -------------------------------------------------------------------
   What this does, in plain English:
     1. Shows the website (all the .html pages).
     2. Lets a client send a booking request from book.html — it becomes
        a new "pending" job in your tracker.
     3. Keeps two lists on disk:
          data/jobs.json      – your job ledger (like JOB TRACKER 2026)
          data/schedule.json  – your day-by-day calendar (like 2026 SCHEDULE)
     4. Lets the team view and manage both from admin.html.

   To start it:   node server.js
   Then open:     http://localhost:3000/            (the website)
                  http://localhost:3000/admin.html  (your dashboard)
   =================================================================== */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

/* ---- SETTINGS you can safely change ------------------------------ */
const PORT     = process.env.PORT || 3000;
const PASSWORD = process.env.ADMIN_PASSWORD || 'mpmodels';
// The Job Tracker holds confirmed bookings only — leads live in the Schedule.
const STATUSES = ['confirmed', 'declined', 'completed'];       // legacy job field (all confirmed)
const LEAD_STATUSES = ['open', 'confirmed', 'postponed', 'declined'];  // schedule lead outcomes
// Pipeline stages for the drag-and-drop Board (a booking moves left → right):
const SCHED_STAGES = ['casting', 'goandsee', 'shortlist', 'option', 'fitting', 'shooting', 'priority', 'waiting_payment', 'complete'];

// Data lives here. In production set DATA_DIR to a PERSISTENT disk (e.g. /data)
// so jobs/schedule/users survive restarts and redeploys.
const DATA_DIR      = process.env.DATA_DIR || path.join(__dirname, 'data');
const JOBS_FILE     = path.join(DATA_DIR, 'jobs.json');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');
const MODELS_FILE   = path.join(DATA_DIR, 'models.json');   // model directory (operational contacts only — NO money)
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json'); // exchange rates etc.
const INCOME_FILE   = path.join(DATA_DIR, 'income.json');   // other income / commission (Director+Admin ONLY — never sent to bookers)
const CLIENTS_FILE  = path.join(DATA_DIR, 'clients.json');  // CRM client records (added directly, not only via jobs)
const MAC_FILE      = path.join(DATA_DIR, 'mac.json');      // Mother-Agency-Commission ledger (per scouter)
const REQUESTS_FILE = path.join(DATA_DIR, 'requests.json'); // client job requests from the public form (leads to chase)
// Exchange rates → THB (editable by managers). Foreign jobs convert for the THB total.
const FX_DEFAULT = { USD: 35, EUR: 38, CNY: 5 };
function loadSettings() {
  const s = load(SETTINGS_FILE);
  const fx = (s && s.fxRates) || {};
  // Keep EVERY stored setting — dropping keys here meant a rates-only save
  // erased driveUploadUrl from disk and the client never received it at all.
  return { ...(s || {}), fxRates: { ...FX_DEFAULT, ...fx }, driveUploadUrl: (s && s.driveUploadUrl) || '', driveUploadKey: (s && s.driveUploadKey) || '' };
}
// Changes every deploy (server restart) → busts Cloudflare's cache of js/css so
// browsers always load the code that matches the current HTML.
const ASSET_VERSION = Date.now().toString(36);
// Shared secret so the SEPARATE Finance app can read revenue + models read-only.
const SERVICE_KEY = process.env.SERVICE_KEY || '';

// Extra client / confirmation fields a booker fills in for the quotation,
// contract and confirmation form (beyond the basic tracker columns).
const CLIENT_KEYS = [
  'companyName', 'clientTaxId', 'companyAddress', 'contactPerson', 'contactNumber', 'clientEmail',
  'product', 'role', 'mediaUsage', 'periodOfUsage', 'countryOfUse', 'shootLocation',
  'shootStart', 'shootEnd', 'timeStart', 'timeEnd', 'noOfShoot',
  'workPackage', 'contractHours', 'breakHours', 'overtimeRate', 'overtimeFee', 'paymentTerm', 'remark',
  'confType',     // last confirmation form type used (tax/nontax/intl) — Drive re-uploads must keep it
  'leadSource',   // CRM: which channel this lead/client came from (LINE, IG, website…)
  'signedDocUrl', // Drive link to the SIGNED confirmation the client sent back
  'clientCategory',   // CRM: client industry — Fashion / Commercial / Film & TV / Event organizer…
];

// ---- Users & access levels ---------------------------------------
// Roles: master / admin  → managers: everything, incl. revenue totals & delete
//        booker          → manage jobs & schedule, make confirmations (with the
//                          job's own fee), but NOT the aggregate revenue totals
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
const sessions = Object.create(null);   // login token -> { email, name, role }

// Append an audit event (who did what, when). Director/Admin can review these.
function logActivity(user, action, detail) {
  if (!user) return;
  const list = load(ACTIVITY_FILE);
  list.push({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    email: user.email, name: user.name, role: user.role,
    action, detail: text(detail, 200),
  });
  save(ACTIVITY_FILE, list.length > 5000 ? list.slice(-5000) : list);  // keep it bounded
}

// Create data/users.json with default logins the first time the server runs.
function seedUsers() {
  if (fs.existsSync(USERS_FILE)) return;
  const users = [
    { email: 'lisa@mpmodelsbkk.com',      name: 'Lisa (Director)', role: 'master', password: 'MPdirector2026' },
    { email: 'admin@mpmodelsbkk.com',     name: 'Admin',           role: 'admin',  password: 'admin1234' },
    { email: 'team@mpmodelsbkk.com',      name: 'Team (View only)',role: 'booker', password: 'mpmodels' },
    { email: 'mpbooker1@mpmodelsbkk.com', name: 'Booker 1',        role: 'booker', password: 'booker1234' },
    { email: 'mpbooker2@mpmodelsbkk.com', name: 'Booker 2',        role: 'booker', password: 'booker1234' },
    { email: 'talents@mpmodelsbkk.com',   name: 'Talents',         role: 'booker', password: 'booker1234' },
  ];
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
// Ensure Wolf's SCOUTER login exists (added once to any existing install). A scouter
// only ever sees their own Mother-Agency ledger + their own models' schedule.
function ensureExtraUsers() {
  if (!fs.existsSync(USERS_FILE)) return;
  const users = load(USERS_FILE);
  if (!Array.isArray(users)) return;
  if (!users.some(u => String(u.email || '').toLowerCase() === 'scouter@mpmodelsbkk.com')) {
    users.push({ email: 'scouter@mpmodelsbkk.com', name: 'Wolf (Scouter)', role: 'scouter', password: hashPassword('WolfMP2026scout') });
    save(USERS_FILE, users);
  }
}
// Passwords are stored hashed (scrypt, built-in — no dependencies) as
// "scrypt$<salt>$<hash>". Legacy plaintext is still accepted, then migrated.
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored) return false;
  if (stored.startsWith('scrypt$')) {
    const [, salt, hash] = stored.split('$');
    const test = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return String(plain) === stored;   // legacy plaintext (pre-migration)
}
// One-time: hash any plaintext passwords still on disk.
function migratePasswords() {
  if (!fs.existsSync(USERS_FILE)) return;
  const users = load(USERS_FILE);
  let changed = false;
  users.forEach(u => {
    if (u.password && !String(u.password).startsWith('scrypt$')) { u.password = hashPassword(u.password); changed = true; }
  });
  if (changed) save(USERS_FILE, users);
}

function findUser(email, password) {
  const pw = String(password || '').trim();   // tolerate autofill/paste whitespace
  if (!pw) return null;
  const users = load(USERS_FILE);
  const wanted = String(email || '').toLowerCase().trim();
  const ok = u => verifyPassword(pw, u.password);
  // Email is required: a password must never act as a global credential
  // (password-only match would log into whichever account happens to share it).
  if (!wanted) return null;
  return users.find(u => u.email.toLowerCase() === wanted && ok(u)) || null;
}
function getUser(req) { return sessions[req.headers['x-admin-token']] || null; }

// Describe exactly what changed on an edit, for the activity log.
function fieldChange(before, after, key, label) {
  const o = String(before[key] == null ? '' : before[key]);
  const n = String(after[key] == null ? '' : after[key]);
  if (o === n) return null;
  if (!n) return `${label} removed`;
  if (!o) return `${label} added`;
  return `${label} → ${n}`;
}
function diffSummary(before, after, body, fields) {
  const parts = [];
  for (const [key, label] of fields) {
    if (body[key] === undefined) continue;
    const c = fieldChange(before, after, key, label);
    if (c) parts.push(c);
  }
  return parts.join(', ');
}
const JOB_DIFF_FIELDS = [['status', 'status'], ['booker', 'booker'], ['budget', 'budget'],
  ['client', 'client'], ['jobTitle', 'title'], ['jobDate', 'job date'], ['jobId', 'job ID'],
  ['jobIdNonTax', 'non-tax ID'], ['model', 'model'], ['freelance', 'freelance']];
const SCHED_DIFF_FIELDS = [['status', 'status'], ['booker', 'booker'], ['date', 'date'],
  ['subject', 'subject'], ['timeStart', 'start time'], ['timeEnd', 'end time'], ['models', 'models'], ['casting', 'casting'],
  ['fitting', 'fitting'], ['option', 'option'], ['job', 'job'], ['shortlist', 'shortlist'], ['priority', 'priority'],
  ['note', 'note'], ['postponeDate', 'postpone date']];


/* ===================================================================
   1. READING & WRITING THE TWO DATA FILES
   =================================================================== */

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}
function save(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Crash-safe write: write to a temp file then rename. A crash mid-write can no
  // longer leave a truncated JSON file (which load() would silently read as []).
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}


/* ===================================================================
   2. JOBS  (create / update / delete)
   =================================================================== */

// Build a clean job record from whatever fields were sent.
// `fromWebsite` = true means a client filled in book.html (limited fields).
// Per-model fee lines for a job: [{ name, mp:bool, rate, ot }]. A line's fee = rate + ot.
// Lets ONE job hold several models at different rates + OT (Tawa's multi-model bookings).
function buildLines(input) {
  if (!Array.isArray(input.lines)) return null;   // null = caller didn't send lines (don't touch)
  return input.lines.map(l => ({
    name: text(l && l.name, 100),
    mp:   !!(l && l.mp),
    rate: number(l && l.rate),
    ot:   number(l && l.ot),
  })).filter(l => l.name || l.rate || l.ot).slice(0, 30);
}
function linesTotal(lines) { return (lines || []).reduce((s, l) => s + number(l.rate) + number(l.ot), 0); }
// overtimeFee may be a CONDITION text ("1,250/hour after 13 hours") — only a
// clean number counts toward totals (number() would wrongly grab the leading 1250).
// Commas must be REAL thousands groups: "12,50" (European decimal comma) is NOT
// 1250 baht — anything ambiguous is treated as condition text, never money.
function otAmount(v) {
  const s = String(v == null ? '' : v).trim();
  return /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(s) ? number(s) : 0;
}
function applyLines(job, lines) {
  job.lines = lines || [];
  if (job.lines.length) {
    job.budget = linesTotal(job.lines);                       // total = sum of every model's fee
    job.model = job.lines.filter(l => l.mp).map(l => l.name).filter(Boolean).join(', ');
    job.freelance = job.lines.filter(l => !l.mp).map(l => l.name).filter(Boolean).join(', ');
  }
}

function buildJob(input, fromWebsite) {
  const jobDate = date(input.jobDate) || date(input.startDate);
  // Jobs in the Tracker are confirmed by default; a booker may set another status.
  const status = STATUSES.includes(input.status) ? input.status : 'confirmed';
  const job = {
    id:          crypto.randomUUID(),
    source:      fromWebsite ? 'website' : 'manual',
    status,
    confirmed:   status === 'confirmed' || status === 'completed',
    month:       monthOf(jobDate) || monthOf(today()),
    bookingDate: today(),
    jobDate,
    budget:      number(input.budget),
    shootDays:   Math.max(1, Math.round(number(input.shootDays)) || 1),   // fees are often per shoot day
    jobId:       text(input.jobId, 60),
    jobIdNonTax: text(input.jobIdNonTax, 60),
    currency:    ['THB', 'USD', 'CNY', 'EUR'].includes(input.currency) ? input.currency : 'THB',
    jobTitle:    text(input.jobTitle) || text(input.projectType),
    model:       text(input.model) || text(input.modelName),
    modelSlug:   text(input.modelSlug, 80),
    freelance:   text(input.freelance),
    // Graphic designer's photo/video sourcing status (bookers never see this):
    materials:     ['searching', 'found', 'done'].includes(input.materials) ? input.materials : '',
    materialsNote: text(input.materialsNote, 500),
    collected:     !!input.collected,   // graphic ticks this once the work is collected/done
    confirmationMade: !!input.confirmationMade,   // set when the job confirmation has been generated
    whtMode: ['on', 'off'].includes(input.whtMode) ? input.whtMode : '',   // WHT on the confirmation: '' auto (THB only) | on | off
    // Shooting date(s) — the days the shoot happens; auto-placed on the Schedule.
    shootDates:    Array.isArray(input.shootDates) ? input.shootDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 30) : [],
    // Team-only scratch note — never printed on the client confirmation:
    internalNote:  text(input.internalNote, 2000),
    client:      text(input.client) || text(input.company) || text(input.clientName),
    booker:      text(input.booker, 40),
    // Extra contact details kept for website bookings:
    clientName:  text(input.clientName),
    email:       text(input.email, 160),
    phone:       text(input.phone, 60),
    notes:       text(input.notes, 2000),
  };
  // Client / confirmation details (empty until a booker fills them in).
  CLIENT_KEYS.forEach(k => { job[k] = text(input[k], 500); });
  // Website bookings pre-fill a couple of obvious ones.
  if (fromWebsite) {
    job.companyName  = job.companyName  || text(input.company);
    job.contactPerson = job.contactPerson || text(input.clientName);
    job.contactNumber = job.contactNumber || text(input.phone);
    job.clientEmail  = job.clientEmail  || text(input.email);
  }
  applyLines(job, buildLines(input) || []);   // multi-model per-rate breakdown (if provided)
  return job;
}

// Apply allowed edits to an existing job. Returns the updated job or null.
function updateJob(id, changes) {
  const jobs = load(JOBS_FILE);
  const job = jobs.find(j => j.id === id);
  if (!job) return null;

  const editable = ['status', 'confirmed', 'bookingDate', 'jobDate', 'budget', 'currency',
    'jobId', 'jobIdNonTax', 'jobTitle', 'model', 'freelance', 'client',
    'booker', 'notes', 'month', 'materials', 'materialsNote', 'collected', 'confirmationMade', 'shootDates', 'shootDays', 'whtMode', 'internalNote', ...CLIENT_KEYS];

  for (const key of editable) {
    if (changes[key] === undefined) continue;
    if (key === 'budget')         job.budget = number(changes.budget);
    else if (key === 'materials') job.materials = ['searching', 'found', 'done'].includes(changes.materials) ? changes.materials : '';
    else if (key === 'collected') job.collected = !!changes.collected;
    else if (key === 'confirmationMade') job.confirmationMade = !!changes.confirmationMade;
    else if (key === 'shootDates') job.shootDates = Array.isArray(changes.shootDates) ? changes.shootDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 30) : [];
    else if (key === 'shootDays') job.shootDays = Math.max(1, Math.round(number(changes.shootDays)) || 1);
    else if (key === 'whtMode') job.whtMode = ['on', 'off'].includes(changes.whtMode) ? changes.whtMode : '';
    else if (key === 'internalNote') job.internalNote = text(changes.internalNote, 2000);
    else if (key === 'currency')  job.currency = ['THB', 'USD', 'CNY', 'EUR'].includes(changes.currency) ? changes.currency : 'THB';
    else if (key === 'confirmed') job.confirmed = !!changes.confirmed;
    else if (key === 'status') {
      if (!STATUSES.includes(changes.status)) continue;
      job.status = changes.status;
      job.confirmed = (changes.status === 'confirmed' || changes.status === 'completed');
    }
    else job[key] = text(changes[key], key === 'notes' ? 2000 : 500);
  }
  // Multi-model fee lines — recompute budget + model/freelance from them.
  const newLines = buildLines(changes);
  if (newLines !== null) applyLines(job, newLines);
  // keep month in sync if the job date changed
  if (changes.jobDate !== undefined) job.month = monthOf(job.jobDate) || job.month;

  save(JOBS_FILE, jobs);
  return job;
}

function deleteJob(id) {
  const jobs = load(JOBS_FILE);
  const remaining = jobs.filter(j => j.id !== id);
  if (remaining.length === jobs.length) return false;
  save(JOBS_FILE, remaining);
  return true;
}

// Work out the next running codes, continuing your existing numbering:
//   C#### = taxed jobs,  B#### = non-tax jobs.
// Next running code. If a code was recently freed (its job was moved to the other
// invoice type or deleted), REUSE it instead of skipping — e.g. free B1110 → the
// next B is B1110 again, not B1113. We only reuse a gap within 40 of the current
// max (a genuinely-recent free), never the old reserved ranges far below.
const CODE_REUSE_WINDOW = 40;
function nextCode(prefix, jobs) {
  const used = new Set();
  const re = new RegExp(prefix + '\\s?(\\d{3,})', 'i');
  for (const j of jobs) {
    const m = `${j.jobId || ''} ${j.jobIdNonTax || ''}`.match(re);
    if (m) used.add(+m[1]);
  }
  if (!used.size) return prefix + '1';
  const max = Math.max(...used);
  // Highest freed number just below the max (a recent free) → reuse it.
  for (let n = max - 1; n >= max - CODE_REUSE_WINDOW && n > 0; n--) {
    if (!used.has(n)) return prefix + n;
  }
  return prefix + (max + 1);
}
function nextCodes() {
  const jobs = load(JOBS_FILE);
  return { tax: nextCode('C', jobs), nonTax: nextCode('B', jobs) };
}
// Short-lived reservations handed out by /api/next-code (code → expiry ms).
const codeHolds = Object.create(null);
// Flood guard for the public job-request form: ip → timestamps this hour.
const reqFlood = Object.create(null);

/* --- Web Push: "ring" the team's installed app on a new client request ---
   Zero-dependency VAPID: pushes carry NO payload (so no message encryption
   is needed) — the service worker shows a fixed "new job request" note and
   the app fetches the details itself when opened. */
const PUSH_KEYS_FILE = path.join(DATA_DIR, 'push_keys.json');
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push_subs.json');
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function vapidKeys() {
  try { return JSON.parse(fs.readFileSync(PUSH_KEYS_FILE, 'utf8')); } catch (_) {}
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const keys = {
    publicKey: b64url(Buffer.concat([Buffer.from([4]),
      Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')])),
    privateJwk: privateKey.export({ format: 'jwk' }),
  };
  try { fs.writeFileSync(PUSH_KEYS_FILE, JSON.stringify(keys)); } catch (_) {}
  return keys;
}
function pushAll() {
  let subs; try { subs = load(PUSH_SUBS_FILE); } catch (_) { subs = []; }
  if (!Array.isArray(subs) || !subs.length) return;
  const keys = vapidKeys();
  let privKey;
  try { privKey = crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' }); } catch (_) { return; }
  subs.forEach(s => {
    try {
      const aud = new URL(s.endpoint).origin;
      const seg = o => b64url(Buffer.from(JSON.stringify(o)));
      const unsigned = seg({ typ: 'JWT', alg: 'ES256' }) + '.'
        + seg({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:lisa@mpmodelsbkk.com' });
      const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: privKey, dsaEncoding: 'ieee-p1363' });
      const rq = https.request(s.endpoint, {
        method: 'POST',
        headers: { TTL: '86400', Urgency: 'high', 'Content-Length': 0,
          Authorization: `vapid t=${unsigned + '.' + b64url(sig)}, k=${keys.publicKey}` },
      }, resp => {
        resp.resume();
        if (resp.statusCode === 404 || resp.statusCode === 410) {   // subscription is dead — drop it
          try { save(PUSH_SUBS_FILE, load(PUSH_SUBS_FILE).filter(x => x.endpoint !== s.endpoint)); } catch (_) {}
        }
      });
      rq.on('error', () => {});
      rq.end();
    } catch (_) {}
  });
}


/* ===================================================================
   3. SCHEDULE  (add / delete calendar entries)
   =================================================================== */

function buildScheduleEntry(input) {
  const d = date(input.date);
  return {
    id:      crypto.randomUUID(),
    month:   monthOf(d) || monthOf(today()),
    date:    d,
    booker:  text(input.booker, 40),
    status:  LEAD_STATUSES.includes(input.status) ? input.status : 'open',
    subject: text(input.subject, 200),
    holdGroup: text(input.holdGroup, 40),   // links the days of a multi-day hold
    holdStart: text(input.holdStart, 20),
    holdEnd:   text(input.holdEnd, 20),
    timeStart: text(input.timeStart, 5),
    timeEnd:   text(input.timeEnd, 5),
    models:  text(input.models, 500),
    casting: text(input.casting, 1000),
    fitting: text(input.fitting, 1000),
    option:  text(input.option, 1000),
    job:     text(input.job, 1000),
    shortlist: text(input.shortlist, 1000),
    priority: text(input.priority, 1000),
    note:    text(input.note, 2000),
    stage:   SCHED_STAGES.includes(input.stage) ? input.stage : '',   // Board pipeline stage
    postponeDate: text(input.postponeDate, 40),      // new date when postponed (optional / free text)
    internalNote: text(input.internalNote, 2000),   // team-only; never in the model notify message
    jobRef:  text(input.jobRef, 40),                 // links a shoot-date entry back to its job
    planGroup: text(input.planGroup, 40),            // links casting/fitting/shooting of ONE booking
    notified: input.notified ? String(input.notified).slice(0, 30) : '',  // 'YYYY-MM-DD' when the model was told, else ''
    // Scouting placements (Wolf): a plan can span months — where a model is,
    // with whom, from `date` until `endDate`, and whether it's happening yet.
    endDate:   date(input.endDate) || '',
    place:     text(input.place, 200),
    planState: ['planned', 'current', 'done'].includes(input.planState) ? input.planState : '',
    shootDays: input.shootDays ? Math.max(1, Math.round(number(input.shootDays)) || 1) : '',  // 1 or 2 shoot days
    leadSource: text(input.leadSource, 40),          // CRM: which channel this lead came from
    clientType: (input.clientType === 'new' || input.clientType === 'old') ? input.clientType : '',  // new vs returning client
    clientContact: text(input.clientContact, 300),   // client's contact (name / phone / LINE / email)
    clientCategory: text(input.clientCategory, 40),  // CRM: client industry
  };
}
function updateScheduleEntry(id, changes) {
  const list = load(SCHEDULE_FILE);
  const entry = list.find(e => e.id === id);
  if (!entry) return null;
  if (changes.date !== undefined) { entry.date = date(changes.date); entry.month = monthOf(entry.date) || entry.month; }
  if (changes.booker !== undefined)  entry.booker = text(changes.booker, 40);
  if (changes.status !== undefined && LEAD_STATUSES.includes(changes.status)) entry.status = changes.status;
  if (changes.subject !== undefined) entry.subject = text(changes.subject, 200);
  if (changes.timeStart !== undefined) entry.timeStart = text(changes.timeStart, 5);
  if (changes.timeEnd !== undefined)   entry.timeEnd = text(changes.timeEnd, 5);
  if (changes.models !== undefined)  entry.models = text(changes.models, 500);
  if (changes.casting !== undefined) entry.casting = text(changes.casting, 1000);
  if (changes.fitting !== undefined) entry.fitting = text(changes.fitting, 1000);
  if (changes.option !== undefined)  entry.option = text(changes.option, 1000);
  if (changes.job !== undefined)     entry.job = text(changes.job, 1000);
  if (changes.shortlist !== undefined) entry.shortlist = text(changes.shortlist, 1000);
  if (changes.priority !== undefined) entry.priority = text(changes.priority, 1000);
  if (changes.note !== undefined)    entry.note = text(changes.note, 2000);
  if (changes.stage !== undefined) entry.stage = SCHED_STAGES.includes(changes.stage) ? changes.stage : '';
  if (changes.postponeDate !== undefined) entry.postponeDate = text(changes.postponeDate, 40);
  if (changes.internalNote !== undefined) entry.internalNote = text(changes.internalNote, 2000);
  if (changes.jobCreated !== undefined) entry.jobCreated = !!changes.jobCreated;
  if (changes.notified !== undefined) entry.notified = changes.notified ? String(changes.notified).slice(0, 30) : '';
  if (changes.keptOpen !== undefined)  entry.keptOpen = !!changes.keptOpen;
  if (changes.endDate !== undefined)   entry.endDate = date(changes.endDate) || '';
  if (changes.place !== undefined)     entry.place = text(changes.place, 200);
  if (changes.planState !== undefined) entry.planState = ['planned', 'current', 'done'].includes(changes.planState) ? changes.planState : '';
  if (changes.shootDays !== undefined) entry.shootDays = changes.shootDays ? Math.max(1, Math.round(number(changes.shootDays)) || 1) : '';
  if (changes.leadSource !== undefined) entry.leadSource = text(changes.leadSource, 40);
  if (changes.clientType !== undefined) entry.clientType = (changes.clientType === 'new' || changes.clientType === 'old') ? changes.clientType : '';
  if (changes.clientContact !== undefined) entry.clientContact = text(changes.clientContact, 300);
  if (changes.clientCategory !== undefined) entry.clientCategory = text(changes.clientCategory, 40);
  // Link fields — the client re-links entries to jobs/plans/holds via PATCH
  // (e.g. syncShootDates converting a casting into the job's shoot entry).
  if (changes.jobRef !== undefined) entry.jobRef = text(changes.jobRef, 40);
  if (changes.planGroup !== undefined) entry.planGroup = text(changes.planGroup, 40);
  if (changes.holdGroup !== undefined) entry.holdGroup = text(changes.holdGroup, 40);
  if (changes.holdStart !== undefined) entry.holdStart = date(changes.holdStart);
  if (changes.holdEnd !== undefined) entry.holdEnd = date(changes.holdEnd);
  save(SCHEDULE_FILE, list);
  return entry;
}
// ---- Model directory (operational contacts only — NEVER money) ---
const MODEL_FIELDS = ['name', 'nickname', 'sex', 'country', 'status', 'agency', 'category',
  'motherAgency', 'phone', 'whatsapp', 'line', 'email', 'ig', 'visaType', 'visaExpiry',
  'workPermit', 'arrival', 'departure', 'compCard', 'note', 'age', 'location', 'modelCode', 'scouter'];
// The REAL model code (MP-YY-MM-###) from the master Google Sheet — the same code
// Aim uses as the product code in FlowAccount. One-time seed maps our models to it.
const MODEL_CODE_SEED = path.join(__dirname, 'model_code_seed.json');
const MODEL_LONG = { note: 1000, motherAgency: 600 };
// Running Model ID — a unique sequential number per model (tells duplicate names apart).
function nextModelNo(list) {
  const max = (list || []).reduce((m, x) => Math.max(m, parseInt(x.modelNo, 10) || 0), 0);
  return max + 1;
}
function buildModel(input, list) {
  const m = { id: crypto.randomUUID() };
  MODEL_FIELDS.forEach(k => { m[k] = text(input[k], MODEL_LONG[k] || 200); });
  m.modelNo = nextModelNo(list || load(MODELS_FILE));
  return m;
}
// CRM client record (managers only). Contact/marketing data — never money.
const CLIENT_REC_FIELDS = ['name', 'company', 'taxId', 'address', 'contactPerson',
  'phone', 'email', 'leadSource', 'clientCategory', 'clientType', 'note'];
function buildClient(input) {
  const c = { id: input.id || crypto.randomUUID(), created: input.created || new Date().toISOString() };
  CLIENT_REC_FIELDS.forEach(k => { c[k] = text(input[k], k === 'note' || k === 'address' ? 800 : 200); });
  return c;
}

// Mother-Agency-Commission ledger record (a scouter's own management sheet).
function buildMacRecord(input) {
  return {
    id: input.id || crypto.randomUUID(),
    owner: text(input.owner, 120),          // scouter's email (who owns this record)
    ownerName: text(input.ownerName, 80),
    year: text(input.year, 9),
    period: text(input.period, 60),         // work period, free text
    model: text(input.model, 100),
    agency: text(input.agency, 100),
    amount: number(input.amount),           // what the MODEL earned abroad
    gross: number(input.gross),             // MP's gross mother-agency commission (10% of amount)
    commission: number(input.commission),   // the scouter's (Wolf's) share (5% = half the gross)
    expense: number(input.expense),
    advanceCost: number(input.advanceCost),
    status: text(input.status, 40),         // PAID / To be paid / Postponed / OFF / In town…
    paymentInfo: text(input.paymentInfo, 300),
    note: text(input.note, 500),
    created: input.created || new Date().toISOString(),
  };
}

// One-time import of Wolf's historical MAC ledger from the bundled seed. Runs only
// until the ledger has seeded rows, so it never re-imports or overwrites live data.
const MAC_SEED = path.join(__dirname, 'mac_seed.json');
function seedMacRecords() {
  if (!fs.existsSync(MAC_SEED)) return;
  const cur = load(MAC_FILE);
  if (Array.isArray(cur) && cur.some(r => r.fromSeed)) return;   // already imported
  let seed = [];
  try { seed = JSON.parse(fs.readFileSync(MAC_SEED, 'utf8')); } catch (_) { return; }
  if (!Array.isArray(seed) || !seed.length) return;
  save(MAC_FILE, seed.map(s => ({ ...buildMacRecord(s), fromSeed: true })));
}

// Other income / commission entry (managers only). Amount stored as a number.
const INCOME_KINDS = ['sale', 'commission', 'referral', 'rental', 'mac', 'other'];
function buildIncome(input) {
  const kind = INCOME_KINDS.includes(String(input.kind)) ? input.kind : 'commission';
  const cur = ['THB', 'USD', 'EUR', 'CNY'].includes(String(input.currency)) ? input.currency : 'THB';
  return {
    id: input.id || crypto.randomUUID(),
    date: text(input.date, 10),           // YYYY-MM-DD
    kind,
    amount: number(input.amount),          // the income (for MAC = the commission MP earns)
    currency: cur,
    source: text(input.source, 200),      // who / which deal
    note: text(input.note, 1000),
    // Mother-Agency-Commission ledger fields (only used when kind === 'mac').
    model: text(input.model, 100),
    agency: text(input.agency, 100),
    period: text(input.period, 60),        // work period, free text (e.g. "10th Oct 2024 - 13th Jan 2025")
    modelAmount: number(input.modelAmount),// what the model earned abroad
    expense: number(input.expense),
    advanceCost: number(input.advanceCost),
    status: text(input.status, 30),        // PAID / Pending / OFF / Postponed
    paymentInfo: text(input.paymentInfo, 300),
    created: input.created || new Date().toISOString(),
  };
}
function updateModel(id, changes) {
  const list = load(MODELS_FILE);
  const m = list.find(x => x.id === id);
  if (!m) return null;
  // Renames get the same duplicate guard as adding (no two models with one name).
  if (changes.name !== undefined) {
    const wanted = String(changes.name || '').trim().toLowerCase();
    const clash = wanted && list.find(x => x.id !== id && String(x.name || '').trim().toLowerCase() === wanted);
    if (clash) return { __duplicate: text(changes.name) };
  }
  MODEL_FIELDS.forEach(k => { if (changes[k] !== undefined) m[k] = text(changes[k], MODEL_LONG[k] || 200); });
  save(MODELS_FILE, list);
  return m;
}
// Give every existing model a running number (once), in current order.
function backfillModelNos() {
  const list = load(MODELS_FILE);
  if (!Array.isArray(list) || !list.length) return;
  let next = nextModelNo(list), changed = false;
  list.forEach(m => { if (!m.modelNo) { m.modelNo = next++; changed = true; } });
  if (changed) save(MODELS_FILE, list);
}
// Seed the directory from the model names bookers ALREADY use in the Job Tracker,
// tagging MP vs Freelance, so it's linked to bookings from day one — the designer
// then fills each one's contacts.
function seedModels() {
  if (fs.existsSync(MODELS_FILE)) return;
  const agencyOf = {};
  load(JOBS_FILE).forEach(j => {
    const mp = text(j.model, 80).trim();       if (mp && mp.length <= 60) agencyOf[mp] = 'MP';
    const fl = text(j.freelance, 80).trim();   if (fl && fl.length <= 60 && !agencyOf[fl]) agencyOf[fl] = 'Freelance';
  });
  const list = Object.keys(agencyOf).sort((a, b) => a.localeCompare(b))
    .map(n => buildModel({ name: n, agency: agencyOf[n] }));
  fs.mkdirSync(path.dirname(MODELS_FILE), { recursive: true });
  save(MODELS_FILE, list);
}
// Finance lives in the SEPARATE Financial Management app now (finance.mpmodelsbkk.com).
// This app only EXPORTS revenue + models to it read-only (see /api/export below).
function deleteScheduleEntry(id) {
  const list = load(SCHEDULE_FILE);
  const remaining = list.filter(e => e.id !== id);
  if (remaining.length === list.length) return false;
  save(SCHEDULE_FILE, remaining);
  return true;
}


/* ===================================================================
   4. THE API
   =================================================================== */

async function handleApi(req, res) {
  const method   = req.method;
  const url      = req.url.split('?')[0];      // e.g. "/api/jobs/123"
  const parts    = url.split('/').filter(Boolean);  // ["api","jobs","123"]
  const resource = parts[1];                   // "jobs" | "schedule" | "auth"
  const id       = parts[2] || '';
  const body     = await readJson(req);

  // --- LOGIN -----------------------------------------------------
  if (resource === 'auth' && method === 'POST') {
    const user = findUser(body.email, body.password);
    if (!user) return reply(res, 401, { error: 'Wrong email or password' });
    const token = crypto.randomUUID();
    const session = { email: user.email, name: user.name, role: user.role, bookerName: user.bookerName || '' };
    sessions[token] = session;
    logActivity(session, 'login', '');
    return reply(res, 200, { ok: true, token, email: user.email, name: user.name, role: user.role,
      bookerName: user.bookerName || '' });
  }
  // --- LOGOUT: invalidate the session server-side ----------------
  if (resource === 'logout' && method === 'POST') {
    const t = req.headers['x-admin-token'];
    if (t && sessions[t]) delete sessions[t];
    return reply(res, 200, { ok: true });
  }

  // --- READ-ONLY EXPORT for the separate Finance app --------------
  // One-way: the Finance app reads revenue + models with a shared service key.
  // Nothing financial ever flows back; no user session involved.
  // --- FULL BACKUP (service-key gated) — pulled nightly by Lisa's Mac ---
  // Returns every data file so a complete off-Railway copy always exists.
  if (resource === 'backup' && method === 'GET') {
    if (!SERVICE_KEY || req.headers['x-service-key'] !== SERVICE_KEY) {
      return reply(res, 403, { error: 'Forbidden' });
    }
    const files = {};
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.endsWith('.json')) continue;
      try { files[f] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch (_) {}
    }
    return reply(res, 200, { when: new Date().toISOString(), app: 'booking', files });
  }

  if (resource === 'export' && method === 'GET') {
    if (!SERVICE_KEY || req.headers['x-service-key'] !== SERVICE_KEY) {
      return reply(res, 403, { error: 'Forbidden' });
    }
    // A job with per-model fee lines is EXPANDED into one row per model, each carrying
    // that model's own fee — so the finance app credits every model correctly with no
    // changes on its side. Single-model jobs pass through unchanged.
    const jobs = [];
    load(JOBS_FILE).forEach(j => {
      // month is the NORMALISED period (YYYY-MM) — jobDate is often free text
      // ("13,14 July") and must never be used alone for year attribution.
      const base = { currency: j.currency, jobDate: j.jobDate, month: j.month, jobId: j.jobId, jobIdNonTax: j.jobIdNonTax,
        jobTitle: j.jobTitle, client: j.client, leadSource: j.leadSource };
      if (Array.isArray(j.lines) && j.lines.length) {
        j.lines.forEach(l => {
          const fee = number(l.rate) + number(l.ot);
          jobs.push({ ...base, model: l.mp ? l.name : '', freelance: l.mp ? '' : l.name, budget: fee });
        });
      } else {
        // budget + overtime: the finance app must see the full job amount
        // (lines-jobs already carry OT inside each line's fee above).
        jobs.push({ ...base, model: j.model, freelance: j.freelance, budget: number(j.budget) + otAmount(j.overtimeFee) });
      }
    });
    // fx: current exchange rates so the Finance app can convert foreign-currency
    // budgets to THB (a €500 job must not be read as ฿500).
    return reply(res, 200, { jobs, models: load(MODELS_FILE), schedule: load(SCHEDULE_FILE), fx: loadSettings().fxRates });
  }

  // --- CLIENT booking from the website (no login) ----------------
  // A website request is a LEAD, so it lands in the Schedule as an option —
  // not as a confirmed job in the Tracker.
  if (resource === 'jobs' && method === 'POST' && !getUser(req)) {
    // A DEAD admin token (deploy wiped the session) must get a clean 401 so the
    // app re-shows login — not fall into this public website-lead branch and
    // confuse the booker with "fill in your name and pick a model".
    if (req.headers['x-admin-token']) return reply(res, 401, { error: 'Session expired — please log in again.' });
    if (!body.clientName || !body.email || !body.modelSlug) {
      return reply(res, 400, { error: 'Please fill in your name, email and pick a model.' });
    }
    const entry = buildScheduleEntry({
      date: body.startDate,
      models: body.modelName || body.modelSlug,
      option: `Website request: ${text(body.projectType, 60)} for ${text(body.clientName, 60)}${body.company ? ' (' + text(body.company, 60) + ')' : ''}`,
      note: `Client: ${text(body.clientName, 60)} · ${text(body.email, 120)}${body.phone ? ' · ' + text(body.phone, 40) : ''}\n`
          + `Dates: ${text(body.startDate, 20)}${body.endDate ? ' → ' + text(body.endDate, 20) : ''}\n`
          + `Budget: ${text(body.budget, 40) || '-'}\n${text(body.notes, 500)}`,
    });
    const list = load(SCHEDULE_FILE);
    list.push(entry);
    save(SCHEDULE_FILE, list);
    return reply(res, 201, { ok: true, entry });
  }

  // --- CLIENT JOB REQUEST from the public form (no login) --------
  // Bookers send clients the /request.html link (social media enquiries);
  // the filled form lands in the Requests tab as a lead to chase.
  if (resource === 'requests' && method === 'POST' && !getUser(req)) {
    if (req.headers['x-admin-token']) return reply(res, 401, { error: 'Session expired — please log in again.' });
    if (text(body.website)) return reply(res, 201, { ok: true });   // honeypot: bots fill it, humans never see it
    const contact = text(body.email, 120) || text(body.phone, 40) || text(body.lineId, 60);
    if (!text(body.clientName, 80) || !contact) {
      return reply(res, 400, { error: 'Please fill in your name and at least one way to contact you.' });
    }
    // simple flood guard: max 10 public requests per IP per hour
    const ip = String(req.socket.remoteAddress || '');
    const now = Date.now();
    reqFlood[ip] = (reqFlood[ip] || []).filter(t => now - t < 3600000);
    if (reqFlood[ip].length >= 10) return reply(res, 429, { error: 'Too many requests — please try again later.' });
    reqFlood[ip].push(now);
    const rec = {
      id: crypto.randomUUID(),
      created: new Date().toISOString(),
      status: 'new',                       // new → contacted → won | lost
      clientName: text(body.clientName, 80),
      company: text(body.company, 120),
      email: text(body.email, 120),
      phone: text(body.phone, 40),
      lineId: text(body.lineId, 60),
      projectType: text(body.projectType, 60),
      description: text(body.description, 1000),
      startDate: text(body.startDate, 20),
      endDate: text(body.endDate, 20),
      dateFlexible: !!body.dateFlexible,
      budget: text(body.budget, 60),
      modelsCount: text(body.modelsCount, 60),
      usage: text(body.usage, 200),
      location: text(body.location, 200),
      // the bookers' own 11-question checklist (Ness's template):
      product: text(body.product, 120),
      halfFull: text(body.halfFull, 60),
      bikinis: text(body.bikinis, 20),
      countryOfUse: text(body.countryOfUse, 120),
      periodOfUsage: text(body.periodOfUsage, 60),
      outfits: text(body.outfits, 30),
      foundVia: text(body.foundVia, 40),
      notes: text(body.notes, 800),
      booker: '', statusNote: '', entryRef: '', jobRef: '',
    };
    const list = load(REQUESTS_FILE);
    list.unshift(rec);
    save(REQUESTS_FILE, list);
    try { pushAll(); } catch (_) {}   // ring the team's phones
    return reply(res, 201, { ok: true });
  }

  // Public VAPID key — needed by browsers to subscribe (not a secret by design).
  if (resource === 'push' && id === 'key' && method === 'GET') {
    return reply(res, 200, { key: vapidKeys().publicKey });
  }

  // Deploy version — the client polls this to auto-reload open tabs after a deploy.
  if (resource === 'version' && method === 'GET') {
    return reply(res, 200, { version: ASSET_VERSION });
  }

  /* Everything below is team-only. */
  const user = getUser(req);
  if (!user) return reply(res, 401, { error: 'Please log in.' });
  const isManager = user.role === 'master' || user.role === 'admin';
  // Graphic designer is read-only on jobs & schedule, BUT she maintains the Models
  // directory (contacts/materials) AND marks photo/video status on a job.
  if (user.role === 'designer' && method !== 'GET' && resource !== 'models') {
    const designerMaterialsEdit = resource === 'jobs' && method === 'PATCH';  // materials only, enforced below
    if (!designerMaterialsEdit) {
      return reply(res, 403, { error: 'View only — the graphic designer cannot make changes.' });
    }
  }

  // A SCOUTER (external) is tightly sandboxed: only their own Mother-Agency ledger,
  // plus READ-ONLY access to their own models + those models' schedule. Nothing else.
  const isScouter = user.role === 'scouter';
  if (isScouter) {
    const allowed = resource === 'mac'
      // Scouter can WRITE schedule too — but only his own scouting entries
      // (ownership + field whitelist enforced inside the schedule handlers).
      || resource === 'schedule'
      || (resource === 'models' && method === 'GET')
      || (resource === 'settings' && method === 'GET');
    if (!allowed) return reply(res, 403, { error: 'Not allowed.' });
  }
  // The set of model names this scouter owns (for filtering models + schedule).
  const scouterModelNames = () => new Set(
    load(MODELS_FILE)
      .filter(m => String(m.scouter || '').toLowerCase() === String(user.email || '').toLowerCase())
      .map(m => String(m.name || '').trim().toLowerCase()).filter(Boolean));

  // --- MODEL DIRECTORY (contacts only, NO money) ----------------
  if (resource === 'models') {
    if (method === 'GET') {
      let list = load(MODELS_FILE);
      if (isScouter) { const mine = scouterModelNames(); list = list.filter(m => mine.has(String(m.name || '').trim().toLowerCase())); }
      return reply(res, 200, { models: list });
    }
    // One-time import: stamp each model with its REAL code from the master sheet
    // (matched by email/IG/phone/name). Managers only. Never overwrites a code
    // already set by hand. Backs up the directory first.
    if (method === 'POST' && body && body.__applyCodes) {
      if (!isManager) return reply(res, 403, { error: 'Director / Admin only.' });
      let seed = {};
      try { seed = JSON.parse(fs.readFileSync(MODEL_CODE_SEED, 'utf8')); } catch (_) {}
      const models = load(MODELS_FILE);
      try { fs.writeFileSync(MODELS_FILE + '.bak', JSON.stringify(models)); } catch (_) {}
      let applied = 0, already = 0;
      models.forEach(m => {
        if (!seed[m.id]) return;
        if (m.modelCode) { already++; return; }   // never clobber a hand-set code
        m.modelCode = seed[m.id]; applied++;
      });
      save(MODELS_FILE, models);
      logActivity(user, 'imported model codes', `${applied} set, ${already} already had one`);
      return reply(res, 200, { ok: true, applied, already, total: models.length, seeded: Object.keys(seed).length });
    }
    // Create / edit / delete: managers + the graphic designer. Bookers view only.
    const canEditModels = isManager || user.role === 'designer';
    if (!canEditModels) return reply(res, 403, { error: 'View only — ask Admin or the designer to edit contacts.' });
    // Bulk update (Ploy's cleanup): set status and/or category on MANY models in one
    // write. POST { __bulk:true, ids:[...], set:{ status?, category? } }.
    if (method === 'POST' && body && body.__bulk) {
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 500) : [];
      const set = body.set || {};
      const ALLOWED_STATUS = ['In town', 'Out of town', 'Direct booking', 'Left', ''];
      const patch = {};
      if (set.status !== undefined && ALLOWED_STATUS.includes(set.status)) patch.status = set.status;
      if (set.category !== undefined) {
        patch.category = text(set.category, 40);
        patch.agency = patch.category === 'MP Models' ? 'MP' : (patch.category ? 'Freelance' : '');
      }
      if (!ids.length || !Object.keys(patch).length) return reply(res, 400, { error: 'Nothing to update.' });
      const list = load(MODELS_FILE);
      const idSet = new Set(ids);
      let n = 0;
      list.forEach(m => { if (idSet.has(m.id)) { Object.assign(m, patch); n++; } });
      save(MODELS_FILE, list);
      logActivity(user, 'bulk-updated models', `${n} models → ${Object.entries(patch).filter(([k]) => k !== 'agency').map(([k, v]) => k + ': ' + (v || '(cleared)')).join(', ')}`);
      return reply(res, 200, { ok: true, updated: n });
    }
    if (method === 'POST') {
      const list = load(MODELS_FILE);
      // Stop accidental duplicates: no two models with the same name.
      const wanted = String(body.name || '').trim().toLowerCase();
      if (wanted) {
        const clash = list.find(x => String(x.name || '').trim().toLowerCase() === wanted);
        if (clash) return reply(res, 409, { error: `A model named “${text(body.name)}” is already on the list.`, duplicate: true, existingId: clash.id });
      }
      const m = buildModel(body, list);
      list.push(m); save(MODELS_FILE, list);
      logActivity(user, 'added model', m.name);
      return reply(res, 201, { ok: true, model: m });
    }
    if (method === 'PATCH' && id) {
      const m = updateModel(id, body);
      if (!m) return reply(res, 404, { error: 'Model not found.' });
      if (m.__duplicate) return reply(res, 409, { error: `A model named “${m.__duplicate}” is already on the list.`, duplicate: true });
      return reply(res, 200, { ok: true, model: m });
    }
    if (method === 'DELETE' && id) {
      save(MODELS_FILE, load(MODELS_FILE).filter(x => x.id !== id));
      logActivity(user, 'deleted model', id);
      return reply(res, 200, { ok: true });
    }
  }

  // Finance is no longer served here — it lives in the separate, locked
  // Financial Management app which pulls revenue via /api/export (above).

  // --- ACTIVITY LOG (visible to the whole team) -----------------
  // Money-bearing entries (income amounts, MAC commissions, FX rates, restores)
  // are manager-only: their detail text carries figures bookers/designer must
  // never see, so those rows are filtered out for non-managers.
  if (resource === 'activity' && method === 'GET') {
    const MONEY_ACTIONS = ['added other income', 'edited other income', 'deleted other income',
      'added MAC record', 'updated FX rates', 'restored data'];
    let list = load(ACTIVITY_FILE).slice().reverse();   // newest first
    if (!isManager) {
      list = list.filter(a => !MONEY_ACTIONS.some(m => String(a.action || '').startsWith(m)));
    }
    return reply(res, 200, { activity: list });
  }

  // Settings (exchange rates). Everyone can read (for display); managers can edit.
  if (resource === 'settings') {
    if (method === 'GET') return reply(res, 200, loadSettings());   // whole team (Lisa 2026-08-20)
    if (method === 'PUT') {
      if (!isManager) return reply(res, 403, { error: 'Only Director/Admin can change rates.' });
      const s = loadSettings();
      if (body.fxRates && typeof body.fxRates === 'object') {
        ['USD', 'EUR', 'CNY'].forEach(c => { if (body.fxRates[c] !== undefined) s.fxRates[c] = number(body.fxRates[c]); });
      }
      // Apps Script webhook that files each generated confirmation into the
      // Google Drive confirmations folder as a Google Doc (Aim reads in Chrome).
      if (body.driveUploadUrl !== undefined) s.driveUploadUrl = text(body.driveUploadUrl, 300);
      // Shared secret the script demands on every upload (defence beyond the URL).
      if (body.driveUploadKey !== undefined) s.driveUploadKey = text(body.driveUploadKey, 100);
      save(SETTINGS_FILE, s);
      logActivity(user, 'updated FX rates', ['USD', 'EUR', 'CNY'].map(c => `${c} ${s.fxRates[c]}`).join(', '));
      return reply(res, 200, { ok: true, ...s });
    }
  }

  // --- RESTORE (manager only) — one-time data transfer to production -----
  // Lets a Director push the local jobs/schedule straight to the server
  // (used once after deploy, so data never has to go through GitHub).
  if (resource === 'restore' && method === 'POST') {
    // Director ONLY — a restore replaces whole data files. It must never touch the
    // user table (that would let an admin mint a master account or reset passwords).
    if (user.role !== 'master') return reply(res, 403, { error: 'Director only.' });
    // Keep a backup of whatever is being replaced, so a bad restore is recoverable.
    const backup = f => { try { fs.copyFileSync(f, f + '.pre-restore'); } catch (_) {} };
    if (Array.isArray(body.jobs)) { backup(JOBS_FILE); save(JOBS_FILE, body.jobs); }
    if (Array.isArray(body.schedule)) { backup(SCHEDULE_FILE); save(SCHEDULE_FILE, body.schedule); }
    if (Array.isArray(body.models) && body.models.length) { backup(MODELS_FILE); save(MODELS_FILE, body.models); }
    logActivity(user, 'restored data', `${(body.jobs || []).length} jobs, ${(body.schedule || []).length} leads`);
    return reply(res, 200, { ok: true, jobs: (body.jobs || []).length, schedule: (body.schedule || []).length, models: (body.models || []).length });
  }

  // --- NEXT RUNNING CODE (team) ---------------------------------
  if (resource === 'next-code' && method === 'GET') {
    // Reserve each issued code for 10 minutes so two bookers generating at
    // the same moment can never receive the SAME next code (duplicate race).
    const now = Date.now();
    for (const k of Object.keys(codeHolds)) if (codeHolds[k] < now) delete codeHolds[k];
    const codes = nextCodes();
    const bump = c => {
      const m = String(c || '').match(/^([CB])(\d+)$/i);
      if (!m) return c;
      let n = +m[2];
      while (codeHolds[m[1].toUpperCase() + n]) n++;
      const out = m[1].toUpperCase() + n;
      codeHolds[out] = now + 10 * 60 * 1000;
      return out;
    };
    return reply(res, 200, { tax: bump(codes.tax), nonTax: bump(codes.nonTax) });
  }

  // --- OTHER INCOME / COMMISSION (Director + Admin ONLY) --------
  // Sales, commission, net income the agency earns outside the model bookings.
  // This is money data: gated to managers on EVERY method, so bookers/designer
  // never even receive it in a response.
  // --- WEB PUSH subscriptions (team phones that want the "ring") ---
  if (resource === 'push' && id === 'subscribe' && method === 'POST') {
    const sub = body && body.subscription;
    if (!sub || !/^https:\/\//.test(String(sub.endpoint || ''))) return reply(res, 400, { error: 'Bad subscription.' });
    let list; try { list = load(PUSH_SUBS_FILE); } catch (_) { list = []; }
    list = list.filter(x => x.endpoint !== sub.endpoint);
    list.push({ endpoint: String(sub.endpoint).slice(0, 600), keys: sub.keys || {}, email: user.email, created: new Date().toISOString() });
    save(PUSH_SUBS_FILE, list);
    return reply(res, 200, { ok: true });
  }

  // --- CLIENT JOB REQUESTS (team view — bookers chase these leads) ---
  if (resource === 'requests') {
    if (method === 'GET') return reply(res, 200, { requests: load(REQUESTS_FILE) });
    if (method === 'PATCH' && id) {
      const list = load(REQUESTS_FILE);
      const rec = list.find(x => x.id === id);
      if (!rec) return reply(res, 404, { error: 'Request not found.' });
      // Team edits only the tracking fields — the client's own answers stay as sent.
      ['status', 'booker', 'statusNote', 'entryRef', 'jobRef'].forEach(k => {
        if (k in body) rec[k] = text(body[k], k === 'statusNote' ? 500 : 80);
      });
      if (!['new', 'contacted', 'won', 'lost'].includes(rec.status)) rec.status = 'new';
      rec.updated = new Date().toISOString();
      save(REQUESTS_FILE, list);
      logActivity(user, 'updated job request', `${rec.clientName} → ${rec.status}`);
      return reply(res, 200, { ok: true, request: rec });
    }
    if (method === 'DELETE' && id) {
      if (!isManager) return reply(res, 403, { error: 'Director / Admin only.' });
      save(REQUESTS_FILE, load(REQUESTS_FILE).filter(x => x.id !== id));
      logActivity(user, 'deleted job request', id);
      return reply(res, 200, { ok: true });
    }
  }

  if (resource === 'income') {
    if (!isManager) return reply(res, 403, { error: 'Director / Admin only.' });
    if (method === 'GET') return reply(res, 200, { income: load(INCOME_FILE) });
    if (method === 'POST') {
      const list = load(INCOME_FILE);
      const rec = buildIncome(body);
      list.unshift(rec); save(INCOME_FILE, list);
      logActivity(user, 'added other income', `${rec.kind} ${rec.amount} ${rec.currency}${rec.source ? ' — ' + rec.source : ''}`);
      return reply(res, 201, { ok: true, income: rec });
    }
    if (method === 'PATCH' && id) {
      const list = load(INCOME_FILE);
      const rec = list.find(x => x.id === id);
      if (!rec) return reply(res, 404, { error: 'Entry not found.' });
      Object.assign(rec, buildIncome({ ...rec, ...body }), { id: rec.id, created: rec.created });
      save(INCOME_FILE, list);
      logActivity(user, 'edited other income', `${rec.kind} ${rec.amount} ${rec.currency}`);
      return reply(res, 200, { ok: true, income: rec });
    }
    if (method === 'DELETE' && id) {
      save(INCOME_FILE, load(INCOME_FILE).filter(x => x.id !== id));
      logActivity(user, 'deleted other income', id);
      return reply(res, 200, { ok: true });
    }
  }

  // --- CRM CLIENT RECORDS (Director + Admin ONLY) --------------
  // Clients added directly (not only via jobs). Merged with job history in the UI.
  if (resource === 'clients') {
    if (!isManager) return reply(res, 403, { error: 'Director / Admin only.' });
    if (method === 'GET') return reply(res, 200, { clients: load(CLIENTS_FILE) });
    if (method === 'POST') {
      if (!text(body.name)) return reply(res, 400, { error: 'Client name is required.' });
      const list = load(CLIENTS_FILE);
      const rec = buildClient(body);
      list.push(rec); save(CLIENTS_FILE, list);
      logActivity(user, 'added client', rec.name);
      return reply(res, 201, { ok: true, client: rec });
    }
    if (method === 'PATCH' && id) {
      const list = load(CLIENTS_FILE);
      const rec = list.find(x => x.id === id);
      if (!rec) return reply(res, 404, { error: 'Client not found.' });
      Object.assign(rec, buildClient({ ...rec, ...body }), { id: rec.id, created: rec.created });
      save(CLIENTS_FILE, list);
      logActivity(user, 'edited client', rec.name);
      return reply(res, 200, { ok: true, client: rec });
    }
    if (method === 'DELETE' && id) {
      save(CLIENTS_FILE, load(CLIENTS_FILE).filter(x => x.id !== id));
      logActivity(user, 'deleted client', id);
      return reply(res, 200, { ok: true });
    }
  }

  // --- MOTHER AGENCY (MAC) LEDGER — scouters + managers --------
  // A scouter sees & edits ONLY their own records; managers see all scouters'.
  if (resource === 'mac') {
    if (!isManager && !isScouter) return reply(res, 403, { error: 'Not allowed.' });
    const mine = r => String(r.owner || '').toLowerCase() === String(user.email || '').toLowerCase();
    if (method === 'GET') {
      let list = load(MAC_FILE);
      if (isScouter) list = list.filter(mine);
      return reply(res, 200, { mac: list });
    }
    if (method === 'POST') {
      const list = load(MAC_FILE);
      const owner = isScouter ? user.email : (body.owner || user.email);
      const ownerName = isScouter ? user.name : (body.ownerName || '');
      const rec = buildMacRecord({ ...body, owner, ownerName });
      list.push(rec); save(MAC_FILE, list);
      logActivity(user, 'added MAC record', `${rec.model || ''} ${rec.agency || ''} ${rec.commission || ''}`);
      return reply(res, 201, { ok: true, mac: rec });
    }
    if (method === 'PATCH' && id) {
      const list = load(MAC_FILE);
      const rec = list.find(x => x.id === id);
      if (!rec) return reply(res, 404, { error: 'Record not found.' });
      if (isScouter && !mine(rec)) return reply(res, 403, { error: 'Not your record.' });
      Object.assign(rec, buildMacRecord({ ...rec, ...body }), { id: rec.id, owner: rec.owner, ownerName: rec.ownerName, created: rec.created });
      save(MAC_FILE, list);
      return reply(res, 200, { ok: true, mac: rec });
    }
    if (method === 'DELETE' && id) {
      const list = load(MAC_FILE);
      const rec = list.find(x => x.id === id);
      if (rec && isScouter && !mine(rec)) return reply(res, 403, { error: 'Not your record.' });
      save(MAC_FILE, list.filter(x => x.id !== id));
      return reply(res, 200, { ok: true });
    }
  }

  // --- JOBS (team) ----------------------------------------------
  // Everyone on the team can see & set a job's own fee (bookers make the
  // confirmations). Only the aggregate revenue totals are hidden — that's done
  // in the dashboard UI. Deleting a job stays manager-only.
  if (resource === 'jobs') {
    if (method === 'GET') {
      let jobs = load(JOBS_FILE);
      // Graphic designer sees monthly money like the bookers (Lisa 2026-08-20);
      // only the manager year-total/billing views stay hidden (client-side gates).
      return reply(res, 200, { jobs });
    }
    if (method === 'POST') {                       // team adds a job by hand
      if (!body.booker && user.bookerName) body.booker = user.bookerName;
      const job = buildJob(body, false);
      // Give every new job a running code if none was typed in.
      if (!job.jobId && !job.jobIdNonTax) job.jobId = nextCodes().tax;
      const jobs = load(JOBS_FILE);
      jobs.unshift(job);
      save(JOBS_FILE, jobs);
      logActivity(user, 'created job', `${job.jobTitle} (${job.jobId || job.jobIdNonTax})`);
      return reply(res, 201, { ok: true, job });
    }
    if (method === 'PATCH' && id) {
      // The graphic designer may change ONLY the materials status + collected tick.
      const patch = user.role === 'designer'
        ? { materials: body.materials, materialsNote: body.materialsNote, collected: body.collected }
        : body;
      const before = load(JOBS_FILE).find(j => j.id === id) || {};
      const job = updateJob(id, patch);
      if (job) {
        const what = user.role === 'designer'
          ? 'materials → ' + (job.materials || 'not checked')
          : diffSummary(before, job, body, JOB_DIFF_FIELDS);
        logActivity(user, 'edited job', `${job.jobTitle}${what ? ' — ' + what : ''}`);
      }
      return job ? reply(res, 200, { ok: true, job })
                 : reply(res, 404, { error: 'Job not found.' });
    }
    if (method === 'DELETE' && id) {
      // Bookers manage their own jobs fully (create/edit/delete). The designer stays read-only.
      if (user.role === 'designer') return reply(res, 403, { error: 'View only — the graphic designer cannot delete jobs.' });
      const target = load(JOBS_FILE).find(j => j.id === id);
      const ok = deleteJob(id);
      if (ok) {
        // Cascade: remove the schedule entries this job auto-created for its shoot
        // dates (jobRef-linked) so no orphan green "shooting" cards linger.
        const sched = load(SCHEDULE_FILE);
        const remaining = sched.filter(e => e.jobRef !== id);
        if (remaining.length !== sched.length) save(SCHEDULE_FILE, remaining);
        logActivity(user, 'deleted job', target ? target.jobTitle : id);
      }
      return ok ? reply(res, 200, { ok: true })
                : reply(res, 404, { error: 'Job not found.' });
    }
  }

  // --- SCHEDULE (team) ------------------------------------------
  if (resource === 'schedule') {
    if (method === 'GET') {
      let { list } = autoDeclinePastOptions();   // keep expired holds tidy on every load
      if (isScouter) {
        // Only entries for THIS scouter's models. Match whole names (the models field
        // is a free-text list) — a substring match would leak other models' bookings
        // when a scouter owns a short name (e.g. "An" matching "Joanna").
        const mine = scouterModelNames();
        const tokens = s => String(s || '').toLowerCase().split(/[,\/\n•·&+]| and /).map(t => t.trim()).filter(Boolean);
        // …plus his scouting diary: entries he created OR a manager created for him.
        list = list.filter(e => e.createdBy === user.email || e.booker === user.name || tokens(e.models).some(t => mine.has(t)));
      }
      return reply(res, 200, { schedule: list });
    }
    if (method === 'POST') {
      // A booker's new entry is always tagged with their OWN name, even if the
      // form's booker field was left blank — so nothing lands untagged.
      if (!body.booker && user.bookerName) body.booker = user.bookerName;
      // Scouting entries are simple diary rows — no job/hold/type machinery,
      // always tagged with the scouter's name.
      const input = isScouter ? {
        date: body.date, endDate: body.endDate, models: body.models, subject: body.subject,
        place: body.place, planState: body.planState,
        timeStart: body.timeStart, timeEnd: body.timeEnd, note: body.note,
        internalNote: body.internalNote, booker: user.name || 'Wolf',
      } : body;
      const entry = buildScheduleEntry(input);
      entry.createdBy = user.email || '';   // ownership — scouters may edit only their own
      const list = load(SCHEDULE_FILE);
      list.push(entry);
      save(SCHEDULE_FILE, list);
      logActivity(user, 'added schedule', `${entry.date} ${entry.models}`.trim());
      return reply(res, 201, { ok: true, entry });
    }
    if (method === 'PATCH' && id === 'bulk') {   // tag many entries with one booker, atomically
      if (isScouter) return reply(res, 403, { error: 'Not allowed.' });
      const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
      const booker = text(body.booker, 40);
      const list = load(SCHEDULE_FILE);
      let n = 0;
      list.forEach(e => { if (ids.has(e.id)) { e.booker = booker; n++; } });
      save(SCHEDULE_FILE, list);
      logActivity(user, 'bulk-tagged schedule', `${n} entries → ${booker || '(cleared)'}`);
      return reply(res, 200, { ok: true, count: n });
    }
    if (method === 'PATCH' && id) {
      const before = load(SCHEDULE_FILE).find(e => e.id === id) || {};
      if (isScouter) {
        // Only his own entries (created by him, or created FOR him by a manager).
        if (before.createdBy !== user.email && before.booker !== user.name) return reply(res, 403, { error: 'Not allowed.' });
        const allow = ['date', 'endDate', 'models', 'subject', 'place', 'planState', 'timeStart', 'timeEnd', 'note', 'internalNote', 'status'];
        Object.keys(body).forEach(k => { if (!allow.includes(k)) delete body[k]; });
      }
      const entry = updateScheduleEntry(id, body);
      if (entry) {
        const what = diffSummary(before, entry, body, SCHED_DIFF_FIELDS);
        logActivity(user, 'edited schedule', `${entry.date} ${entry.models || ''} — ${what || 'updated'}`.trim());
      }
      return entry ? reply(res, 200, { ok: true, entry })
                   : reply(res, 404, { error: 'Entry not found.' });
    }
    if (method === 'DELETE' && id) {
      const target = load(SCHEDULE_FILE).find(e => e.id === id);
      if (isScouter && (!target || (target.createdBy !== user.email && target.booker !== user.name))) return reply(res, 403, { error: 'Not allowed.' });
      const ok = deleteScheduleEntry(id);
      if (ok) logActivity(user, 'deleted schedule', target ? `${target.date} ${target.models}`.trim() : id);
      return ok ? reply(res, 200, { ok: true })
                : reply(res, 404, { error: 'Entry not found.' });
    }
  }

  return reply(res, 404, { error: 'Unknown request.' });
}


/* ===================================================================
   5. SERVING THE WEBSITE FILES
   =================================================================== */

const FILE_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function serveFile(req, res) {
  let name = decodeURIComponent(req.url.split('?')[0]);
  // On this domain the booking SOFTWARE is the site — send the root (and the old
  // prototype index) straight to the team dashboard. The client booking form is
  // still reachable directly at /book.html for a "Book a Model" website link.
  if (name === '/' || name === '/index.html') {
    res.writeHead(302, { Location: '/admin.html' });
    return res.end();
  }
  // Clean bio-friendly address for the client job-request form.
  if (name === '/request' || name === '/request/') name = '/request.html';
  const filePath = path.normalize(path.join(__dirname, name));
  if (!filePath.startsWith(__dirname + path.sep)) return reply(res, 403, { error: 'Forbidden' });

  // Only ever serve real front-end assets: the .html pages at the root, and files
  // under js/ css/ images/. Never the backend source, configs, data, docs, or the
  // model-code seed — those live at the root too and must NOT be publicly readable.
  const rel = filePath.slice(__dirname.length + 1).replace(/\\/g, '/');
  const isPublicAsset = (rel.endsWith('.html') && !rel.includes('/')) || /^(js|css|images)\//.test(rel)
    || rel === 'sw.js' || rel === 'manifest.webmanifest';   // PWA files must live at root (sw.js scope = '/')
  if (!isPublicAsset) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    return res.end('<h1>404 — Page not found</h1>');
  }

  fs.readFile(filePath, (err, contents) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end('<h1>404 — Page not found</h1>');
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = FILE_TYPES[ext] || 'text/plain';
    const headers = { 'Content-Type': type };
    // Never let the browser serve a stale HTML/JS/CSS after a deploy — it must
    // revalidate, so the page & script always match (no old-HTML + new-JS crashes).
    if (ext === '.html' || ext === '.js' || ext === '.css') headers['Cache-Control'] = 'no-cache';
    // In HTML, stamp the current deploy version onto every script/style link so
    // Cloudflare (which caches .js/.css hard) is forced to fetch the fresh file.
    if (ext === '.html') {
      contents = Buffer.from(String(contents).replace(/\b(src|href)="([^"]+\.(?:js|css))"/g,
        (m, attr, url) => `${attr}="${url}?v=${ASSET_VERSION}"`));
    }
    res.writeHead(200, headers);
    res.end(contents);
  });
}


/* ===================================================================
   6. SMALL HELPERS
   =================================================================== */

function reply(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function readJson(req) {
  return new Promise(resolve => {
    let data = '', dead = false;
    req.on('error', () => { if (!dead) { dead = true; resolve({}); } });   // client dropped mid-body — never crash
    const MAX = 2 * 1024 * 1024;   // 2 MB — plenty for any real payload, blocks memory-exhaustion posts
    req.on('data', c => {
      if (dead) return;
      data += c;
      if (data.length > MAX) { dead = true; data = ''; try { req.destroy(); } catch (_) {} resolve({}); }
    });
    req.on('end', () => { if (!dead) { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } } });
  });
}
function text(v, max = 300)  { return String(v == null ? '' : v).trim().slice(0, max); }
function number(v)          { const n = parseFloat(String(v).replace(/[,\s]/g, '')); return isNaN(n) ? 0 : n; }
function today()           { return new Date().toISOString().slice(0, 10); }               // YYYY-MM-DD
function date(v)           { const t = text(v, 40); return (t === '-' ) ? '' : t; }
function monthOf(d)        { return /^\d{4}-\d{2}/.test(d || '') ? d.slice(0, 7) : ''; }    // YYYY-MM
// Thailand has no daylight saving, so Bangkok's date is simply UTC + 7 hours.
function bangkokToday()    { return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); }

// An OPTION is just a hold; once its day passes with nothing confirmed, it's dead.
// Auto-decline past, still-"open" OPTION-only entries so bookers don't have to tick
// each held day by hand. NEVER touches castings, jobs, confirmed, or postponed.
function autoDeclinePastOptions() {
  const list = load(SCHEDULE_FILE);
  const t = bangkokToday();
  let changed = 0;
  for (const e of list) {
    if (e.status === 'open'
        && /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') && e.date < t
        && e.option && !e.casting && !e.job
        && !e.keptOpen) {   // a booker deliberately brought it back — leave it alone
      e.status = 'declined';
      e.autoDeclined = t;          // marks it as system-expired (vs a real client decline)
      changed++;
    }
  }
  if (changed) {
    save(SCHEDULE_FILE, list);
    logActivity({ email: 'system@mpmodelsbkk.com', name: 'System (auto)', role: 'system' },
      'auto-declined past options', `${changed} expired option day(s)`);
  }
  return { list, changed };
}


/* ===================================================================
   7. START THE SERVER
   =================================================================== */

// ---- CRASH-PROOFING ------------------------------------------------
// One request must never take down the whole app (a crash logs everyone out).
// 1. Every request/response stream gets an error listener — a phone dropping
//    the connection mid-request otherwise raises an unhandled stream error
//    that KILLS the process (the likely cause of the repeated crashes).
// 2. API errors are LOGGED with a stack (they were swallowed silently before).
// 3. Last-resort process guards log the stack instead of dying quietly.
process.on('uncaughtException', err => {
  console.error('[uncaughtException]', err && err.stack || err);
});
process.on('unhandledRejection', err => {
  console.error('[unhandledRejection]', err && err.stack || err);
});
// Daily on-volume snapshot: copies every data file to DATA_DIR/backups/YYYY-MM-DD/
// once per day (idempotent), keeping the last 14 days. Protects against a bad
// write or an accidental in-app deletion — the OFF-Railway copy is the Mac pull.
function dailySnapshot() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const root = path.join(DATA_DIR, 'backups');
    const dir = path.join(root, today);
    if (fs.existsSync(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (f.endsWith('.json')) fs.copyFileSync(path.join(DATA_DIR, f), path.join(dir, f));
    }
    fs.readdirSync(root).sort().slice(0, -14).forEach(d => {
      try { fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch (_) {}
    });
    console.log('[backup] snapshot ' + today + ' written');
  } catch (e) { console.error('[backup]', e.message); }
}

const server = http.createServer((req, res) => {
  req.on('error', e => { console.error('[req error]', req.url, e.code || e.message); try { res.destroy(); } catch (_) {} });
  res.on('error', e => { console.error('[res error]', req.url, e.code || e.message); });
  try {
    if (req.url.startsWith('/api/')) {
      handleApi(req, res).catch(err => {
        console.error('[api error]', req.method, req.url, err && err.stack || err);
        if (!res.headersSent) reply(res, 500, { error: 'Something went wrong — please try again.' });
        else try { res.end(); } catch (_) {}
      });
    } else {
      serveFile(req, res);
    }
  } catch (err) {
    console.error('[handler error]', req.method, req.url, err && err.stack || err);
    if (!res.headersSent) { try { reply(res, 500, { error: 'Something went wrong.' }); } catch (_) {} }
  }
});

// Graceful shutdown: Railway sends SIGTERM when it replaces the container on
// every deploy. Without this, Node dies with a non-zero code and Railway mails
// a "Deployment crashed" alert for a perfectly normal deploy.
process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received — closing server');
  server.close(() => { console.log('[shutdown] closed cleanly'); process.exit(0); });
  if (server.closeIdleConnections) server.closeIdleConnections();
  // If a request hangs past 8s, leave anyway — deliberate shutdown, exit 0.
  setTimeout(() => { console.log('[shutdown] timeout — forcing exit'); process.exit(0); }, 8000).unref();
});

server.listen(PORT, () => {
  seedUsers();          // create data/users.json on first run
  ensureExtraUsers();   // add Wolf's scouter login if missing
  seedMacRecords();     // import Wolf's historical MAC ledger once
  migratePasswords();   // hash any plaintext passwords still on disk
  seedModels();         // build the model directory from booking names on first run
  backfillModelNos();   // give every model a running number
  autoDeclinePastOptions();   // tidy expired option holds on boot
  setInterval(autoDeclinePastOptions, 6 * 3600 * 1000);   // …and every 6 hours
  dailySnapshot();            // on-volume daily backup (14 days kept)
  setInterval(dailySnapshot, 6 * 3600 * 1000);   // idempotent — one snapshot per day
  console.log(`\n  MP Models booking & job tracker is running.`);
  console.log(`  → Website:   http://localhost:${PORT}/`);
  console.log(`  → Dashboard: http://localhost:${PORT}/admin.html`);
  console.log(`  → Logins are in data/users.json\n`);
});
