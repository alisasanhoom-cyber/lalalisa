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
  'workPackage', 'breakHours', 'overtimeRate', 'overtimeFee', 'paymentTerm', 'remark',
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
  // With an email: match email + password. Without: match by password alone.
  return wanted
    ? users.find(u => u.email.toLowerCase() === wanted && ok(u)) || null
    : users.find(u => ok(u)) || null;
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
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
}


/* ===================================================================
   2. JOBS  (create / update / delete)
   =================================================================== */

// Build a clean job record from whatever fields were sent.
// `fromWebsite` = true means a client filled in book.html (limited fields).
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
    currency:    ['THB', 'USD', 'CNY'].includes(input.currency) ? input.currency : 'THB',
    jobTitle:    text(input.jobTitle) || text(input.projectType),
    model:       text(input.model) || text(input.modelName),
    modelSlug:   text(input.modelSlug, 80),
    freelance:   text(input.freelance),
    // Graphic designer's photo/video sourcing status (bookers never see this):
    materials:     ['searching', 'found', 'done'].includes(input.materials) ? input.materials : '',
    materialsNote: text(input.materialsNote, 500),
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
  return job;
}

// Apply allowed edits to an existing job. Returns the updated job or null.
function updateJob(id, changes) {
  const jobs = load(JOBS_FILE);
  const job = jobs.find(j => j.id === id);
  if (!job) return null;

  const editable = ['status', 'confirmed', 'bookingDate', 'jobDate', 'budget', 'currency',
    'jobId', 'jobIdNonTax', 'jobTitle', 'model', 'freelance', 'client',
    'booker', 'notes', 'month', 'materials', 'materialsNote', 'internalNote', ...CLIENT_KEYS];

  for (const key of editable) {
    if (changes[key] === undefined) continue;
    if (key === 'budget')         job.budget = number(changes.budget);
    else if (key === 'materials') job.materials = ['searching', 'found', 'done'].includes(changes.materials) ? changes.materials : '';
    else if (key === 'internalNote') job.internalNote = text(changes.internalNote, 2000);
    else if (key === 'currency')  job.currency = ['THB', 'USD', 'CNY'].includes(changes.currency) ? changes.currency : 'THB';
    else if (key === 'confirmed') job.confirmed = !!changes.confirmed;
    else if (key === 'status') {
      if (!STATUSES.includes(changes.status)) continue;
      job.status = changes.status;
      job.confirmed = (changes.status === 'confirmed' || changes.status === 'completed');
    }
    else job[key] = text(changes[key], key === 'notes' ? 2000 : 500);
  }
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
function nextCodes() {
  const jobs = load(JOBS_FILE);
  let maxC = 0, maxB = 0;
  for (const j of jobs) {
    const both = `${j.jobId || ''} ${j.jobIdNonTax || ''}`;
    const c = both.match(/C\s?(\d{3,})/i); if (c) maxC = Math.max(maxC, +c[1]);
    const b = both.match(/B\s?(\d{3,})/i); if (b) maxB = Math.max(maxB, +b[1]);
  }
  return { tax: 'C' + (maxC + 1), nonTax: 'B' + (maxB + 1) };
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
    notified: input.notified ? String(input.notified).slice(0, 30) : '',  // 'YYYY-MM-DD' when the model was told, else ''
    shootDays: input.shootDays ? Math.max(1, Math.round(number(input.shootDays)) || 1) : '',  // 1 or 2 shoot days
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
  if (changes.shootDays !== undefined) entry.shootDays = changes.shootDays ? Math.max(1, Math.round(number(changes.shootDays)) || 1) : '';
  save(SCHEDULE_FILE, list);
  return entry;
}
// ---- Model directory (operational contacts only — NEVER money) ---
const MODEL_FIELDS = ['name', 'nickname', 'sex', 'country', 'status', 'agency', 'category',
  'motherAgency', 'phone', 'whatsapp', 'line', 'email', 'ig', 'visaType', 'visaExpiry',
  'workPermit', 'arrival', 'departure', 'compCard', 'note'];
const MODEL_LONG = { note: 1000, motherAgency: 600 };
function buildModel(input) {
  const m = { id: crypto.randomUUID() };
  MODEL_FIELDS.forEach(k => { m[k] = text(input[k], MODEL_LONG[k] || 200); });
  return m;
}
function updateModel(id, changes) {
  const list = load(MODELS_FILE);
  const m = list.find(x => x.id === id);
  if (!m) return null;
  MODEL_FIELDS.forEach(k => { if (changes[k] !== undefined) m[k] = text(changes[k], MODEL_LONG[k] || 200); });
  save(MODELS_FILE, list);
  return m;
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

  // --- READ-ONLY EXPORT for the separate Finance app --------------
  // One-way: the Finance app reads revenue + models with a shared service key.
  // Nothing financial ever flows back; no user session involved.
  if (resource === 'export' && method === 'GET') {
    if (!SERVICE_KEY || req.headers['x-service-key'] !== SERVICE_KEY) {
      return reply(res, 403, { error: 'Forbidden' });
    }
    const jobs = load(JOBS_FILE).map(j => ({
      model: j.model, freelance: j.freelance, budget: j.budget, currency: j.currency,
      jobDate: j.jobDate, jobId: j.jobId, jobIdNonTax: j.jobIdNonTax, jobTitle: j.jobTitle, client: j.client,
    }));
    return reply(res, 200, { jobs, models: load(MODELS_FILE) });
  }

  // --- CLIENT booking from the website (no login) ----------------
  // A website request is a LEAD, so it lands in the Schedule as an option —
  // not as a confirmed job in the Tracker.
  if (resource === 'jobs' && method === 'POST' && !getUser(req)) {
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

  // --- MODEL DIRECTORY (contacts only, NO money) ----------------
  if (resource === 'models') {
    if (method === 'GET') return reply(res, 200, { models: load(MODELS_FILE) });
    // Create / edit / delete: managers + the graphic designer. Bookers view only.
    const canEditModels = isManager || user.role === 'designer';
    if (!canEditModels) return reply(res, 403, { error: 'View only — ask Admin or the designer to edit contacts.' });
    if (method === 'POST') {
      const list = load(MODELS_FILE);
      // Stop accidental duplicates: no two models with the same name.
      const wanted = String(body.name || '').trim().toLowerCase();
      if (wanted) {
        const clash = list.find(x => String(x.name || '').trim().toLowerCase() === wanted);
        if (clash) return reply(res, 409, { error: `A model named “${text(body.name)}” is already on the list.`, duplicate: true, existingId: clash.id });
      }
      const m = buildModel(body);
      list.push(m); save(MODELS_FILE, list);
      logActivity(user, 'added model', m.name);
      return reply(res, 201, { ok: true, model: m });
    }
    if (method === 'PATCH' && id) {
      const m = updateModel(id, body);
      if (!m) return reply(res, 404, { error: 'Model not found.' });
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
  if (resource === 'activity' && method === 'GET') {
    return reply(res, 200, { activity: load(ACTIVITY_FILE).slice().reverse() });  // newest first
  }

  // --- RESTORE (manager only) — one-time data transfer to production -----
  // Lets a Director push the local jobs/schedule straight to the server
  // (used once after deploy, so data never has to go through GitHub).
  if (resource === 'restore' && method === 'POST') {
    if (!isManager) return reply(res, 403, { error: 'Not allowed.' });
    if (Array.isArray(body.jobs)) save(JOBS_FILE, body.jobs);
    if (Array.isArray(body.schedule)) save(SCHEDULE_FILE, body.schedule);
    // Passwords in an incoming users list are already hashed (scrypt$...); only
    // accept a non-empty array so we never wipe logins by mistake.
    if (Array.isArray(body.users) && body.users.length) save(USERS_FILE, body.users);
    if (Array.isArray(body.models) && body.models.length) save(MODELS_FILE, body.models);
    logActivity(user, 'restored data', `${(body.jobs || []).length} jobs, ${(body.schedule || []).length} leads`);
    return reply(res, 200, { ok: true, jobs: (body.jobs || []).length, schedule: (body.schedule || []).length, users: (body.users || []).length, models: (body.models || []).length });
  }

  // --- NEXT RUNNING CODE (team) ---------------------------------
  if (resource === 'next-code' && method === 'GET') {
    return reply(res, 200, nextCodes());
  }

  // --- JOBS (team) ----------------------------------------------
  // Everyone on the team can see & set a job's own fee (bookers make the
  // confirmations). Only the aggregate revenue totals are hidden — that's done
  // in the dashboard UI. Deleting a job stays manager-only.
  if (resource === 'jobs') {
    if (method === 'GET') {
      let jobs = load(JOBS_FILE);
      // Graphic designer browses jobs to source photos/videos — never sees money.
      // Strip the fee server-side so it isn't even in the response.
      if (user.role === 'designer') jobs = jobs.map(({ budget, currency, ...rest }) => rest);
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
      // The graphic designer may change ONLY the materials status — nothing else.
      const patch = user.role === 'designer'
        ? { materials: body.materials, materialsNote: body.materialsNote }
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
      if (!isManager) return reply(res, 403, { error: 'Bookers cannot delete jobs.' });
      const target = load(JOBS_FILE).find(j => j.id === id);
      const ok = deleteJob(id);
      if (ok) logActivity(user, 'deleted job', target ? target.jobTitle : id);
      return ok ? reply(res, 200, { ok: true })
                : reply(res, 404, { error: 'Job not found.' });
    }
  }

  // --- SCHEDULE (team) ------------------------------------------
  if (resource === 'schedule') {
    if (method === 'GET') {
      const { list } = autoDeclinePastOptions();   // keep expired holds tidy on every load
      return reply(res, 200, { schedule: list });
    }
    if (method === 'POST') {
      // A booker's new entry is always tagged with their OWN name, even if the
      // form's booker field was left blank — so nothing lands untagged.
      if (!body.booker && user.bookerName) body.booker = user.bookerName;
      const entry = buildScheduleEntry(body);
      const list = load(SCHEDULE_FILE);
      list.push(entry);
      save(SCHEDULE_FILE, list);
      logActivity(user, 'added schedule', `${entry.date} ${entry.models}`.trim());
      return reply(res, 201, { ok: true, entry });
    }
    if (method === 'PATCH' && id === 'bulk') {   // tag many entries with one booker, atomically
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
  const filePath = path.normalize(path.join(__dirname, name));
  if (!filePath.startsWith(__dirname)) return reply(res, 403, { error: 'Forbidden' });

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
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
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
        && e.option && !e.casting && !e.job) {
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

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    handleApi(req, res).catch(() => reply(res, 400, { error: 'Something went wrong.' }));
  } else {
    serveFile(req, res);
  }
}).listen(PORT, () => {
  seedUsers();          // create data/users.json on first run
  migratePasswords();   // hash any plaintext passwords still on disk
  seedModels();         // build the model directory from booking names on first run
  autoDeclinePastOptions();   // tidy expired option holds on boot
  setInterval(autoDeclinePastOptions, 6 * 3600 * 1000);   // …and every 6 hours
  console.log(`\n  MP Models booking & job tracker is running.`);
  console.log(`  → Website:   http://localhost:${PORT}/`);
  console.log(`  → Dashboard: http://localhost:${PORT}/admin.html`);
  console.log(`  → Logins are in data/users.json\n`);
});
